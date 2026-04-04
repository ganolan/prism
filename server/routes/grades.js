import { Router } from 'express';
import { getDb } from '../db/index.js';

const router = Router();

// GET /api/grades — grades with optional filters
router.get('/', (req, res) => {
  const db = getDb();
  const { student_id, assignment_id, course_id } = req.query;

  let sql = `
    SELECT g.*, a.title as assignment_title, a.due_date, a.max_points as assignment_max_points,
           s.first_name, s.last_name, s.preferred_name,
           c.course_name, c.id as course_id
    FROM grades g
    JOIN assignments a ON a.id = g.assignment_id
    JOIN students s ON s.id = g.student_id
    JOIN courses c ON c.id = a.course_id
    WHERE 1=1
  `;
  const params = [];

  if (student_id) { sql += ' AND g.student_id = ?'; params.push(student_id); }
  if (assignment_id) { sql += ' AND g.assignment_id = ?'; params.push(assignment_id); }
  if (course_id) { sql += ' AND c.id = ?'; params.push(course_id); }

  sql += ' ORDER BY a.due_date DESC, s.last_name';
  res.json(db.prepare(sql).all(...params));
});

export default router;
