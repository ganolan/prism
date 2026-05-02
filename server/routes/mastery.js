import { Router } from 'express';
import { getDb } from '../db/index.js';
import { syncMasteryForCourse, syncMasteryForAssignment, writeMasteryScores, writeMasteryOverride, getMasteryForCourse, getRubricScoresForStudent, interactiveLogin } from '../services/masterySync.js';
import { pushGradeComments } from '../services/schoology.js';

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
    res.json({ ...data, rollups });
  } catch (err) {
    console.error('[mastery] Error fetching mastery data:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mastery/:courseId/student/:studentUid — per-student mastery scores
router.get('/:courseId/student/:studentUid', (req, res) => {
  const { courseId, studentUid } = req.params;
  const db = getDb();

  // Derive topics from actual scores for published assignments in this course (handles shared topics across courses)
  const topics = db.prepare(`
    SELECT DISTINCT mt.*, rc.title AS category_title, rc.external_id AS category_external_id
    FROM measurement_topics mt
    JOIN reporting_categories rc ON rc.id = mt.category_id
    WHERE mt.id IN (
      SELECT DISTINCT ms.topic_id FROM mastery_scores ms
      JOIN assignments a ON a.schoology_assignment_id = ms.assignment_schoology_id
      WHERE a.course_id = ? AND a.published = 1
    )
    ORDER BY rc.external_id, mt.external_id
  `).all(courseId);

  const topicIds = topics.map(t => t.id);
  const scores = topicIds.length > 0 ? db.prepare(`
    SELECT ms.*, a.title AS assignment_title, a.due_date AS assignment_due_date
    FROM mastery_scores ms
    LEFT JOIN assignments a ON a.schoology_assignment_id = ms.assignment_schoology_id
    LEFT JOIN folders f ON f.schoology_folder_id = a.folder_id AND f.course_id = a.course_id
    LEFT JOIN folders fp ON fp.schoology_folder_id = f.parent_id AND fp.course_id = f.course_id AND f.parent_id != '0'
    WHERE ms.student_uid = ? AND a.course_id = ? AND a.published = 1
    ORDER BY
      CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN a.display_weight
           WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(fp.display_weight, 0)
           ELSE COALESCE(f.display_weight, a.display_weight) END ASC,
      CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN 0
           WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(f.display_weight, 0)
           ELSE a.display_weight END ASC,
      CASE WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN a.display_weight ELSE 0 END ASC,
      ms.assignment_schoology_id
  `).all(studentUid, courseId) : [];

  // Authoritative topic↔assignment alignments from the Schoology alignments
  // endpoint. Falls back to inferring from scores if the table is empty
  // (e.g. before the first sync after this feature was added).
  let alignments = db.prepare(`
    SELECT ma.assignment_schoology_id, ma.topic_id
    FROM mastery_alignments ma
    JOIN assignments a ON a.schoology_assignment_id = ma.assignment_schoology_id
    WHERE ma.course_id = ? AND a.published = 1
  `).all(courseId);
  if (alignments.length === 0 && topicIds.length > 0) {
    alignments = db.prepare(`
      SELECT DISTINCT ms.assignment_schoology_id, ms.topic_id
      FROM mastery_scores ms
      JOIN assignments a ON a.schoology_assignment_id = ms.assignment_schoology_id
      WHERE a.course_id = ? AND a.published = 1
    `).all(courseId);
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
// for one (student, objective). Pass gradeScaled as "87.50"/"62.50"/...
// to set, or null/undefined to clear. Objective can be a reporting-category
// UUID or a measurement-topic UUID.
router.post('/:courseId/override', async (req, res) => {
  const { courseId } = req.params;
  const { studentUid, objectiveId, gradeScaled } = req.body;

  if (!studentUid || !objectiveId) {
    return res.status(400).json({ error: 'studentUid and objectiveId are required' });
  }
  if (gradeScaled != null && !['0.00', '12.50', '37.50', '62.50', '87.50'].includes(String(gradeScaled))) {
    return res.status(400).json({ error: 'gradeScaled must be one of "0.00","12.50","37.50","62.50","87.50" or null to clear' });
  }

  const db = getDb();
  const courseRow = db.prepare('SELECT schoology_section_id FROM courses WHERE id = ?').get(courseId);
  if (!courseRow) return res.status(404).json({ error: 'Course not found' });

  try {
    const result = await writeMasteryOverride({
      sectionId: courseRow.schoology_section_id,
      studentUid,
      objectiveId,
      gradeScaled: gradeScaled != null ? String(gradeScaled) : null,
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
      const POINTS_TO_LETTER = { 0: 'IE', 25: 'EM', 50: 'D', 75: 'EX', 100: 'ED' };
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
        const letter = POINTS_TO_LETTER[points] ?? null;
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

  // Aligned topics for THIS assignment, sourced from the authoritative
  // mastery_alignments table. Falls back to topics that have any score for
  // this assignment if alignments haven't been synced yet — so a freshly
  // aligned assignment with no grades still renders its rubric.
  let topics = db.prepare(`
    SELECT DISTINCT mt.*, rc.title AS category_title, rc.external_id AS category_external_id
    FROM measurement_topics mt
    JOIN reporting_categories rc ON rc.id = mt.category_id
    WHERE mt.id IN (
      SELECT ma.topic_id FROM mastery_alignments ma
      WHERE ma.assignment_schoology_id = ? AND ma.course_id = ?
    )
    ORDER BY rc.external_id, mt.external_id
  `).all(assignmentId, courseId);

  if (topics.length === 0) {
    topics = db.prepare(`
      SELECT DISTINCT mt.*, rc.title AS category_title, rc.external_id AS category_external_id
      FROM measurement_topics mt
      JOIN reporting_categories rc ON rc.id = mt.category_id
      WHERE mt.id IN (
        SELECT DISTINCT ms.topic_id FROM mastery_scores ms
        WHERE ms.assignment_schoology_id = ?
      )
      ORDER BY rc.external_id, mt.external_id
    `).all(assignmentId);
  }

  const assignmentRow = db.prepare(`
    SELECT * FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?
  `).get(assignmentId, courseId);

  const students = db.prepare(`
    SELECT s.id, s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
           e.schoology_enrolment_id AS enrollment_id
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ?
    ORDER BY s.last_name, s.first_name
  `).all(courseId);

  const scores = topics.length > 0 ? db.prepare(`
    SELECT * FROM mastery_scores WHERE assignment_schoology_id = ?
    AND topic_id IN (${topics.map(() => '?').join(',')})
  `).all(assignmentId, ...topics.map(t => t.id)) : [];

  // Grade comments from the regular grades table
  const comments = db.prepare(`
    SELECT s.schoology_uid, g.grade_comment
    FROM grades g
    JOIN students s ON s.id = g.student_id
    JOIN assignments a ON a.id = g.assignment_id
    WHERE a.schoology_assignment_id = ?
  `).all(assignmentId);

  const commentMap = {};
  for (const c of comments) commentMap[c.schoology_uid] = c.grade_comment || '';

  const scoreMap = {};
  for (const sc of scores) {
    if (!scoreMap[sc.student_uid]) scoreMap[sc.student_uid] = {};
    scoreMap[sc.student_uid][sc.topic_id] = { points: sc.points, grade: sc.grade };
  }

  res.json({
    assignment: assignmentRow || { schoology_assignment_id: assignmentId, title: 'Unknown Assignment' },
    topics,
    students: students.map(s => ({
      ...s,
      scores: scoreMap[s.schoology_uid] || {},
      grade_comment: commentMap[s.schoology_uid] || '',
    })),
  });
});

// POST /api/mastery/:courseId/write-comment — write grade comment back to Schoology
router.post('/:courseId/write-comment', async (req, res) => {
  const { courseId } = req.params;
  const { enrollmentId, assignmentId, comment } = req.body;

  if (!enrollmentId || !assignmentId) {
    return res.status(400).json({ error: 'enrollmentId and assignmentId are required' });
  }

  const db = getDb();
  const courseRow = db.prepare('SELECT schoology_section_id FROM courses WHERE id = ?').get(courseId);
  if (!courseRow) return res.status(404).json({ error: 'Course not found' });

  try {
    const result = await pushGradeComments(courseRow.schoology_section_id, [{
      assignment_id: String(assignmentId),
      enrollment_id: String(enrollmentId),
      comment: comment || '',
    }]);
    res.json(result);
  } catch (err) {
    console.error('[mastery write-comment] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
