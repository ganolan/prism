// Prism posts accepted FRQ marks to the student's test attempt (linked quizzes phase 4b, spec §14).
// The request is the attempt form's own POST (phase 4a probe): the freshly loaded form, with only
// the essay's level, points, override and comment changed. Before each write the attempt is re-read
// and a mark changed in Schoology is refused; after it the attempt is read back. Behind quiz_writeback.
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { sessionDeps, noteSessionLive } from './schoologySession.js';
import { QuizError } from './quizError.js';
import { getGroup } from './quizGroups.js';
import { openReader } from './quizLoader.js';
import { schoologyMarkOf, sameMark } from './frqMarks.js';
import { levelNameFor } from '../lib/parseQuizRubric.js';
import { studentFullName } from './studentNames.js';
import { serializeAttemptForm, essayFields, withEssayMark, changedNames, essayNames, toBody } from '../lib/attemptForm.js';

const ATTEMPT_PATH = /^\/assignment\/\d+\/assessment_results\/student_stats\/\d+\/\d+$/;
const posting = new Set();
const parse = (t, fallback = null) => (t ? JSON.parse(t) : fallback);

async function inPagePost({ url, body, timeoutMs }) {
  try {
    const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(timeoutMs) });
    await r.text();
    return { status: r.status, finalUrl: r.url };
  } catch (err) {
    return { status: 0, finalUrl: url, error: String(err?.message || err) };
  }
}

// The production client: the loader's logged-in reader, plus one form POST.
export async function openClient({ pauseMs = 400 } = {}) {
  const reader = await openReader({ openPage: () => sessionDeps.openPage(), pauseMs });
  const post = async (path, body) => {
    if (!ATTEMPT_PATH.test(path)) throw new Error(`Refusing to post to ${path}`);
    const r = await reader.page.evaluate(inPagePost, { url: `${SCHOOLOGY_BASE}${path}`, body, timeoutMs: 30000 });
    if (r.status !== 0 && r.finalUrl && !isLoggedInUrl(r.finalUrl)) {
      noteSessionLive('expired', 'Schoology sent the saved session to the login page');
      throw new QuizError('NO_SESSION', 'Schoology connection expired while posting: reconnect in Settings');
    }
    return r;
  };
  return { get: reader.get, post, close: reader.close };
}

export function waitingMarks(db, groupId) {
  const rows = db.prepare(`SELECT m.attempt_id, m.question_id, m.final_cells_json, m.final_comment,
      q.position, q.schoology_rubric_json, qa.student_id, qa.schoology_attempt_id,
      s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
      a.schoology_assignment_id AS member_sid, c.schoology_question_id AS qid
    FROM frq_marks m
    JOIN quiz_attempts qa ON qa.id = m.attempt_id
    JOIN quiz_questions q ON q.id = m.question_id
    JOIN students s ON s.id = qa.student_id
    JOIN assignments a ON a.id = qa.assignment_id
    JOIN quiz_question_copies c ON c.question_id = q.id AND c.assignment_id = qa.assignment_id
    WHERE qa.group_id = ? AND m.writeback_status IN ('pending', 'failed') AND m.final_cells_json IS NOT NULL`).all(Number(groupId));
  return rows.map((r) => {
    const rubric = parse(r.schoology_rubric_json);
    if (!rubric || rubric.rows.length !== 1) return null;
    const rowId = rubric.rows[0].id;
    return {
      attemptId: r.attempt_id, questionId: r.question_id, position: r.position, studentId: r.student_id,
      name: studentFullName(r), qid: String(r.qid), rowId, rubric,
      path: `/assignment/${r.member_sid}/assessment_results/student_stats/${r.schoology_uid}/${r.schoology_attempt_id}`,
      final: { points: Number(parse(r.final_cells_json)[rowId]), comment: r.final_comment ?? '' },
    };
  }).filter(Boolean).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.position - y.position));
}

const record = (db, w, status, error) => db.prepare(`UPDATE frq_marks SET writeback_status = ?, writeback_error = ?,
    writeback_at = datetime('now'),
    posted_cells_json = CASE WHEN ? THEN final_cells_json ELSE posted_cells_json END,
    posted_comment = CASE WHEN ? THEN final_comment ELSE posted_comment END,
    updated_at = datetime('now') WHERE attempt_id = ? AND question_id = ?`)
  .run(status, error, status === 'posted' ? 1 : 0, status === 'posted' ? 1 : 0, w.attemptId, w.questionId);

const formMark = (fields, rowId) => (fields.rubricScore == null && !fields.comment.trim()
  ? null : { cells: fields.rubricScore == null ? {} : { [rowId]: fields.rubricScore }, comment: fields.comment });

async function postOne(db, client, w) {
  const before = await client.get(w.path);
  const form = before.status === 200 ? serializeAttemptForm(before.text) : null;
  if (!form) return { status: 'failed', error: `The attempt page did not load (HTTP ${before.status})` };
  const now = essayFields(form.pairs, w.qid);
  if (!now) return { status: 'failed', error: 'The question was not found on the attempt page' };
  const stored = schoologyMarkOf(db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ? AND question_id = ?').get(w.attemptId, w.questionId), w.rubric);
  const current = formMark(now, w.rowId);
  if (!(current === null && stored === null) && !sameMark(current, stored)) return { status: 'failed', error: 'Changed in Schoology since the last load' };

  const next = withEssayMark(form.pairs, w.qid, w.final);
  const extra = changedNames(form.pairs, next).filter(n => !essayNames(w.qid).includes(n));
  if (extra.length) return { status: 'failed', error: `Refused: the post would change ${extra.join(', ')}` };
  await client.post(w.path, toBody(next));

  const after = await client.get(w.path);
  const afterForm = after.status === 200 ? serializeAttemptForm(after.text) : null;
  const got = afterForm && essayFields(afterForm.pairs, w.qid);
  if (!got || !sameMark(formMark(got, w.rowId), { cells: { [w.rowId]: w.final.points }, comment: w.final.comment })) {
    return { status: 'failed', error: `Schoology still shows ${got ? `${levelNameFor(w.rubric, w.rowId, got.rubricScore) ?? 'no level'} and the old comment` : 'no attempt form'}` };
  }
  const others = changedNames(form.pairs, afterForm.pairs).filter(n => !essayNames(w.qid).includes(n));
  if (others.length) return { status: 'failed', error: `Posted, but other fields changed: ${others.join(', ')}` };
  db.prepare(`UPDATE quiz_responses SET points = ?, schoology_rubric_cells_json = ?, schoology_comment = ? WHERE attempt_id = ? AND question_id = ?`)
    .run(got.points, JSON.stringify({ [w.rowId]: { points: got.rubricScore, comment: '' } }), got.comment.replace(/\r\n/g, '\n'), w.attemptId, w.questionId);
  return { status: 'posted', error: null };
}

export async function postWritebacks(db, { groupId, limit = null }, deps = { openClient }) {
  const group = getGroup(db, groupId);
  if (posting.has(group.id)) throw new QuizError('BUSY', 'Marks for this quiz are already being posted');
  posting.add(group.id);
  let client = null;
  try {
    const all = waitingMarks(db, group.id);
    const batch = limit == null ? all : all.slice(0, Number(limit));
    const results = [];
    if (batch.length) client = await deps.openClient({});
    for (const w of batch) {
      let r;
      try {
        r = await postOne(db, client, w);
      } catch (err) {
        if (err?.code === 'NO_SESSION') throw err;
        r = { status: 'failed', error: String(err?.message || err) };
      }
      record(db, w, r.status, r.error);
      results.push({ student_id: w.studentId, name: w.name, question: w.position, level: levelNameFor(w.rubric, w.rowId, w.final.points), status: r.status, error: r.error });
    }
    return { results, remaining: waitingMarks(db, group.id).length };
  } finally {
    posting.delete(group.id);
    if (client) await client.close().catch(() => {});
  }
}
