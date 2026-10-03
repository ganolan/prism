import { Router } from 'express';
import { getDb } from '../db/index.js';
import { hasMasterySession, syncMasteryForCourse, syncMasteryForAssignment, writeMasteryScores, writeMasteryScoresBatch, writeMasteryOverride, getMasteryForCourse, getRubricScoresForStudent, interactiveLogin } from '../services/masterySync.js';
import { pushGradeComments, getSectionGrades } from '../services/schoology.js';
import { settleResubmissions, resubmissionByStudent, arrivedKeys, pairResubmissionFields } from '../services/resubmissions.js';
import { captureFeedbackSnapshots } from '../services/feedbackSnapshots.js';
import { STATUS_LINE_KINDS, putSucceeded, checkLine, lockPair, withCheckedLine } from '../services/statusLinePublisher.js';
import { getAlignedTopics, getRoster, getScoreMap, getGradeMetaRows, scoreScaleFor } from '../services/assessmentContext.js';
import { getSchoologyConfig, getScoreScales } from '../middleware/featureGate.js';
import { findScoreScale, levelForScore, isScalePoints } from '../lib/scoreScales.js';
import { toSchoologyWebUrl } from '../lib/schoologyWebUrl.js';
import { levelToGradeScaled, gradeScaledValues, pointsToLevel, LEVELS } from '../lib/proficiencyScale.js';
import { getAssignmentFiles } from '../services/oneDriveLinks.js';
import { matchFilesToRoster } from '../lib/oneDriveSubmissions.js';
import { epochToLocalDate } from '../lib/schoolDays.js';

const router = Router();
const syncsInProgress = new Set();

// Why `points` can't be written as a scale grade on this assignment, or null
// when it can: the assignment must be on a configured score scale (#41) and
// `points` must be exactly one of that scale's level values.
function scalePointsError(db, courseId, assignmentId, points) {
  const row = db.prepare(
    'SELECT grading_scale_id FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?'
  ).get(String(assignmentId), courseId);
  const scale = row ? findScoreScale(getScoreScales(), row.grading_scale_id) : null;
  if (!scale) return `Assignment ${assignmentId} is not on a scale Prism can grade`;
  if (!isScalePoints(scale, points)) return `${points} is not a level of ${scale.name}`;
  return null;
}

// POST /api/mastery/login — open a visible browser window for Schoology login
let loginInProgress = false;
router.post('/login', async (req, res) => {
  if (loginInProgress) {
    return res.status(409).json({ error: 'Login browser already open. Log in and close the browser window.' });
  }
  loginInProgress = true;
  try {
    await interactiveLogin();
    res.json({ success: true, message: 'Login session saved.' });
  } catch (err) {
    console.error('[mastery login] Error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    loginInProgress = false;
  }
});

// GET /api/mastery/login-status — best-effort: does a saved browser session
// file exist? Does not verify the session is still valid.
router.get('/login-status', (req, res) => {
  res.json({ loggedIn: hasMasterySession() });
});

// Rubric levels are part of the visible-feedback fingerprint, so every mastery pull
// re-snapshots the course (Amendment B fix round 1) — otherwise the next revision is
// judged against stale levels. Best-effort: never fails the pull.
function snapshotAfterMasteryPull(db, courseId) {
  try {
    captureFeedbackSnapshots(db, { courseId: Number(courseId) });
    settleResubmissions(db, { courseId: Number(courseId) });
  } catch (err) {
    console.error('[mastery] snapshot/settle after pull failed:', err.message);
  }
}

// POST /api/mastery/sync/:courseId — trigger Playwright mastery sync for a course
router.post('/sync/:courseId', async (req, res) => {
  const { courseId } = req.params;
  if (syncsInProgress.has(courseId)) {
    return res.status(409).json({ error: 'Mastery sync already in progress for this course' });
  }
  syncsInProgress.add(courseId);
  const db = getDb();
  const now = new Date().toISOString();
  const syncRow = db.prepare(
    `INSERT INTO sync_log (sync_type, status, started_at) VALUES ('mastery', 'running', ?)`
  ).run(now);
  const syncId = syncRow.lastInsertRowid;

  try {
    const result = await syncMasteryForCourse(courseId, {
      onProgress: (p) => console.log(`[mastery] ${p.message}`),
    });
    db.prepare(`UPDATE sync_log SET status = 'completed', records_synced = ?, completed_at = ? WHERE id = ?`)
      .run(result.scoresCount || 0, new Date().toISOString(), syncId);
    snapshotAfterMasteryPull(db, courseId);
    res.json(result);
  } catch (err) {
    console.error('[mastery sync] Error:', err);
    db.prepare(`UPDATE sync_log SET status = 'error', error_message = ?, completed_at = ? WHERE id = ?`)
      .run(err.message, new Date().toISOString(), syncId);
    res.status(500).json({ error: err.message });
  } finally {
    syncsInProgress.delete(courseId);
  }
});

// GET /api/mastery/:courseId — all mastery data for a course (from local DB)
router.get('/:courseId', (req, res) => {
  const { courseId } = req.params;
  try {
    const data = getMasteryForCourse(courseId);
    const db = getDb();
    const rollups = db.prepare(`
      SELECT student_uid, objective_id, is_category, grade_percentage, grade_scaled_rounded, override_value
      FROM mastery_rollups
      WHERE course_id = ?
    `).all(courseId);
    // Authoritative assignment↔topic alignments, with topic/category metadata
    // so the gradebook can render a mini rubric per cell (#32). Published
    // assignments only — mirrors every other mastery query.
    const alignments = db.prepare(`
      SELECT ma.assignment_schoology_id, ma.topic_id,
             mt.title              AS topic_title,
             mt.external_id        AS topic_external_id,
             mt.category_id        AS category_id,
             rc.title              AS category_title,
             rc.external_id        AS category_external_id
      FROM mastery_alignments ma
      JOIN measurement_topics  mt ON mt.id = ma.topic_id
      JOIN reporting_categories rc ON rc.id = mt.category_id
      JOIN assignments a ON a.schoology_assignment_id = ma.assignment_schoology_id
      WHERE ma.course_id = ? AND a.published = 1
    `).all(courseId);
    res.json({ ...data, rollups, alignments });
  } catch (err) {
    console.error('[mastery] Error fetching mastery data:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mastery/:courseId/student/:studentUid — per-student mastery scores
router.get('/:courseId/student/:studentUid', (req, res) => {
  const { courseId, studentUid } = req.params;
  const db = getDb();

  // Topics that are either aligned to a published assignment in this course
  // OR have a score for one. Alignments alone are enough — they let the UI
  // render a topic column with "Pending" cells before any grades exist.
  // Filter both inner selects to assignments individually-relevant to this
  // student (#54) so a topic aligned only to other-student assessments does
  // not appear as an empty column on this student's summary.
  const topics = db.prepare(`
    SELECT DISTINCT mt.*, rc.title AS category_title, rc.external_id AS category_external_id
    FROM measurement_topics mt
    JOIN reporting_categories rc ON rc.id = mt.category_id
    WHERE mt.id IN (
      SELECT ma.topic_id FROM mastery_alignments ma
      JOIN assignments a ON a.schoology_assignment_id = ma.assignment_schoology_id
      WHERE ma.course_id = ? AND a.published = 1
        AND (
          a.num_assignees IS NULL OR a.num_assignees = 0
          OR EXISTS (
            SELECT 1 FROM assignment_assignees aa
            WHERE aa.assignment_id = a.id AND aa.schoology_uid = ?
          )
        )
      UNION
      SELECT ms.topic_id FROM mastery_scores ms
      JOIN assignments a ON a.schoology_assignment_id = ms.assignment_schoology_id
      WHERE a.course_id = ? AND a.published = 1
        AND (
          a.num_assignees IS NULL OR a.num_assignees = 0
          OR EXISTS (
            SELECT 1 FROM assignment_assignees aa
            WHERE aa.assignment_id = a.id AND aa.schoology_uid = ?
          )
        )
    )
    ORDER BY rc.external_id, mt.external_id
  `).all(courseId, studentUid, courseId, studentUid);

  const topicIds = topics.map(t => t.id);
  const scores = topicIds.length > 0 ? db.prepare(`
    SELECT ms.*, a.title AS assignment_title, a.due_date AS assignment_due_date
    FROM mastery_scores ms
    LEFT JOIN assignments a ON a.schoology_assignment_id = ms.assignment_schoology_id
    LEFT JOIN folders f ON f.schoology_folder_id = a.folder_id AND f.course_id = a.course_id
    LEFT JOIN folders fp ON fp.schoology_folder_id = f.parent_id AND fp.course_id = f.course_id AND f.parent_id != '0'
    WHERE ms.student_uid = ? AND a.course_id = ? AND a.published = 1
      AND (
        a.num_assignees IS NULL OR a.num_assignees = 0
        OR EXISTS (
          SELECT 1 FROM assignment_assignees aa
          WHERE aa.assignment_id = a.id AND aa.schoology_uid = ?
        )
      )
    ORDER BY
      CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN a.display_weight
           WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(fp.display_weight, 0)
           ELSE COALESCE(f.display_weight, a.display_weight) END ASC,
      CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN 0
           WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(f.display_weight, 0)
           ELSE a.display_weight END ASC,
      CASE WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN a.display_weight ELSE 0 END ASC,
      ms.assignment_schoology_id
  `).all(studentUid, courseId, studentUid) : [];

  // Authoritative topic↔assignment alignments from the Schoology alignments
  // endpoint. Falls back to inferring from scores if the table is empty
  // (e.g. before the first sync after this feature was added).
  // Order matches the scores query above so the summary table renders aligned
  // assignments (with or without scores) in the same gradebook order.
  const alignmentOrderBy = `
    CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN a.display_weight
         WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(fp.display_weight, 0)
         ELSE COALESCE(f.display_weight, a.display_weight) END ASC,
    CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN 0
         WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(f.display_weight, 0)
         ELSE a.display_weight END ASC,
    CASE WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN a.display_weight ELSE 0 END ASC,
    a.schoology_assignment_id
  `;
  let alignments = db.prepare(`
    SELECT ma.assignment_schoology_id, ma.topic_id,
           a.title AS assignment_title, a.due_date AS assignment_due_date
    FROM mastery_alignments ma
    JOIN assignments a ON a.schoology_assignment_id = ma.assignment_schoology_id
    LEFT JOIN folders f ON f.schoology_folder_id = a.folder_id AND f.course_id = a.course_id
    LEFT JOIN folders fp ON fp.schoology_folder_id = f.parent_id AND fp.course_id = f.course_id AND f.parent_id != '0'
    WHERE ma.course_id = ? AND a.published = 1
      AND (
        a.num_assignees IS NULL OR a.num_assignees = 0
        OR EXISTS (
          SELECT 1 FROM assignment_assignees aa
          WHERE aa.assignment_id = a.id AND aa.schoology_uid = ?
        )
      )
    ORDER BY ${alignmentOrderBy}
  `).all(courseId, studentUid);
  if (alignments.length === 0 && topicIds.length > 0) {
    alignments = db.prepare(`
      SELECT DISTINCT ms.assignment_schoology_id, ms.topic_id,
             a.title AS assignment_title, a.due_date AS assignment_due_date
      FROM mastery_scores ms
      JOIN assignments a ON a.schoology_assignment_id = ms.assignment_schoology_id
      LEFT JOIN folders f ON f.schoology_folder_id = a.folder_id AND f.course_id = a.course_id
      LEFT JOIN folders fp ON fp.schoology_folder_id = f.parent_id AND fp.course_id = f.course_id AND f.parent_id != '0'
      WHERE a.course_id = ? AND a.published = 1
        AND (
          a.num_assignees IS NULL OR a.num_assignees = 0
          OR EXISTS (
            SELECT 1 FROM assignment_assignees aa
            WHERE aa.assignment_id = a.id AND aa.schoology_uid = ?
          )
        )
      ORDER BY ${alignmentOrderBy}
    `).all(courseId, studentUid);
  }

  // Schoology's own per-(student, objective) rollups — the level shown in the
  // mastery gradebook UI for this student, per topic and per reporting category.
  const rollups = db.prepare(`
    SELECT objective_id, is_category, grade_percentage, grade_scaled_rounded, override_value
    FROM mastery_rollups
    WHERE student_uid = ? AND course_id = ?
  `).all(studentUid, courseId);

  res.json({ topics, scores, alignments, rollups });
});

// GET /api/mastery/:courseId/rubric — current scores for one student+assignment (pre-populate grading panel)
// Query params: studentUid, assignmentId
router.get('/:courseId/rubric', async (req, res) => {
  const { courseId } = req.params;
  const { studentUid, assignmentId } = req.query;

  if (!studentUid || !assignmentId) {
    return res.status(400).json({ error: 'studentUid and assignmentId are required' });
  }

  const db = getDb();
  const courseRow = db.prepare('SELECT schoology_section_id FROM courses WHERE id = ?').get(courseId);
  if (!courseRow) return res.status(404).json({ error: 'Course not found' });

  try {
    const scores = await getRubricScoresForStudent({
      sectionId: courseRow.schoology_section_id,
      studentUid,
      assignmentId,
    });
    res.json({ scores });
  } catch (err) {
    console.error('[mastery rubric] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mastery/:courseId/override — set or clear a teacher override
// for one (student, objective). Pass a level code (e.g. 'EX') or a raw
// gradeScaled string ('87.50'/'62.50'/...) to set, or omit both to clear.
// Objective can be a reporting-category UUID or a measurement-topic UUID.
router.post('/:courseId/override', async (req, res) => {
  const { courseId } = req.params;
  const { studentUid, objectiveId, level, gradeScaled: rawScaled } = req.body;

  if (!studentUid || !objectiveId) {
    return res.status(400).json({ error: 'studentUid and objectiveId are required' });
  }
  // Prefer a level (Prism owns the conversion); accept a raw gradeScaled transitionally.
  let gradeScaled = level != null ? levelToGradeScaled(level)
    : (rawScaled != null ? String(rawScaled) : null);
  // A provided level that didn't resolve means a typo/invalid code — reject it
  // explicitly so the route doesn't silently fall through to a clear operation.
  // (A clear is level==null && rawScaled==null → gradeScaled null → allowed below.)
  if (level != null && gradeScaled == null) {
    return res.status(400).json({ error: `Unknown level "${level}" — expected one of ${LEVELS.join(', ')}` });
  }
  const valid = gradeScaledValues();
  if (gradeScaled != null && !valid.has(gradeScaled)) {
    return res.status(400).json({ error: `Unknown level/grade — expected one of ${[...valid].join(', ')} or a level code` });
  }

  const db = getDb();
  const courseRow = db.prepare('SELECT schoology_section_id FROM courses WHERE id = ?').get(courseId);
  if (!courseRow) return res.status(404).json({ error: 'Course not found' });

  try {
    const result = await writeMasteryOverride({
      sectionId: courseRow.schoology_section_id,
      studentUid,
      objectiveId,
      gradeScaled,
    });

    // Mirror Schoology's response into mastery_rollups so the UI reflects
    // the override without requiring a full sync.
    const override = result?.data?.outcome_override || {};
    const overrideVal = override.grade_scaled_rounded != null ? Number(override.grade_scaled_rounded) : null;
    db.prepare(`
      INSERT INTO mastery_rollups (student_uid, objective_id, course_id, is_category, grade_percentage, grade_scaled_rounded, override_value, synced_at)
      VALUES (?, ?, ?, 0, NULL, NULL, ?, ?)
      ON CONFLICT(student_uid, objective_id, course_id) DO UPDATE SET
        override_value = excluded.override_value,
        synced_at = excluded.synced_at
    `).run(String(studentUid), String(objectiveId), Number(courseId), overrideVal, new Date().toISOString());

    res.json({ ok: true, override: overrideVal });
  } catch (err) {
    console.error('[mastery override] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mastery/:courseId/assignment/:assignmentId/sync — re-pull scores
// from Schoology for one assignment (faster than full course sync).
router.post('/:courseId/assignment/:assignmentId/sync', async (req, res) => {
  const { courseId, assignmentId } = req.params;
  try {
    const result = await syncMasteryForAssignment(courseId, assignmentId);
    snapshotAfterMasteryPull(getDb(), courseId);
    res.json(result);
  } catch (err) {
    console.error('[mastery assignment sync] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mastery/:courseId/write — write scores back to Schoology for one student+assignment
router.post('/:courseId/write', async (req, res) => {
  const { courseId } = req.params;
  const { enrollmentId, assignmentId, gradeInfo, gradingPeriodId, gradingCategoryId } = req.body;

  if (!enrollmentId || !assignmentId || !gradeInfo) {
    return res.status(400).json({ error: 'enrollmentId, assignmentId, and gradeInfo are required' });
  }

  const db = getDb();
  const courseRow = db.prepare('SELECT schoology_section_id FROM courses WHERE id = ?').get(courseId);
  if (!courseRow) return res.status(404).json({ error: 'Course not found' });

  try {
    const result = await writeMasteryScores({
      sectionId: courseRow.schoology_section_id,
      enrollmentId,
      assignmentId,
      gradeInfo,
      gradingPeriodId,
      gradingCategoryId,
    });

    // Mirror the just-confirmed Schoology state into our local mastery_scores
    // so the UI re-fetch shows the new values immediately.
    const studentRow = db.prepare(
      'SELECT s.id, s.schoology_uid FROM students s JOIN enrolments e ON e.student_id = s.id WHERE e.schoology_enrolment_id = ?'
    ).get(String(enrollmentId));
    // Round 5: capture the pair unstamped before mirroring, so levels a pull wrote meanwhile
    // (or a revision a running sync upserted) are never credited to this rubric save.
    const preAssignment = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(assignmentId));
    if (studentRow && preAssignment) captureBeforeSave(db, studentRow.id, preAssignment.id, 'mastery write');
    if (studentRow) {
      const upsert = db.prepare(`
        INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade, synced_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(student_uid, assignment_schoology_id, topic_id) DO UPDATE SET
          points = excluded.points,
          grade = excluded.grade,
          synced_at = excluded.synced_at
      `);
      const now = new Date().toISOString();
      for (const [topicId, info] of Object.entries(gradeInfo)) {
        const points = Number(info.grade);
        const letter = pointsToLevel(points);
        upsert.run(studentRow.schoology_uid, String(assignmentId), topicId, points, letter, now);
      }
    }
    // Best-effort: snapshot the pair's new visible feedback (a Prism save) so a rubric
    // regrade of an arrived resubmission is seen at once (Amendment B), then settle.
    const localAssignment = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(assignmentId));
    let resubmissionFields = null;
    if (localAssignment && studentRow) {
      try {
        captureFeedbackSnapshots(db, { assignmentId: localAssignment.id, studentId: studentRow.id, mode: 'save' });
        settleResubmissions(db, { assignmentId: localAssignment.id });
      } catch (err) {
        console.error('[mastery write] snapshot/settle failed:', err.message);
      }
      resubmissionFields = savedPairFields(db, studentRow.id, localAssignment.id, 'write');
    }

    res.json({ ...(result && typeof result === 'object' ? result : {}), resubmissionFields });
  } catch (err) {
    console.error('[mastery write] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mastery/:courseId/assignment/:assignmentId/submission-links[?refresh=1]
// On-demand links to each student's OneDrive copy of an lti_submission
// assignment — in progress or submitted (#120). Lists the teacher's OneDrive via
// the browser session (a few seconds; cached briefly) and keys files to students
// by the name leading each filename. → { status, links: { [uid]: { url, fileName,
// modifiedAt } } }; status 'ok' | 'not_lti' | 'no_folder' | 'no_session' |
// 'sso_failed' | 'error'. Anything but 'ok' carries no links.
router.get('/:courseId/assignment/:assignmentId/submission-links', async (req, res) => {
  const { courseId, assignmentId } = req.params;
  const db = getDb();
  const course = db.prepare('SELECT schoology_section_id FROM courses WHERE id = ?').get(courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const assignmentRow = db.prepare(
    'SELECT * FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?'
  ).get(assignmentId, courseId);
  if (!assignmentRow?.is_lti_submission) return res.json({ status: 'not_lti', links: {} });

  const result = await getAssignmentFiles({
    sectionId: course.schoology_section_id,
    assignmentId,
    refresh: req.query.refresh === '1',
  });
  if (result.status !== 'ok') return res.json({ status: result.status, links: {} });
  const roster = getRoster(db, courseId, assignmentRow);
  res.json({ status: 'ok', links: matchFilesToRoster(result.files, roster, result.origin) });
});

// GET /api/mastery/:courseId/assignment/:assignmentId
// Returns all students + their mastery scores + grade comments for one assignment.
// Used by AssessmentSummaryPage (whole-class rubric view).
router.get('/:courseId/assignment/:assignmentId', (req, res) => {
  const { courseId, assignmentId } = req.params;
  const db = getDb();

  // Aligned topics, roster (honoring #54 targeting), scores, and grade-meta are
  // shared with PrisMCP via server/services/assessmentContext.js. The topics
  // query falls back to scored topics when alignments haven't synced yet.
  const topics = getAlignedTopics(db, courseId, assignmentId);

  const assignmentRow = db.prepare(`
    SELECT * FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?
  `).get(assignmentId, courseId);
  // Rewrite the captured app.schoology.com host onto the school web domain (#76).
  if (assignmentRow) {
    assignmentRow.web_url = toSchoologyWebUrl(assignmentRow.web_url, getSchoologyConfig().webBaseUrl);
  }

  // getRoster hides students an individually-targeted assignment isn't assigned
  // to (#54); an undefined assignmentRow (unknown id) is treated as open-to-all.
  const students = getRoster(db, courseId, assignmentRow);
  const scoreMap = getScoreMap(db, assignmentId, topics.map(t => t.id));

  // Grade comments + exception + comment_status from the regular grades table.
  // Exception (1=Excused, 2=Incomplete, 3=Missing, 4=Late) deletes any
  // existing score in Schoology when set — surfaced on the assessment page so
  // the rubric can be locked while an exception is active.
  // comment_status drives the Display-to-student toggle (#34): integer 1 = visible,
  // null/missing = hidden. has_grade_row distinguishes "synced and got null"
  // from "never synced" so the client can arm auto-flip only for virgin rows.
  const gradeRows = getGradeMetaRows(db, assignmentId);
  // Arrived resubmissions (visible-feedback snapshots, Amendment B) — the ⚠ pill.
  const arrived = assignmentRow ? arrivedKeys(db, { assignmentId: assignmentRow.id }) : new Set();
  const commentMap = {};
  const exceptionMap = {};
  const commentStatusMap = {};
  const hasGradeRowMap = {};
  const resubmittedMap = {};
  const ltiStateMap = {};
  const submissionTypeMap = {};
  const lateMap = {};
  const draftMap = {};
  const submittedAtMap = {};
  const scoreValueMap = {};
  const revisionAtMap = {};
  for (const c of gradeRows) {
    scoreValueMap[c.schoology_uid] = c.score ?? null;
    commentMap[c.schoology_uid] = c.grade_comment || '';
    exceptionMap[c.schoology_uid] = c.exception ?? 0;
    commentStatusMap[c.schoology_uid] = c.comment_status ?? null;
    hasGradeRowMap[c.schoology_uid] = true;
    resubmittedMap[c.schoology_uid] = arrived.has(`${c.student_id}:${assignmentRow?.id}`);
    ltiStateMap[c.schoology_uid] = c.lti_submission_state ?? null;
    submissionTypeMap[c.schoology_uid] = c.submission_type ?? null;
    lateMap[c.schoology_uid] = c.late ?? 0;
    draftMap[c.schoology_uid] = c.draft ?? 0;
    submittedAtMap[c.schoology_uid] = c.submitted_at ?? 0;
    revisionAtMap[c.schoology_uid] = c.latest_revision_at ?? 0;
  }

  // Status lines (triage resubmissions, Amendment B) — the exact text Prism last
  // published in each student's comment, for the card's "resubmission received"
  // chip to find and replace (composeComment), keyed by local student id.
  const statusLineMap = {};
  if (assignmentRow) {
    for (const r of db.prepare('SELECT student_id, line, kind FROM status_lines WHERE assignment_id = ?').all(assignmentRow.id)) {
      statusLineMap[r.student_id] = { line: r.line, kind: r.kind };
    }
  }

  // Submission-scoped 'review needed' flags for this assignment (#20).
  // Prism-local; keyed by internal student_id. assignmentRow is undefined for
  // an unknown assignment id — no flags can exist in that case.
  const reviewFlagRows = assignmentRow
    ? db.prepare(`
        SELECT id, student_id, flag_reason FROM flags
        WHERE assignment_id = ? AND flag_type = 'review_needed' AND resolved = 0
      `).all(assignmentRow.id)
    : [];
  const reviewFlagMap = {};
  for (const r of reviewFlagRows) {
    reviewFlagMap[r.student_id] = { id: r.id, flag_reason: r.flag_reason };
  }

  // Triage resubmissions: open request (the card's pill) + derived state.
  const resubmissionMap = assignmentRow ? resubmissionByStudent(db, assignmentRow.id) : new Map();

  // An unaligned assignment on a Schoology scale Prism can grade (#41) is one
  // plain gradebook grade: ship the scale (levels best → worst) and each
  // student's current level, read from the stored score by cutoff.
  const scoreScale = scoreScaleFor(assignmentRow, topics.length);

  // Which class this is — the page names it (block + course) so sections of
  // the same course can't be confused.
  const course = db.prepare(
    'SELECT id, course_name, section_name, block_number, archived, excluded FROM courses WHERE id = ?'
  ).get(courseId) || null;

  res.json({
    course,
    assignment: assignmentRow || { schoology_assignment_id: assignmentId, title: 'Unknown Assignment' },
    topics,
    scoreScale,
    students: students.map(s => {
      const resubmission = resubmissionMap.get(s.id) || null;
      // Arrival date for the card's "resubmission received" chip: the snapshot's
      // own arrivedOn when known, else grades.latest_revision_at as a fallback —
      // only meaningful while the state is 'arrived'.
      const arrivedOn = resubmission?.state === 'arrived'
        ? (resubmission.arrivedOn || epochToLocalDate(revisionAtMap[s.schoology_uid]))
        : null;
      return {
        ...s,
        scores: scoreMap[s.schoology_uid] || {},
        grade_comment: commentMap[s.schoology_uid] || '',
        exception: exceptionMap[s.schoology_uid] || 0,
        comment_status: commentStatusMap[s.schoology_uid] ?? null,
        has_grade_row: hasGradeRowMap[s.schoology_uid] === true,
        review_flag: reviewFlagMap[s.id] || null,
        resubmit_flag: resubmission?.request ? { id: resubmission.request.id } : null,
        resubmission,
        resubmitted: resubmittedMap[s.schoology_uid] === true,
        status_line: statusLineMap[s.id] || null,
        arrived_on: arrivedOn,
        lti_submission_state: ltiStateMap[s.schoology_uid] ?? null,
        submission_type: submissionTypeMap[s.schoology_uid] ?? null,
        late: lateMap[s.schoology_uid] ?? 0,
        draft: draftMap[s.schoology_uid] ?? 0,
        submitted_at: submittedAtMap[s.schoology_uid] ?? 0,
        score: scoreValueMap[s.schoology_uid] ?? null,
        scale_level: scoreScale ? levelForScore(scoreScale, scoreValueMap[s.schoology_uid]) : null,
      };
    }),
  });
});

// The saved pair's post-save resubmission fields for the card (final review I2):
// what the server now decides — a hidden-only or unchanged save keeps an arrival
// Arrived. Best-effort like the capture before it: null means "unknown, keep what
// you show" (the client then leaves its resubmission fields alone).
function savedPairFields(db, studentId, assignmentId, where) {
  try {
    return pairResubmissionFields(db, studentId, assignmentId);
  } catch (err) {
    console.error(`[mastery ${where}] resubmission state read failed:`, err.message);
    return null;
  }
}

// The grade time (grades.submitted_at) to mirror after a SUCCESSFUL comment PUT.
// `fresh` was read before the PUT, so its timestamp is the previous grade time —
// mirroring it would leave a just-regraded resubmission "Arrived" (and its open
// request unsettled) until the next sync. Any teacher write (score, exception or
// comment) sets the REST timestamp, so the write itself is at least "now"; the
// next sync overwrites this with Schoology's real value.
function gradeTimeAfterWrite(fresh) {
  return Math.max(Number(fresh?.timestamp) || 0, Math.floor(Date.now() / 1000));
}

// Round 5: a Prism save credits only what the teacher wrote. A save route captures the
// pair UNSTAMPED before its own mirror — judging a revision a running sync upserted (with
// C1) and absorbing levels a pull wrote, with the true pre-save state — and mirrors the
// fresh Schoology score/exception it echoes (+ Schoology's grade time) unstamped unless
// the teacher wrote it in this save; only then does it mirror the teacher's own changes
// and capture stamped, so the save log's before→after is exactly the teacher's change.
// Best-effort, like every capture: never fails a save that succeeded.
function captureBeforeSave(db, studentId, assignmentId, label, echoAt = 0) {
  try {
    captureFeedbackSnapshots(db, { studentId, assignmentId, mode: 'save', stamp: false, echoAt });
  } catch (err) {
    console.error(`[${label}] pre-save snapshot failed:`, err.message);
  }
}
function echoFreshGrade(db, studentId, assignmentId, fresh, label) {
  if (!fresh) return;
  const at = Number(fresh.timestamp) || 0;
  const changed = db.prepare(`
    UPDATE grades SET score = ?, exception = ?, submitted_at = CASE WHEN ? > 0 THEN ? ELSE submitted_at END
    WHERE student_id = ? AND assignment_id = ?
  `).run(fresh.grade ?? null, fresh.exception ?? 0, at, at, studentId, assignmentId).changes;
  // echoAt: the change is logged as Schoology's, at Schoology's own grade time.
  if (changed) captureBeforeSave(db, studentId, assignmentId, label, at);
}

// POST /api/mastery/:courseId/write-comment — write grade comment back to Schoology
router.post('/:courseId/write-comment', async (req, res) => {
  const { courseId } = req.params;
  const { enrollmentId, assignmentId, commentStatus, points, statusLine, statusLineKind, rubricSaved } = req.body;
  let { comment } = req.body;

  if (!enrollmentId || !assignmentId) {
    return res.status(400).json({ error: 'enrollmentId and assignmentId are required' });
  }

  // Optional Prism status line (triage resubmissions, Amendment B — e.g. the card's
  // "Resubmission received DD/MM - regraded." chip). The client composes it into
  // `comment`; it must be the comment's first line so the next action can replace
  // the exact stored text. Stored in status_lines after a successful PUT.
  let line = '';
  const lineKind = statusLineKind ?? 'received';
  if (statusLine != null && statusLine !== '') {
    try {
      line = checkLine(statusLine);
    } catch (err) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    comment = withCheckedLine(comment, statusLine, line);   // a normalised line replaces the typed one
    const text = String(comment ?? '').replace(/\r\n/g, '\n');
    if (!(text === line || text.startsWith(`${line}\n`))) {
      return res.status(400).json({ error: 'statusLine must be the first line of comment' });
    }
    if (!STATUS_LINE_KINDS.includes(lineKind)) {
      return res.status(400).json({ error: `statusLineKind must be one of ${STATUS_LINE_KINDS.join(', ')}` });
    }
  }

  const db = getDb();
  const courseRow = db.prepare('SELECT schoology_section_id FROM courses WHERE id = ?').get(courseId);
  if (!courseRow) return res.status(404).json({ error: 'Course not found' });

  // Optional scale grade for an unaligned assignment (#41), written in the same
  // PUT. Only a level value of the assignment's own configured scale is allowed.
  const hasPoints = points != null;
  if (hasPoints) {
    const scaleError = scalePointsError(db, courseId, assignmentId, points);
    if (scaleError) return res.status(400).json({ error: scaleError });
  }

  // Public OAuth API uses integer 1 = visible, null = hidden.
  // Map the boolean from the client; default to 1 when omitted so existing
  // callers (none today) keep their current behaviour.
  const commentStatusInt = commentStatus === false ? null : 1;

  // PUT /sections/{id}/grades replaces the grade record. Sending a payload
  // without `grade` wipes the existing grade — and for rubric-aligned
  // assignments that wipe also clears the underlying mastery observations on
  // Schoology. Always echo back the current grade, exception, and
  // comment_status so the PUT acts as a comment-only update.
  //
  // We MUST read this fresh from Schoology, not from the local grades table.
  // The client sends rubric scores via writeMasteryScores immediately before
  // the comment write, so the local DB is stale by the time we get here, and
  // for brand-new students it may have no row at all. Echoing the stale/null
  // grade reproduced the original #46 wipe — see commit history.
  // A status line is replaced by its exact stored text: hold the per-pair lock
  // (shared with the triage actions) across read → PUT → store, so an overlapping
  // write can't compose from the same read and drop it.
  let release = null;
  if (line) {
    const pairStudent = db.prepare(`
      SELECT s.id FROM students s JOIN enrolments e ON e.student_id = s.id WHERE e.schoology_enrolment_id = ?
    `).get(String(enrollmentId));
    const pairAssignment = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(assignmentId));
    if (pairStudent && pairAssignment) {
      try {
        release = lockPair(pairStudent.id, pairAssignment.id);
      } catch (err) {
        return res.status(409).json({ error: err.message, code: err.code });
      }
    }
  }
  try {
    let fresh = null;
    let lookupFailed = false;
    try {
      const allGrades = await getSectionGrades(courseRow.schoology_section_id);
      fresh = allGrades.find(g =>
        String(g.assignment_id) === String(assignmentId) &&
        String(g.enrollment_id) === String(enrollmentId)
      ) || null;
    } catch (err) {
      lookupFailed = true;
      console.warn(`[mastery write-comment] fresh grade lookup failed: ${err.message}`);
    }
    // The PUT replaces the whole grade record: without the fresh record it would
    // drop the grade (and the rubric observations behind it) or an exception (e.g.
    // Late) it must echo — stop rather than write blind, comment-only saves included.
    // The read worked but holds no record for this pair while Prism knows a score or
    // exception for it: the lookup missed (ids drifted, partial response), it isn't a
    // never-graded student. A PUT without the echo would wipe that grade — same stop.
    if (!lookupFailed && !fresh) {
      const local = db.prepare(`
        SELECT g.score, g.exception FROM grades g
        JOIN enrolments e ON e.student_id = g.student_id AND e.schoology_enrolment_id = ?
        JOIN assignments a ON a.id = g.assignment_id AND a.schoology_assignment_id = ?
      `).get(String(enrollmentId), String(assignmentId));
      if (local && (local.score != null || (Number(local.exception) || 0) !== 0)) {
        console.warn(`[mastery write-comment] no Schoology record for ${enrollmentId}/${assignmentId} but Prism has a grade — not writing blind`);
        return res.status(502).json({ error: 'Schoology has no grade record Prism expected — sync, then try again' });
      }
    }
    if (lookupFailed) {
      return res.status(502).json({ error: 'Could not read the current Schoology grade — nothing was saved. Try again.' });
    }

    const payload = {
      assignment_id: String(assignmentId),
      enrollment_id: String(enrollmentId),
      comment: comment || '',
      comment_status: commentStatusInt,
    };
    if (fresh && fresh.grade != null) payload.grade = String(fresh.grade);
    if (hasPoints) payload.grade = String(Number(points));
    if (fresh && fresh.exception != null) payload.exception = fresh.exception;

    try {
      const result = await pushGradeComments(courseRow.schoology_section_id, [payload]);

      // apiPut never throws on an HTTP error, so the result must be checked —
      // a rejected write (or a 207 with a failed per-item response_code) must
      // never be mirrored as if Schoology had accepted it (grades, status_lines,
      // the snapshot capture, settling a request) or reported back as saved.
      if (!putSucceeded(result)) {
        console.error('[mastery write-comment] comment PUT rejected:', result?.status, JSON.stringify(result?.data)?.slice(0, 500));
        return res.status(502).json({ error: 'Schoology rejected the update — nothing was recorded in Prism' });
      }

      // Mirror to local DB. Use upsert so virgin records (no prior grade row)
      // also get cached locally — without this, the assessment page would
      // re-render with loadedDisplay=false and the toggle would appear unsaved
      // immediately after save.
      //
      // When the fresh Schoology lookup succeeded, also mirror score/exception/
      // submission timestamp. Grading on the assessment page reaches this route
      // (the comment write follows the rubric write), and `fresh` already holds
      // the just-entered grade — without mirroring it the local row keeps a
      // stale NULL score and the gradebook shows "Missing • Not Started" for
      // graded work until the next full sync (#60).
      const studentRow = db.prepare(`
        SELECT s.id FROM students s
        JOIN enrolments e ON e.student_id = s.id
        WHERE e.schoology_enrolment_id = ?
      `).get(String(enrollmentId));
      const assignmentRow = db.prepare(`
        SELECT id FROM assignments WHERE schoology_assignment_id = ?
      `).get(String(assignmentId));
      let resubmissionFields = null;
      if (studentRow && assignmentRow) {
        const now = new Date().toISOString();
        // Round 5: judge/absorb what other writers put in the DB, then the Schoology-side
        // part of the fresh echo — unless the teacher wrote the score in this save (a
        // rubric write just before this request, or a scale grade's points).
        captureBeforeSave(db, studentRow.id, assignmentRow.id, 'mastery write-comment');
        if (!(rubricSaved === true || hasPoints)) echoFreshGrade(db, studentRow.id, assignmentRow.id, fresh, 'mastery write-comment');
        if (fresh || hasPoints) {
          db.prepare(`
            INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception, submitted_at, grade_comment, comment_status, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(student_id, assignment_id) DO UPDATE SET
              score = excluded.score,
              exception = excluded.exception,
              submitted_at = excluded.submitted_at,
              grade_comment = excluded.grade_comment,
              comment_status = excluded.comment_status,
              synced_at = excluded.synced_at
          `).run(
            studentRow.id,
            assignmentRow.id,
            String(enrollmentId),
            hasPoints ? Number(points) : (fresh.grade ?? null),
            fresh?.exception ?? 0,
            gradeTimeAfterWrite(fresh),
            comment || '',
            commentStatusInt,
            now,
          );
        } else {
          // No Schoology record for the pair (a failed lookup returns 502 above) —
          // mirror the comment only. Touching score or submitted_at here would
          // wipe a real grade to NULL.
          db.prepare(`
            INSERT INTO grades (student_id, assignment_id, enrolment_id, grade_comment, comment_status, synced_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(student_id, assignment_id) DO UPDATE SET
              grade_comment = excluded.grade_comment,
              comment_status = excluded.comment_status,
              synced_at = excluded.synced_at
          `).run(
            studentRow.id,
            assignmentRow.id,
            String(enrollmentId),
            comment || '',
            commentStatusInt,
            now,
          );
        }
        // The published status line, stored before the snapshot so the fingerprint
        // ignores it. putSucceeded(result) already returned above otherwise. Not
        // tied to a triage record (source cleared), so no earlier action's undo
        // can strip it.
        if (line) {
          db.prepare(`
            INSERT INTO status_lines (student_id, assignment_id, line, kind, written_at, source_type, source_id)
            VALUES (?, ?, ?, ?, datetime('now'), NULL, NULL)
            ON CONFLICT (student_id, assignment_id) DO UPDATE SET line = excluded.line, kind = excluded.kind,
              written_at = excluded.written_at, source_type = NULL, source_id = NULL
          `).run(studentRow.id, assignmentRow.id, line, lineKind);
        }
        // Best-effort: a local grade just landed — snapshot its visible feedback
        // (Amendment B) and settle any request it fulfilled. Never fails the save.
        try {
          captureFeedbackSnapshots(db, { assignmentId: assignmentRow.id, studentId: studentRow.id, mode: 'save' });
          settleResubmissions(db, { assignmentId: assignmentRow.id });
        } catch (err) {
          console.error('[mastery write-comment] snapshot/settle failed:', err.message);
        }
        resubmissionFields = savedPairFields(db, studentRow.id, assignmentRow.id, 'write-comment');
      }

      res.json({ ...result, resubmissionFields });
    } catch (err) {
      console.error('[mastery write-comment] Error:', err);
      res.status(500).json({ error: err.message });
    }
  } finally {
    release?.();
  }
});

// POST /api/mastery/:courseId/send-all — batched bulk send (#51).
// Collapses the assessment-page "Send all" loop into one request: all rubric
// score writes go through a single browser session (writeMasteryScoresBatch),
// then a single fresh GET + one bulk comment PUT covers every comment. The
// batch is all-or-nothing — any failure aborts before anything is mirrored
// locally, and a retry is idempotent (observations replace; the comment PUT
// echoes each fresh grade so it never wipes a score, see #46).
router.post('/:courseId/send-all', async (req, res) => {
  const { courseId } = req.params;
  const { entries } = req.body;

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'entries[] is required' });
  }

  const db = getDb();
  const courseRow = db.prepare('SELECT schoology_section_id FROM courses WHERE id = ?').get(courseId);
  if (!courseRow) return res.status(404).json({ error: 'Course not found' });
  const sectionId = courseRow.schoology_section_id;

  const scoreEntries = entries.filter(e => e.scores);
  const commentEntries = entries.filter(e => e.comment);

  // Scale grades (#41) ride the comment PUT; validate them all before writing
  // anything, so one bad entry can't leave the batch half-sent.
  for (const e of entries.filter(e => e.grade)) {
    const scaleError = !e.comment
      ? 'a scale grade must be sent with its comment'
      : scalePointsError(db, courseId, e.assignmentId, e.grade.points);
    if (scaleError) return res.status(400).json({ error: scaleError, results: entries.map(x => ({ uid: x.uid, ok: false })) });
  }

  // Optional Prism status lines (triage resubmissions, Amendment B — the card's
  // "resubmission received" chip, carried through Send-all too). Same rule as
  // write-comment: validate every line before any write — a bad one must not
  // leave the batch half-sent.
  for (const e of commentEntries) {
    if (e.comment.statusLine == null || e.comment.statusLine === '') continue;
    let line;
    try {
      line = checkLine(e.comment.statusLine);
    } catch (err) {
      return res.status(400).json({ error: err.message, code: err.code, results: entries.map(x => ({ uid: x.uid, ok: false })) });
    }
    e.comment.comment = withCheckedLine(e.comment.comment, e.comment.statusLine, line);
    const text = String(e.comment.comment ?? '').replace(/\r\n/g, '\n');
    if (!(text === line || text.startsWith(`${line}\n`))) {
      return res.status(400).json({ error: 'statusLine must be the first line of comment', results: entries.map(x => ({ uid: x.uid, ok: false })) });
    }
    const kind = e.comment.statusLineKind ?? 'received';
    if (!STATUS_LINE_KINDS.includes(kind)) {
      return res.status(400).json({ error: `statusLineKind must be one of ${STATUS_LINE_KINDS.join(', ')}`, results: entries.map(x => ({ uid: x.uid, ok: false })) });
    }
  }

  // Per-pair lock (shared with write-comment/triage) for every entry carrying a
  // status line: an overlapping write for the same pair must not compose from
  // the same stale read and drop one line. Acquired before any write; if any
  // pair is already busy, release what was taken and fail the whole batch
  // before touching Schoology — the rest is released in the finally below.
  const releases = [];
  for (const e of commentEntries) {
    if (!e.comment.statusLine) continue;
    const pairStudent = db.prepare(`
      SELECT s.id FROM students s JOIN enrolments en ON en.student_id = s.id WHERE en.schoology_enrolment_id = ?
    `).get(String(e.enrollmentId));
    const pairAssignment = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(e.assignmentId));
    if (!pairStudent || !pairAssignment) continue;
    try {
      releases.push(lockPair(pairStudent.id, pairAssignment.id));
    } catch (err) {
      for (const release of releases) release();
      return res.status(409).json({ error: err.message, code: err.code, results: entries.map(x => ({ uid: x.uid, ok: false })) });
    }
  }

  // Once step 1 has started, a later failure can leave rubric scores already written
  // to Schoology (the batch is not transactional there) — say so, so the teacher syncs.
  const SCORES_MAY_BE_WRITTEN = 'nothing was recorded in Prism; rubric scores may already be in Schoology — sync, then check';
  const failMessage = (msg) => (scoreEntries.length > 0 ? `${msg} — ${SCORES_MAY_BE_WRITTEN}` : msg);
  try {
    // 1. All rubric scores in one browser session.
    if (scoreEntries.length > 0) {
      await writeMasteryScoresBatch({
        sectionId,
        entries: scoreEntries.map(e => ({
          enrollmentId: e.enrollmentId,
          assignmentId: e.assignmentId,
          gradeInfo: e.scores.gradeInfo,
          gradingPeriodId: e.scores.gradingPeriodId,
          gradingCategoryId: e.scores.gradingCategoryId,
        })),
      });
    }

    // 2. One fresh read of the section grades, reflecting the writes above, so
    //    each comment PUT can echo the current grade/exception (#46 safety).
    let freshByKey = new Map();
    if (commentEntries.length > 0) {
      const allGrades = await getSectionGrades(sectionId);
      for (const g of allGrades) {
        freshByKey.set(`${g.assignment_id}::${g.enrollment_id}`, g);
      }

      // Never write blind: an entry with no Schoology record while Prism holds a
      // score or exception for that pair means the read missed it (a PUT without
      // the echo would wipe the grade). Fail the whole batch before any PUT or
      // local write. A genuinely never-graded pair proceeds comment-only.
      const localGrade = db.prepare(`
        SELECT g.score, g.exception FROM grades g
        JOIN enrolments en ON en.student_id = g.student_id AND en.schoology_enrolment_id = ?
        JOIN assignments a ON a.id = g.assignment_id AND a.schoology_assignment_id = ?
      `);
      const missed = commentEntries.filter((e) => {
        if (freshByKey.has(`${e.assignmentId}::${e.enrollmentId}`)) return false;
        const local = localGrade.get(String(e.enrollmentId), String(e.assignmentId));
        return Boolean(local && (local.score != null || (Number(local.exception) || 0) !== 0));
      });
      if (missed.length > 0) {
        console.warn(`[mastery send-all] no Schoology record for ${missed.map((e) => `${e.enrollmentId}/${e.assignmentId}`).join(', ')} but Prism has a grade — batch not sent`);
        return res.status(502).json({
          error: scoreEntries.length > 0
            ? `Schoology has no grade record Prism expected — ${SCORES_MAY_BE_WRITTEN}`
            : 'Schoology has no grade record Prism expected — sync, then try again',
          results: entries.map((x) => ({ uid: x.uid, ok: false })),
        });
      }

      const payloads = commentEntries.map(e => {
        const fresh = freshByKey.get(`${e.assignmentId}::${e.enrollmentId}`) || null;
        const payload = {
          assignment_id: String(e.assignmentId),
          enrollment_id: String(e.enrollmentId),
          comment: e.comment.comment || '',
          comment_status: e.comment.commentStatus === false ? null : 1,
        };
        if (fresh && fresh.grade != null) payload.grade = String(fresh.grade);
        if (e.grade) payload.grade = String(Number(e.grade.points));
        if (fresh && fresh.exception != null) payload.exception = fresh.exception;
        return payload;
      });

      // apiPut never throws on an HTTP error, so the result must be checked —
      // a discarded failure here would mirror a comment Schoology never
      // accepted (the pre-existing send-all gap putSucceeded closes elsewhere).
      const result = await pushGradeComments(sectionId, payloads);
      if (!putSucceeded(result)) {
        console.error('[mastery send-all] comment PUT rejected:', result?.status, JSON.stringify(result?.data)?.slice(0, 500));
        return res.status(502).json({
          error: scoreEntries.length > 0
            ? `Schoology rejected the comment update — ${SCORES_MAY_BE_WRITTEN}`
            : 'Schoology rejected the update — nothing was recorded in Prism',
          results: entries.map((x) => ({ uid: x.uid, ok: false })),
        });
      }
    }

    // 3. Mirror to the local DB — only now that every write above succeeded.
    //    Scores → mastery_scores (like the single /write); comments → grades
    //    with the echoed fresh score/exception/timestamp (like write-comment),
    //    so the gradebook reflects the save without a full re-sync (#60).
    const now = new Date().toISOString();
    // assignment id → student ids saved (snapshot + settle below); uid → the saved pair.
    const touched = new Map();
    const pairByUid = new Map();
    const touch = (assignmentId, studentId, uid) => {
      if (!touched.has(assignmentId)) touched.set(assignmentId, new Set());
      touched.get(assignmentId).add(studentId);
      pairByUid.set(uid, { studentId, assignmentId });
    };
    const upsertScore = db.prepare(`
      INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_uid, assignment_schoology_id, topic_id) DO UPDATE SET
        points = excluded.points, grade = excluded.grade, synced_at = excluded.synced_at
    `);
    const upsertGrade = db.prepare(`
      INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception, submitted_at, grade_comment, comment_status, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id, assignment_id) DO UPDATE SET
        score = excluded.score, exception = excluded.exception, submitted_at = excluded.submitted_at,
        grade_comment = excluded.grade_comment, comment_status = excluded.comment_status, synced_at = excluded.synced_at
    `);
    // Published status line (triage resubmissions, Amendment B card chip), same
    // upsert as write-comment: not tied to a triage record (source cleared), so
    // no earlier action's undo can strip it.
    const upsertStatusLine = db.prepare(`
      INSERT INTO status_lines (student_id, assignment_id, line, kind, written_at, source_type, source_id)
      VALUES (?, ?, ?, ?, datetime('now'), NULL, NULL)
      ON CONFLICT (student_id, assignment_id) DO UPDATE SET line = excluded.line, kind = excluded.kind,
        written_at = excluded.written_at, source_type = NULL, source_id = NULL
    `);

    // Round 5: every pair this batch saves is captured unstamped before any mirror, and a
    // comment entry's fresh Schoology score/exception is echoed unstamped unless the
    // teacher wrote it in this batch (the entry's rubric scores, or a scale grade).
    const pairOf = (e) => {
      const st = db.prepare('SELECT s.id FROM students s JOIN enrolments en ON en.student_id = s.id WHERE en.schoology_enrolment_id = ?').get(String(e.enrollmentId));
      const as = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(e.assignmentId));
      return st && as ? { studentId: st.id, assignmentId: as.id } : null;
    };
    const preCaptured = new Set();
    for (const e of [...scoreEntries, ...commentEntries]) {
      const p = pairOf(e);
      if (!p || preCaptured.has(`${p.studentId}:${p.assignmentId}`)) continue;
      preCaptured.add(`${p.studentId}:${p.assignmentId}`);
      captureBeforeSave(db, p.studentId, p.assignmentId, 'mastery send-all');
    }
    for (const e of commentEntries) {
      if (e.scores || e.grade) continue;
      const p = pairOf(e);
      if (p) echoFreshGrade(db, p.studentId, p.assignmentId, freshByKey.get(`${e.assignmentId}::${e.enrollmentId}`) || null, 'mastery send-all');
    }

    for (const e of scoreEntries) {
      const studentRow = db.prepare(
        'SELECT s.id, s.schoology_uid FROM students s JOIN enrolments en ON en.student_id = s.id WHERE en.schoology_enrolment_id = ?'
      ).get(String(e.enrollmentId));
      if (!studentRow) continue;
      for (const [topicId, info] of Object.entries(e.scores.gradeInfo)) {
        const points = Number(info.grade);
        upsertScore.run(studentRow.schoology_uid, String(e.assignmentId), topicId, points, pointsToLevel(points), now);
      }
      const scoredAssignment = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(e.assignmentId));
      if (scoredAssignment) touch(scoredAssignment.id, studentRow.id, e.uid);
    }

    for (const e of commentEntries) {
      const studentRow = db.prepare(
        'SELECT s.id FROM students s JOIN enrolments en ON en.student_id = s.id WHERE en.schoology_enrolment_id = ?'
      ).get(String(e.enrollmentId));
      const assignmentRow = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(e.assignmentId));
      if (!studentRow || !assignmentRow) continue;
      const fresh = freshByKey.get(`${e.assignmentId}::${e.enrollmentId}`) || null;
      const commentStatusInt = e.comment.commentStatus === false ? null : 1;
      upsertGrade.run(
        studentRow.id, assignmentRow.id, String(e.enrollmentId),
        e.grade ? Number(e.grade.points) : (fresh ? (fresh.grade ?? null) : null),
        fresh ? (fresh.exception ?? 0) : 0,
        gradeTimeAfterWrite(fresh),
        e.comment.comment || '', commentStatusInt, now,
      );
      if (e.comment.statusLine) {
        // The trimmed/validated text (checkLine), not the raw payload field —
        // matches write-comment, which stores `line` from checkLine too.
        upsertStatusLine.run(studentRow.id, assignmentRow.id, checkLine(e.comment.statusLine), e.comment.statusLineKind ?? 'received');
      }
      touch(assignmentRow.id, studentRow.id, e.uid);
    }
    // Best-effort: local grades just landed — snapshot their visible feedback
    // (Amendment B) and settle requests they fulfilled, once per distinct
    // assignment touched (not per entry). Never fails a save that succeeded.
    for (const [assignmentId, studentIds] of touched) {
      try {
        for (const studentId of studentIds) captureFeedbackSnapshots(db, { assignmentId, studentId, mode: 'save' });
        settleResubmissions(db, { assignmentId });
      } catch (err) {
        console.error('[mastery send-all] snapshot/settle failed:', err.message);
      }
    }

    // Each saved pair's post-save resubmission state (final review I2).
    res.json({
      results: entries.map((e) => {
        const p = pairByUid.get(e.uid);
        return { uid: e.uid, ok: true, resubmissionFields: p ? savedPairFields(db, p.studentId, p.assignmentId, 'send-all') : null };
      }),
    });
  } catch (err) {
    console.error('[mastery send-all] Error:', err);
    res.status(502).json({ error: failMessage(err.message), results: entries.map(e => ({ uid: e.uid, ok: false })) });
  } finally {
    for (const release of releases) release();
  }
});

export default router;
