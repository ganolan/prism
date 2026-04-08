import { Router } from 'express';
import { getDb } from '../db/index.js';
import { syncMasteryForCourse, writeMasteryScores, getMasteryForCourse, getRubricScoresForStudent, interactiveLogin } from '../services/masterySync.js';
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
    res.json(data);
  } catch (err) {
    console.error('[mastery] Error fetching mastery data:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mastery/:courseId/student/:studentUid — per-student mastery scores
router.get('/:courseId/student/:studentUid', (req, res) => {
  const { courseId, studentUid } = req.params;
  const db = getDb();

  const topics = db.prepare(`
    SELECT mt.*, rc.title AS category_title, rc.external_id AS category_external_id
    FROM measurement_topics mt
    JOIN reporting_categories rc ON rc.id = mt.category_id
    WHERE mt.course_id = ?
    ORDER BY mt.external_id
  `).all(courseId);

  const scores = db.prepare(`
    SELECT ms.*, a.title AS assignment_title
    FROM mastery_scores ms
    LEFT JOIN assignments a ON a.schoology_assignment_id = ms.assignment_schoology_id
    WHERE ms.student_uid = ? AND ms.topic_id IN (
      SELECT id FROM measurement_topics WHERE course_id = ?
    )
    ORDER BY ms.topic_id, ms.assignment_schoology_id
  `).all(studentUid, courseId);

  res.json({ topics, scores });
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

  const topics = db.prepare(`
    SELECT mt.*, rc.title AS category_title, rc.external_id AS category_external_id
    FROM measurement_topics mt
    JOIN reporting_categories rc ON rc.id = mt.category_id
    WHERE mt.course_id = ?
    ORDER BY rc.external_id, mt.external_id
  `).all(courseId);

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

  const scores = db.prepare(`
    SELECT * FROM mastery_scores WHERE assignment_schoology_id = ? AND topic_id IN (
      SELECT id FROM measurement_topics WHERE course_id = ?
    )
  `).all(assignmentId, courseId);

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
