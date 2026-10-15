# Linked Quizzes, Phase 4b (Prism Posts FRQ Marks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prism posts each accepted FRQ mark (one-row Schoology rubric level, points and comment) to the student's test attempt by replaying the attempt form's own POST, re-reading before and after, and records the result; the Free response tab posts one student first, then the rest, behind `quiz_writeback`.

**Architecture:** A pure module (`server/lib/attemptForm.js`) serializes the attempt page's form exactly as a browser does (verified byte-identical against the phase 4a capture) and changes only the essay's `rubric_score`, `points`, `override` and `comment`. A writer service (`server/services/quizWriteback.js`) works through an injected Schoology client (`get`, `post`): re-read, refuse on a Schoology change, post, read back, record. The production client reuses the loader's logged-in reader. A route behind `quiz_writeback` and a two-step button on the Free response tab complete it.

**Tech Stack:** Node ESM, Express, better-sqlite3, node-html-parser, Playwright (through the existing session), Vitest, React + RTL.

**Spec:** `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md` §14 and §9; request shapes in `.claude/schoology-api-reference.md`, "Saving an FRQ level and comment".

## Global Constraints

- **MCQ points and every other field are never changed:** the body is the freshly loaded form, serialized, with only the essay's `rubric_score`, `points`, `override` and `comment` replaced. A self-check refuses the post if any other field differs.
- **Re-read before each write:** if Schoology's stored cell or comment differs from Prism's stored copy, the mark becomes `failed` with "Changed in Schoology since the last load" and nothing is posted.
- **Only POST target:** `/assignment/{testId}/assessment_results/student_stats/{uid}/{attemptId}` (digits only). GETs keep the loader's `assertReadOnlyUrl`.
- **Scope:** FRQs with a one-row Schoology rubric. Others are skipped with a reason.
- **Errors:** `NO_SESSION` stops the batch; anything else is recorded for that student and never thrown.
- `override` is set to `1` with the new points (the observed value for a teacher-marked essay; a never-marked essay with `override` 0 was not observed, so the first real post checks it).
- The feature ships with `quiz_writeback: false` in `config.yaml`. Dev turns it on through `CONFIG_PATH` pointing at a copy.
- No em dashes in UI copy; colours through tokens; buttons `.primary` / `.secondary` / `.ghost`.
- Server tests: `npx vitest run <path>`; client: `npm --prefix client run test -- run <path>`.
- Dev on the mini: this worktree, `PORT=3002`, `DB_PATH=<worktree>/server/db/students.db`, `PRISM_SESSION_DIR=/Users/gnolan/repos/prism/.playwright-session`. Never kill by port; never touch `~/prism/releases` or `~/prism/data`.

## Review Focus

1. **Comment with line breaks, `&`, `<` or non-ASCII:** the body encodes it as a browser does (CRLF in a textarea value, UTF-8). Test in Task 1.
2. **A read-back that keeps the old level** (Schoology ignored the post): `failed` with what it shows, never `posted`. Test in Task 2.
3. **Session expires between two students:** the batch stops with `NO_SESSION`, the first student's result stands. Test in Task 2.
4. **Two posts at once** (double click, or the tab and an agent): the second is refused as busy. Test in Task 2.
5. **A mark on the extra-time copy:** the qid and URL come from that copy's own question id and test id. Test in Task 2.

---

### Task 1: Serializing the attempt form

**Files:**
- Create: `server/lib/attemptForm.js`
- Test: `server/lib/attemptForm.test.js`

**Interfaces:**
- Produces:
  - `serializeAttemptForm(html) => { action, pairs: [name, value][] } | null`
  - `essayFields(pairs, qid) => { rubricScore, points, override, comment, maxPoints } | null` (numbers or `null`; comment a string)
  - `withEssayMark(pairs, qid, { points, comment }) => pairs` (a new array)
  - `changedNames(a, b) => string[]` (names whose values differ, ignoring `form_build_id` and `form_token`)
  - `essayNames(qid) => string[]`
  - `toBody(pairs) => string`

- [ ] **Step 1: Write the failing tests** (`server/lib/attemptForm.test.js`)

```js
import { describe, test, expect } from 'vitest';
import { serializeAttemptForm, essayFields, withEssayMark, changedNames, essayNames, toBody } from './attemptForm.js';

// A synthetic attempt form in the observed shape (schoology-api-reference.md, "Saving an FRQ level and comment").
const q = (qid, { points, override = 0, original = points, max = 1, score = '', comment = '' }) => `
  <div class="question-review question-x">
    <input type="hidden" name="components[0][${qid}][points]" value="${points}">
    <input type="hidden" name="components[0][${qid}][override]" value="${override}">
    <input type="hidden" name="components[0][${qid}][original_points]" value="${original}">
    <input type="hidden" name="components[0][${qid}][max_points]" value="${max}">
    <input type="hidden" name="components[0][${qid}][rubric_score]" value="${score}">
    <textarea name="components[0][${qid}][comment]">${comment}</textarea>
  </div>`;
const PAGE = (essay = { points: 2, override: 1, original: 0, max: 4, score: '2', comment: 'Good &amp; clear' }) => `<html><body>
  <form id="s-assessment-edit-submission-form" action="/assignment/900/assessment_results/student_stats/701/5001" accept-charset="UTF-8" method="post">
    <select name="enrollment-selector-sa"><option value="/a">A</option><option value="/assignment/900/assessment_results/student_stats/701/5001" selected="selected">B</option></select>
    ${q('11', { points: 1 })}${q('12', { points: 0 })}${q('21', essay)}
    <input type="submit" name="op" value="Save Changes">
    <input type="submit" name="op" value="Cancel">
    <input type="hidden" name="form_build_id" value="form-abc">
    <input type="hidden" name="form_token" value="tok">
    <input type="hidden" name="form_id" value="s_assessment_edit_submission_form">
  </form></body></html>`;

describe('serializeAttemptForm', () => {
  test('every named field in page order, the chosen option, only the Save Changes button', () => {
    const f = serializeAttemptForm(PAGE());
    expect(f.action).toBe('/assignment/900/assessment_results/student_stats/701/5001');
    expect(f.pairs.map(p => p[0])).toEqual([
      'enrollment-selector-sa',
      ...['11', '12', '21'].flatMap(id => ['points', 'override', 'original_points', 'max_points', 'rubric_score', 'comment'].map(k => `components[0][${id}][${k}]`)),
      'op', 'form_build_id', 'form_token', 'form_id',
    ]);
    expect(f.pairs[0][1]).toBe('/assignment/900/assessment_results/student_stats/701/5001');
    expect(Object.fromEntries(f.pairs).op).toBe('Save Changes');
    expect(Object.fromEntries(f.pairs)['components[0][21][comment]']).toBe('Good & clear');
  });
  test('no form is null', () => {
    expect(serializeAttemptForm('<html><body>Sign in</body></html>')).toBeNull();
  });
});

describe('the essay', () => {
  const pairs = serializeAttemptForm(PAGE()).pairs;
  test('reads its fields', () => {
    expect(essayFields(pairs, '21')).toEqual({ rubricScore: 2, points: 2, override: 1, comment: 'Good & clear', maxPoints: 4 });
    expect(essayFields(pairs, '99')).toBeNull();
  });
  test('an empty rubric score is null', () => {
    const p = serializeAttemptForm(PAGE({ points: 0, override: 0, original: 0, max: 4, score: '', comment: '' })).pairs;
    expect(essayFields(p, '21')).toMatchObject({ rubricScore: null, override: 0, comment: '' });
  });
  test('withEssayMark changes only the essay level, points, override and comment', () => {
    const next = withEssayMark(pairs, '21', { points: 3, comment: 'Line one\nLine two <b> & é' });
    expect(changedNames(pairs, next)).toEqual(['components[0][21][points]', 'components[0][21][rubric_score]', 'components[0][21][comment]']);
    expect(essayFields(next, '21')).toEqual({ rubricScore: 3, points: 3, override: 1, comment: 'Line one\r\nLine two <b> & é', maxPoints: 4 });
    expect(changedNames(pairs, next).every(n => essayNames('21').includes(n))).toBe(true);
  });
  test('override becomes 1 when it was 0', () => {
    const p = serializeAttemptForm(PAGE({ points: 0, override: 0, original: 0, max: 4, score: '', comment: '' })).pairs;
    expect(essayFields(withEssayMark(p, '21', { points: 4, comment: 'x' }), '21').override).toBe(1);
  });
  test('changedNames ignores the Drupal tokens', () => {
    const other = pairs.map(([k, v]) => [k, k === 'form_build_id' ? 'form-new' : k === 'form_token' ? 'tok2' : v]);
    expect(changedNames(pairs, other)).toEqual([]);
  });
});

describe('toBody', () => {
  test('url-encoded as a browser sends it: spaces as +, UTF-8, CRLF kept', () => {
    expect(toBody([['a', 'x y'], ['c', 'é\r\n&']])).toBe('a=x+y&c=%C3%A9%0D%0A%26');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run server/lib/attemptForm.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`server/lib/attemptForm.js`)

```js
// The test attempt page's form (linked quizzes phase 4b, spec §14). Serialized the way a browser
// submits it: checked against the phase 4a capture, byte for byte. Only the essay's level, points,
// override and comment are ever changed; every other field goes back exactly as Schoology sent it.
import { parse } from 'node-html-parser';

const FORM = '#s-assessment-edit-submission-form';
const TOKENS = new Set(['form_build_id', 'form_token']);
const name = (qid, field) => `components[0][${qid}][${field}]`;
const num = (v) => (v == null || String(v).trim() === '' ? null : Number(v));

export function serializeAttemptForm(html) {
  const form = parse(String(html ?? '')).querySelector(FORM);
  if (!form) return null;
  const pairs = [];
  for (const el of form.querySelectorAll('input, textarea, select')) {
    const n = el.getAttribute('name');
    if (!n || el.hasAttribute('disabled')) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio') && !el.hasAttribute('checked')) continue;
    if (tag === 'input' && ['submit', 'button', 'image', 'reset'].includes(type)) {
      if (n === 'op' && el.getAttribute('value') === 'Save Changes') pairs.push([n, 'Save Changes']);
      continue;
    }
    if (tag === 'textarea') { pairs.push([n, el.text.replace(/^\n/, '').replace(/\r?\n/g, '\r\n')]); continue; }
    if (tag === 'select') {
      const o = el.querySelector('option[selected]') || el.querySelector('option');
      pairs.push([n, o ? (o.getAttribute('value') ?? o.text) : '']);
      continue;
    }
    pairs.push([n, el.getAttribute('value') ?? '']);
  }
  return { action: form.getAttribute('action'), pairs };
}

export const essayNames = (qid) => ['points', 'override', 'rubric_score', 'comment'].map(f => name(qid, f));

export function essayFields(pairs, qid) {
  const m = new Map(pairs);
  if (!m.has(name(qid, 'points'))) return null;
  return {
    rubricScore: num(m.get(name(qid, 'rubric_score'))),
    points: num(m.get(name(qid, 'points'))),
    override: num(m.get(name(qid, 'override'))),
    comment: m.get(name(qid, 'comment')) ?? '',
    maxPoints: num(m.get(name(qid, 'max_points'))),
  };
}

export function withEssayMark(pairs, qid, { points, comment }) {
  const set = {
    [name(qid, 'points')]: String(points),
    [name(qid, 'override')]: '1',
    [name(qid, 'rubric_score')]: String(points),
    [name(qid, 'comment')]: String(comment ?? '').replace(/\r?\n/g, '\r\n'),
  };
  return pairs.map(([k, v]) => [k, k in set ? set[k] : v]);
}

export function changedNames(a, b) {
  const bm = new Map(b);
  const out = [];
  for (const [k, v] of a) if (!TOKENS.has(k) && bm.get(k) !== v) out.push(k);
  for (const [k] of b) if (!TOKENS.has(k) && !a.some(([ak]) => ak === k)) out.push(k);
  return out;
}

export const toBody = (pairs) => new URLSearchParams(pairs).toString();
```

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run server/lib/attemptForm.test.js`
Expected: PASS.

- [ ] **Step 5: Parity against the real capture (local, not committed)**

Run from the repo root (reads the capture outside the repo; prints only booleans and lengths):
`node --input-type=module -e "import {serializeAttemptForm,toBody} from './server/lib/attemptForm.js'; import {readFileSync} from 'fs'; const d=process.env.HOME+'/prism-probes/attempt-write/'; const f=serializeAttemptForm(readFileSync(d+'stageB-before-2247871023.html','utf8')); const c=JSON.parse(readFileSync(d+'stageB-requests-2247871023.json','utf8')).find(r=>r.url.includes('student_stats')); console.log(toBody(f.pairs)===c.body, toBody(f.pairs).length)"`
Expected: `true 6815`.

- [ ] **Step 6: Commit**

```bash
git add server/lib/attemptForm.js server/lib/attemptForm.test.js
git commit -m "feat(quizzes): serialize the test attempt form and set only the essay's mark"
```

---

### Task 2: The writer

**Files:**
- Create: `server/services/quizWriteback.js`
- Modify: `server/services/quizLoader.js` (export `openReader`, and add `page` to what it returns)
- Test: `server/services/quizWriteback.test.js`

**Interfaces:**
- Consumes: Task 1; `getGroup`, `schoologyMarkOf`, `sameMark`, `levelNameFor`, `studentFullName`, `QuizError`.
- Produces:
  - `waitingMarks(db, groupId) => [{ attemptId, questionId, position, studentId, name, path, qid, rowId, final: { points, comment }, rubric }]` (pending or failed, sorted by name; one-row rubric only)
  - `postWritebacks(db, { groupId, limit = null }, deps = { openClient }) => { results: [{ student_id, name, question, level, status: 'posted'|'failed', error }], remaining }`
  - `openClient({ pauseMs })` (production): `{ get(path), post(path, body), close() }`, where `get` returns `{ status, text, finalUrl }` and `post` returns `{ status, finalUrl }`.

- [ ] **Step 1: Write the failing tests** (`server/services/quizWriteback.test.js`)

```js
import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { postWritebacks, waitingMarks } from './quizWriteback.js';
import { writeFrqSuggestions, setFrqMark } from './frqMarks.js';
import { QuizError } from './quizError.js';

const RUBRIC = { id: 'r1', title: 'FRQ', rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth' }, { points: 3, name: 'Exhibiting' }, { points: 2, name: 'Developing' }, { points: 1, name: 'Emerging' }] }] };

// A fake Schoology: each attempt page holds form values; a POST stores the posted values (unless ignore).
function fakeSchoology(initial, { ignorePost = false, expireAfterPosts = Infinity } = {}) {
  const pages = new Map(Object.entries(initial));
  const calls = [];
  let posts = 0;
  const render = (path, v) => `<form id="s-assessment-edit-submission-form" action="${path}">
    <input type="hidden" name="components[0][1001][points]" value="1"><input type="hidden" name="components[0][1001][override]" value="0">
    <input type="hidden" name="components[0][1001][original_points]" value="1"><input type="hidden" name="components[0][1001][max_points]" value="1">
    <input type="hidden" name="components[0][1001][rubric_score]" value=""><textarea name="components[0][1001][comment]"></textarea>
    <input type="hidden" name="components[0][${v.qid}][points]" value="${v.points}"><input type="hidden" name="components[0][${v.qid}][override]" value="${v.override}">
    <input type="hidden" name="components[0][${v.qid}][original_points]" value="0"><input type="hidden" name="components[0][${v.qid}][max_points]" value="4">
    <input type="hidden" name="components[0][${v.qid}][rubric_score]" value="${v.score}"><textarea name="components[0][${v.qid}][comment]">${v.comment}</textarea>
    <input type="submit" name="op" value="Save Changes"><input type="hidden" name="form_build_id" value="b${Math.random()}">
    <input type="hidden" name="form_token" value="t"><input type="hidden" name="form_id" value="s_assessment_edit_submission_form"></form>`;
  const client = {
    get: vi.fn(async (path) => { calls.push(['GET', path]); const v = pages.get(path); return { status: v ? 200 : 404, text: v ? render(path, v) : '', finalUrl: path }; }),
    post: vi.fn(async (path, body) => {
      calls.push(['POST', path, body]);
      posts += 1;
      if (posts > expireAfterPosts) throw new QuizError('NO_SESSION', 'Schoology connection expired: reconnect in Settings');
      if (ignorePost) return { status: 200, finalUrl: path };
      const p = new URLSearchParams(body); const v = pages.get(path);
      pages.set(path, { ...v, points: p.get(`components[0][${v.qid}][points]`), override: p.get(`components[0][${v.qid}][override]`), score: p.get(`components[0][${v.qid}][rubric_score]`), comment: p.get(`components[0][${v.qid}][comment]`) });
      return { status: 200, finalUrl: path };
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
    expect(f.calls.map(c => c.slice(0, 2))).toEqual([['GET', path('900', '701', '5001')], ['POST', path('900', '701', '5001')], ['GET', path('900', '701', '5001')]]);
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
    expect(r.results[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Schoology still shows/) });
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
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run server/services/quizWriteback.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Export the loader's reader with its page**

In `server/services/quizLoader.js`: change `async function openReader(` to `export async function openReader(`, and its return to `return { get, page: session.page, close: () => session.close().catch(() => {}) };`.

- [ ] **Step 4: Implement** (`server/services/quizWriteback.js`)

```js
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
```

- [ ] **Step 5: Run to see them pass**

Run: `npx vitest run server/services/quizWriteback.test.js server/services/quizLoader.test.js`
Expected: PASS. If the comment comparison fails on CRLF, compare with `sameMark` (it normalizes spacing) and keep the stored copy in LF, as written.

- [ ] **Step 6: Commit**

```bash
git add server/services/quizWriteback.js server/services/quizWriteback.test.js server/services/quizLoader.js
git commit -m "feat(quizzes): post accepted FRQ marks to the attempt (re-read, post, read back)"
```

---

### Task 3: Route and client call

**Files:**
- Modify: `server/routes/quizzes.js`, `client/src/services/api.js`
- Test: `server/routes/quizzes.test.js`

**Interfaces:**
- Produces: `POST /api/quizzes/:id/writeback` body `{ limit }` → `{ results, remaining }`, behind `featureGate('quiz_writeback')`; client `postFrqWritebacks(groupId, limit)`.

- [ ] **Step 1: Write the failing test** (append inside `describe('/api/quizzes')` in `server/routes/quizzes.test.js`; add `vi.mock('../services/quizWriteback.js', () => ({ postWritebacks: vi.fn(async () => ({ results: [], remaining: 0 })) }))` at the top beside the other mocks, and import `postWritebacks`)

```js
test('POST /:id/writeback posts with the limit given', async () => {
  const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
  const r = await call('POST', `/api/quizzes/${id}/writeback`, { limit: 1 });
  expect([r.status, r.body]).toEqual([200, { results: [], remaining: 0 }]);
  expect(vi.mocked(postWritebacks)).toHaveBeenCalledWith(expect.anything(), { groupId: String(id), limit: 1 });
});
```

(The file's `featureGate` mock lets every flag through; the flag itself is covered by `featureGate`'s own tests.)

- [ ] **Step 2: Run to see it fail**, then implement:

```js
import { postWritebacks } from '../services/quizWriteback.js';
...
router.post('/:id/writeback', featureGate('quiz_writeback'), handle((req, db) =>
  postWritebacks(db, { groupId: req.params.id, limit: req.body?.limit ?? null })));
```

`client/src/services/api.js`:

```js
export const postFrqWritebacks = (groupId, limit = null) => request(`/quizzes/${groupId}/writeback`, { method: 'POST', body: JSON.stringify({ limit }) });
```

- [ ] **Step 3: Run** `npx vitest run server/routes/quizzes.test.js` (PASS), **commit**:

```bash
git add server/routes/quizzes.js server/routes/quizzes.test.js client/src/services/api.js
git commit -m "feat(quizzes): POST /api/quizzes/:id/writeback behind quiz_writeback"
```

---

### Task 4: One first, then the rest, on the Free response tab

**Files:**
- Create: `client/src/components/quiz/PostMarksBar.jsx`, `client/src/components/quiz/PostMarksBar.test.jsx`
- Modify: `client/src/components/quiz/FreeResponseTab.jsx`

**Interfaces:**
- Consumes: `postFrqWritebacks` (Task 3).
- Produces: `<PostMarksBar groupId count onPosted />`: `count` is the waiting and failed marks; `onPosted()` reloads the tab.

- [ ] **Step 1: Write the failing tests** (`PostMarksBar.test.jsx`)

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PostMarksBar from './PostMarksBar.jsx';
import { postFrqWritebacks } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({ postFrqWritebacks: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe('PostMarksBar', () => {
  it('posts one first, shows its result, then offers the rest', async () => {
    postFrqWritebacks.mockResolvedValueOnce({ results: [{ student_id: 1, name: 'Ana Lee', question: 21, level: 'Exhibiting', status: 'posted', error: null }], remaining: 2 });
    const onPosted = vi.fn();
    render(<PostMarksBar groupId={7} count={3} onPosted={onPosted} />);
    fireEvent.click(screen.getByRole('button', { name: 'Post accepted to Schoology (3)' }));
    expect(await screen.findByText('Posted: Ana Lee, Q21 Exhibiting')).toBeInTheDocument();
    expect(postFrqWritebacks).toHaveBeenCalledWith(7, 1);
    expect(screen.getByText(/Check it in Schoology/)).toBeInTheDocument();
    postFrqWritebacks.mockResolvedValueOnce({ results: [
      { student_id: 2, name: 'Ana Ng', question: 21, level: 'Developing', status: 'posted', error: null },
      { student_id: 3, name: 'Bo Wu', question: 21, level: 'Exhibiting', status: 'failed', error: 'Changed in Schoology since the last load' },
    ], remaining: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Post the other 2' }));
    expect(await screen.findByText('Failed: Bo Wu, Q21: Changed in Schoology since the last load')).toBeInTheDocument();
    expect(postFrqWritebacks).toHaveBeenLastCalledWith(7, null);
    expect(onPosted).toHaveBeenCalledTimes(2);
  });

  it('shows a refused post (busy, expired session) as an alert', async () => {
    postFrqWritebacks.mockRejectedValueOnce(new Error('Schoology connection expired: reconnect in Settings'));
    render(<PostMarksBar groupId={7} count={1} onPosted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Post accepted to Schoology (1)' }));
    expect(await screen.findByText('Schoology connection expired: reconnect in Settings')).toBeInTheDocument();
  });

  it('renders nothing with no marks to post', () => {
    const { container } = render(<PostMarksBar groupId={7} count={0} onPosted={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});
```

- [ ] **Step 2: Run to see them fail**: `npm --prefix client run test -- run src/components/quiz/PostMarksBar.test.jsx`

- [ ] **Step 3: Implement** (`PostMarksBar.jsx`)

```jsx
// Post accepted FRQ marks to Schoology (spec §14): one student first, then the rest, each read back.
// Shown only while quiz_writeback is on.
import { useState } from 'react';
import { postFrqWritebacks } from '../../services/api.js';

const line = (r) => (r.status === 'posted'
  ? `Posted: ${r.name}, Q${r.question} ${r.level}`
  : `Failed: ${r.name}, Q${r.question}: ${r.error}`);

export default function PostMarksBar({ groupId, count, onPosted }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null); // null before the first post
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState(null);
  if (!count && !results) return null;

  async function post(limit) {
    setBusy(true); setError(null);
    try {
      const r = await postFrqWritebacks(groupId, limit);
      setResults(prev => [...(prev || []), ...r.results]);
      setRemaining(r.remaining);
      onPosted();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="post-marks">
      {!results && (
        <button className="primary" disabled={busy} onClick={() => post(1)}>{`Post accepted to Schoology (${count})`}</button>
      )}
      {results && (
        <>
          <ul className="post-marks__results">
            {results.map((r, i) => <li key={i} className={r.status === 'posted' ? 'text-success' : 'text-danger'}>{line(r)}</li>)}
          </ul>
          {results.length === 1 && <p className="text-sm text-muted">Check it in Schoology before posting the rest.</p>}
          {remaining > 0 && <button className="secondary" disabled={busy} onClick={() => post(null)}>{`Post the other ${remaining}`}</button>}
        </>
      )}
      {busy && <span className="text-sm text-muted">Posting…</span>}
      {error && <div className="alert alert-warning">{error}</div>}
    </div>
  );
}
```

Check `client/src/app.css` for `.text-success` / `.text-danger`; if they do not exist, add (outside the PHONE LAYOUT block):

```css
.post-marks { display: grid; gap: 0.4rem; justify-items: start; }
.post-marks__results { margin: 0; padding-left: 1.1rem; font-size: 0.85rem; }
```

and colour the list items with the existing success and danger tokens (`var(--success)`, `var(--danger)` or whatever `:root` names them) through two classes defined there.

In `FreeResponseTab.jsx`: import `PostMarksBar`; add `const [reload, setReload] = useState(0);` and include `reload` in the data effect's dependencies; compute `toPost` as the count of marks with `writeback.status` `pending` or `failed`; replace the "waiting for the agent" line with:

```jsx
{features.quiz_writeback
  ? <PostMarksBar groupId={groupId} count={toPost} onPosted={() => setReload(k => k + 1)} />
  : waiting > 0 && <span className="text-sm text-muted">{waiting} waiting for the agent</span>}
```

Add a test to the existing `FreeResponseTab` tests: with `getFeatures` resolving `{ quiz_writeback: true }` and one pending mark, the bar shows "Post accepted to Schoology (1)" and no "waiting for the agent".

- [ ] **Step 4: Run** `npm --prefix client run test -- run src/components/quiz` (PASS), **commit**:

```bash
git add client/src/components/quiz/PostMarksBar.jsx client/src/components/quiz/PostMarksBar.test.jsx client/src/components/quiz/FreeResponseTab.jsx client/src/components/quiz/FreeResponseTab.test.jsx client/src/app.css
git commit -m "feat(quizzes): post accepted marks to Schoology, one first, then the rest"
```

---

### Task 5: Docs, dev check, the first real post, landing

- [ ] **Step 1: Suites and build**: `npx vitest run`, `npm --prefix client run test -- run`, `npm run build`.
- [ ] **Step 2: Dev check without writing:** copy `config.yaml` to the scratchpad with `quiz_writeback: true`; start `PORT=3002 DB_PATH=<worktree>/server/db/students.db PRISM_SESSION_DIR=/Users/gnolan/repos/prism/.playwright-session CONFIG_PATH=<copy> npm run dev` in the background; open the BK 6 Free response tab and screenshot the bar (names hidden). Do not click Post.
- [ ] **Step 3: Stop and ask Graham** (AskUserQuestion): which current mark to post first (an accepted mark he wants in Schoology anyway), with the attempt link. Only on his yes, click **Post accepted to Schoology** (it posts that one first; if the first waiting mark by name is not the one he chose, accept or keep only that one first). Read back in Schoology with him; record the result in `.claude/schoology-api-reference.md` (a changed value persists; `override` behaviour if it was 0).
- [ ] **Step 4: Docs**: `docs/design-language.md` (the post bar), `.claude/build-progress.md` (phase 4b section), the spec status line.
- [ ] **Step 5: Land with approval**: ask before pushing to `main` and before turning `quiz_writeback` on in `config.yaml` (prod).
