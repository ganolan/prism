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
import { serializeAttemptForm, essayFields, withEssayMark, changedNames, essayNames, toBody, rubricLaunch } from '../lib/attemptForm.js';
import { parseRubricGradeInfo } from '../lib/parseQuizRubric.js';
import { posting } from './quizLocks.js';

const ATTEMPT_PATH = /^\/assignment\/\d+\/assessment_results\/student_stats\/\d+\/\d+$/;
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

// The production client: the loader's logged-in reader, the rubric PUT and the form POST.
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

const formMark = (fields, rowId) => (fields.rubricScore == null && !fields.comment.trim()
  ? null : { cells: fields.rubricScore == null ? {} : { [rowId]: fields.rubricScore }, comment: fields.comment });

const HALF = 'The rubric level was saved in Schoology but the form was not';

async function postOne(db, client, w) {
  if (!ATTEMPT_PATH.test(w.path)) return { status: 'failed', error: `${w.path} is not a test attempt address: nothing was posted` };
  const before = await client.get(w.path);
  const form = before.status === 200 ? serializeAttemptForm(before.text) : null;
  if (!form) return { status: 'failed', error: `The attempt page did not load (HTTP ${before.status})` };
  const now = essayFields(form.pairs, w.qid);
  if (!now) return { status: 'failed', error: 'The question was not found on the attempt page' };
  const top = Math.max(...w.rubric.rows[0].levels.map(l => l.points));
  if (now.maxPoints != null && now.maxPoints !== top) {
    return { status: 'failed', error: `Post this one by hand: the question is worth ${now.maxPoints} points and the rubric's top level ${top}` };
  }
  const attemptId = w.path.split('/').pop();
  const launch = rubricLaunch(before.text, w.qid);
  if (!launch) return { status: 'failed', error: 'The question\'s rubric was not found on the attempt page' };
  if (String(launch.rubricId) !== String(w.rubric.id)) return { status: 'failed', error: 'Post this one by hand: the question has a different rubric in Schoology' };
  const giPath = gradePath(launch, w.qid, attemptId);
  const giBefore = await client.get(giPath, { json: true });
  const gradeNow = giBefore.status === 200 ? parseRubricGradeInfo(giBefore.json) : null;
  if (!gradeNow) return { status: 'failed', error: `The rubric grade did not load (HTTP ${giBefore.status})` };

  // A hand edit since the last load is never overwritten: the points box, the comment, or the rubric
  // level. The rubric level may also already be Prism's own (an earlier post saved the rubric, not the form).
  const response = db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ? AND question_id = ?').get(w.attemptId, w.questionId);
  const stored = schoologyMarkOf(response, w.rubric);
  const storedGrade = stored?.cells?.[w.rowId] ?? null;
  const grade = gradeNow[w.rowId]?.points ?? null;
  const pointsMoved = response?.points != null && now.points !== Number(response.points);
  const commentMoved = lf(now.comment) !== lf(stored?.comment ?? '');
  const gradeMoved = grade !== storedGrade && grade !== w.final.points;
  if (pointsMoved || commentMoved || gradeMoved) return { status: 'failed', error: 'Changed in Schoology since the last load' };

  // Two requests, as Schoology's own page sends them (stage C): the rubric cell, then the form.
  const level = (p) => levelNameFor(w.rubric, w.rowId, p) ?? 'no level';
  if (grade !== w.final.points) {
    const put = await client.putRubric(giPath, { gradeInfo: { [w.rowId]: { grade: w.final.points, comment: '' } }, overrideGrade: null, comment: w.final.comment });
    if (put.status !== 200) return { status: 'failed', error: `Schoology refused the rubric save (${put.error || `HTTP ${put.status}`}): the form was not posted` };
    const check = await client.get(giPath, { json: true });
    const saved = check.status === 200 ? parseRubricGradeInfo(check.json)?.[w.rowId]?.points ?? null : undefined;
    if (saved !== w.final.points) return { status: 'failed', error: `The rubric save did not take (Schoology shows ${saved === undefined ? 'nothing readable' : level(saved)}): the form was not posted` };
  }
  try {
    await client.post(w.path, toBody(withEssayMark(form.pairs, w.qid, w.final)));
  } catch (err) {
    err.halfWritten = true;
    throw err;
  }

  const after = await client.get(w.path);
  const afterForm = after.status === 200 ? serializeAttemptForm(after.text) : null;
  const got = afterForm && essayFields(afterForm.pairs, w.qid);
  if (!got) return { status: 'failed', error: `${HALF}: the attempt page did not load afterwards, check it in Schoology` };
  const others = changedNames(form.pairs, afterForm.pairs).filter(n => !essayNames(w.qid).includes(n));
  if (others.length) return { status: 'failed', unsafe: true, error: `Posted, but other fields changed: ${others.join(', ')}` };
  if (got.rubricScore !== w.final.points || got.points !== w.final.points || got.override !== 1 || lf(got.comment) !== lf(w.final.comment)) {
    return { status: 'failed', error: `${HALF}: the form shows rubric score ${got.rubricScore ?? 'empty'}, points ${got.points ?? 'empty'}${lf(got.comment) === lf(w.final.comment) ? '' : ' and a different comment'}; post it again` };
  }
  const gi = await client.get(giPath, { json: true });
  const cells = gi.status === 200 ? parseRubricGradeInfo(gi.json) : null;
  if (!cells || cells[w.rowId]?.points !== w.final.points) {
    return { status: 'failed', error: `The form saved, but Schoology's rubric shows ${cells ? level(cells[w.rowId]?.points) : 'nothing readable'}: check it in Schoology` };
  }
  db.prepare(`UPDATE quiz_responses SET points = ?, schoology_rubric_cells_json = ?, schoology_comment = ? WHERE attempt_id = ? AND question_id = ?`)
    .run(got.points, JSON.stringify(cells), got.comment.replace(/\r\n/g, '\n'), w.attemptId, w.questionId);
  return { status: 'posted', error: null };
}

const resultLine = (w, status, error) => ({
  student_id: w.studentId, name: w.name, question: w.position,
  level: w.final ? levelNameFor(w.rubric, w.rowId, w.final.points) : null, status, error,
});

// Before each post the mark must still be the one listed (the teacher can edit a card during a batch).
const stillWaiting = (db, w) => !!db.prepare(`SELECT 1 FROM frq_marks WHERE attempt_id = ? AND question_id = ?
  AND writeback_status IN ('pending', 'failed') AND final_cells_json = ? AND COALESCE(final_comment, '') = ?`)
  .get(w.attemptId, w.questionId, w.finalCellsJson, w.finalComment);

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
    for (const w of batch) {
      if (!stillWaiting(db, w)) { results.push(resultLine(w, 'failed', 'Changed in Prism before posting: post it again')); continue; }
      let r;
      try {
        r = await postOne(db, client, w);
      } catch (err) {
        if (err?.halfWritten) record(db, w, 'failed', `${HALF}: post it again`);
        if (err?.code === 'NO_SESSION') throw err;
        r = { status: 'failed', error: err?.halfWritten ? `${HALF}: post it again` : String(err?.message || err) };
      }
      const recorded = record(db, w, r.status, r.error);
      results.push(recorded ? resultLine(w, r.status, r.error)
        : resultLine(w, 'failed', 'Changed in Prism during the post: Schoology has the earlier version, post it again'));
      if (r.unsafe) throw new QuizError('UNSAFE', `${w.name}: ${r.error}. Posting stopped; check this attempt in Schoology`);
    }
    return { results, remaining: waitingMarks(db, group.id).filter(w => !w.skip).length };
  } finally {
    posting.delete(group.id);
    if (client) await client.close().catch(() => {});
  }
}
