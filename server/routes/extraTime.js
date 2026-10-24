// A student's confirmed extra time on tests (#160, Test day), in the Prism-owned table student_extra_time.
// GET    /api/extra-time?studentIds=1,2   → { [studentId]: { percent, updatedAt } } (students without a figure are absent)
// PUT    /api/extra-time/:studentId { percent }   (a whole number, 0 to 200) → { percent, updatedAt }
// DELETE /api/extra-time/:studentId   → { ok: true }
// Prism's own data, so there is no feature gate and no Schoology or PowerSchool call. The suggestion
// that the teacher confirms comes from server/lib/extraTime.js.
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { MAX_EXTRA_TIME_PERCENT } from '../lib/extraTime.js';

const router = Router();

router.get('/', (req, res) => {
  const ids = String(req.query.studentIds || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (ids.some((n) => !Number.isInteger(n))) return res.status(400).json({ error: 'studentIds must be a comma-separated list of student ids' });
  const out = {};
  if (ids.length) {
    const rows = getDb().prepare(
      `SELECT student_id, percent, updated_at FROM student_extra_time WHERE student_id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids);
    for (const r of rows) out[r.student_id] = { percent: r.percent, updatedAt: r.updated_at };
  }
  res.json(out);
});

router.put('/:studentId', (req, res) => {
  const percent = req.body?.percent;
  if (!Number.isInteger(percent) || percent < 0 || percent > MAX_EXTRA_TIME_PERCENT) {
    return res.status(400).json({ error: `percent must be a whole number from 0 to ${MAX_EXTRA_TIME_PERCENT}` });
  }
  const db = getDb();
  const studentId = Number(req.params.studentId);
  if (!db.prepare('SELECT 1 FROM students WHERE id = ?').get(studentId)) return res.status(404).json({ error: 'Student not found' });
  const updatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO student_extra_time (student_id, percent, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(student_id) DO UPDATE SET percent = excluded.percent, updated_at = excluded.updated_at`
  ).run(studentId, percent, updatedAt);
  res.json({ percent, updatedAt });
});

router.delete('/:studentId', (req, res) => {
  getDb().prepare('DELETE FROM student_extra_time WHERE student_id = ?').run(Number(req.params.studentId));
  res.json({ ok: true });
});

export default router;
