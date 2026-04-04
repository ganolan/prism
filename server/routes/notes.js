import { Router } from 'express';
import { getDb } from '../db/index.js';

const router = Router();

// GET /api/notes?student_id=&course_id= — list notes with optional filters
router.get('/', (req, res) => {
  const db = getDb();
  const { student_id, course_id } = req.query;
  let sql = `
    SELECT n.*, s.first_name, s.last_name, s.preferred_name,
           c.course_name
    FROM notes n
    JOIN students s ON s.id = n.student_id
    LEFT JOIN courses c ON c.id = n.course_id
    WHERE 1=1
  `;
  const params = [];
  if (student_id) { sql += ' AND n.student_id = ?'; params.push(student_id); }
  if (course_id) { sql += ' AND n.course_id = ?'; params.push(course_id); }
  sql += ' ORDER BY n.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// POST /api/notes — create a note
router.post('/', (req, res) => {
  const db = getDb();
  const { student_id, course_id, content } = req.body;
  if (!student_id || !content?.trim()) {
    return res.status(400).json({ error: 'student_id and content are required' });
  }
  const result = db.prepare(`
    INSERT INTO notes (student_id, course_id, content) VALUES (?, ?, ?)
  `).run(student_id, course_id || null, content.trim());
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(note);
});

// PUT /api/notes/:id — update a note
router.put('/:id', (req, res) => {
  const db = getDb();
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
  db.prepare(`UPDATE notes SET content = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(content.trim(), req.params.id);
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  res.json(note);
});

// DELETE /api/notes/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Note not found' });
  res.json({ success: true });
});

export default router;
