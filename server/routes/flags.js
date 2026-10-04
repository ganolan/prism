import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requestResubmission } from '../services/resubmissions.js';
import { TriageError } from '../services/triageCommon.js';

const router = Router();

// GET /api/flags?student_id=&resolved=&flag_type= — list flags
router.get('/', (req, res) => {
  const db = getDb();
  const { student_id, resolved, flag_type } = req.query;
  let sql = `
    SELECT f.*, s.first_name, s.last_name, s.preferred_name,
           a.title as assignment_title
    FROM flags f
    JOIN students s ON s.id = f.student_id
    LEFT JOIN assignments a ON a.id = f.assignment_id
    WHERE 1=1
  `;
  const params = [];
  if (student_id) { sql += ' AND f.student_id = ?'; params.push(student_id); }
  if (resolved !== undefined) { sql += ' AND f.resolved = ?'; params.push(resolved === 'true' ? 1 : 0); }
  if (flag_type) { sql += ' AND f.flag_type = ?'; params.push(flag_type); }
  sql += ' ORDER BY f.resolved ASC, f.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// POST /api/flags — create a flag
router.post('/', (req, res) => {
  const db = getDb();
  const { student_id, assignment_id, flag_type, flag_reason } = req.body;
  const type = flag_type || 'custom';
  if (!student_id) {
    return res.status(400).json({ error: 'student_id is required' });
  }
  // Only review_needed flags carry a reason; resubmit_requested is a reason-less
  // toggle and custom flags (legacy, no longer created by the UI) are unconstrained.
  if (type === 'review_needed' && !flag_reason?.trim()) {
    return res.status(400).json({ error: 'flag_reason is required for review_needed flags' });
  }
  // #49's toggle is now a triage resubmission request (default lessons).
  if (type === 'resubmit_requested') {
    if (!assignment_id) return res.status(400).json({ error: 'assignment_id is required for resubmit_requested flags' });
    try {
      return res.status(201).json(requestResubmission(db, { studentId: student_id, assignmentId: assignment_id, source: 'app' }));
    } catch (err) {
      if (err instanceof TriageError) return res.status(err.code === 'NOT_FOUND' ? 404 : 409).json({ error: err.message, code: err.code });
      throw err;
    }
  }
  // #124: don't create a second unresolved flag of the same type for the same
  // (student, assignment) — update the existing row's reason instead. `IS ?`
  // (not `=`) so a NULL assignment_id (non-assignment-scoped flag) matches a
  // NULL assignment_id, which `=` never does.
  const existing = db.prepare(`
    SELECT * FROM flags WHERE student_id = ? AND assignment_id IS ? AND flag_type = ? AND resolved = 0
  `).get(student_id, assignment_id || null, type);
  let flag;
  if (existing) {
    db.prepare('UPDATE flags SET flag_reason = ? WHERE id = ?').run(flag_reason?.trim() || null, existing.id);
    flag = db.prepare('SELECT * FROM flags WHERE id = ?').get(existing.id);
  } else {
    const result = db.prepare(`
      INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
      VALUES (?, ?, ?, ?)
    `).run(student_id, assignment_id || null, type, flag_reason?.trim() || null);
    flag = db.prepare('SELECT * FROM flags WHERE id = ?').get(result.lastInsertRowid);
  }
  res.status(201).json(flag);
});

// DELETE /api/flags/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM flags WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Flag not found' });
  res.json({ success: true });
});

export default router;
