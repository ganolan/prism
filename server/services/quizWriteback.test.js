import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { postWritebacks, waitingMarks } from './quizWriteback.js';
import { writeFrqSuggestions, setFrqMark, recordWriteback } from './frqMarks.js';
import { posting } from './quizLocks.js';
import { QuizError } from './quizError.js';

const RUBRIC = { id: 'r1', title: 'FRQ', rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth' }, { points: 3, name: 'Exhibiting' }, { points: 2, name: 'Developing' }, { points: 1, name: 'Emerging' }] }] };

// A fake Schoology: each attempt page holds form values; a POST stores the posted values. Options simulate
// a save Schoology ignores or applies only in part, an expired session, and a change to another field.
// As observed (stage C): the rubric PUT changes the rubric grade; the form POST changes points, score and comment only.
function fakeSchoology(initial, { ignorePost = false, expireAfterPosts = Infinity, applyPoints = true, gradeInfoStale = false, putStatus = 200, mutateOther = false, maxPoints = 4, onPost = null } = {}) {
  const pages = new Map(Object.entries(initial).map(([k, v]) => [k, { grade: v.score, other: '1', ...v }]));
  const calls = [];
  let posts = 0;
  const render = (path, v) => `<form id="s-assessment-edit-submission-form" action="${path}">
    <input type="hidden" name="components[0][1001][points]" value="${v.other}"><input type="hidden" name="components[0][1001][override]" value="0">
    <input type="hidden" name="components[0][1001][original_points]" value="1"><input type="hidden" name="components[0][1001][max_points]" value="1">
    <input type="hidden" name="components[0][1001][rubric_score]" value=""><textarea name="components[0][1001][comment]"></textarea>
    <script>{"theme_js":{"a":{"template":"s_grades_rubric_grading_launch_btn","module":"gradingRubric","args":["91","92","${v.qid}","x",1,1,"0",4,false,false]}}}</script>
    <input type="hidden" name="components[0][${v.qid}][points]" value="${v.points}"><input type="hidden" name="components[0][${v.qid}][override]" value="${v.override}">
    <input type="hidden" name="components[0][${v.qid}][original_points]" value="0"><input type="hidden" name="components[0][${v.qid}][max_points]" value="${maxPoints}">
    <input type="hidden" name="components[0][${v.qid}][rubric_score]" value="${v.score}"><textarea name="components[0][${v.qid}][comment]">${v.comment}</textarea>
    <input type="submit" name="op" value="Save Changes"><input type="hidden" name="form_build_id" value="b${Math.random()}">
    <input type="hidden" name="form_token" value="t"><input type="hidden" name="form_id" value="s_assessment_edit_submission_form"></form>`;
  const byAttempt = (id) => [...pages.entries()].find(([k]) => k.endsWith(`/${id}`));
  const client = {
    get: vi.fn(async (path, opts = {}) => {
      calls.push(['GET', path]);
      const gi = path.match(/rubric_grade_info\/91\/(\d+)\/92\/(\d+)$/);
      if (gi) {
        const [, v] = byAttempt(gi[2]) || [];
        return { status: v ? 200 : 404, text: '', finalUrl: path, json: v ? { response_code: 200, body: { gradeInfo: { 146: { grade: String(v.grade ?? ''), comment: '' } } } } : null };
      }
      const v = pages.get(path);
      return { status: v ? 200 : 404, text: v ? render(path, v) : '', finalUrl: path };
    }),
    post: vi.fn(async (path, body) => {
      calls.push(['POST', path, body]);
      posts += 1;
      if (posts > expireAfterPosts) throw new QuizError('NO_SESSION', 'Schoology connection expired: reconnect in Settings');
      if (onPost) onPost(path);
      if (ignorePost) return { status: 200, finalUrl: path };
      const p = new URLSearchParams(body); const v = pages.get(path);
      const score = p.get(`components[0][${v.qid}][rubric_score]`);
      pages.set(path, { ...v, points: applyPoints ? p.get(`components[0][${v.qid}][points]`) : v.points, override: p.get(`components[0][${v.qid}][override]`),
        score, comment: p.get(`components[0][${v.qid}][comment]`), other: mutateOther ? '0' : v.other });
      return { status: 302, finalUrl: path };
    }),
    putRubric: vi.fn(async (path, json) => {
      calls.push(['PUT', path, json]);
      if (putStatus !== 200) return { status: putStatus };
      const m = path.match(/rubric_grade_info\/91\/(\d+)\/92\/(\d+)$/);
      const [key, v] = byAttempt(m[2]);
      if (!gradeInfoStale) pages.set(key, { ...v, grade: String(json.gradeInfo['146'].grade) });
      return { status: 200 };
    }),
    close: vi.fn(async () => {}),
  };
  return { client, calls, pages };
}

let db, g, std, ext, q, att;
const path = (sid, uid, a) => `/assignment/${sid}/assessment_results/student_stats/${uid}/${a}`;
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
  for (const [uid, last, member, aid] of [['701', 'Lee', std, '5001'], ['702', 'Ng', ext, '6001']]) {
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
const pagesNow = () => ({
  [path('900', '701', '5001')]: { qid: '2001', points: '2', override: '1', score: '2', comment: 'Old' },
  [path('901', '702', '6001')]: { qid: '3001', points: '2', override: '1', score: '2', comment: 'Old' },
});
const mark = (uid) => db.prepare('SELECT * FROM frq_marks WHERE attempt_id = ?').get(att[uid]);

describe('waitingMarks', () => {
  test('accepted marks with their own copy\'s question id and attempt path, by name', () => {
    const w = waitingMarks(db, g);
    expect(w.map(x => [x.name, x.qid, x.path, x.final.points])).toEqual([
      ['Ana Lee', '2001', path('900', '701', '5001'), 3],
      ['Ana Ng', '3001', path('901', '702', '6001'), 4],
    ]);
  });
});

describe('postWritebacks', () => {
  test('one first: posts the first student, reads back, records posted, updates the stored copy', async () => {
    const f = fakeSchoology(pagesNow());
    const r = await postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => f.client });
    expect(r).toEqual({ results: [{ student_id: expect.any(Number), name: 'Ana Lee', question: 21, level: 'Exhibiting', status: 'posted', error: null }], remaining: 1 });
    const gi = '/iapi/grades/assessment_component_submission_rubric_grade_info/91/2001/92/5001';
    expect(f.calls.map(c => c.slice(0, 2))).toEqual([['GET', path('900', '701', '5001')], ['GET', gi], ['PUT', gi], ['POST', path('900', '701', '5001')],
      ['GET', path('900', '701', '5001')], ['GET', gi]]);
    expect(f.calls.find(c => c[0] === 'PUT')[2]).toEqual({ gradeInfo: { 146: { grade: 3, comment: '' } }, overrideGrade: null, comment: 'New line one\nline two' });
    expect(mark('701')).toMatchObject({ writeback_status: 'posted', writeback_error: null, posted_comment: 'New line one\nline two' });
    const resp = db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ?').get(att['701']);
    expect([JSON.parse(resp.schoology_rubric_cells_json)[146].points, resp.schoology_comment, resp.points]).toEqual([3, 'New line one\nline two', 3]);
    expect(f.client.close).toHaveBeenCalled();
  });

  test('then the rest; nothing but the essay fields changes in the body', async () => {
    const f = fakeSchoology(pagesNow());
    await postWritebacks(db, { groupId: g, limit: null }, { openClient: async () => f.client });
    const body = new URLSearchParams(f.calls.find(c => c[0] === 'POST' && c[1].includes('6001'))[2]);
    expect([body.get('components[0][1001][points]'), body.get('components[0][1001][override]'), body.get('components[0][3001][rubric_score]'), body.get('op')]).toEqual(['1', '0', '4', 'Save Changes']);
    expect(mark('702').writeback_status).toBe('posted');
  });

  test('a mark changed in Schoology since the last load is refused, not posted', async () => {
    const pages = pagesNow();
    pages[path('900', '701', '5001')] = { ...pages[path('900', '701', '5001')], score: '1', points: '1' };
    const f = fakeSchoology(pages);
    const r = await postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => f.client });
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'Changed in Schoology since the last load' });
    expect(f.calls.some(c => c[0] === 'POST')).toBe(false);
    expect(mark('701').writeback_status).toBe('failed');
  });

  test('a read-back that still shows the old mark is failed, not posted', async () => {
    const f = fakeSchoology(pagesNow(), { ignorePost: true });
    const r = await postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => f.client });
    expect(r.results[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Schoology shows/) });
    expect(mark('701').writeback_status).toBe('failed');
  });

  test('an expired session stops the batch; the first result stands', async () => {
    const f = fakeSchoology(pagesNow(), { expireAfterPosts: 1 });
    await expect(postWritebacks(db, { groupId: g, limit: null }, { openClient: async () => f.client })).rejects.toMatchObject({ code: 'NO_SESSION' });
    expect(mark('701').writeback_status).toBe('posted');
    expect(mark('702').writeback_status).toBe('pending');
    expect(f.client.close).toHaveBeenCalled();
  });

  test('a second post while one runs is refused as busy', async () => {
    let release;
    const slow = { get: vi.fn(() => new Promise(r => { release = () => r({ status: 404, text: '', finalUrl: '/' }); })), post: vi.fn(), close: vi.fn(async () => {}) };
    const first = postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => slow });
    await new Promise(r => setTimeout(r, 0));
    await expect(postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => slow })).rejects.toMatchObject({ code: 'BUSY' });
    release();
    await first;
  });

  test('a page without the form is a failure for that student', async () => {
    const f = fakeSchoology({});
    const r = await postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => f.client });
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'The attempt page did not load (HTTP 404)' });
  });

  test('a save that kept the old points is failed', async () => {
    const f = fakeSchoology(pagesNow(), { applyPoints: false });
    const r = await postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => f.client });
    expect(r.results[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/points 2/) });
  });

  test('a save whose rubric grade did not change is failed, and the stored copy is not touched', async () => {
    const f = fakeSchoology(pagesNow(), { gradeInfoStale: true });
    const r = await postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => f.client });
    expect(r.results[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/rubric/) });
    expect(JSON.parse(db.prepare('SELECT schoology_rubric_cells_json FROM quiz_responses WHERE attempt_id = ?').get(att['701']).schoology_rubric_cells_json)[146].points).toBe(2);
  });

  test('points changed by hand in Schoology (rubric untouched) are a conflict: nothing is posted', async () => {
    const pages = pagesNow();
    pages[path('900', '701', '5001')] = { ...pages[path('900', '701', '5001')], points: '3' };
    const f = fakeSchoology(pages);
    const r = await postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => f.client });
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'Changed in Schoology since the last load' });
    expect(f.calls.some(c => c[0] === 'POST')).toBe(false);
  });

  test('a question worth more than the rubric\'s top level is refused before posting', async () => {
    const f = fakeSchoology(pagesNow(), { maxPoints: 10 });
    const r = await postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => f.client });
    expect(r.results[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/worth 10 points/) });
    expect(f.calls.some(c => c[0] === 'POST')).toBe(false);
  });

  test('a mark edited in Prism during the post is not recorded as posted with the new text', async () => {
    const f = fakeSchoology(pagesNow(), { onPost: () => setFrqMark(db, { groupId: g, attemptId: att['701'], position: 21, action: 'save', cells: { 146: 4 }, comment: 'Newer' }) });
    const r = await postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => f.client });
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

  test('a post that changed another field stops the batch at once', async () => {
    const f = fakeSchoology(pagesNow(), { mutateOther: true });
    await expect(postWritebacks(db, { groupId: g, limit: null }, { openClient: async () => f.client })).rejects.toMatchObject({ code: 'UNSAFE' });
    expect(mark('701')).toMatchObject({ writeback_status: 'failed', writeback_error: expect.stringMatching(/other fields changed/) });
    expect(f.calls.filter(c => c[0] === 'POST')).toHaveLength(1);
    expect(mark('702').writeback_status).toBe('pending');
  });

  test('one first picks a waiting mark before a failed one', async () => {
    db.prepare(`UPDATE frq_marks SET writeback_status = 'failed', writeback_error = 'x' WHERE attempt_id = ?`).run(att['701']);
    const f = fakeSchoology(pagesNow());
    const r = await postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => f.client });
    expect(r.results[0]).toMatchObject({ name: 'Ana Ng', status: 'posted' });
  });

  test('a mark outside the scope (no one-row rubric) is reported as skipped and not counted', async () => {
    const two = { ...RUBRIC, rows: [RUBRIC.rows[0], { ...RUBRIC.rows[0], id: '147', title: 'Code' }] };
    const q22 = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json) VALUES (?, 22, 'frq', 'E2', 8, ?)`).run(g, JSON.stringify(two)).lastInsertRowid;
    db.prepare(`INSERT INTO quiz_question_copies (question_id, assignment_id, schoology_question_id) VALUES (?, ?, '2002')`).run(q22, std);
    db.prepare(`INSERT INTO quiz_responses (attempt_id, question_id, answer_html) VALUES (?, ?, 'a')`).run(att['701'], q22);
    db.prepare(`INSERT INTO frq_marks (attempt_id, question_id, final_cells_json, final_comment, state, writeback_status) VALUES (?, ?, '{"146":4,"147":4}', 'c', 'edited', 'pending')`).run(att['701'], q22);
    const f = fakeSchoology(pagesNow());
    const r = await postWritebacks(db, { groupId: g, limit: null }, { openClient: async () => f.client });
    expect(r.results.find(x => x.question === 22)).toMatchObject({ status: 'skipped', error: 'Post this one by hand: Prism posts only a one-row Schoology rubric' });
    expect(r.remaining).toBe(0);
  });

  test('limit is 1 or none', async () => {
    await expect(postWritebacks(db, { groupId: g, limit: -1 }, { openClient: async () => fakeSchoology(pagesNow()).client })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
  });

  test('a refused rubric save stops that student before the form is posted', async () => {
    const f = fakeSchoology(pagesNow(), { putStatus: 403 });
    const r = await postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => f.client });
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'Schoology refused the rubric save (HTTP 403): nothing was posted' });
    expect(f.calls.some(c => c[0] === 'POST')).toBe(false);
  });

  test('a rubric grade changed in Schoology since the last load is a conflict, even when the form agrees', async () => {
    const pages = pagesNow();
    pages[path('900', '701', '5001')] = { ...pages[path('900', '701', '5001')], grade: '1' };
    const f = fakeSchoology(pages);
    const r = await postWritebacks(db, { groupId: g, limit: 1 }, { openClient: async () => f.client });
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'Changed in Schoology since the last load' });
    expect(f.calls.some(c => c[0] === 'PUT' || c[0] === 'POST')).toBe(false);
  });
});

