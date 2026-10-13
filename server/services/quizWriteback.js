// Prism posts accepted FRQ marks to the student's test attempt (linked quizzes phase 4b, spec §14).
// The request is the attempt form's own POST (phase 4a probe): the freshly loaded form, with only
// the essay's level, points, override and comment changed. Before each write the attempt is re-read
// and a mark changed in Schoology is refused; after it the attempt is read back. Behind quiz_writeback.
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { sessionDeps, noteSessionLive } from './schoologySession.js';
import { QuizError } from './quizError.js';
import { getGroup } from './quizGroups.js';
import { openReader } from './quizLoader.js';
import { schoologyMarkOf } from './frqMarks.js';
import { levelNameFor } from '../lib/parseQuizRubric.js';
import { studentFullName } from './studentNames.js';
import { serializeForm, BYQ_FORM, submissionPrefix, fieldsAt, withMarkAt, namesAt, byQuestionRubrics, changedNames, toBody } from '../lib/attemptForm.js';
import { parseQuizQuestions } from '../lib/parseQuizQuestions.js';
import { parseRubricGradeInfo } from '../lib/parseQuizRubric.js';
import { posting } from './quizLocks.js';

// The grade-by-question page (spec §15): one form for the class on one question.
const BYQ_PATH = /^\/assignment\/\d+\/assessment_results\/question_stats\/\d+\/\d+$/;
const GRADE_PATH = /^\/iapi\/grades\/assessment_component_submission_rubric_grade_info\/\d+\/\d+\/\d+\/\d+$/;
const gradePath = (launch, qid, attemptId) => `/iapi/grades/assessment_component_submission_rubric_grade_info/${launch.rubricId}/${qid}/${launch.enrollmentId}/${attemptId}`;
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

// In the page: the rubric save the popup sends (stage C), with Drupal's CSRF values from the open page.
async function inPagePut({ url, json, timeoutMs }) {
  const s = window.Drupal?.settings?.s_common || {};
  if (!s.csrf_token || !s.csrf_key) return { status: 0, error: 'no CSRF values on the page' };
  try {
    const r = await fetch(url, {
      method: 'PUT', credentials: 'include', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', 'X-Csrf-Token': s.csrf_token, 'X-Csrf-Key': s.csrf_key },
      body: JSON.stringify(json),
    });
    await r.text();
    return { status: r.status, finalUrl: r.url };
  } catch (err) {
    return { status: 0, error: String(err?.message || err) };
  }
}

// The production client: the loader's logged-in reader, the rubric PUT and the by-question form POST.
export async function openClient({ pauseMs = 400 } = {}) {
  const reader = await openReader({ openPage: () => sessionDeps.openPage(), pauseMs });
  const post = async (path, body) => {
    if (!BYQ_PATH.test(path)) throw new Error(`Refusing to post to ${path}`);
    const r = await reader.page.evaluate(inPagePost, { url: `${SCHOOLOGY_BASE}${path}`, body, timeoutMs: 30000 });
    if (r.status !== 0 && r.finalUrl && !isLoggedInUrl(r.finalUrl)) {
      noteSessionLive('expired', 'Schoology sent the saved session to the login page');
      throw new QuizError('NO_SESSION', 'Schoology connection expired while posting: reconnect in Settings');
    }
    return r;
  };
  const putRubric = async (path, json) => {
    if (!GRADE_PATH.test(path)) throw new Error(`Refusing to put to ${path}`);
    const r = await reader.page.evaluate(inPagePut, { url: `${SCHOOLOGY_BASE}${path}`, json, timeoutMs: 30000 });
    if (r.status !== 0 && r.finalUrl && !isLoggedInUrl(r.finalUrl)) {
      noteSessionLive('expired', 'Schoology sent the saved session to the login page');
      throw new QuizError('NO_SESSION', 'Schoology connection expired while posting: reconnect in Settings');
    }
    return r;
  };
  return { get: reader.get, post, putRubric, close: reader.close };
}

const SKIP_SCOPE = 'Post this one by hand: Prism posts only a one-row Schoology rubric';
const lf = (c) => String(c ?? '').replace(/\r\n?/g, '\n').trim();
const byName = (x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.position - y.position);

// Accepted or edited marks not yet in Schoology (pending, then failed), each with its own copy's
// question id and attempt path. A mark Prism cannot post carries `skip`.
export function waitingMarks(db, groupId) {
  const rows = db.prepare(`SELECT m.attempt_id, m.question_id, m.final_cells_json, m.final_comment, m.writeback_status,
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
  const out = rows.map((r) => {
    const rubric = parse(r.schoology_rubric_json);
    const base = {
      attemptId: r.attempt_id, questionId: r.question_id, position: r.position, studentId: r.student_id,
      name: studentFullName(r), qid: String(r.qid), rubric, status: r.writeback_status,
      uid: String(r.schoology_uid), memberSid: String(r.member_sid), schoologyAttemptId: String(r.schoology_attempt_id),
      path: `/assignment/${r.member_sid}/assessment_results/student_stats/${r.schoology_uid}/${r.schoology_attempt_id}`,
      finalCellsJson: r.final_cells_json, finalComment: r.final_comment ?? '',
    };
    if (!rubric || rubric.rows.length !== 1) return { ...base, skip: SKIP_SCOPE };
    const row = rubric.rows[0];
    const points = Number(parse(r.final_cells_json)[row.id]);
    if (!row.levels.some(l => l.points === points)) return { ...base, rowId: row.id, skip: 'Post this one by hand: the mark is not a level of the rubric' };
    return { ...base, rowId: row.id, final: { points, comment: r.final_comment ?? '' } };
  });
  const rank = (w) => (w.status === 'pending' ? 0 : 1);
  return out.sort((x, y) => rank(x) - rank(y) || byName(x, y));
}

// Records the result only if the mark is still the one that was posted: a mark changed in Prism during
// the post stays waiting with its new text. → true when recorded.
function record(db, w, status, error) {
  return db.prepare(`UPDATE frq_marks SET writeback_status = ?, writeback_error = ?, writeback_at = datetime('now'),
      posted_cells_json = CASE WHEN ? THEN ? ELSE posted_cells_json END,
      posted_comment = CASE WHEN ? THEN ? ELSE posted_comment END,
      updated_at = datetime('now')
    WHERE attempt_id = ? AND question_id = ? AND writeback_status IN ('pending', 'failed')
      AND final_cells_json = ? AND COALESCE(final_comment, '') = ?`)
    .run(status, error, status === 'posted' ? 1 : 0, w.finalCellsJson, status === 'posted' ? 1 : 0, w.finalComment,
      w.attemptId, w.questionId, w.finalCellsJson, w.finalComment).changes === 1;
}

const HALF = 'The rubric level was saved in Schoology but the form was not';
const failAll = (marks, error) => marks.map(w => ({ w, status: 'failed', error }));

// Before each post the mark must still be the one listed (the teacher can edit a card during a batch).
const stillWaiting = (db, w) => !!db.prepare(`SELECT 1 FROM frq_marks WHERE attempt_id = ? AND question_id = ?
  AND writeback_status IN ('pending', 'failed') AND final_cells_json = ? AND COALESCE(final_comment, '') = ?`)
  .get(w.attemptId, w.questionId, w.finalCellsJson, w.finalComment);

// The checks of §14 for one student on the page: the right attempt, question and rubric, the points
// worth the rubric's top level, and nothing changed in Schoology since the last load (the rubric grade
// may already be Prism's own, after a half-written post). → { fields, grade, giPath } or { error }.
async function checkOne(db, client, w, form, rubrics) {
  if (!stillWaiting(db, w)) return { error: 'Changed in Prism before posting: post it again' };
  const entry = rubrics[w.schoologyAttemptId];
  if (!entry) return { error: 'The attempt on the question page is not the one Prism loaded: load the results again' };
  if (entry.qid !== w.qid) return { error: 'The question page shows another question: load the results again' };
  if (String(entry.rubricId) !== String(w.rubric.id)) return { error: 'Post this one by hand: the question has a different rubric in Schoology' };
  const fields = fieldsAt(form.pairs, submissionPrefix(w.uid, w.schoologyAttemptId));
  if (!fields) return { error: 'The attempt on the question page is not the one Prism loaded: load the results again' };
  const top = Math.max(...w.rubric.rows[0].levels.map(l => l.points));
  if (fields.maxPoints != null && fields.maxPoints !== top) {
    return { error: `Post this one by hand: the question is worth ${fields.maxPoints} points and the rubric's top level ${top}` };
  }
  const giPath = gradePath(entry, w.qid, w.schoologyAttemptId);
  const gi = await client.get(giPath, { json: true });
  const gradeNow = gi.status === 200 ? parseRubricGradeInfo(gi.json) : null;
  if (!gradeNow) return { error: `The rubric grade did not load (HTTP ${gi.status})` };
  const response = db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ? AND question_id = ?').get(w.attemptId, w.questionId);
  const stored = schoologyMarkOf(response, w.rubric);
  const grade = gradeNow[w.rowId]?.points ?? null;
  const pointsMoved = response?.points != null && fields.points !== Number(response.points);
  const commentMoved = lf(fields.comment) !== lf(stored?.comment ?? '');
  const gradeMoved = grade !== (stored?.cells?.[w.rowId] ?? null) && grade !== w.final.points;
  if (pointsMoved || commentMoved || gradeMoved) return { error: 'Changed in Schoology since the last load' };
  return { fields, grade, giPath };
}

// Every mark for one member test and one question, through that question's grade-by-question page
// (spec §15): the per-student rubric save, then one form save for the page, then one read-back.
async function postGroup(db, client, marks) {
  const { memberSid, qid } = marks[0];
  const level = (w, p) => levelNameFor(w.rubric, w.rowId, p) ?? 'no level';
  const list = await client.get(`/assignment/${memberSid}/assessment_questions`);
  const number = (list.status === 200 ? parseQuizQuestions(list.text) : null)?.find(x => x.qid === qid)?.number;
  if (!number) return failAll(marks, 'The question was not found in this test');
  const index = await client.get(`/assignment/${memberSid}/assessment_results/question_stats`);
  const qPath = String(index.text ?? '').match(new RegExp(`href="(/assignment/${memberSid}/assessment_results/question_stats/\\d+/${number})"`))?.[1];
  if (!qPath || !BYQ_PATH.test(qPath)) return failAll(marks, 'No grade-by-question page for this question');
  const before = await client.get(qPath);
  const form = before.status === 200 ? serializeForm(before.text, BYQ_FORM) : null;
  if (!form) return failAll(marks, `The question page did not load (HTTP ${before.status})`);
  const rubrics = byQuestionRubrics(before.text);

  const results = new Map();
  const ready = [];
  for (const w of marks) {
    const c = await checkOne(db, client, w, form, rubrics);
    if (c.error) { results.set(w, { w, status: 'failed', error: c.error }); continue; }
    if (c.grade !== w.final.points) {
      const put = await client.putRubric(c.giPath, { gradeInfo: { [w.rowId]: { grade: w.final.points, comment: '' } }, overrideGrade: null, comment: w.final.comment });
      if (put.status !== 200) { results.set(w, { w, status: 'failed', error: `Schoology refused the rubric save (${put.error || `HTTP ${put.status}`}): the form was not posted` }); continue; }
      const check = await client.get(c.giPath, { json: true });
      const saved = check.status === 200 ? parseRubricGradeInfo(check.json)?.[w.rowId]?.points ?? null : undefined;
      if (saved !== w.final.points) { results.set(w, { w, status: 'failed', error: `The rubric save did not take (Schoology shows ${saved === undefined ? 'nothing readable' : level(w, saved)}): the form was not posted` }); continue; }
    }
    ready.push({ w, giPath: c.giPath, prefix: submissionPrefix(w.uid, w.schoologyAttemptId) });
  }
  const done = () => marks.map(w => results.get(w));
  if (!ready.length) return done();

  const next = ready.reduce((pairs, r) => withMarkAt(pairs, r.prefix, r.w.final), form.pairs);
  try {
    await client.post(qPath, toBody(next));
  } catch (err) {
    err.halfWritten = ready.map(r => r.w);
    err.partial = done().filter(Boolean);
    throw err;
  }

  const after = await client.get(qPath);
  const afterForm = after.status === 200 ? serializeForm(after.text, BYQ_FORM) : null;
  if (!afterForm) {
    for (const r of ready) results.set(r.w, { w: r.w, status: 'failed', error: `${HALF}: the question page did not load afterwards, check it in Schoology` });
    return done();
  }
  const allowed = new Set(ready.flatMap(r => namesAt(r.prefix)));
  const others = changedNames(form.pairs, afterForm.pairs).filter(n => !allowed.has(n));
  if (others.length) {
    for (const r of ready) results.set(r.w, { w: r.w, status: 'failed', unsafe: true, error: `Posted, but other fields changed: ${others.join(', ')}` });
    return done();
  }
  for (const r of ready) {
    const got = fieldsAt(afterForm.pairs, r.prefix);
    const w = r.w;
    if (!got || got.rubricScore !== w.final.points || got.points !== w.final.points || got.override !== 1 || lf(got.comment) !== lf(w.final.comment)) {
      results.set(w, { w, status: 'failed', error: `${HALF}: the form shows rubric score ${got?.rubricScore ?? 'empty'}, points ${got?.points ?? 'empty'}${got && lf(got.comment) === lf(w.final.comment) ? '' : ' and a different comment'}; post it again` });
      continue;
    }
    const gi = await client.get(r.giPath, { json: true });
    const cells = gi.status === 200 ? parseRubricGradeInfo(gi.json) : null;
    if (!cells || cells[w.rowId]?.points !== w.final.points) {
      results.set(w, { w, status: 'failed', error: `The form saved, but Schoology's rubric shows ${cells ? level(w, cells[w.rowId]?.points) : 'nothing readable'}: check it in Schoology` });
      continue;
    }
    db.prepare(`UPDATE quiz_responses SET points = ?, schoology_rubric_cells_json = ?, schoology_comment = ? WHERE attempt_id = ? AND question_id = ?`)
      .run(got.points, JSON.stringify(cells), got.comment.replace(/\r\n/g, '\n'), w.attemptId, w.questionId);
    results.set(w, { w, status: 'posted', error: null });
  }
  return done();
}

const resultLine = (w, status, error) => ({
  student_id: w.studentId, name: w.name, question: w.position,
  level: w.final ? levelNameFor(w.rubric, w.rowId, w.final.points) : null, status, error,
});

export async function postWritebacks(db, { groupId, limit = null }, deps = { openClient }) {
  if (limit != null && Number(limit) !== 1) throw new QuizError('NOT_ELIGIBLE', 'limit must be 1 (one first) or empty (the rest)');
  const group = getGroup(db, groupId);
  if (posting.has(group.id)) throw new QuizError('BUSY', 'Marks for this quiz are already being posted');
  posting.add(group.id);
  let client = null;
  try {
    const all = waitingMarks(db, group.id);
    const eligible = all.filter(w => !w.skip);
    const batch = limit == null ? [...eligible].sort(byName) : eligible.slice(0, 1);
    const results = limit == null ? all.filter(w => w.skip).map(w => resultLine(w, 'skipped', w.skip)) : [];
    if (batch.length) client = await deps.openClient({});
    // One group per member test and question, in batch order (one page each).
    const groups = new Map();
    for (const w of batch) {
      const key = `${w.memberSid}:${w.qid}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(w);
    }
    for (const marks of groups.values()) {
      let out;
      try {
        out = await postGroup(db, client, marks);
      } catch (err) {
        for (const r of err?.partial || []) { record(db, r.w, r.status, r.error); results.push(resultLine(r.w, r.status, r.error)); }
        for (const w of err?.halfWritten || []) { record(db, w, 'failed', `${HALF}: post it again`); results.push(resultLine(w, 'failed', `${HALF}: post it again`)); }
        if (err?.code === 'NO_SESSION') throw err;
        out = marks.filter(w => !(err?.halfWritten || []).includes(w) && !(err?.partial || []).some(r => r.w === w))
          .map(w => ({ w, status: 'failed', error: String(err?.message || err) }));
      }
      for (const r of out) {
        const recorded = record(db, r.w, r.status, r.error);
        results.push(recorded ? resultLine(r.w, r.status, r.error)
          : resultLine(r.w, 'failed', 'Changed in Prism during the post: Schoology has the earlier version, post it again'));
      }
      const unsafe = out.find(r => r.unsafe);
      if (unsafe) throw new QuizError('UNSAFE', `${unsafe.w.name}: ${unsafe.error}. Posting stopped; check this question in Schoology`);
    }
    return { results, remaining: waitingMarks(db, group.id).filter(w => !w.skip).length };
  } finally {
    posting.delete(group.id);
    if (client) await client.close().catch(() => {});
  }
}
