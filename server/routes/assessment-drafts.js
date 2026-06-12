import { Router } from 'express';
import { getDb } from '../db/index.js';
import { resolveAssignmentId, resolveStudentId } from '../services/idResolvers.js';

const router = Router();

// GET /api/assessment-drafts?assignment_id=<schoology|local>
// → { [student_id]: { pending, comment, display, displayTouched, base } }
router.get('/', (req, res) => {
  const db = getDb();
  const { assignment_id } = req.query;
  if (!assignment_id) return res.status(400).json({ error: 'assignment_id is required' });
  const localAssignmentId = resolveAssignmentId(db, assignment_id);
  if (!localAssignmentId) return res.json({});
  const rows = db.prepare('SELECT student_id, draft_json FROM assessment_drafts WHERE assignment_id = ?').all(localAssignmentId);
  const byStudent = {};
  for (const r of rows) {
    try { byStudent[r.student_id] = JSON.parse(r.draft_json); } catch { /* skip corrupt row */ }
  }
  res.json(byStudent);
});

// POST /api/assessment-drafts — upsert one draft. Body:
// { assignment_id, student_id, enrollment_id?, draft }. Also serves
// navigator.sendBeacon flushes (a Blob with type application/json — parsed by
// the express.json() body parser like any POST). The US-spelled enrollment_id
// body field is stored into the British-spelled enrolment_id column.
router.post('/', (req, res) => {
  const db = getDb();
  const { assignment_id, student_id, enrollment_id, draft } = req.body || {};
  if (!assignment_id || !draft) return res.status(400).json({ error: 'assignment_id and draft are required' });
  const localAssignmentId = resolveAssignmentId(db, assignment_id);
  if (!localAssignmentId) return res.status(404).json({ error: 'Assignment not found' });
  const localStudentId = resolveStudentId(db, student_id);
  if (!localStudentId) return res.status(404).json({ error: 'Student not found' });
  db.prepare(`
    INSERT INTO assessment_drafts (assignment_id, student_id, enrolment_id, draft_json, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(assignment_id, student_id) DO UPDATE SET
      draft_json = excluded.draft_json,
      enrolment_id = excluded.enrolment_id,
      updated_at = datetime('now')
  `).run(localAssignmentId, localStudentId, enrollment_id ?? null, JSON.stringify(draft));
  res.json({ ok: true });
});

// DELETE /api/assessment-drafts?assignment_id=&student_id=
router.delete('/', (req, res) => {
  const db = getDb();
  const { assignment_id, student_id } = req.query;
  if (!assignment_id || !student_id) return res.status(400).json({ error: 'assignment_id and student_id are required' });
  const localAssignmentId = resolveAssignmentId(db, assignment_id);
  if (!localAssignmentId) return res.json({ ok: true });
  const localStudentId = resolveStudentId(db, student_id);
  if (localStudentId) {
    db.prepare('DELETE FROM assessment_drafts WHERE assignment_id = ? AND student_id = ?').run(localAssignmentId, localStudentId);
  }
  res.json({ ok: true });
});

export default router;
