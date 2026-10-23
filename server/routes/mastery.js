import { Router } from 'express';
import { getDb } from '../db/index.js';
import { hasMasterySession, writeMasteryScores, writeMasteryScoresBatch, writeMasteryOverride, getMasteryForCourse, getRubricScoresForStudent } from '../services/masterySync.js';
import { pushGradeUpdates, getSectionGrades } from '../services/schoology.js';
import { settleResubmissions, pairResubmissionFields } from '../services/resubmissions.js';
import { captureFeedbackSnapshots } from '../services/feedbackSnapshots.js';
import { refreshCourseMastery } from '../services/masteryRefresh.js';
import { enqueue } from '../services/syncQueue.js';
import { STATUS_LINE_KINDS, putSucceeded, checkLine, lockPair, withCheckedLine, removeStatusLine } from '../services/statusLinePublisher.js';
import { retireCopy } from '../services/gradeFlags.js';
import { FLAG_NAMES, isFinalFlag, isMarker } from '../lib/flags.js';
import { getFeedbackRows, rowLevelsError, saveRowLevels } from '../services/feedbackRows.js';
import { getAlignedTopics, getRoster, scoreScaleFor } from '../services/assessmentContext.js';
import { getSchoologyConfig, getScoreScales } from '../middleware/featureGate.js';
import { findScoreScale, isScalePoints } from '../lib/scoreScales.js';
import { levelToGradeScaled, gradeScaledValues, pointsToLevel, LEVELS } from '../lib/proficiencyScale.js';
import { getAssignmentFiles } from '../services/oneDriveLinks.js';
import { matchFilesToRoster } from '../lib/oneDriveSubmissions.js';
import { getLtiSubmissionApp, getSubmittedDocuments } from '../services/ltiSubmissionApps.js';
import { driveLinksForSubmitted, GOOGLE_DRIVE, ONEDRIVE, OTHER_APP } from '../lib/ltiSubmissionApp.js';
import { sessionStatus } from '../services/schoologySession.js';
import { buildAssessmentView, courseSyncedAt } from '../services/assessmentView.js';

const router = Router();

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

// Sign-in to Schoology is /api/schoology-login (routes/schoologyLogin.js, any device).

// GET /api/mastery/login-status[?refresh=1][?check=0] → { loggedIn (a saved session
// file exists), live: 'connected' | 'expired' | 'none' | null, checkedAt, message? }.
// live = one cheap authenticated page load with the saved session, cached ~10 min
// (server/services/schoologySession.js); refresh=1 forces a re-check; check=0 never
// reaches Schoology (live = the cached answer, or null). Best-effort, never fails.
router.get('/login-status', async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const check = req.query.check !== '0';
  res.json(await sessionStatus({ refresh, check, hasSession: hasMasterySession }));
});

// POST /api/mastery/sync/:courseId — read the course's mastery from Schoology now (masteryRefresh,
// force). No page button since #58: the course page's Sync Course runs a full sync (POST /api/sync). A read already running for the course is shared, not refused.
// → the sync counts plus syncedAt; 500 { error } when the read fails.
router.post('/sync/:courseId', async (req, res) => {
  const { courseId } = req.params;
  const db = getDb();
  const syncId = db.prepare(`INSERT INTO sync_log (sync_type, status, started_at) VALUES ('mastery', 'running', ?)`)
    .run(new Date().toISOString()).lastInsertRowid;
  try {
    const r = await refreshCourseMastery(courseId, { force: true });
    if (r.error) {
      console.error('[mastery sync] Error:', r.error);
      db.prepare(`UPDATE sync_log SET status = 'error', error_message = ?, completed_at = ? WHERE id = ?`).run(r.error, new Date().toISOString(), syncId);
      return res.status(500).json({ error: r.error });
    }
    db.prepare(`UPDATE sync_log SET status = 'completed', records_synced = ?, completed_at = ? WHERE id = ?`)
      .run(r.result?.scoresCount || 0, new Date().toISOString(), syncId);
    res.json({ ...r.result, syncedAt: r.syncedAt });
  } catch (err) {
    db.prepare(`UPDATE sync_log SET status = 'error', error_message = ?, completed_at = ? WHERE id = ?`).run(err.message, new Date().toISOString(), syncId);
    res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({ error: err.message });
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
      WHERE ma.course_id = ? AND a.published = 1 AND a.removed_at IS NULL
    `).all(courseId);
    res.json({ ...data, rollups, alignments, masterySyncedAt: courseSyncedAt(db, courseId) });
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
      WHERE ma.course_id = ? AND a.published = 1 AND a.removed_at IS NULL
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
      WHERE a.course_id = ? AND a.published = 1 AND a.removed_at IS NULL
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
    WHERE ms.student_uid = ? AND a.course_id = ? AND a.published = 1 AND a.removed_at IS NULL
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
    WHERE ma.course_id = ? AND a.published = 1 AND a.removed_at IS NULL
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
      WHERE a.course_id = ? AND a.published = 1 AND a.removed_at IS NULL
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

  res.json({ topics, scores, alignments, rollups, masterySyncedAt: courseSyncedAt(db, courseId) });
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
    return res.status(400).json({ error: `Unknown level "${level}": expected one of ${LEVELS.join(', ')}` });
  }
  const valid = gradeScaledValues();
  if (gradeScaled != null && !valid.has(gradeScaled)) {
    return res.status(400).json({ error: `Unknown level/grade: expected one of ${[...valid].join(', ')} or a level code` });
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

// POST /api/mastery/:courseId/assignment/:assignmentId/sync — the assessment page's Sync Assignment:
// a forced task run in the sync queue (taskSyncRun.js: the task's details, submissions, grades and
// comment threads, then its mastery). → { runId, state, joined }; the page follows the run.
router.post('/:courseId/assignment/:assignmentId/sync', (req, res) => {
  const { courseId, assignmentId } = req.params;
  const known = getDb().prepare('SELECT 1 FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?').get(String(assignmentId), Number(courseId));
  if (!known) return res.status(404).json({ error: `Assignment ${assignmentId} not found in course ${courseId}` });
  res.json(enqueue({ kind: 'task', courseId: Number(courseId), assignmentId: String(assignmentId), trigger: 'button', force: true }));
});

// A level write clears Exempt, Incomplete, Absent and Late in Schoology (probed 21-22 Oct 2026;
// not probed under Missing), so levels are never written over a final flag (Exempt, Missing;
// #40): the card keeps those locked, and a stale card (Prism
// holding a marker that is now final in Schoology) must not wipe one. Checks Prism's row for each
// pair, then (fresh: true) one read of the section's grades for all of them, before any write.
// → null (go ahead) or { status, error, code } (nothing was written).
async function finalFlagStop(db, sectionId, pairs, { fresh = true } = {}) {
  if (pairs.length === 0) return null;
  const local = db.prepare(`
    SELECT g.exception FROM grades g
    JOIN enrolments en ON en.student_id = g.student_id AND en.schoology_enrolment_id = ?
    JOIN assignments a ON a.id = g.assignment_id AND a.schoology_assignment_id = ?
  `);
  for (const p of pairs) {
    const code = local.get(String(p.enrollmentId), String(p.assignmentId))?.exception;
    if (isFinalFlag(code)) return { status: 409, error: flaggedError(code), code: 'FLAGGED' };
  }
  if (!fresh) return null;
  let all;
  try {
    all = await getSectionGrades(sectionId);
  } catch (err) {
    console.warn(`[mastery] flag check read failed: ${err.message}`);
    return { status: 502, error: 'Could not read the current Schoology grade: nothing was saved. Try again.' };
  }
  const byKey = new Map((all || []).map((g) => [`${g.assignment_id}::${g.enrollment_id}`, g]));
  for (const p of pairs) {
    const code = byKey.get(`${p.assignmentId}::${p.enrollmentId}`)?.exception;
    if (isFinalFlag(code)) return { status: 409, error: flaggedError(code), code: 'FLAGGED' };
  }
  return null;
}

// The /observations write REPLACES a pair's whole set of topic levels in Schoology (postObservation),
// and the card leaves a removed level out of gradeInfo. So after a confirmed write the pair's local
// rows for topics NOT in gradeInfo are stale: drop them, or Prism shows a level Schoology no longer
// holds until the next sync (#176 live check). An empty gradeInfo clears the pair.
function dropOmittedLevels(db, studentUid, assignmentId, gradeInfo) {
  const kept = Object.keys(gradeInfo);
  db.prepare(`
    DELETE FROM mastery_scores
    WHERE student_uid = ? AND assignment_schoology_id = ?
      AND topic_id NOT IN (${kept.map(() => '?').join(',')})
  `).run(studentUid, String(assignmentId), ...kept);
}

// Mirror a confirmed /observations write into one pair's local mastery_scores: upsert the written
// levels, then drop the omitted ones, in ONE transaction so a throw leaves the old mirror, never
// half of the new one. Only this student's rows for this assignment are touched.
function mirrorPairLevels(db, studentUid, assignmentId, gradeInfo, now) {
  const upsert = db.prepare(`
    INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade, synced_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_uid, assignment_schoology_id, topic_id) DO UPDATE SET
      points = excluded.points,
      grade = excluded.grade,
      synced_at = excluded.synced_at
  `);
  db.transaction(() => {
    for (const [topicId, info] of Object.entries(gradeInfo)) {
      const points = Number(info.grade);
      upsert.run(studentUid, String(assignmentId), topicId, points, pointsToLevel(points), now);
    }
    dropOmittedLevels(db, studentUid, assignmentId, gradeInfo);
  })();
}

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

  const stop = await finalFlagStop(db, courseRow.schoology_section_id, [{ enrollmentId, assignmentId }]);
  if (stop) return res.status(stop.status).json({ error: stop.error, ...(stop.code ? { code: stop.code } : {}) });

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
    let preAssignment = null;
    try {
      preAssignment = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(assignmentId));
    } catch (err) {
      console.error('[mastery write] pre-save lookup failed:', err.message);   // Schoology already accepted the write
    }
    if (studentRow && preAssignment) captureBeforeSave(db, studentRow.id, preAssignment.id, 'mastery write');
    if (studentRow) mirrorPairLevels(db, studentRow.schoology_uid, assignmentId, gradeInfo, new Date().toISOString());
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
      // A newer published grade makes a waiting saved copy stale (#40): it is no longer offered.
      try { retireCopy(db, { studentId: studentRow.id, assignmentId: localAssignment.id }); } catch (err) {
        console.error('[mastery write] could not retire the saved copy:', err.message);
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
// On-demand links to each student's own copy of an lti_submission assignment.
// The app behind the task is read from the assignment page, never assumed (#142):
//  - Google Drive: Schoology's own "open in a new tab" launch URL per student,
//    for the students in the grader's submitted list (two plain-HTTP reads; the
//    teacher's browser runs the launch and lands on the Drive file).
//  - OneDrive (or the app couldn't be read): the teacher's OneDrive listing via
//    the browser session, in progress or submitted, keyed by the name leading
//    each filename (#120; a few seconds, cached briefly).
// → { status, provider, links: { [uid]: { url, provider, modifiedAt? | submittedAt? } } };
// status 'ok' | 'not_lti' | 'unsupported_app' | 'no_folder' | 'no_session' |
// 'session_expired' | 'sso_failed' | 'error'. Anything but 'ok' carries no links.
router.get('/:courseId/assignment/:assignmentId/submission-links', async (req, res) => {
  const { courseId, assignmentId } = req.params;
  const db = getDb();
  const course = db.prepare('SELECT schoology_section_id FROM courses WHERE id = ?').get(courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const assignmentRow = db.prepare(
    'SELECT * FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?'
  ).get(assignmentId, courseId);
  if (!assignmentRow?.is_lti_submission) return res.json({ status: 'not_lti', links: {} });
  const refresh = req.query.refresh === '1';

  const app = await getLtiSubmissionApp({ assignmentId, refresh });
  if (app.status === 'ok' && app.provider === GOOGLE_DRIVE) {
    const submitted = await getSubmittedDocuments({ assignmentId, refresh });
    if (submitted.status !== 'ok') return res.json({ status: submitted.status, provider: GOOGLE_DRIVE, links: {} });
    const roster = getRoster(db, courseId, assignmentRow);
    const links = driveLinksForSubmitted(submitted.entries, roster, getSchoologyConfig().webBaseUrl, app.launchUrl);
    return res.json({ status: 'ok', provider: GOOGLE_DRIVE, links });
  }
  if (app.status === 'ok' && app.provider === OTHER_APP) {
    return res.json({ status: 'unsupported_app', provider: OTHER_APP, links: {} });
  }

  const result = await getAssignmentFiles({
    sectionId: course.schoology_section_id,
    assignmentId,
    refresh,
  });
  if (result.status !== 'ok') return res.json({ status: result.status, provider: ONEDRIVE, links: {} });
  const roster = getRoster(db, courseId, assignmentRow);
  const links = {};
  for (const [uid, link] of Object.entries(matchFilesToRoster(result.files, roster, result.origin))) {
    links[uid] = { ...link, provider: ONEDRIVE };
  }
  res.json({ status: 'ok', provider: ONEDRIVE, links });
});

// GET /api/mastery/:courseId/assignment/:assignmentId
// Returns all students + their mastery scores + grade comments for one assignment.
// Used by AssessmentSummaryPage (whole-class rubric view). The body is buildAssessmentView
// (services/assessmentView.js), which the student page's grade cards share (#176).
router.get('/:courseId/assignment/:assignmentId', (req, res) => {
  const { courseId, assignmentId } = req.params;
  res.json(buildAssessmentView(getDb(), { courseId, assignmentId }));
});

// The feedback rows (spec 2026-10-13) of an assignment in this course, or [].
function feedbackRowsFor(db, courseId, assignmentId) {
  const row = db.prepare('SELECT * FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?')
    .get(String(assignmentId), courseId);
  if (!row) return [];
  const scale = scoreScaleFor(row, getAlignedTopics(db, row.course_id, row.schoology_assignment_id).length);
  return getFeedbackRows(db, row.schoology_assignment_id, scale)?.rows ?? [];
}

// A row save that failed after Schoology accepted the grade (spec 2026-10-13 §5).
const ROWS_NOT_SAVED = 'Published to Schoology, but the feedback rows were not saved in Prism: save again';
// Levels published over a marker, but Prism could not read Schoology back to settle it (#177).
const SETTLE_NOT_READ = 'Levels published to Schoology, but Prism could not read the flag again, so its line may still be in the comment. Sync, then check the comment.';

// The student's schoology_uid for an enrolment id, or null.
function uidForEnrolment(db, enrollmentId) {
  return db.prepare(`SELECT s.schoology_uid FROM students s JOIN enrolments e ON e.student_id = s.id
    WHERE e.schoology_enrolment_id = ?`).get(String(enrollmentId))?.schoology_uid ?? null;
}

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
  let changed = 0;
  try {
    changed = db.prepare(`
      UPDATE grades SET score = ?, exception = ?, submitted_at = CASE WHEN ? > 0 THEN ? ELSE submitted_at END
      WHERE student_id = ? AND assignment_id = ?
    `).run(fresh.grade ?? null, fresh.exception ?? 0, at, at, studentId, assignmentId).changes;
  } catch (err) {
    // Schoology already accepted the write: never turn it into a 5xx here.
    console.error(`[${label}] fresh-grade echo failed:`, err.message);
    return;
  }
  // echoAt: the change is logged as Schoology's, at Schoology's own grade time.
  if (changed) captureBeforeSave(db, studentId, assignmentId, label, at);
}

// Grading over a flag (#40). Exempt and Missing are final: the card keeps their rubric locked, and a
// score written over one is refused (FLAGGED, 409). Late, Incomplete and Absent are markers the
// teacher grades straight through: a score sent with a flag is removed (verified), so a score
// written over a marker sends exception 0; the mastery (rubric) write clears the flag in Schoology
// by itself (verified), so the comment write after it reads exception 0 fresh.
const flaggedError = (code) => `This task is flagged ${FLAG_NAMES[Number(code)]} in Schoology: clear the flag before grading it. Nothing was written.`;
// Was this save a grade over a marker? A score sent over a fresh marker, or a rubric save (its
// mastery write already cleared the flag, so fresh reads 0) over the marker Prism held locally.
function gradedOverMarker({ wroteScore, wroteRubric, freshException, localException }) {
  const fresh = Number(freshException) || 0;
  return (wroteScore && isMarker(fresh)) || (wroteRubric && fresh === 0 && isMarker(localException));
}
// After a grade over a marker is published and mirrored: the grade the marker removed is no longer
// the one to restore (retire the saved copy), and the marker's status line comes off by its exact
// stored text (removeStatusLine: a fresh read, then a comment-only PUT echoing the new grade). A
// line of another kind stays. Best-effort: the grade is already published, so a failure here is
// reported (lineError), never turned into a failed save.
// → { exception: 0, comment?, status_line?: null, lineError? } for the card's in-place patch.
async function settleMarker(db, studentId, assignmentId, label) {
  const out = { exception: 0 };
  try {
    retireCopy(db, { studentId, assignmentId });
  } catch (err) {
    console.error(`[${label}] could not retire the saved copy:`, err.message);
  }
  const stored = db.prepare('SELECT kind FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId);
  if (stored?.kind !== 'flag') return out;
  try {
    const removed = await removeStatusLine(db, { studentId, assignmentId });
    return { ...out, comment: removed.comment, status_line: null };
  } catch (err) {
    console.error(`[${label}] the flag's status line was not removed:`, err.message);
    return { ...out, lineError: `Published, but the flag's line was not removed from the comment: ${err.message}` };
  }
}

// A rubric-only save over a marker (write-comment with settleMarker: true, #40). The rubric
// (mastery) write just before it cleared the flag in Schoology by itself; this writes no comment
// of its own (the card's copy may be stale: a line PrisMCP published, or an edit in Schoology),
// only mirrors the fresh score and exception 0 and runs settleMarker, whose line removal composes
// from the fresh comment. Nothing happens unless the fresh exception is 0 and Prism held a marker.
async function settleMarkerOnly(req, res) {
  const { courseId } = req.params;
  const { enrollmentId, assignmentId } = req.body;
  const db = getDb();
  const courseRow = db.prepare('SELECT schoology_section_id FROM courses WHERE id = ?').get(courseId);
  if (!courseRow) return res.status(404).json({ error: 'Course not found' });
  const studentRow = db.prepare('SELECT s.id FROM students s JOIN enrolments e ON e.student_id = s.id WHERE e.schoology_enrolment_id = ?').get(String(enrollmentId));
  const assignmentRow = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(assignmentId));
  if (!studentRow || !assignmentRow) return res.status(404).json({ error: 'No such student or assignment in Prism' });
  let release;
  try {
    release = lockPair(studentRow.id, assignmentRow.id);
  } catch (err) {
    return res.status(409).json({ error: err.message, code: err.code });
  }
  try {
    const localException = db.prepare('SELECT exception FROM grades WHERE student_id = ? AND assignment_id = ?').get(studentRow.id, assignmentRow.id)?.exception ?? 0;
    let fresh;
    try {
      const all = await getSectionGrades(courseRow.schoology_section_id);
      fresh = (all || []).find((g) => String(g.assignment_id) === String(assignmentId) && String(g.enrollment_id) === String(enrollmentId)) || null;
    } catch (err) {
      console.warn(`[mastery settle] fresh grade lookup failed: ${err.message}`);
      return res.status(502).json({ error: 'The levels are published, but Prism could not read Schoology to clear the flag\'s line. Sync, then check the comment.' });
    }
    if (!gradedOverMarker({ wroteScore: false, wroteRubric: true, freshException: fresh?.exception, localException })) {
      return res.json({ flagCleared: null });
    }
    captureBeforeSave(db, studentRow.id, assignmentRow.id, 'mastery settle');
    db.prepare('UPDATE grades SET score = ?, exception = 0, submitted_at = ? WHERE student_id = ? AND assignment_id = ?')
      .run(fresh.grade ?? null, gradeTimeAfterWrite(fresh), studentRow.id, assignmentRow.id);
    try {
      captureFeedbackSnapshots(db, { assignmentId: assignmentRow.id, studentId: studentRow.id, mode: 'save' });
      settleResubmissions(db, { assignmentId: assignmentRow.id });
    } catch (err) {
      console.error('[mastery settle] snapshot/settle failed:', err.message);
    }
    const flagCleared = await settleMarker(db, studentRow.id, assignmentRow.id, 'mastery settle');
    res.json({ flagCleared, resubmissionFields: savedPairFields(db, studentRow.id, assignmentRow.id, 'settle') });
  } catch (err) {
    console.error('[mastery settle] Error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    release();
  }
}

// POST /api/mastery/:courseId/write-comment — write grade comment back to Schoology
router.post('/:courseId/write-comment', async (req, res) => {
  const { courseId } = req.params;
  const { enrollmentId, assignmentId, commentStatus, points, statusLine, statusLineKind, rubricSaved, rowLevels } = req.body;
  let { comment } = req.body;

  if (!enrollmentId || !assignmentId) {
    return res.status(400).json({ error: 'enrollmentId and assignmentId are required' });
  }
  // A rubric-only save over a marker (#40): settle the marker without writing the card's comment.
  if (req.body.settleMarker === true) {
    if (comment !== undefined || commentStatus !== undefined || points != null || statusLine != null || rowLevels != null) {
      return res.status(400).json({ error: 'settleMarker writes no comment, display, score, status line or rows' });
    }
    return settleMarkerOnly(req, res);
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

  // Feedback rows (spec 2026-10-13): Prism-only. Validated before any Schoology
  // call; written only after Schoology accepts the overall write below.
  const hasRowLevels = rowLevels != null;
  if (hasRowLevels) {
    const rowError = rowLevelsError(feedbackRowsFor(db, courseId, assignmentId), rowLevels);
    if (rowError) return res.status(400).json({ error: rowError });
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
  // write can't compose from the same read and drop it. A grade write holds it too:
  // over a marker it removes the flag's line afterwards (#40).
  const wroteGrade = hasPoints || rubricSaved === true;
  const pairStudent = db.prepare(`
    SELECT s.id FROM students s JOIN enrolments e ON e.student_id = s.id WHERE e.schoology_enrolment_id = ?
  `).get(String(enrollmentId));
  const pairAssignment = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(assignmentId));
  // The flag Prism held before this save (the rubric write just before it never touches grades).
  const localException = pairStudent && pairAssignment
    ? db.prepare('SELECT exception FROM grades WHERE student_id = ? AND assignment_id = ?').get(pairStudent.id, pairAssignment.id)?.exception ?? 0
    : 0;
  let release = null;
  if (line || wroteGrade) {
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
        return res.status(502).json({ error: 'Schoology has no grade record Prism expected: sync, then try again' });
      }
    }
    if (lookupFailed) {
      return res.status(502).json({ error: 'Could not read the current Schoology grade: nothing was saved. Try again.' });
    }
    // A score over a final flag (Exempt, Missing) is refused: the card keeps them locked (#40).
    if (hasPoints && isFinalFlag(fresh?.exception)) {
      return res.status(409).json({ error: flaggedError(fresh.exception), code: 'FLAGGED' });
    }
    const overMarker = gradedOverMarker({
      wroteScore: hasPoints, wroteRubric: rubricSaved === true, freshException: fresh?.exception, localException,
    });

    const payload = {
      assignment_id: String(assignmentId),
      enrollment_id: String(enrollmentId),
      comment: comment || '',
      comment_status: commentStatusInt,
    };
    if (fresh && fresh.grade != null) payload.grade = String(fresh.grade);
    if (hasPoints) payload.grade = String(Number(points));
    if (fresh && fresh.exception != null) payload.exception = fresh.exception;
    // A score sent with a flag is removed (verified): over a marker, the grade clears it.
    if (hasPoints && isMarker(fresh?.exception)) payload.exception = 0;

    try {
      const result = await pushGradeUpdates(courseRow.schoology_section_id, [payload]);

      // apiPut never throws on an HTTP error, so the result must be checked —
      // a rejected write (or a 207 with a failed per-item response_code) must
      // never be mirrored as if Schoology had accepted it (grades, status_lines,
      // the snapshot capture, settling a request) or reported back as saved.
      if (!putSucceeded(result)) {
        console.error('[mastery write-comment] comment PUT rejected:', result?.status, JSON.stringify(result?.data)?.slice(0, 500));
        return res.status(502).json({ error: 'Schoology rejected the update: nothing was recorded in Prism' });
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
      // stale NULL score and the gradebook shows "Overdue • Not Started" for
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
      let rowsSaveFailed = false;
      let flagCleared = null; // set when this grade cleared a marker (#40)
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
            Number(payload.exception) || 0, // what this PUT set: 0 when the grade cleared a marker
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
        // Feedback rows (Prism-only), after the grade mirror so a failure here never
        // leaves the published grade unmirrored. A failure is reported, not swallowed:
        // the rows exist nowhere else, and the card keeps them for a second Save.
        if (hasRowLevels) {
          try {
            const uid = uidForEnrolment(db, enrollmentId);
            if (uid) saveRowLevels(db, { assignmentSchoologyId: String(assignmentId), studentUid: uid, rowLevels });
          } catch (err) {
            console.error('[mastery write-comment] feedback rows not saved:', err.message);
            rowsSaveFailed = true;
          }
        }
        // Best-effort: a local grade just landed — snapshot its visible feedback
        // (Amendment B) and settle any request it fulfilled. Never fails the save.
        try {
          captureFeedbackSnapshots(db, { assignmentId: assignmentRow.id, studentId: studentRow.id, mode: 'save' });
          settleResubmissions(db, { assignmentId: assignmentRow.id });
        } catch (err) {
          console.error('[mastery write-comment] snapshot/settle failed:', err.message);
        }
        // A score or levels published: a waiting saved copy is stale now (#40), over a flag or not.
        if (wroteGrade) {
          try { retireCopy(db, { studentId: studentRow.id, assignmentId: assignmentRow.id }); } catch (err) {
            console.error('[mastery write-comment] could not retire the saved copy:', err.message);
          }
        }
        if (overMarker) flagCleared = await settleMarker(db, studentRow.id, assignmentRow.id, 'mastery write-comment');
        resubmissionFields = savedPairFields(db, studentRow.id, assignmentRow.id, 'write-comment');
      }

      if (rowsSaveFailed) {
        return res.status(500).json({ error: ROWS_NOT_SAVED, published: true, resubmissionFields, ...(flagCleared ? { flagCleared } : {}) });
      }
      res.json({ ...result, resubmissionFields, ...(flagCleared ? { flagCleared } : {}) });
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
// score writes go through one mastery client (writeMasteryScoresBatch, plain HTTP),
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
  // A rubric-only entry over a marker (#40): settle the marker after the batch, never writing the
  // card's comment (settleMarkerOnly in one pass).
  if (entries.some((e) => e.settleMarker === true && (e.comment || e.grade || !e.scores))) {
    return res.status(400).json({ error: 'settleMarker goes with rubric scores and no comment or grade', results: entries.map(x => ({ uid: x.uid, ok: false })) });
  }
  const settleEntries = entries.filter((e) => e.settleMarker === true);

  // Scale grades (#41) ride the comment PUT; validate them all before writing
  // anything, so one bad entry can't leave the batch half-sent.
  for (const e of entries.filter(e => e.grade)) {
    const scaleError = !e.comment
      ? 'a scale grade must be sent with its comment'
      : scalePointsError(db, courseId, e.assignmentId, e.grade.points);
    if (scaleError) return res.status(400).json({ error: scaleError, results: entries.map(x => ({ uid: x.uid, ok: false })) });
  }

  // Feedback rows: validate every entry's rows before any write.
  for (const e of entries.filter(x => x.rowLevels != null)) {
    const rowError = rowLevelsError(feedbackRowsFor(db, courseId, e.assignmentId), e.rowLevels);
    if (rowError) return res.status(400).json({ error: rowError, results: entries.map(x => ({ uid: x.uid, ok: false })) });
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

  // The flag Prism holds for each entry's pair before this batch (#40): a scale grade over a final
  // flag (Exempt, Missing) is refused before anything is written; a grade over a marker clears it.
  const localFlag = db.prepare(`
    SELECT g.exception FROM grades g
    JOIN enrolments en ON en.student_id = g.student_id AND en.schoology_enrolment_id = ?
    JOIN assignments a ON a.id = g.assignment_id AND a.schoology_assignment_id = ?
  `);
  const localExceptionOf = new Map(entries.map((e) => [e.uid, localFlag.get(String(e.enrollmentId), String(e.assignmentId))?.exception ?? 0]));
  // Neither a score nor levels over a final flag: Prism's rows for every grade entry, and (when the
  // batch writes levels, before the mastery batch) one fresh read for all of them.
  const stop = await finalFlagStop(db, sectionId, entries.filter((e) => e.grade || e.scores), { fresh: scoreEntries.length > 0 });
  if (stop) {
    return res.status(stop.status).json({ error: stop.error, ...(stop.code ? { code: stop.code } : {}), results: entries.map(x => ({ uid: x.uid, ok: false })) });
  }

  // Per-pair lock (shared with write-comment/triage) for every entry carrying a
  // status line: an overlapping write for the same pair must not compose from
  // the same stale read and drop one line. A grade entry holds it too: over a
  // marker it removes the flag's line afterwards (#40). Acquired before any write; if any
  // pair is already busy, release what was taken and fail the whole batch
  // before touching Schoology — the rest is released in the finally below.
  const releases = [];
  for (const e of [...commentEntries, ...settleEntries]) {
    if (!e.comment?.statusLine && !e.grade && !e.scores) continue;
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
  const SCORES_MAY_BE_WRITTEN = 'nothing was recorded in Prism; rubric scores may already be in Schoology, sync, then check';
  const failMessage = (msg) => (scoreEntries.length > 0 ? `${msg}: ${SCORES_MAY_BE_WRITTEN}` : msg);
  try {
    // 1. All rubric scores through one mastery client (one page read for the CSRF pair).
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
    const sentException = new Map(); // uid → the exception each comment PUT set
    const overMarker = new Set();    // uids whose grade cleared a marker (#40)
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
            ? `Schoology has no grade record Prism expected: ${SCORES_MAY_BE_WRITTEN}`
            : 'Schoology has no grade record Prism expected: sync, then try again',
          results: entries.map((x) => ({ uid: x.uid, ok: false })),
        });
      }

      // A final flag set in Schoology since Prism last read it: refuse the batch before any PUT.
      const flaggedNow = commentEntries.find((e) => e.grade && isFinalFlag(freshByKey.get(`${e.assignmentId}::${e.enrollmentId}`)?.exception));
      if (flaggedNow) {
        const code = freshByKey.get(`${flaggedNow.assignmentId}::${flaggedNow.enrollmentId}`).exception;
        return res.status(409).json({ error: failMessage(flaggedError(code)), code: 'FLAGGED', results: entries.map((x) => ({ uid: x.uid, ok: false })) });
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
        // A score sent with a flag is removed (verified): over a marker, the grade clears it.
        if (e.grade && isMarker(fresh?.exception)) payload.exception = 0;
        sentException.set(e.uid, Number(payload.exception) || 0);
        if (gradedOverMarker({
          wroteScore: Boolean(e.grade), wroteRubric: Boolean(e.scores), freshException: fresh?.exception, localException: localExceptionOf.get(e.uid),
        })) overMarker.add(e.uid);
        return payload;
      });

      // apiPut never throws on an HTTP error, so the result must be checked —
      // a discarded failure here would mirror a comment Schoology never
      // accepted (the pre-existing send-all gap putSucceeded closes elsewhere).
      const result = await pushGradeUpdates(sectionId, payloads);
      if (!putSucceeded(result)) {
        console.error('[mastery send-all] comment PUT rejected:', result?.status, JSON.stringify(result?.data)?.slice(0, 500));
        return res.status(502).json({
          error: scoreEntries.length > 0
            ? `Schoology rejected the comment update: ${SCORES_MAY_BE_WRITTEN}`
            : 'Schoology rejected the update: nothing was recorded in Prism',
          results: entries.map((x) => ({ uid: x.uid, ok: false })),
        });
      }
    }

    // Rubric-only entries over a marker: the fresh state after the mastery batch (one read, shared
    // with the comment entries when there are any). A failed read leaves them unsettled: their
    // levels are published, Prism still holds the marker and its line, and each result carries a
    // warning for its card (#177); the next sync catches up.
    let settleReadFailed = false;
    if (settleEntries.length > 0 && commentEntries.length === 0) {
      try {
        for (const g of (await getSectionGrades(sectionId)) || []) freshByKey.set(`${g.assignment_id}::${g.enrollment_id}`, g);
      } catch (err) {
        console.error('[mastery send-all] settle read failed:', err.message);
        settleReadFailed = true;
      }
    }
    for (const e of settleEntries) {
      const fresh = freshByKey.get(`${e.assignmentId}::${e.enrollmentId}`);
      if (fresh && gradedOverMarker({ wroteScore: false, wroteRubric: true, freshException: fresh.exception, localException: localExceptionOf.get(e.uid) })) {
        overMarker.add(e.uid);
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
    // Best-effort (Schoology already accepted these writes): a failed lookup skips the pair.
    const pairOf = (e) => {
      try {
        const st = db.prepare('SELECT s.id FROM students s JOIN enrolments en ON en.student_id = s.id WHERE en.schoology_enrolment_id = ?').get(String(e.enrollmentId));
        const as = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(e.assignmentId));
        return st && as ? { studentId: st.id, assignmentId: as.id } : null;
      } catch (err) {
        console.error('[mastery send-all] pair lookup failed:', err.message);
        return null;
      }
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

    const mirrorSettled = db.prepare('UPDATE grades SET score = ?, exception = 0, submitted_at = ? WHERE student_id = ? AND assignment_id = ?');
    for (const e of scoreEntries) {
      const studentRow = db.prepare(
        'SELECT s.id, s.schoology_uid FROM students s JOIN enrolments en ON en.student_id = s.id WHERE en.schoology_enrolment_id = ?'
      ).get(String(e.enrollmentId));
      if (!studentRow) continue;
      if (e.settleMarker && overMarker.has(e.uid)) {
        const fresh = freshByKey.get(`${e.assignmentId}::${e.enrollmentId}`);
        const settledAssignment = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(e.assignmentId));
        if (settledAssignment) mirrorSettled.run(fresh.grade ?? null, gradeTimeAfterWrite(fresh), studentRow.id, settledAssignment.id);
      }
      mirrorPairLevels(db, studentRow.schoology_uid, e.assignmentId, e.scores.gradeInfo, now);
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
        sentException.get(e.uid) ?? 0, // 0 when the grade cleared a marker
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
    // Feedback rows: Prism-only, mirrored now that every Schoology write succeeded
    // (a rows-only entry made no Schoology call at all).
    // A failed row save marks only that entry not ok: its grade and comment are already
    // in Schoology and mirrored, and the card keeps the rows for another send.
    const rowsFailed = new Set();
    for (const e of entries.filter(x => x.rowLevels != null)) {
      try {
        const uid = uidForEnrolment(db, e.enrollmentId);
        if (uid) saveRowLevels(db, { assignmentSchoologyId: String(e.assignmentId), studentUid: uid, rowLevels: e.rowLevels });
      } catch (err) {
        console.error('[mastery send-all] feedback rows not saved:', e.uid, err.message);
        rowsFailed.add(e.uid);
      }
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
    // Every pair that published a score or levels: a waiting saved copy is stale now (#40).
    for (const e of entries.filter((x) => x.scores || x.grade)) {
      const p = pairByUid.get(e.uid);
      if (!p) continue;
      try { retireCopy(db, p); } catch (err) { console.error('[mastery send-all] could not retire the saved copy:', e.uid, err.message); }
    }
    // Grades over a marker: retire the saved copy and remove the flag's line (#40), one pair at a time.
    const flagClearedByUid = new Map();
    for (const e of [...commentEntries, ...settleEntries]) {
      const p = overMarker.has(e.uid) ? pairByUid.get(e.uid) : null;
      if (p) flagClearedByUid.set(e.uid, await settleMarker(db, p.studentId, p.assignmentId, 'mastery send-all'));
    }

    // Each saved pair's post-save resubmission state (final review I2).
    res.json({
      results: entries.map((e) => {
        const p = pairByUid.get(e.uid);
        const resubmissionFields = p ? savedPairFields(db, p.studentId, p.assignmentId, 'send-all') : null;
        const cleared = flagClearedByUid.has(e.uid) ? { flagCleared: flagClearedByUid.get(e.uid) } : {};
        // published: the grade and comment are in Schoology and mirrored; only the rows are not.
        if (rowsFailed.has(e.uid)) return { uid: e.uid, ok: false, published: true, error: ROWS_NOT_SAVED, resubmissionFields, ...cleared };
        const warning = settleReadFailed && e.settleMarker ? SETTLE_NOT_READ : null;
        return { uid: e.uid, ok: true, resubmissionFields, ...cleared, ...(warning ? { warning } : {}) };
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
