import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { postWritebacks, waitingMarks } from './quizWriteback.js';
import { writeFrqSuggestions, setFrqMark, recordWriteback } from './frqMarks.js';
import { posting } from './quizLocks.js';
import { serializeForm, BYQ_FORM } from '../lib/attemptForm.js';
import { QuizError } from './quizError.js';

const RUBRIC = { id: '91', title: 'FRQ', rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth' }, { points: 3, name: 'Exhibiting' }, { points: 2, name: 'Developing' }, { points: 1, name: 'Emerging' }] }] };

// A fake Schoology: each attempt page holds form values; a POST stores the posted values. Options simulate
// a save Schoology ignores or applies only in part, an expired session, and a change to another field.
// A fake Schoology for posting by question (spec §15, stage D). Per member test: a question list
// (qid -> number), the by-question index, and one class-wide page per question. The rubric PUT changes a
// student's rubric grade (stage C); the page's form POST changes points, score and comment only.
function fakeSchoology(subs, { questions = { 900: { 2001: 21 }, 901: { 3001: 21 } }, ignorePost = false, expireAfterPosts = Infinity, applyPoints = true,
  gradeInfoStale = false, putStatus = 200, putError = null, mutateOther = false, maxPoints = 4, onPost = null, pageAttempt = {}, missingPage = false,
  onPut = null, putThrowAt = 0, readBackThrows = false, onFirstGet = null, linkById = true, putSetsForm = false } = {}) {
  const state = new Map(Object.entries(subs).map(([a, v]) => [a, { grade: v.score, ...v }]));
  const calls = [];
  let posts = 0, puts = 0, gets = 0;
  // The real index links each question as question_stats/{question id}/{number} (stage D page).
  const qidOf = (sid, n) => Object.entries(questions[sid] || {}).find(([, num]) => num === Number(n))?.[0];
  const pagePath = (sid, n) => `/assignment/${sid}/assessment_results/question_stats/${linkById ? qidOf(sid, n) : 77}/${n}`;
  const onPage = (sid, n) => [...state.entries()].filter(([, v]) => v.member === sid && questions[sid]?.[v.qid] === Number(n));
  const shown = (a) => pageAttempt[a] ?? a;
  const render = (sid, n) => {
    const rows = onPage(sid, n);
    return `<form id="s-assessment-view-question-responses-form" action="${pagePath(sid, n)}">${rows.map(([a, v]) => {
      const pre = `students[${v.uid}][submissions][${shown(a)}]`;
      return `<input type="hidden" name="${pre}[points]" value="${v.points}"><input type="hidden" name="${pre}[override]" value="${v.override}">
        <input type="hidden" name="${pre}[original_points]" value="0"><input type="hidden" name="${pre}[max_points]" value="${maxPoints}">
        <input type="hidden" name="${pre}[rubric_score]" value="${v.score}"><textarea name="${pre}[comment]">${v.comment}</textarea>`;
    }).join('')}<input type="submit" name="op" value="Save Changes"><input type="hidden" name="form_build_id" value="b${Math.random()}">
      <input type="hidden" name="form_token" value="t"><input type="hidden" name="form_id" value="s_assessment_view_question_responses_form"></form>
      <script>{${rows.map(([a, v], i) => `"r${i}":{"template":"s_grades_rubric_grading_launch_btn","module":"gradingRubric","args":["91","92","${v.qid}","x",1,1,"${shown(a)}",${maxPoints},false,false]}`).join(',')}}</script>`;
  };
  const client = {
    get: vi.fn(async (path) => {
      calls.push(['GET', path]);
      gets += 1;
      if (gets === 1 && onFirstGet) onFirstGet();
      let m = path.match(/rubric_grade_info\/91\/(\d+)\/92\/(\d+)$/);
      if (m) {
        if (readBackThrows && posts > 0) throw new QuizError('NO_SESSION', 'Schoology connection expired: reconnect in Settings');
        const v = state.get(m[2]);
        return { status: v ? 200 : 404, text: '', finalUrl: path, json: v ? { response_code: 200, body: { gradeInfo: { 146: { grade: String(v.grade ?? ''), comment: '' } } } } : null };
      }
      if ((m = path.match(/^\/assignment\/(\d+)\/assessment_questions$/))) {
        const qs = questions[m[1]] || {};
        return { status: 200, finalUrl: path, text: `<table>${Object.entries(qs).map(([qid, n]) => `<tr><td class="component-number">${n}</td><td><input name="components[${qid}][delta]" value="${n}"><div class="component-summary-wrapper component-essay"><div class="component-title">E</div></div></td></tr>`).join('')}</table>` };
      }
      if ((m = path.match(/^\/assignment\/(\d+)\/assessment_results\/question_stats$/))) {
        return { status: 200, finalUrl: path, text: Object.values(questions[m[1]] || {}).map(n => `<a href="${pagePath(m[1], n)}">Q${n}</a>`).join('') };
      }
      if ((m = path.match(/^\/assignment\/(\d+)\/assessment_results\/question_stats\/\d+\/(\d+)$/))) {
        if (missingPage) return { status: 404, text: '', finalUrl: path };
        return { status: 200, finalUrl: path, text: render(m[1], m[2]) };
      }
      return { status: 404, text: '', finalUrl: path };
    }),
    post: vi.fn(async (path, body) => {
      calls.push(['POST', path, body]);
      posts += 1;
      if (posts > expireAfterPosts) throw new QuizError('NO_SESSION', 'Schoology connection expired: reconnect in Settings');
      if (onPost) onPost(path);
      if (ignorePost) return { status: 302, finalUrl: path };
      const [, sid, n] = path.match(/^\/assignment\/(\d+)\/assessment_results\/question_stats\/\d+\/(\d+)$/);
      const p = new URLSearchParams(body);
      let tampered = false;
      for (const [a, v] of onPage(sid, n)) {
        const pre = `students[${v.uid}][submissions][${shown(a)}]`;
        const next = { ...v, points: applyPoints ? p.get(`${pre}[points]`) : v.points, override: p.get(`${pre}[override]`), score: p.get(`${pre}[rubric_score]`), comment: p.get(`${pre}[comment]`) };
        const changed = next.score !== v.score || next.comment !== v.comment;
        if (mutateOther && !changed && !tampered) { next.comment = 'tampered'; tampered = true; }
        state.set(a, next);
      }
      return { status: 302, finalUrl: path };
    }),
    putRubric: vi.fn(async (path, json) => {
      calls.push(['PUT', path, json]);
      puts += 1;
      if (putThrowAt && puts === putThrowAt) throw new QuizError('NO_SESSION', 'Schoology connection expired: reconnect in Settings');
      if (onPut) onPut(state);
      if (putStatus !== 200) return { status: putStatus, error: putError };
      const a = path.match(/\/(\d+)$/)[1];
      const grade = String(json.gradeInfo['146'].grade);
      // As observed for an essay already marked: the PUT also sets points, rubric score and comment.
      if (!gradeInfoStale) state.set(a, { ...state.get(a), grade, ...(putSetsForm ? { points: grade, score: grade, comment: json.comment } : {}) });
      return { status: 200 };
    }),
    close: vi.fn(async () => {}),
  };
  return { client, calls, state };
}

let db, g, std, ext, q, att;
const QIDS = { 900: { 21: '2001', 22: '2002' }, 901: { 21: '3001', 5: '3001' } };
const page = (sid, n = 21) => `/assignment/${sid}/assessment_results/question_stats/${QIDS[sid][n]}/${n}`;
const gi = (qid, a) => `/iapi/grades/assessment_component_submission_rubric_grade_info/91/${qid}/92/${a}`;
beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'C')`).run().lastInsertRowid;
  std = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'T', 1)`).run(c).lastInsertRowid;
  ext = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '901', 'T *', 1)`).run(c).lastInsertRowid;
  g = db.prepare(`INSERT INTO quiz_groups (course_id, title, loaded_at) VALUES (?, 'T', 'x')`).run(c).lastInsertRowid;
  for (const a of [std, ext]) db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)').run(g, a);
  q = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json) VALUES (?, 21, 'frq', 'E', 4, ?)`).run(g, JSON.stringify(RUBRIC)).lastInsertRowid;
  db.prepare(`INSERT INTO quiz_question_copies (question_id, assignment_id, schoology_question_id) VALUES (?, ?, '2001'), (?, ?, '3001')`).run(q, std, q, ext);
  att = {};
  for (const [uid, last, member, aid] of [['701', 'Lee', std, '5001'], ['702', 'Ng', ext, '6001'], ['703', 'Wu', std, '5003']]) {
    const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Ana', ?)`).run(uid, last).lastInsertRowid;
    att[uid] = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, ?, 'now')`).run(g, member, s, aid).lastInsertRowid;
    db.prepare(`INSERT INTO quiz_responses (attempt_id, question_id, answer_html, points, schoology_rubric_cells_json, schoology_comment) VALUES (?, ?, 'a', 2, ?, 'Old')`)
      .run(att[uid], q, JSON.stringify({ 146: { points: 2, comment: '' } }));
  }
  writeFrqSuggestions(db, { groupId: g, position: 21, students: [
    { student: '701', level: 'Exhibiting', comment: 'New line one\nline two' },
    { student: '702', level: 'Exhibiting Depth', comment: 'All parts.' },
  ] });
  setFrqMark(db, { groupId: g, attemptId: att['701'], position: 21, action: 'accept' });
  setFrqMark(db, { groupId: g, attemptId: att['702'], position: 21, action: 'accept' });
});
// Ana Wu (703) sits on the standard copy's page with no Prism mark unless a test gives her one.
const subsNow = () => ({
  5001: { member: '900', qid: '2001', uid: '701', points: '2', override: '1', score: '2', comment: 'Old' },
  6001: { member: '901', qid: '3001', uid: '702', points: '2', override: '1', score: '2', comment: 'Old' },
  5003: { member: '900', qid: '2001', uid: '703', points: '2', override: '1', score: '2', comment: 'Old' },
});
const mark = (uid) => db.prepare('SELECT * FROM frq_marks WHERE attempt_id = ?').get(att[uid]);
const acceptWu = (level = 'Developing', comment = 'Wu comment') => {
  writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: '703', level, comment }] });
  setFrqMark(db, { groupId: g, attemptId: att['703'], position: 21, action: 'accept' });
};
const run = (f, limit) => postWritebacks(db, { groupId: g, limit }, { openClient: async () => f.client });
const postBody = (f, sid) => new URLSearchParams(f.calls.find(c => c[0] === 'POST' && c[1] === page(sid))[2]);

describe('waitingMarks', () => {
  test('accepted marks with their own copy\'s question id, uid and attempt, waiting before failed, by name', () => {
    const w = waitingMarks(db, g);
    expect(w.map(x => [x.name, x.qid, x.memberSid, x.uid, x.schoologyAttemptId, x.final.points])).toEqual([
      ['Ana Lee', '2001', '900', '701', '5001', 3],
      ['Ana Ng', '3001', '901', '702', '6001', 4],
    ]);
  });
});

describe('postWritebacks (by question)', () => {
  test('one first: one page, the rubric save, one form save changing only that student, read back, recorded', async () => {
    const f = fakeSchoology(subsNow());
    const r = await run(f, 1);
    expect(r).toEqual({ results: [{ student_id: expect.any(Number), name: 'Ana Lee', question: 21, level: 'Exhibiting', status: 'posted', error: null }], remaining: 1 });
    expect(f.calls.map(c => c.slice(0, 2))).toEqual([
      ['GET', '/assignment/900/assessment_results/question_stats'], ['GET', page('900')],
      ['GET', gi('2001', '5001')], ['PUT', gi('2001', '5001')], ['GET', gi('2001', '5001')],
      ['GET', page('900')], ['POST', page('900')], ['GET', page('900')], ['GET', gi('2001', '5001')],
    ]);
    expect(f.calls.find(c => c[0] === 'PUT')[2]).toEqual({ gradeInfo: { 146: { grade: 3, comment: '' } }, overrideGrade: null, comment: 'New line one\nline two' });
    const body = postBody(f, '900');
    expect([body.get('students[701][submissions][5001][rubric_score]'), body.get('students[703][submissions][5003][rubric_score]'), body.get('students[703][submissions][5003][comment]'), body.get('op')]).toEqual(['3', '2', 'Old', 'Save Changes']);
    expect(mark('701')).toMatchObject({ writeback_status: 'posted', writeback_error: null, posted_comment: 'New line one\nline two' });
    const resp = db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ?').get(att['701']);
    expect([JSON.parse(resp.schoology_rubric_cells_json)[146].points, resp.schoology_comment, resp.points]).toEqual([3, 'New line one\nline two', 3]);
    expect(f.client.close).toHaveBeenCalled();
  });

  test('then the rest: one form save per copy\'s page, each changing only its students', async () => {
    acceptWu();
    const f = fakeSchoology(subsNow());
    const r = await run(f, null);
    expect(r.results.map(x => [x.name, x.status])).toEqual([['Ana Lee', 'posted'], ['Ana Wu', 'posted'], ['Ana Ng', 'posted']]);
    expect(f.calls.filter(c => c[0] === 'POST').map(c => c[1])).toEqual([page('900'), page('901')]);
    const b900 = postBody(f, '900');
    expect([b900.get('students[701][submissions][5001][points]'), b900.get('students[703][submissions][5003][points]')]).toEqual(['3', '2']);
    expect(postBody(f, '901').get('students[702][submissions][6001][rubric_score]')).toBe('4');
  });

  test('two students on one page, one changed by hand: the other is posted in the same save, the refused one sent as loaded', async () => {
    acceptWu();
    const subs = subsNow();
    subs[5001] = { ...subs[5001], points: '3' };
    const f = fakeSchoology(subs);
    const r = await run(f, null);
    expect(r.results.find(x => x.name === 'Ana Lee')).toMatchObject({ status: 'failed', error: 'Changed in Schoology since the last load' });
    expect(r.results.find(x => x.name === 'Ana Wu')).toMatchObject({ status: 'posted' });
    const b = postBody(f, '900');
    expect([b.get('students[701][submissions][5001][points]'), b.get('students[701][submissions][5001][comment]'), b.get('students[703][submissions][5003][rubric_score]')]).toEqual(['3', 'Old', '2']);
    expect(f.calls.some(c => c[0] === 'PUT' && c[1] === gi('2001', '5001'))).toBe(false);
  });

  test('the extra-time copy uses its own question number for its page', async () => {
    db.prepare(`UPDATE frq_marks SET writeback_status = 'posted' WHERE attempt_id = ?`).run(att['701']);
    const f = fakeSchoology(subsNow(), { questions: { 900: { 2001: 21 }, 901: { 3001: 5 } } });
    const r = await run(f, 1);
    expect(r.results[0]).toMatchObject({ name: 'Ana Ng', status: 'posted' });
    expect(f.calls.map(c => c[1])).toContain(page('901', 5));
  });

  test('a mark changed in Schoology since the last load is refused, not posted', async () => {
    const subs = subsNow();
    subs[5001] = { ...subs[5001], score: '1', points: '1' };
    const f = fakeSchoology(subs);
    const r = await run(f, 1);
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'Changed in Schoology since the last load' });
    expect(f.calls.some(c => c[0] === 'POST' || c[0] === 'PUT')).toBe(false);
    expect(mark('701').writeback_status).toBe('failed');
  });

  test('a student whose page attempt is not Prism\'s stored attempt (a retake) is refused', async () => {
    const f = fakeSchoology(subsNow(), { pageAttempt: { 5001: '9999' } });
    const r = await run(f, 1);
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'The attempt on the question page is not the one Prism loaded: load the results again' });
    expect(f.calls.some(c => c[0] === 'POST' || c[0] === 'PUT')).toBe(false);
  });

  test('a read-back that still shows the old mark is half-written, not posted', async () => {
    const f = fakeSchoology(subsNow(), { ignorePost: true });
    const r = await run(f, 1);
    expect(r.results[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/^The rubric level was saved in Schoology but the form was not: the form shows rubric score 2/) });
    expect(mark('701').writeback_status).toBe('failed');
  });

  test('an expired session on the second page stops the batch; the first page\'s result stands', async () => {
    const f = fakeSchoology(subsNow(), { expireAfterPosts: 1 });
    await expect(run(f, null)).rejects.toMatchObject({ code: 'NO_SESSION' });
    expect(mark('701').writeback_status).toBe('posted');
    expect(mark('702')).toMatchObject({ writeback_status: 'failed', writeback_error: 'The rubric level was saved in Schoology but the form was not: post it again' });
    expect(f.client.close).toHaveBeenCalled();
  });

  test('the form save throws after two rubric saves on one page: both are recorded half-written', async () => {
    acceptWu();
    const f = fakeSchoology(subsNow(), { expireAfterPosts: 0 });
    await expect(run(f, null)).rejects.toMatchObject({ code: 'NO_SESSION' });
    for (const uid of ['701', '703']) expect(mark(uid)).toMatchObject({ writeback_status: 'failed', writeback_error: 'The rubric level was saved in Schoology but the form was not: post it again' });
  });

  test('a second post while one runs is refused as busy', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const slow = { get: vi.fn(async () => { await gate; return { status: 404, text: '', finalUrl: '/' }; }), post: vi.fn(), putRubric: vi.fn(), close: vi.fn(async () => {}) };
    const first = postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => slow });
    await new Promise(r => setTimeout(r, 0));
    await expect(postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => slow })).rejects.toMatchObject({ code: 'BUSY' });
    release();
    await first;
  });

  test('a question page that does not load fails its students', async () => {
    const f = fakeSchoology(subsNow(), { missingPage: true });
    const r = await run(f, 1);
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'The question page did not load (HTTP 404)' });
  });

  test('without a link by question id, the copy\'s own number finds the page; a question missing from both fails its students', async () => {
    const byNumber = fakeSchoology(subsNow(), { linkById: false });
    expect((await run(byNumber, 1)).results[0]).toMatchObject({ status: 'posted' });
    expect(byNumber.calls.map(c => c[1])).toContain('/assignment/900/assessment_questions');
    db.prepare(`UPDATE frq_marks SET writeback_status = 'pending' WHERE attempt_id = ?`).run(att['701']);
    const f = fakeSchoology(subsNow(), { questions: { 900: {}, 901: { 3001: 21 } } });
    const r = await run(f, 1);
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'The question was not found in this test' });
  });

  test('a save that kept the old points is failed', async () => {
    const r = await run(fakeSchoology(subsNow(), { applyPoints: false }), 1);
    expect(r.results[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/points 2/) });
  });

  test('a rubric save that did not take stops that student before the form; the stored copy is untouched', async () => {
    const f = fakeSchoology(subsNow(), { gradeInfoStale: true });
    const r = await run(f, 1);
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'The rubric save did not take (Schoology shows Developing): the form was not posted' });
    expect(f.calls.some(c => c[0] === 'POST')).toBe(false);
    expect(JSON.parse(db.prepare('SELECT schoology_rubric_cells_json FROM quiz_responses WHERE attempt_id = ?').get(att['701']).schoology_rubric_cells_json)[146].points).toBe(2);
  });

  test('points changed by hand (rubric untouched) are a conflict', async () => {
    const subs = subsNow();
    subs[5001] = { ...subs[5001], points: '3' };
    const f = fakeSchoology(subs);
    expect((await run(f, 1)).results[0]).toMatchObject({ status: 'failed', error: 'Changed in Schoology since the last load' });
    expect(f.calls.some(c => c[0] === 'POST')).toBe(false);
  });

  test('a question worth more than the rubric\'s top level is refused before any write', async () => {
    const f = fakeSchoology(subsNow(), { maxPoints: 10 });
    expect((await run(f, 1)).results[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/worth 10 points/) });
    expect(f.calls.some(c => c[0] === 'POST' || c[0] === 'PUT')).toBe(false);
  });

  test('a mark edited in Prism during the post is not recorded as posted with the new text', async () => {
    const f = fakeSchoology(subsNow(), { onPost: () => setFrqMark(db, { groupId: g, attemptId: att['701'], position: 21, action: 'save', cells: { 146: 4 }, comment: 'Newer' }) });
    const r = await run(f, 1);
    expect(r.results[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/Changed in Prism during the post/) });
    expect(mark('701')).toMatchObject({ writeback_status: 'pending', final_comment: 'Newer' });
    expect(mark('701').posted_comment).not.toBe('Newer');
  });

  test('an agent cannot record a write-back while Prism is posting the group', () => {
    posting.add(g);
    try {
      expect(() => recordWriteback(db, { groupId: g, student: '701', position: 21, status: 'posted' })).toThrow(/being posted/);
    } finally { posting.delete(g); }
  });

  test('another student\'s field changed in the read-back stops the batch at once', async () => {
    const f = fakeSchoology(subsNow(), { mutateOther: true });
    await expect(run(f, null)).rejects.toMatchObject({ code: 'UNSAFE' });
    expect(mark('701')).toMatchObject({ writeback_status: 'failed', writeback_error: expect.stringMatching(/other fields changed/) });
    expect(f.calls.filter(c => c[0] === 'POST')).toHaveLength(1);
    expect(mark('702').writeback_status).toBe('pending');
  });

  test('one first picks a waiting mark before a failed one', async () => {
    db.prepare(`UPDATE frq_marks SET writeback_status = 'failed', writeback_error = 'x' WHERE attempt_id = ?`).run(att['701']);
    expect((await run(fakeSchoology(subsNow()), 1)).results[0]).toMatchObject({ name: 'Ana Ng', status: 'posted' });
  });

  test('a mark outside the scope (no one-row rubric) is reported as skipped and not counted', async () => {
    const two = { ...RUBRIC, rows: [RUBRIC.rows[0], { ...RUBRIC.rows[0], id: '147', title: 'Code' }] };
    const q22 = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json) VALUES (?, 22, 'frq', 'E2', 8, ?)`).run(g, JSON.stringify(two)).lastInsertRowid;
    db.prepare(`INSERT INTO quiz_question_copies (question_id, assignment_id, schoology_question_id) VALUES (?, ?, '2002')`).run(q22, std);
    db.prepare(`INSERT INTO quiz_responses (attempt_id, question_id, answer_html) VALUES (?, ?, 'a')`).run(att['701'], q22);
    db.prepare(`INSERT INTO frq_marks (attempt_id, question_id, final_cells_json, final_comment, state, writeback_status) VALUES (?, ?, '{"146":4,"147":4}', 'c', 'edited', 'pending')`).run(att['701'], q22);
    const r = await run(fakeSchoology(subsNow()), null);
    expect(r.results.find(x => x.question === 22)).toMatchObject({ status: 'skipped', error: 'Post this one by hand: Prism posts only a one-row Schoology rubric' });
    expect(r.remaining).toBe(0);
  });

  test('limit is 1 or none', async () => {
    await expect(run(fakeSchoology(subsNow()), -1)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
  });

  test('a refused rubric save stops that student before the form is posted', async () => {
    const f = fakeSchoology(subsNow(), { putStatus: 403 });
    expect((await run(f, 1)).results[0]).toMatchObject({ status: 'failed', error: 'Schoology refused the rubric save (HTTP 403): the form was not posted' });
    expect(f.calls.some(c => c[0] === 'POST')).toBe(false);
  });

  test('a rubric grade changed in Schoology since the last load is a conflict, even when the form agrees', async () => {
    const subs = subsNow();
    subs[5001] = { ...subs[5001], grade: '1' };
    const f = fakeSchoology(subs);
    expect((await run(f, 1)).results[0]).toMatchObject({ status: 'failed', error: 'Changed in Schoology since the last load' });
    expect(f.calls.some(c => c[0] === 'PUT' || c[0] === 'POST')).toBe(false);
  });

  test('missing CSRF values are named in the error', async () => {
    const r = await run(fakeSchoology(subsNow(), { putStatus: 0, putError: 'no CSRF values on the page' }), 1);
    expect(r.results[0].error).toBe('Schoology refused the rubric save (no CSRF values on the page): the form was not posted');
  });

  test('a page whose rubric is not the stored one is refused before any write', async () => {
    db.prepare(`UPDATE quiz_questions SET schoology_rubric_json = ? WHERE id = ?`).run(JSON.stringify({ ...RUBRIC, id: '55' }), q);
    const f = fakeSchoology(subsNow());
    expect((await run(f, 1)).results[0]).toMatchObject({ status: 'failed', error: 'Post this one by hand: the question has a different rubric in Schoology' });
    expect(f.calls.some(c => c[0] === 'PUT' || c[0] === 'POST')).toBe(false);
  });

  test('rubric saved, form ignored: half-written, and a retry finishes it without a second rubric save', async () => {
    const f = fakeSchoology(subsNow(), { ignorePost: true });
    expect((await run(f, 1)).results[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/^The rubric level was saved in Schoology but the form was not/) });
    const again = fakeSchoology(Object.fromEntries(f.state));
    const r2 = await run(again, null);
    expect(r2.results.find(x => x.name === 'Ana Lee')).toMatchObject({ status: 'posted' });
    expect(again.calls.some(c => c[0] === 'PUT' && c[1] === gi('2001', '5001'))).toBe(false);
  });

  test('an ungraded answer (no stored mark, empty rubric grade) is not a conflict', async () => {
    db.prepare(`UPDATE quiz_responses SET points = 0, schoology_rubric_cells_json = NULL, schoology_comment = '' WHERE attempt_id = ?`).run(att['701']);
    const subs = subsNow();
    subs[5001] = { ...subs[5001], points: '0', override: '0', score: '', grade: '', comment: '' };
    expect((await run(fakeSchoology(subs), 1)).results[0]).toMatchObject({ status: 'posted' });
  });

  test('a hand edit in Schoology during the batch is never undone by the form save', async () => {
    const f = fakeSchoology(subsNow(), { onPut: (state) => state.set('5003', { ...state.get('5003'), comment: 'Teacher typed this' }) });
    const r = await run(f, 1);
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'The rubric level was saved in Schoology but the form was not: the question page changed during the post, load the results again' });
    expect(f.calls.some(c => c[0] === 'POST')).toBe(false);
    expect(f.state.get('5003').comment).toBe('Teacher typed this');
  });

  test('the session expires on the second student\'s rubric save: the first is recorded half-written, the second as unknown', async () => {
    acceptWu('Exhibiting');
    const f = fakeSchoology(subsNow(), { putThrowAt: 2 });
    await expect(run(f, null)).rejects.toMatchObject({ code: 'NO_SESSION' });
    expect(mark('701')).toMatchObject({ writeback_status: 'failed', writeback_error: 'The rubric level was saved in Schoology but the form was not: post it again' });
    expect(mark('703')).toMatchObject({ writeback_status: 'failed', writeback_error: 'The connection ended during this student\'s rubric save: load the results again, then post' });
  });

  test('the form saved but the read-back failed: recorded as unconfirmed, never left waiting', async () => {
    acceptWu();
    const f = fakeSchoology(subsNow(), { readBackThrows: true });
    await expect(run(f, null)).rejects.toMatchObject({ code: 'NO_SESSION' });
    for (const uid of ['701', '703']) expect(mark(uid)).toMatchObject({ writeback_status: 'failed', writeback_error: 'The form was saved but the read-back failed: check it in Schoology, then load the results again' });
  });

  test('a mark changed in Prism before its turn is reported as such and keeps its new text', async () => {
    const f = fakeSchoology(subsNow(), { onFirstGet: () => setFrqMark(db, { groupId: g, attemptId: att['701'], position: 21, action: 'save', cells: { 146: 4 }, comment: 'Newer' }) });
    const r = await run(f, 1);
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'Changed in Prism before posting: post it again' });
    expect(mark('701')).toMatchObject({ writeback_status: 'pending', final_comment: 'Newer' });
  });

  test('two FRQs on one test: one page and one form save each', async () => {
    const q22 = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json) VALUES (?, 22, 'frq', 'E2', 4, ?)`).run(g, JSON.stringify(RUBRIC)).lastInsertRowid;
    db.prepare(`INSERT INTO quiz_question_copies (question_id, assignment_id, schoology_question_id) VALUES (?, ?, '2002')`).run(q22, std);
    db.prepare(`INSERT INTO quiz_responses (attempt_id, question_id, answer_html, points, schoology_rubric_cells_json, schoology_comment) VALUES (?, ?, 'a', 2, ?, 'Old')`).run(att['701'], q22, JSON.stringify({ 146: { points: 2, comment: '' } }));
    writeFrqSuggestions(db, { groupId: g, position: 22, students: [{ student: '701', level: 'Emerging', comment: 'Q22' }] });
    setFrqMark(db, { groupId: g, attemptId: att['701'], position: 22, action: 'accept' });
    // The fake keeps one submission per attempt, so Q22's page has no row for Ana Lee: she is refused
    // there, and the point is that the second question gets its own page.
    const f = fakeSchoology(subsNow(), { questions: { 900: { 2001: 21, 2002: 22 }, 901: { 3001: 21 } } });
    const r = await run(f, null);
    expect(f.calls.filter(c => c[0] === 'GET' && /question_stats\/\d+\/\d+$/.test(c[1])).map(c => c[1])).toContain(page('900', 21));
    expect(r.results.find(x => x.question === 22)).toMatchObject({ status: 'failed', error: 'The attempt on the question page is not the one Prism loaded: load the results again' });
    expect(f.calls.some(c => c[1] === page('900', 22))).toBe(true);
  });

  test('every name the form save changes belongs to a posted student', async () => {
    acceptWu();
    const f = fakeSchoology(subsNow());
    await run(f, null);
    const posted = f.calls.find(c => c[0] === 'POST' && c[1] === page('900'))[2];
    const before = [...new URLSearchParams(posted)].map(([k]) => k);
    const loaded = serializeForm((await f.client.get(page('900'))).text, BYQ_FORM);
    expect(loaded.pairs.map(([k]) => k)).toEqual(before);
  });

  test('the rubric save alone saves an essay already marked: no form save', async () => {
    const f = fakeSchoology(subsNow(), { putSetsForm: true });
    const r = await run(f, 1);
    expect(r.results[0]).toMatchObject({ name: 'Ana Lee', status: 'posted' });
    expect(f.calls.map(c => c.slice(0, 2))).toEqual([
      ['GET', '/assignment/900/assessment_results/question_stats'], ['GET', page('900')],
      ['GET', gi('2001', '5001')], ['PUT', gi('2001', '5001')], ['GET', gi('2001', '5001')], ['GET', page('900')],
    ]);
    const resp = db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ?').get(att['701']);
    expect([JSON.parse(resp.schoology_rubric_cells_json)[146].points, resp.schoology_comment, resp.points]).toEqual([3, 'New line one\nline two', 3]);
    expect(mark('701').writeback_status).toBe('posted');
  });

  test('two students whose rubric saves set their marks: still no form save', async () => {
    acceptWu('Exhibiting Depth');
    const f = fakeSchoology(subsNow(), { putSetsForm: true });
    const r = await run(f, null);
    expect(r.results.filter(x => x.status === 'posted').map(x => x.name)).toEqual(['Ana Lee', 'Ana Wu', 'Ana Ng']);
    expect(f.calls.some(c => c[0] === 'POST')).toBe(false);
  });

  test('an essay never marked (override 0) keeps its form save after the rubric save', async () => {
    db.prepare(`UPDATE quiz_responses SET points = 0, schoology_rubric_cells_json = NULL, schoology_comment = '' WHERE attempt_id = ?`).run(att['701']);
    const subs = subsNow();
    subs[5001] = { ...subs[5001], points: '0', override: '0', score: '', grade: '', comment: '' };
    const f = fakeSchoology(subs, { putSetsForm: true });
    const r = await run(f, 1);
    expect(r.results[0]).toMatchObject({ status: 'posted' });
    expect(postBody(f, '900').get('students[701][submissions][5001][override]')).toBe('1');
  });
});

