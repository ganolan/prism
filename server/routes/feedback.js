import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/index.js';
import { processInbox, importSingleFeedback } from '../services/inbox.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// GET /api/feedback/inbox-log — recent inbox processing log (must be before /:id)
router.get('/inbox-log', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM inbox_log ORDER BY processed_at DESC LIMIT 50').all();
  res.json(rows);
});

// GET /api/feedback — list feedback with filters
router.get('/', (req, res) => {
  const db = getDb();
  const { status, student_id, assignment_id, flagged, course_id } = req.query;
  let sql = `
    SELECT f.*, s.first_name, s.last_name, s.preferred_name,
           a.title as assignment_title, a.max_points,
           c.course_name, c.id as course_id
    FROM feedback f
    JOIN students s ON s.id = f.student_id
    JOIN assignments a ON a.id = f.assignment_id
    JOIN courses c ON c.id = a.course_id
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += ' AND f.status = ?'; params.push(status); }
  if (student_id) { sql += ' AND f.student_id = ?'; params.push(student_id); }
  if (assignment_id) { sql += ' AND f.assignment_id = ?'; params.push(assignment_id); }
  if (course_id) { sql += ' AND c.id = ?'; params.push(course_id); }
  if (flagged === 'true') { sql += ' AND f.flag_for_review = 1'; }
  sql += ' ORDER BY f.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/feedback/:id — single feedback with parsed JSON
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT f.*, s.first_name, s.last_name, s.preferred_name,
           a.title as assignment_title, a.max_points,
           c.course_name, c.id as course_id
    FROM feedback f
    JOIN students s ON s.id = f.student_id
    JOIN assignments a ON a.id = f.assignment_id
    JOIN courses c ON c.id = a.course_id
    WHERE f.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Feedback not found' });
  row.feedback_parsed = JSON.parse(row.feedback_json || '{}');
  row.revision_history_parsed = JSON.parse(row.revision_history || '[]');
  res.json(row);
});

// PUT /api/feedback/:id — update feedback (inline edit)
router.put('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Feedback not found' });

  const { score, feedback_json, teacher_notes, status } = req.body;

  // If feedback content changed, push old version to revision history
  let history = JSON.parse(existing.revision_history || '[]');
  if (feedback_json && feedback_json !== existing.feedback_json) {
    history.push({
      feedback_json: existing.feedback_json,
      score: existing.score,
      status: existing.status,
      changed_at: new Date().toISOString(),
    });
  }

  // Determine new status
  let newStatus = status || existing.status;
  if (!status && feedback_json && feedback_json !== existing.feedback_json) {
    newStatus = 'teacher_modified';
  }

  db.prepare(`
    UPDATE feedback SET
      score = COALESCE(?, score),
      feedback_json = COALESCE(?, feedback_json),
      teacher_notes = COALESCE(?, teacher_notes),
      status = ?,
      revision_history = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    score ?? existing.score,
    feedback_json ?? existing.feedback_json,
    teacher_notes ?? existing.teacher_notes,
    newStatus,
    JSON.stringify(history),
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  updated.feedback_parsed = JSON.parse(updated.feedback_json || '{}');
  updated.revision_history_parsed = JSON.parse(updated.revision_history || '[]');
  res.json(updated);
});

// PUT /api/feedback/:id/approve — approve feedback
router.put('/:id/approve', (req, res) => {
  const db = getDb();
  db.prepare(`UPDATE feedback SET status = 'approved', updated_at = datetime('now') WHERE id = ?`)
    .run(req.params.id);
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Feedback not found' });
  res.json(row);
});

// PUT /api/feedback/:id/request-revision — request revision with notes
router.put('/:id/request-revision', (req, res) => {
  const db = getDb();
  const { teacher_notes } = req.body;
  db.prepare(`
    UPDATE feedback SET status = 'revision_requested', teacher_notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(teacher_notes || '', req.params.id);
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Feedback not found' });
  res.json(row);
});

// POST /api/feedback/batch-approve — approve multiple unflagged feedback items
router.post('/batch-approve', (req, res) => {
  const db = getDb();
  const { ids } = req.body; // array of feedback IDs, or null for all unflagged drafts
  let result;
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    result = db.prepare(`
      UPDATE feedback SET status = 'approved', updated_at = datetime('now')
      WHERE id IN (${placeholders}) AND status IN ('draft', 'revised', 'teacher_modified')
    `).run(...ids);
  } else {
    result = db.prepare(`
      UPDATE feedback SET status = 'approved', updated_at = datetime('now')
      WHERE status IN ('draft', 'revised') AND flag_for_review = 0
    `).run();
  }
  res.json({ approved: result.changes });
});

// POST /api/feedback/process-inbox — scan inbox folder
router.post('/process-inbox', (req, res) => {
  try {
    const result = processInbox();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/feedback/upload — upload a JSON file
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const raw = req.file.buffer.toString('utf-8');
    const data = JSON.parse(raw);
    const items = Array.isArray(data) ? data : [data];
    const results = { imported: 0, errors: [] };

    for (const item of items) {
      const result = importSingleFeedback(item, req.file.originalname);
      if (result.error) {
        results.errors.push(result.error);
      } else {
        results.imported++;
      }
    }

    res.json(results);
  } catch (err) {
    res.status(400).json({ error: `JSON parse error: ${err.message}` });
  }
});

// POST /api/feedback/manual — manual feedback entry
router.post('/manual', (req, res) => {
  const db = getDb();
  const { student_id, assignment_id, score, narrative_feedback, strengths, suggestions, rubric_scores } = req.body;

  if (!student_id || !assignment_id) {
    return res.status(400).json({ error: 'student_id and assignment_id required' });
  }

  const feedbackJson = JSON.stringify({
    strengths: strengths || [],
    suggestions: suggestions || [],
    narrative_feedback: narrative_feedback || '',
    rubric_scores: rubric_scores || {},
  });

  const result = db.prepare(`
    INSERT INTO feedback (student_id, assignment_id, status, score, feedback_json)
    VALUES (?, ?, 'approved', ?, ?)
  `).run(student_id, assignment_id, score ?? null, feedbackJson);

  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(row);
});

// DELETE /api/feedback/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM feedback WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Feedback not found' });
  res.json({ success: true });
});

export default router;
