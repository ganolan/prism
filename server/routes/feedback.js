import { Router } from 'express';
import { getDb } from '../db/index.js';
import { getExistingSuggestions } from '../services/assessmentContext.js';
import { SYNC_FRESH_MS } from '../services/syncQueue.js';

// The feedback rows the /assessment page reads and marks (#122 retired the
// standalone /feedback review page, its inbox and its JSON upload).
const router = Router();

// data_stale: an AI suggestion (status 'draft') made from data over SYNC_FRESH_MS older than itself (#131), or
// from a task that was never synced ('never'). data_as_of and suggested_at are the data time and the
// moment get_assignment_context served the context the grader graded from (a context_serves row,
// named by the context_id the grader passes back; upsertStudentSuggestion copies them), so
// the age is what the grader was given, not what the write came long after. Measured against
// suggested_at, not updated_at, which also moves when the teacher edits the row. Not judged (false): a null data_as_of or
// suggested_at (a row from before they were recorded), a teacher's own saved grade, and a
// suggestion the teacher used or ignored.
export function withDataTime(row) {
  const dataAsOf = row.data_as_of ?? null;
  let stale = false;
  if (row.status === 'draft' && dataAsOf && row.suggested_at && !['used', 'ignored'].includes(row.suggestion_state)) {
    stale = dataAsOf === 'never' || Date.parse(row.suggested_at) - Date.parse(dataAsOf) > SYNC_FRESH_MS;
  }
  return { ...row, data_as_of: dataAsOf, data_stale: stale };
}

// GET /api/feedback/for-assignment/:assignmentId — all draft/teacher_modified
// feedback rows for one assignment, keyed by student_id, each with parsed JSON.
// :assignmentId is the SCHOOLOGY assignment id (matches the assessment page URL
// + the mastery route); resolved to the local assignment id internally.
// approved rows are excluded so they stop re-surfacing as suggestions. Each row also carries data_as_of and data_stale.
router.get('/for-assignment/:assignmentId', (req, res) => {
  const db = getDb();
  const assignment = db.prepare(
    'SELECT id FROM assignments WHERE schoology_assignment_id = ?'
  ).get(req.params.assignmentId);
  if (!assignment) return res.json({});
  const rows = getExistingSuggestions(db, assignment.id);
  res.json(Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, withDataTime(row)])));
});

// GET /api/feedback/analysis/:assignmentId — the assessment_analysis record for
// one assignment (Schoology id), parsed, or null.
router.get('/analysis/:assignmentId', (req, res) => {
  const db = getDb();
  const assignment = db.prepare(
    'SELECT id FROM assignments WHERE schoology_assignment_id = ?'
  ).get(req.params.assignmentId);
  if (!assignment) return res.json(null);
  const row = db.prepare(
    'SELECT * FROM assessment_analysis WHERE assignment_id = ?'
  ).get(assignment.id);
  if (!row) return res.json(null);
  row.analysis_parsed = JSON.parse(row.analysis_json || '{}');
  res.json(row);
});

// PUT /api/feedback/:id/suggestion-state — the teacher used or ignored the
// suggested-feedback narrative on /assessment/ (or cleared that). 'revised' is
// set only by an agent re-run (suggestions.js), never by the teacher.
const TEACHER_SUGGESTION_STATES = new Set(['used', 'ignored', null]);
router.put('/:id/suggestion-state', (req, res) => {
  const state = req.body?.state ?? null;
  if (!TEACHER_SUGGESTION_STATES.has(state)) return res.status(400).json({ error: `Unknown state: ${state}` });
  const db = getDb();
  const id = Number(req.params.id);
  const changed = db.prepare('UPDATE feedback SET suggestion_state = ? WHERE id = ?').run(state, id).changes;
  if (!changed) return res.status(404).json({ error: 'Feedback not found' });
  res.json({ id, suggestion_state: state });
});

export default router;
