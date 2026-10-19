// Prism posts accepted FRQ marks to the student's test attempt (linked quizzes phase 4b, spec §14).
// The request is the attempt form's own POST (phase 4a probe): the freshly loaded form, with only
// the essay's level, points, override and comment changed. Before each write the attempt is re-read
// and a mark changed in Schoology is refused; after it the attempt is read back. Behind quiz_writeback.
import { noteSessionLive } from './schoologySession.js';
import { cookieJar, getResource, sendOnce, drupalSettings, WebSessionError } from './schoologyWeb.js';
import { QuizError } from './quizError.js';
import { getGroup } from './quizGroups.js';
import { openHttpReader } from './quizLoader.js';
import { schoologyMarkOf } from './frqMarks.js';
import { levelNameFor } from '../lib/parseQuizRubric.js';
import { studentFullName } from './studentNames.js';
import { serializeForm, BYQ_FORM, submissionPrefix, fieldsAt, withMarkAt, namesAt, byQuestionRubrics, changedNames, toBody } from '../lib/attemptForm.js';
import { parseQuizQuestions } from '../lib/parseQuizQuestions.js';
import { parseRubricGradeInfo } from '../lib/parseQuizRubric.js';
import { holdGroup } from './quizLocks.js';

// The grade-by-question page (spec §15): one form for the class on one question.
const BYQ_PATH = /^\/assignment\/\d+\/assessment_results\/question_stats\/\d+\/\d+$/;
const GRADE_PATH = /^\/iapi\/grades\/assessment_component_submission_rubric_grade_info\/\d+\/\d+\/\d+\/\d+$/;
const gradePath = (launch, qid, attemptId) => `/iapi/grades/assessment_component_submission_rubric_grade_info/${launch.rubricId}/${qid}/${launch.enrollmentId}/${attemptId}`;
const parse = (t, fallback = null) => (t ? JSON.parse(t) : fallback);

const EXPIRED = 'Schoology connection expired while posting: reconnect in Settings';
const SAVE_TIMEOUT_MS = 30000;

// The production client, over plain HTTP with the saved session's cookies (#141): the loader's HTTP
// reader, the rubric PUT and the by-question form POST. The rubric PUT carries Drupal's CSRF pair from
// /home (read once), the page the browser client took it from. A save sent to sign-in stops the batch
// with NO_SESSION; a save that fails outright (HTTP 0) checks the session as the reader does: a sign-in
// bounce is NO_SESSION, an unreachable Schoology UNREACHABLE, else the failure is returned for that
// student. Each save waits the same short pause as each read (spec §14), so the rubric save and the
// form save never go back to back. Saves are sent once and never retried.
// `web` = { jar, fetchImpl? } (default: the saved session); no jar = NO_SESSION.
export async function openClient({ pauseMs = 400, web = sessionWeb(), sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const reader = openHttpReader({ web, pauseMs, expired: EXPIRED, sleep });
  const io = { fetchImpl: web.fetchImpl ?? fetch, timeoutMs: SAVE_TIMEOUT_MS };
  const send = async (path, opts) => {
    if (pauseMs) await sleep(pauseMs);
    let r;
    try {
      const res = await sendOnce(web.jar, path, { ...io, ...opts });
      r = { status: res.status, finalUrl: res.location ?? res.url };
    } catch (err) {
      if (err instanceof WebSessionError && err.code === 'SESSION_EXPIRED') {
        noteSessionLive('expired', 'Schoology sent the saved session to the login page');
        throw new QuizError('NO_SESSION', EXPIRED);
      }
      r = { status: 0, error: String(err?.message || err) };
    }
    if (r.status === 0) await reader.recheck();
    return r;
  };
  let csrf = null;
  const csrfPair = async () => {
    if (csrf) return csrf;
    let home;
    try {
      home = await getResource(web.jar, '/home', io);
    } catch (err) {
      if (err instanceof WebSessionError && err.code === 'SESSION_EXPIRED') {
        noteSessionLive('expired', 'Schoology sent the saved session to the login page');
        throw new QuizError('NO_SESSION', EXPIRED);
      }
      throw new QuizError('UNREACHABLE', 'Could not reach Schoology: try again');
    }
    const s = drupalSettings(home.text)?.s_common;
    if (s?.csrf_token && s?.csrf_key) csrf = s;
    return csrf;
  };
  const post = async (path, body) => {
    if (!BYQ_PATH.test(path)) throw new Error(`Refusing to post to ${path}`);
    return send(path, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  };
  const putRubric = async (path, json) => {
    if (!GRADE_PATH.test(path)) throw new Error(`Refusing to put to ${path}`);
    const pair = await csrfPair();
    if (!pair) return { status: 0, error: 'no CSRF values on the page' };
    return send(path, {
      method: 'PUT', body: JSON.stringify(json),
      headers: { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', 'X-Csrf-Token': pair.csrf_token, 'X-Csrf-Key': pair.csrf_key },
    });
  };
  return { get: reader.get, post, putRubric, close: reader.close };
}

// The saved session's cookies, or no jar (→ NO_SESSION) when there is none or it is unreadable.
function sessionWeb() {
  try { return { jar: cookieJar(), fetchImpl: fetch }; } catch { return { jar: null }; }
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

// Before each post the mark must still be the one listed (the teacher can edit a card during a batch).
const stillWaiting = (db, w) => !!db.prepare(`SELECT 1 FROM frq_marks WHERE attempt_id = ? AND question_id = ?
  AND writeback_status IN ('pending', 'failed') AND final_cells_json = ? AND COALESCE(final_comment, '') = ?`)
  .get(w.attemptId, w.questionId, w.finalCellsJson, w.finalComment);

// The checks of §14 for one student on the page: the right attempt, question and rubric, the points
// worth the rubric's top level, and nothing changed in Schoology since the last load (the rubric grade
// may already be Prism's own, after a half-written post). → { fields, grade, giPath } or { error }.
async function checkOne(db, client, w, form, rubrics) {
  if (!stillWaiting(db, w)) return { error: 'Changed in Prism before posting: post it again', unrecorded: true };
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
const UNCONFIRMED = 'The form was saved but the read-back failed: check it in Schoology, then load the results again';
// After a rubric save the whole mark may already be in Schoology (the PUT saves an already-marked essay's
// points and comment too), so a retry starts from a fresh load.
const RUBRIC_ONLY = 'The rubric level was saved in Schoology; the rest is not confirmed: load the results again, then post';

// Finds the question's grade-by-question page: by question id, as the real index links it
// (question_stats/{question id}/{number}), else by the copy's own question number. The member test's
// index and question list are read once per batch (`pages`, keyed by member test).
async function questionPage(client, memberSid, qid, pages) {
  const once = (path) => {
    // Only a page that loaded is kept: a failed read is tried again by the next question.
    if (!pages.has(path)) {
      pages.set(path, client.get(path).then(
        (r) => { if (r.status !== 200) pages.delete(path); return r; },
        (err) => { pages.delete(path); throw err; }));
    }
    return pages.get(path);
  };
  const index = await once(`/assignment/${memberSid}/assessment_results/question_stats`);
  const text = index.status === 200 ? String(index.text ?? '') : '';
  const byId = text.match(new RegExp(`href="(/assignment/${memberSid}/assessment_results/question_stats/${qid}/\\d+)"`))?.[1];
  if (byId) return byId;
  const list = await once(`/assignment/${memberSid}/assessment_questions`);
  const number = (list.status === 200 ? parseQuizQuestions(list.text) : null)?.find(x => x.qid === qid)?.number;
  if (!number) return null;
  return text.match(new RegExp(`href="(/assignment/${memberSid}/assessment_results/question_stats/\\d+/${number})"`))?.[1] ?? null;
}

// Every mark for one member test and one question, through that question's grade-by-question page
// (spec §15): the per-student rubric save, a fresh read of the page, then one form save only for the
// students the rubric save did not finish, and one read-back.
// Whatever happens, each mark leaves with a result; a throw carries them (err.results).
async function postGroup(db, client, marks, pages = new Map()) {
  const { memberSid, qid } = marks[0];
  const level = (w, p) => levelNameFor(w.rubric, w.rowId, p) ?? 'no level';
  const results = new Map();
  const set = (w, status, error, extra = {}) => results.set(w, { w, status, error, ...extra });
  const done = () => marks.map(w => results.get(w)).filter(Boolean);
  const ready = [];
  const putSent = [];
  let current = null;
  let posted = false;
  try {
    const qPath = await questionPage(client, memberSid, qid, pages);
    if (!qPath || !BYQ_PATH.test(qPath)) { marks.forEach(w => set(w, 'failed', qPath === null ? 'The question was not found in this test' : 'No grade-by-question page for this question')); return done(); }
    const before = await client.get(qPath);
    const form = before.status === 200 ? serializeForm(before.text, BYQ_FORM) : null;
    if (!form || form.action !== qPath) { marks.forEach(w => set(w, 'failed', `The question page did not load (HTTP ${before.status})`)); return done(); }

    for (const [i, w] of marks.entries()) {
      current = w;
      // Each student is checked against a fresh read of the page: the rubric save writes the comment and
      // points, so a hand edit made since the page loaded would otherwise be overwritten unseen.
      let page = { form, text: before.text };
      if (i > 0) {
        const again = await client.get(qPath);
        const againForm = again.status === 200 ? serializeForm(again.text, BYQ_FORM) : null;
        if (!againForm) { set(w, 'failed', `The question page did not load (HTTP ${again.status})`); continue; }
        page = { form: againForm, text: again.text };
      }
      const c = await checkOne(db, client, w, page.form, byQuestionRubrics(page.text));
      if (c.error) { set(w, 'failed', c.error, { unrecorded: !!c.unrecorded }); continue; }
      if (c.grade !== w.final.points) {
        putSent.push({ w, prefix: submissionPrefix(w.uid, w.schoologyAttemptId) });
        const put = await client.putRubric(c.giPath, { gradeInfo: { [w.rowId]: { grade: w.final.points, comment: '' } }, overrideGrade: null, comment: w.final.comment });
        if (put.status !== 200) { set(w, 'failed', `Schoology refused the rubric save (${put.error || `HTTP ${put.status}`}): the form was not posted`); continue; }
        const check = await client.get(c.giPath, { json: true });
        const cells = check.status === 200 ? parseRubricGradeInfo(check.json) : null;
        const saved = cells ? cells[w.rowId]?.points ?? null : undefined;
        if (saved !== w.final.points) { set(w, 'failed', `The rubric save did not take (Schoology shows ${saved === undefined ? 'nothing readable' : level(w, saved)}): the form was not posted`); continue; }
        ready.push({ w, giPath: c.giPath, prefix: submissionPrefix(w.uid, w.schoologyAttemptId), cells });
        continue;
      }
      ready.push({ w, giPath: c.giPath, prefix: submissionPrefix(w.uid, w.schoologyAttemptId), cells: null });
    }
    current = null;
    if (!ready.length) return done();

    // Read the page again. The rubric save also sets an already-marked essay's points, rubric score and
    // comment (2026-10-13 round trip), so those may now equal Prism's values; any other difference is a
    // hand edit made meanwhile and is never sent back. Students already at Prism's mark need no form save.
    const fresh = await client.get(qPath);
    const freshForm = fresh.status === 200 ? serializeForm(fresh.text, BYQ_FORM) : null;
    // Every student whose rubric save was sent may now show Prism's values, even one Prism saw fail.
    const target = new Map([...ready, ...putSent].flatMap(r => [
      [`${r.prefix}[points]`, String(r.w.final.points)], [`${r.prefix}[rubric_score]`, String(r.w.final.points)],
      [`${r.prefix}[override]`, '1'], [`${r.prefix}[comment]`, lf(r.w.final.comment)],
    ]));
    const freshValues = freshForm ? new Map(freshForm.pairs) : null;
    const reachedTarget = (n) => target.has(n) && freshValues.has(n) && (n.endsWith('[comment]') ? lf(freshValues.get(n)) : freshValues.get(n)) === target.get(n);
    // A student refused this run keeps whatever Schoology now holds: they are not posted, and the form
    // save is built from this fresh read, so their own fields are left out of the comparison.
    const readyOrSent = new Set([...ready, ...putSent].map(r => r.w));
    const refusedNames = new Set(marks.filter(w => !readyOrSent.has(w) && results.has(w)).flatMap(w => namesAt(submissionPrefix(w.uid, w.schoologyAttemptId))));
    const moved = freshForm ? changedNames(form.pairs, freshForm.pairs).filter(n => !reachedTarget(n) && !refusedNames.has(n)) : ['the page'];
    if (moved.length || ready.some(r => !stillWaiting(db, r.w))) {
      for (const r of ready) set(r.w, 'failed', `${HALF}: the question page changed during the post, load the results again`);
      return done();
    }
    const atFinal = (pairs, r) => {
      const f = fieldsAt(pairs, r.prefix);
      return !!f && f.points === r.w.final.points && f.rubricScore === r.w.final.points && f.override === 1 && lf(f.comment) === lf(r.w.final.comment);
    };
    const needForm = ready.filter(r => !atFinal(freshForm.pairs, r));

    let afterForm = freshForm;
    if (needForm.length) {
      await client.post(qPath, toBody(needForm.reduce((pairs, r) => withMarkAt(pairs, r.prefix, r.w.final), freshForm.pairs)));
      posted = true;
      const after = await client.get(qPath);
      afterForm = after.status === 200 ? serializeForm(after.text, BYQ_FORM) : null;
      if (!afterForm) { for (const r of ready) set(r.w, 'failed', UNCONFIRMED); return done(); }
      const allowed = new Set(needForm.flatMap(r => namesAt(r.prefix)));
      const others = changedNames(freshForm.pairs, afterForm.pairs).filter(n => !allowed.has(n));
      if (others.length) { for (const r of ready) set(r.w, 'failed', `Posted, but other fields changed: ${others.join(', ')}`, { unsafe: true }); return done(); }
    }
    for (const r of ready) {
      const w = r.w;
      const got = fieldsAt(afterForm.pairs, r.prefix);
      if (!atFinal(afterForm.pairs, r)) {
        set(w, 'failed', `${HALF}: the form shows rubric score ${got?.rubricScore ?? 'empty'}, points ${got?.points ?? 'empty'}${got && lf(got.comment) === lf(w.final.comment) ? '' : ' and a different comment'}; post it again`);
        continue;
      }
      // The grade the PUT step just confirmed stands when no form save followed; otherwise read it back.
      let cells = posted || !r.cells ? null : r.cells;
      if (!cells) {
        const gi = await client.get(r.giPath, { json: true });
        cells = gi.status === 200 ? parseRubricGradeInfo(gi.json) : null;
      }
      if (!cells || cells[w.rowId]?.points !== w.final.points) {
        set(w, 'failed', `The form saved, but Schoology's rubric shows ${cells ? level(w, cells[w.rowId]?.points) : 'nothing readable'}: check it in Schoology`);
        continue;
      }
      db.prepare(`UPDATE quiz_responses SET points = ?, schoology_rubric_cells_json = ?, schoology_comment = ? WHERE attempt_id = ? AND question_id = ?`)
        .run(got.points, JSON.stringify(cells), got.comment.replace(/\r\n/g, '\n'), w.attemptId, w.questionId);
      set(w, 'posted', null);
    }
    return done();
  } catch (err) {
    // Every mark leaves with an honest result: a rubric saved without its form is half-written; after the
    // form save, an unchecked mark is unconfirmed; the mark whose request failed is unknown.
    for (const r of ready) if (!results.has(r.w)) set(r.w, 'failed', posted ? UNCONFIRMED : RUBRIC_ONLY);
    if (current && !results.has(current)) set(current, 'failed', 'The connection ended during this student\'s rubric save: load the results again, then post');
    for (const w of marks) if (!results.has(w)) set(w, 'failed', `Not posted: ${String(err?.message || err)}`);
    err.results = done();
    throw err;
  }
}

const resultLine = (w, status, error) => ({
  student_id: w.studentId, name: w.name, question: w.position,
  level: w.final ? levelNameFor(w.rubric, w.rowId, w.final.points) : null, status, error,
});

export async function postWritebacks(db, { groupId, limit = null }, deps = { openClient }) {
  if (limit != null && Number(limit) !== 1) throw new QuizError('NOT_ELIGIBLE', 'limit must be 1 (one first) or empty (the rest)');
  const group = getGroup(db, groupId);
  const release = holdGroup(group.id, 'posting');
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
    const pages = new Map();
    for (const marks of groups.values()) {
      let out;
      let thrown = null;
      try {
        out = await postGroup(db, client, marks, pages);
      } catch (err) {
        thrown = err;
        out = err?.results || marks.map(w => ({ w, status: 'failed', error: String(err?.message || err) }));
      }
      for (const r of out) {
        // A mark Prism refused because it changed in Prism keeps its new text, unrecorded.
        if (r.unrecorded) { results.push(resultLine(r.w, r.status, r.error)); continue; }
        const recorded = record(db, r.w, r.status, r.error);
        results.push(recorded ? resultLine(r.w, r.status, r.error)
          : resultLine(r.w, 'failed', r.status === 'posted' || r.error?.startsWith(HALF) || r.error === UNCONFIRMED
            ? 'Changed in Prism during the post: Schoology has the earlier version, post it again'
            : 'Changed in Prism before posting: post it again'));
      }
      if (thrown?.code === 'NO_SESSION' || thrown?.code === 'UNREACHABLE') throw thrown;
      const unsafe = out.find(r => r.unsafe);
      if (unsafe) throw new QuizError('UNSAFE', `${unsafe.w.name}: ${unsafe.error}. Posting stopped; check this question in Schoology`);
    }
    return { results, remaining: waitingMarks(db, group.id).filter(w => !w.skip).length };
  } finally {
    release();
    if (client) await client.close().catch(() => {});
  }
}
