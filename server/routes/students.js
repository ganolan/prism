import { Router } from 'express';
import { getDb } from '../db/index.js';

const router = Router();

// GET /api/students — list all students (optional search)
router.get('/', (req, res) => {
  const db = getDb();
  const { q } = req.query;
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db.prepare(`
      SELECT * FROM students
      WHERE first_name LIKE ? OR last_name LIKE ? OR preferred_name LIKE ?
      ORDER BY last_name, first_name
    `).all(like, like, like);
  } else {
    rows = db.prepare('SELECT * FROM students ORDER BY last_name, first_name').all();
  }
  res.json(rows);
});

// GET /api/students/:id — student profile with courses, grades, notes, flags
router.get('/:id', (req, res) => {
  const db = getDb();
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const courses = db.prepare(`
    SELECT c.*, e.id as enrolment_id
    FROM courses c
    JOIN enrolments e ON e.course_id = c.id
    WHERE e.student_id = ?
    ORDER BY c.course_name
  `).all(req.params.id);

  const grades = db.prepare(`
    SELECT g.*, a.title as assignment_title, a.due_date, a.max_points as assignment_max_points,
           c.course_name, c.id as course_id
    FROM grades g
    JOIN assignments a ON a.id = g.assignment_id
    JOIN courses c ON c.id = a.course_id
    WHERE g.student_id = ?
    ORDER BY a.due_date DESC
  `).all(req.params.id);

  const notes = db.prepare(
    'SELECT * FROM notes WHERE student_id = ? ORDER BY created_at DESC'
  ).all(req.params.id);

  const flags = db.prepare(
    'SELECT * FROM flags WHERE student_id = ? ORDER BY created_at DESC'
  ).all(req.params.id);

  const parents = db.prepare(
    'SELECT * FROM parents WHERE student_id = ? ORDER BY last_name, first_name'
  ).all(req.params.id);

  res.json({ ...student, courses, grades, notes, flags, parents });
});

// PUT /api/students/:id — update editable fields
router.put('/:id', (req, res) => {
  const db = getDb();
  const { nickname } = req.body;
  db.prepare(`
    UPDATE students SET nickname = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(nickname ?? null, req.params.id);
  const updated = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// PUT /api/students/:id/parents/:parentId — update a parent's phone number
router.put('/:id/parents/:parentId', (req, res) => {
  const db = getDb();
  const { phone } = req.body;
  const result = db.prepare(`UPDATE parents SET phone = ? WHERE id = ? AND student_id = ?`)
    .run(phone ?? null, req.params.parentId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Parent not found' });
  const updated = db.prepare('SELECT * FROM parents WHERE id = ?').get(req.params.parentId);
  res.json(updated);
});

export default router;
