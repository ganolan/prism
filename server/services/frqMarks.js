// FRQ marks (spec §12). Two layers on one answer: the agent's suggestion (suggested_*, with
// history and a revised flag) and the teacher's mark (final_*). A new suggestion never changes
// final_*. Write-back state compares final_* with the stored Schoology copy; nothing here reads
// or writes Schoology.
import { QuizError } from './quizError.js';
import { getGroup } from './quizGroups.js';
import { resolveStudentId } from './idResolvers.js';
import { normalizeLevel } from '../lib/proficiencyScale.js';
import { posting } from './quizLocks.js';

export const POINTS_KEY = 'points';
const parse = (t, fallback = null) => (t ? JSON.parse(t) : fallback);
// Comments are plain text on both sides (the Schoology copy is the attempt form's decoded textarea),
// so only spacing is normalized: parsing them as HTML would cut text at a comparison like a<b.
const normComment = (c) => String(c ?? '').replace(/\s+/g, ' ').trim();

export function schoologyMarkOf(response, rubric) {
  if (!response) return null;
  let cells = null;
  if (rubric) {
    const entries = Object.entries(parse(response.schoology_rubric_cells_json, {}))
      .filter(([, v]) => v?.points != null).map(([k, v]) => [k, Number(v.points)]);
    if (entries.length) cells = Object.fromEntries(entries);
  } else if (response.points != null) {
    cells = { [POINTS_KEY]: Number(response.points) };
  }
  const comment = response.schoology_comment ?? '';
  if (!cells && !normComment(comment)) return null;
  return { cells: cells ?? {}, comment };
}

export function sameMark(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a.cells || {}).sort();
  const kb = Object.keys(b.cells || {}).sort();
  if (ka.join() !== kb.join()) return false;
  if (ka.some(k => Number(a.cells[k]) !== Number(b.cells[k]))) return false;
  return normComment(a.comment) === normComment(b.comment);
}

function pointsCells(question, points) {
  const p = Number(points);
  if (points == null || points === '' || !Number.isFinite(p) || p < 0 || p > Number(question.max_points)) {
    return { error: `points must be a number from 0 to ${question.max_points}` };
  }
  return { cells: { [POINTS_KEY]: p } };
}

// An agent's input: rows by id or title, levels by name or Prism code (never a number).
export function resolveCells(question, { cells, level, points } = {}) {
  const rubric = parse(question.schoology_rubric_json);
  if (!rubric) return pointsCells(question, points);
  let input = cells;
  if (input == null && level != null) {
    if (rubric.rows.length !== 1) return { error: 'level alone is only for a one-row rubric: send cells' };
    input = { [rubric.rows[0].id]: level };
  }
  if (!input || !Object.keys(input).length) return { error: 'cells (or level) is required' };
  const out = {};
  const problems = [];
  for (const [rowKey, raw] of Object.entries(input)) {
    const key = String(rowKey).trim().toLowerCase();
    const row = rubric.rows.find(r => r.id === String(rowKey)) || rubric.rows.find(r => r.title.toLowerCase() === key);
    if (!row) { problems.push(`unknown rubric row ${JSON.stringify(rowKey)}`); continue; }
    const name = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
    const code = normalizeLevel(raw);
    const lvl = (name && row.levels.find(l => l.name.toLowerCase() === name))
      || (code && row.levels.find(l => normalizeLevel(l.name) === code));
    if (!lvl) { problems.push(`${row.title}: unknown level ${JSON.stringify(raw)} (levels: ${row.levels.map(l => l.name).join(', ')})`); continue; }
    out[row.id] = lvl.points;
  }
  const missing = rubric.rows.filter(r => out[r.id] == null && !problems.some(p => p.startsWith(`${r.title}:`)));
  if (missing.length && !problems.length) problems.push(`no level for ${missing.map(r => r.title).join(', ')}`);
  return problems.length ? { error: problems.join('; ') } : { cells: out };
}

// The UI's input: cells already in points, each one a level of its row.
export function validatePointCells(question, cells) {
  const rubric = parse(question.schoology_rubric_json);
  if (!rubric) return pointsCells(question, cells?.[POINTS_KEY]);
  const out = {};
  for (const row of rubric.rows) {
    const p = Number(cells?.[row.id]);
    if (!row.levels.some(l => l.points === p)) return { error: `Choose a level for ${row.title}` };
    out[row.id] = p;
  }
  return { cells: out };
}

export function markView(row, schoology) {
  if (!row) return null;
  const layer = (cells, comment) => (cells ? { cells: parse(cells), comment: comment ?? '' } : null);
  const posted = layer(row.posted_cells_json, row.posted_comment);
  return {
    state: row.state,
    suggested: layer(row.suggested_cells_json, row.suggested_comment),
    final: layer(row.final_cells_json, row.final_comment),
    suggestion_revised: !!row.suggestion_revised,
    writeback: { status: row.writeback_status, at: row.writeback_at, error: row.writeback_error },
    changed_in_schoology: row.writeback_status === 'posted' && !!posted && !sameMark(posted, schoology),
  };
}

function questionAt(db, groupId, position) {
  const q = db.prepare(`SELECT * FROM quiz_questions WHERE group_id = ? AND position = ? AND kind = 'frq'`).get(groupId, Number(position));
  if (!q) throw new QuizError('NOT_FOUND', `Quiz group ${groupId} has no free-response question ${position}`);
  return q;
}
const markRow = (db, attemptId, questionId) =>
  db.prepare('SELECT * FROM frq_marks WHERE attempt_id = ? AND question_id = ?').get(attemptId, questionId);
const responseRow = (db, attemptId, questionId) =>
  db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ? AND question_id = ?').get(attemptId, questionId);
const schoologyFor = (db, attemptId, q) => schoologyMarkOf(responseRow(db, attemptId, q.id), parse(q.schoology_rubric_json));

function attemptForStudent(db, groupId, student) {
  const studentId = resolveStudentId(db, student);
  if (!studentId) return { error: `Student not found: ${student}` };
  const a = db.prepare('SELECT id FROM quiz_attempts WHERE group_id = ? AND student_id = ?').get(groupId, studentId);
  return a ? { attemptId: a.id } : { error: 'No loaded attempt for this student: load the results first' };
}

function upsertSuggestion(db, attemptId, questionId, suggestion) {
  const existing = markRow(db, attemptId, questionId);
  if (!existing) {
    db.prepare(`INSERT INTO frq_marks (attempt_id, question_id, suggested_cells_json, suggested_comment, state)
      VALUES (?, ?, ?, ?, 'suggested')`).run(attemptId, questionId, JSON.stringify(suggestion.cells), suggestion.comment);
    return;
  }
  const history = parse(existing.suggestion_history_json, []);
  if (existing.suggested_cells_json) {
    history.push({ cells: parse(existing.suggested_cells_json), comment: existing.suggested_comment ?? '', replaced_at: new Date().toISOString() });
  }
  const final = existing.final_cells_json ? { cells: parse(existing.final_cells_json), comment: existing.final_comment ?? '' } : null;
  const revised = final && !sameMark(final, suggestion) ? 1 : 0;
  db.prepare(`UPDATE frq_marks SET suggested_cells_json = ?, suggested_comment = ?, suggestion_history_json = ?,
      suggestion_revised = ?, updated_at = datetime('now') WHERE attempt_id = ? AND question_id = ?`)
    .run(JSON.stringify(suggestion.cells), suggestion.comment, JSON.stringify(history), revised, attemptId, questionId);
}

export function writeFrqSuggestions(db, { groupId, position, students }) {
  const group = getGroup(db, groupId);
  const q = questionAt(db, group.id, position);
  const results = [];
  for (const s of students || []) {
    const found = attemptForStudent(db, group.id, s.student);
    if (found.error) { results.push({ student: s.student, status: 'error', message: found.error }); continue; }
    const r = resolveCells(q, s);
    if (r.error) { results.push({ student: s.student, status: 'error', message: r.error }); continue; }
    upsertSuggestion(db, found.attemptId, q.id, { cells: r.cells, comment: String(s.comment ?? '') });
    results.push({ student: s.student, status: 'written' });
  }
  return { written: results.filter(x => x.status === 'written').length, results };
}

export function setFrqMark(db, { groupId, attemptId, position, action, cells, comment }) {
  const group = getGroup(db, groupId);
  const q = questionAt(db, group.id, position);
  const attempt = db.prepare('SELECT id FROM quiz_attempts WHERE id = ? AND group_id = ?').get(Number(attemptId), group.id);
  if (!attempt) throw new QuizError('NOT_FOUND', `No attempt ${attemptId} in quiz group ${group.id}`);
  const existing = markRow(db, attempt.id, q.id);
  const schoology = schoologyFor(db, attempt.id, q);
  const suggested = existing?.suggested_cells_json ? { cells: parse(existing.suggested_cells_json), comment: existing.suggested_comment ?? '' } : null;

  if (action === 'keep') {
    if (!existing?.final_cells_json) throw new QuizError('NOT_ELIGIBLE', 'There is no mark of yours to keep');
    db.prepare(`UPDATE frq_marks SET suggestion_revised = 0, updated_at = datetime('now') WHERE attempt_id = ? AND question_id = ?`).run(attempt.id, q.id);
    return markView(markRow(db, attempt.id, q.id), schoology);
  }
  let final;
  let state;
  if (action === 'accept') {
    if (!suggested) throw new QuizError('NOT_ELIGIBLE', 'There is no suggestion to accept');
    final = suggested;
    state = 'accepted';
  } else if (action === 'save') {
    const checked = validatePointCells(q, cells);
    if (checked.error) throw new QuizError('NOT_ELIGIBLE', checked.error);
    final = { cells: checked.cells, comment: String(comment ?? '') };
    state = suggested && sameMark(final, suggested) ? 'accepted' : 'edited';
  } else {
    throw new QuizError('NOT_ELIGIBLE', `Unknown action ${action}`);
  }
  const posted = sameMark(final, schoology);
  db.prepare(`INSERT INTO frq_marks (attempt_id, question_id, state) VALUES (?, ?, ?)
    ON CONFLICT (attempt_id, question_id) DO NOTHING`).run(attempt.id, q.id, state);
  db.prepare(`UPDATE frq_marks SET final_cells_json = ?, final_comment = ?, state = ?, suggestion_revised = 0,
      writeback_status = ?, writeback_error = NULL,
      writeback_at = CASE WHEN ? THEN datetime('now') ELSE writeback_at END,
      posted_cells_json = CASE WHEN ? THEN ? ELSE posted_cells_json END,
      posted_comment = CASE WHEN ? THEN ? ELSE posted_comment END,
      updated_at = datetime('now') WHERE attempt_id = ? AND question_id = ?`)
    .run(JSON.stringify(final.cells), final.comment, state, posted ? 'posted' : 'pending',
      posted ? 1 : 0, posted ? 1 : 0, JSON.stringify(final.cells), posted ? 1 : 0, final.comment, attempt.id, q.id);
  return markView(markRow(db, attempt.id, q.id), schoology);
}

export function recordWriteback(db, { groupId, student, position, status, error }) {
  if (!['posted', 'failed'].includes(status)) throw new QuizError('NOT_ELIGIBLE', 'status must be posted or failed');
  const group = getGroup(db, groupId);
  if (posting.has(group.id)) throw new QuizError('BUSY', 'Marks for this quiz are being posted by Prism: try again when it finishes');
  const q = questionAt(db, group.id, position);
  const found = attemptForStudent(db, group.id, student);
  if (found.error) throw new QuizError('NOT_FOUND', found.error);
  const row = markRow(db, found.attemptId, q.id);
  if (!row?.final_cells_json) throw new QuizError('NOT_ELIGIBLE', 'This answer has no accepted mark to post');
  if (!['pending', 'failed'].includes(row.writeback_status)) {
    throw new QuizError('NOT_ELIGIBLE', `Only a mark waiting to post or failed can be recorded (this one is ${row.writeback_status})`);
  }
  if (status === 'posted') {
    db.prepare(`UPDATE frq_marks SET writeback_status = 'posted', writeback_at = datetime('now'), writeback_error = NULL,
        posted_cells_json = final_cells_json, posted_comment = final_comment, updated_at = datetime('now')
      WHERE attempt_id = ? AND question_id = ?`).run(found.attemptId, q.id);
  } else {
    db.prepare(`UPDATE frq_marks SET writeback_status = 'failed', writeback_at = datetime('now'), writeback_error = ?,
        updated_at = datetime('now') WHERE attempt_id = ? AND question_id = ?`).run(String(error ?? 'No reason given'), found.attemptId, q.id);
  }
  return markView(markRow(db, found.attemptId, q.id), schoologyFor(db, found.attemptId, q));
}

// After a load: a waiting or failed mark that the stored Schoology copy now shows is posted,
// whoever posted it (an agent or the teacher by hand).
export function reconcileMarks(db, { groupId }) {
  const rows = db.prepare(`SELECT m.*, q.schoology_rubric_json FROM frq_marks m
    JOIN quiz_attempts qa ON qa.id = m.attempt_id JOIN quiz_questions q ON q.id = m.question_id
    WHERE qa.group_id = ? AND m.writeback_status IN ('pending', 'failed')`).all(Number(groupId));
  let posted = 0;
  for (const m of rows) {
    const final = { cells: parse(m.final_cells_json), comment: m.final_comment ?? '' };
    const rubric = parse(m.schoology_rubric_json);
    const response = responseRow(db, m.attempt_id, m.question_id);
    const schoology = schoologyMarkOf(response, rubric);
    if (!sameMark(final, schoology)) continue;
    // A one-row rubric's level and the question's points are saved by different requests (spec §14):
    // the mark is in Schoology only when the points agree with the level too.
    if (rubric?.rows?.length === 1 && response?.points != null && Number(response.points) !== Number(final.cells[rubric.rows[0].id])) continue;
    db.prepare(`UPDATE frq_marks SET writeback_status = 'posted', writeback_at = datetime('now'), writeback_error = NULL,
        posted_cells_json = final_cells_json, posted_comment = final_comment WHERE attempt_id = ? AND question_id = ?`)
      .run(m.attempt_id, m.question_id);
    posted++;
  }
  return { posted };
}
