import { Router } from 'express';
import { getDb } from '../db/index.js';
import { hasMasterySession, syncMasteryForCourse, syncMasteryForAssignment, writeMasteryScores, writeMasteryScoresBatch, writeMasteryOverride, getMasteryForCourse, getRubricScoresForStudent, interactiveLogin } from '../services/masterySync.js';
import { pushGradeComments, getSectionGrades } from '../services/schoology.js';
import { isResubmitted } from '../lib/resubmission.js';
import { getAlignedTopics, getRoster, getScoreMap, getGradeMetaRows } from '../services/assessmentContext.js';
import { getSchoologyConfig } from '../middleware/featureGate.js';
import { toSchoologyWebUrl } from '../lib/schoologyWebUrl.js';
import { levelToGradeScaled, gradeScaledValues, pointsToLevel, LEVELS } from '../lib/proficiencyScale.js';

const router = Router();
const syncsInProgress = new Set();

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
      ON CONFLICT(student_uid, objective_id) DO UPDATE SET
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
      'SELECT s.schoology_uid FROM students s JOIN enrolments e ON e.student_id = s.id WHERE e.schoology_enrolment_id = ?'
    ).get(String(enrollmentId));
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

    res.json(result);
  } catch (err) {
    console.error('[mastery write] Error:', err);
    res.status(500).json({ error: err.message });
  }
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
  const commentMap = {};
  const exceptionMap = {};
  const commentStatusMap = {};
  const hasGradeRowMap = {};
  const resubmittedMap = {};
  for (const c of gradeRows) {
    commentMap[c.schoology_uid] = c.grade_comment || '';
    exceptionMap[c.schoology_uid] = c.exception ?? 0;
    commentStatusMap[c.schoology_uid] = c.comment_status ?? null;
    hasGradeRowMap[c.schoology_uid] = true;
    resubmittedMap[c.schoology_uid] = isResubmitted(c);
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

  // Submission-scoped 'resubmit requested' flags for this assignment (#49).
  const resubmitFlagRows = assignmentRow
    ? db.prepare(`
        SELECT id, student_id FROM flags
        WHERE assignment_id = ? AND flag_type = 'resubmit_requested' AND resolved = 0
      `).all(assignmentRow.id)
    : [];
  const resubmitFlagMap = {};
  for (const r of resubmitFlagRows) {
    resubmitFlagMap[r.student_id] = { id: r.id };
  }

  res.json({
    assignment: assignmentRow || { schoology_assignment_id: assignmentId, title: 'Unknown Assignment' },
    topics,
    students: students.map(s => ({
      ...s,
      scores: scoreMap[s.schoology_uid] || {},
      grade_comment: commentMap[s.schoology_uid] || '',
      exception: exceptionMap[s.schoology_uid] || 0,
      comment_status: commentStatusMap[s.schoology_uid] ?? null,
      has_grade_row: hasGradeRowMap[s.schoology_uid] === true,
      review_flag: reviewFlagMap[s.id] || null,
      resubmit_flag: resubmitFlagMap[s.id] || null,
      resubmitted: resubmittedMap[s.schoology_uid] === true,
    })),
  });
});

// POST /api/mastery/:courseId/write-comment — write grade comment back to Schoology
router.post('/:courseId/write-comment', async (req, res) => {
  const { courseId } = req.params;
  const { enrollmentId, assignmentId, comment, commentStatus } = req.body;

  if (!enrollmentId || !assignmentId) {
    return res.status(400).json({ error: 'enrollmentId and assignmentId are required' });
  }

  const db = getDb();
  const courseRow = db.prepare('SELECT schoology_section_id FROM courses WHERE id = ?').get(courseId);
  if (!courseRow) return res.status(404).json({ error: 'Course not found' });

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
  let fresh = null;
  try {
    const allGrades = await getSectionGrades(courseRow.schoology_section_id);
    fresh = allGrades.find(g =>
      String(g.assignment_id) === String(assignmentId) &&
      String(g.enrollment_id) === String(enrollmentId)
    ) || null;
  } catch (err) {
    console.warn(`[mastery write-comment] fresh grade lookup failed: ${err.message}`);
  }

  const payload = {
    assignment_id: String(assignmentId),
    enrollment_id: String(enrollmentId),
    comment: comment || '',
    comment_status: commentStatusInt,
  };
  if (fresh && fresh.grade != null) payload.grade = String(fresh.grade);
  if (fresh && fresh.exception != null) payload.exception = fresh.exception;

  try {
    const result = await pushGradeComments(courseRow.schoology_section_id, [payload]);

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
    if (studentRow && assignmentRow) {
      const now = new Date().toISOString();
      if (fresh) {
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
          fresh.grade ?? null,
          fresh.exception ?? 0,
          Number(fresh.timestamp) || 0,
          comment || '',
          commentStatusInt,
          now,
        );
      } else {
        // Schoology lookup failed — mirror the comment only. Touching score or
        // submitted_at here would wipe a real grade to NULL.
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
    }

    res.json(result);
  } catch (err) {
    console.error('[mastery write-comment] Error:', err);
    res.status(500).json({ error: err.message });
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

      const payloads = commentEntries.map(e => {
        const fresh = freshByKey.get(`${e.assignmentId}::${e.enrollmentId}`) || null;
        const payload = {
          assignment_id: String(e.assignmentId),
          enrollment_id: String(e.enrollmentId),
          comment: e.comment.comment || '',
          comment_status: e.comment.commentStatus === false ? null : 1,
        };
        if (fresh && fresh.grade != null) payload.grade = String(fresh.grade);
        if (fresh && fresh.exception != null) payload.exception = fresh.exception;
        return payload;
      });

      await pushGradeComments(sectionId, payloads);
    }

    // 3. Mirror to the local DB — only now that every write above succeeded.
    //    Scores → mastery_scores (like the single /write); comments → grades
    //    with the echoed fresh score/exception/timestamp (like write-comment),
    //    so the gradebook reflects the save without a full re-sync (#60).
    const now = new Date().toISOString();
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

    for (const e of scoreEntries) {
      const studentRow = db.prepare(
        'SELECT s.schoology_uid FROM students s JOIN enrolments en ON en.student_id = s.id WHERE en.schoology_enrolment_id = ?'
      ).get(String(e.enrollmentId));
      if (!studentRow) continue;
      for (const [topicId, info] of Object.entries(e.scores.gradeInfo)) {
        const points = Number(info.grade);
        upsertScore.run(studentRow.schoology_uid, String(e.assignmentId), topicId, points, pointsToLevel(points), now);
      }
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
        fresh ? (fresh.grade ?? null) : null,
        fresh ? (fresh.exception ?? 0) : 0,
        fresh ? (Number(fresh.timestamp) || 0) : 0,
        e.comment.comment || '', commentStatusInt, now,
      );
    }

    res.json({ results: entries.map(e => ({ uid: e.uid, ok: true })) });
  } catch (err) {
    console.error('[mastery send-all] Error:', err);
    res.status(502).json({ error: err.message, results: entries.map(e => ({ uid: e.uid, ok: false })) });
  }
});

export default router;
