import { Router } from 'express';
import { getDb } from '../db/index.js';

const router = Router();

// GET /api/courses — list all courses (non-archived and visible by default)
router.get('/', (req, res) => {
  const db = getDb();
  const includeArchived = req.query.archived === 'true';
  const includeHidden = req.query.hidden === 'true';

  let query = 'SELECT * FROM courses WHERE 1=1';
  if (!includeArchived) query += ' AND archived = 0';
  if (!includeHidden) query += ' AND hidden = 0';
  query += ' ORDER BY course_name';

  const rows = db.prepare(query).all();
  res.json(rows);
});

// GET /api/courses/:id — course detail with student count
router.get('/:id', (req, res) => {
  const db = getDb();
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });

  const studentCount = db.prepare(
    'SELECT COUNT(*) as count FROM enrolments WHERE course_id = ?'
  ).get(req.params.id).count;

  res.json({ ...course, studentCount });
});

// GET /api/courses/:id/students — students enrolled with their grades summary
router.get('/:id/students', (req, res) => {
  const db = getDb();
  const students = db.prepare(`
    SELECT s.*, e.id as enrolment_id
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ?
    ORDER BY s.last_name, s.first_name
  `).all(req.params.id);

  // Get grade summary per student for this course
  const gradeSummary = db.prepare(`
    SELECT g.student_id,
           COUNT(g.id) as graded_count,
           ROUND(AVG(CASE WHEN g.score IS NOT NULL AND g.max_score > 0 THEN (g.score * 100.0 / g.max_score) END), 1) as avg_pct
    FROM grades g
    JOIN assignments a ON a.id = g.assignment_id
    WHERE a.course_id = ?
    GROUP BY g.student_id
  `).all(req.params.id);

  const summaryMap = Object.fromEntries(gradeSummary.map(s => [s.student_id, s]));

  const enriched = students.map(s => ({
    ...s,
    graded_count: summaryMap[s.id]?.graded_count || 0,
    avg_pct: summaryMap[s.id]?.avg_pct || null,
  }));

  res.json(enriched);
});

// GET /api/courses/:id/assignments — assignments for a course
router.get('/:id/assignments', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM assignments WHERE course_id = ? ORDER BY due_date DESC, title'
  ).all(req.params.id);
  res.json(rows);
});

// GET /api/courses/:id/gradebook — full gradebook grid (students x assignments)
router.get('/:id/gradebook', (req, res) => {
  const db = getDb();

  const assignments = db.prepare(
    'SELECT id, title, max_points, due_date FROM assignments WHERE course_id = ? ORDER BY due_date, title'
  ).all(req.params.id);

  const students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.preferred_name
    FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ?
    ORDER BY s.last_name, s.first_name
  `).all(req.params.id);

  const grades = db.prepare(`
    SELECT g.student_id, g.assignment_id, g.score, g.max_score, g.grade_comment, g.exception
    FROM grades g
    JOIN assignments a ON a.id = g.assignment_id
    WHERE a.course_id = ?
  `).all(req.params.id);

  // Index grades by student_id -> assignment_id
  const gradeMap = {};
  for (const g of grades) {
    if (!gradeMap[g.student_id]) gradeMap[g.student_id] = {};
    gradeMap[g.student_id][g.assignment_id] = g;
  }

  res.json({ assignments, students, grades: gradeMap });
});

// PUT /api/courses/:id/archive — toggle archive status
router.put('/:id/archive', (req, res) => {
  const db = getDb();
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const newState = course.archived ? 0 : 1;
  db.prepare('UPDATE courses SET archived = ? WHERE id = ?').run(newState, req.params.id);
  res.json({ ...course, archived: newState });
});

// PUT /api/courses/:id/visibility — toggle visibility
router.put('/:id/visibility', (req, res) => {
  const db = getDb();
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const newState = course.hidden ? 0 : 1;
  db.prepare('UPDATE courses SET hidden = ? WHERE id = ?').run(newState, req.params.id);
  res.json({ ...course, hidden: newState });
});

export default router;
