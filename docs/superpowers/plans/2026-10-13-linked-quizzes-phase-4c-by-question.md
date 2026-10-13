# Linked Quizzes, Phase 4c (Posting by Question) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prism posts accepted FRQ marks through Schoology's grade-by-question page: one page read and one form save per question and member test, with the per-student rubric save, keeping every check from phase 4b.

**Architecture:** `server/lib/attemptForm.js` gains prefix-based field helpers for a submission on the by-question form (`students[uid][submissions][attemptId][…]`) and a parser for the page's per-student rubric entries. `server/services/quizWriteback.js` replaces the per-attempt `postOne` with `postGroup`, which handles all marks for one (member test, question) together. The route, the UI and `waitingMarks`' ordering are unchanged.

**Tech Stack:** Node ESM, node-html-parser, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md` §15 (with §14 and §9); request shapes in `.claude/schoology-api-reference.md` ("Grade by question", "Stage D", "Stage C").

## Global Constraints

- **Never changed:** any field except the posted students' `rubric_score`, `points`, `override` and `comment` on the question's page. A read-back showing any other change stops the batch (`UNSAFE`).
- **Never overwritten:** a student whose points, comment or rubric grade differ from Prism's stored copy ("Changed in Schoology since the last load"). The rubric grade may already be Prism's own (a half-written earlier post).
- **Requests allowed:** GETs through the loader's guard; `PUT` only to `rubric_grade_info/{4 numbers}`; `POST` only to `/assignment/{n}/assessment_results/question_stats/{n}/{n}`.
- **One first:** `limit: 1` posts one mark through the same page; `limit` is 1 or none.
- Half-written, `NO_SESSION`, `BUSY`, skipped marks and the result lines behave as in phase 4b.
- Server tests: `npx vitest run <path>`.

## Review Focus

1. **Two students on the same page, one refused by the checks:** the form save still goes out for the other, and the refused student's fields are sent unchanged. Test in Task 2.
2. **The extra-time copy numbers the question differently:** its own number is used for its page. Test in Task 2.
3. **The read-back shows another student's field changed:** `UNSAFE`, batch stops, posted students recorded failed. Test in Task 2.
4. **A student on the page whose attempt is not the one Prism stored** (a retake): refused, not posted. Test in Task 2.
5. **The form save throws after rubric saves:** every student whose rubric was saved is recorded half-written. Test in Task 2.

---

### Task 1: Submission fields and the page's rubric entries

**Files:** Modify `server/lib/attemptForm.js`; Test `server/lib/attemptForm.test.js`.

**Interfaces (produces):**
- `BYQ_FORM = '#s-assessment-view-question-responses-form'`
- `submissionPrefix(uid, attemptId) => 'students[uid][submissions][attemptId]'`
- `fieldsAt(pairs, prefix)`, `withMarkAt(pairs, prefix, { points, comment })`, `namesAt(prefix)`: the prefix-based forms of `essayFields`, `withEssayMark`, `essayNames` (which become wrappers with prefix `components[0][qid]`).
- `byQuestionRubrics(html) => { [attemptId]: { rubricId, enrollmentId, qid } }`

- [ ] **Step 1: Failing tests** (append to `server/lib/attemptForm.test.js`; import the new names)

```js
describe('the grade-by-question form', () => {
  const html = String.raw`<form id="s-assessment-view-question-responses-form" action="/assignment/900/assessment_results/question_stats/5/21">
    ${['701:5001:2', '702:5002:3'].map(x => { const [u, a, p] = x.split(':'); return `
    <input type="hidden" name="students[${u}][submissions][${a}][points]" value="${p}"><input type="hidden" name="students[${u}][submissions][${a}][override]" value="1">
    <input type="hidden" name="students[${u}][submissions][${a}][original_points]" value="0"><input type="hidden" name="students[${u}][submissions][${a}][max_points]" value="4">
    <input type="hidden" name="students[${u}][submissions][${a}][rubric_score]" value="${p}"><textarea name="students[${u}][submissions][${a}][comment]">C${u}</textarea>`; }).join('')}
    <input type="submit" name="op" value="Save Changes"><input type="hidden" name="form_token" value="t"></form>
    <script>{"a":{"template":"s_grades_rubric_grading_launch_btn","module":"gradingRubric","args":["91","81","2001","<span>2<\/span>",1,1,"5001",4,false,false]},
      "b":{"template":"s_grades_rubric_grading_launch_btn","module":"gradingRubric","args":["91","82","2001","x",1,1,"5002",4,false,false]}}</script>`;
  const pairs = serializeForm(html, BYQ_FORM).pairs;
  test('reads and sets one submission by its prefix, leaving the other student alone', () => {
    const p = submissionPrefix('701', '5001');
    expect(fieldsAt(pairs, p)).toEqual({ rubricScore: 2, points: 2, override: 1, comment: 'C701', maxPoints: 4 });
    const next = withMarkAt(pairs, p, { points: 4, comment: 'New' });
    expect(changedNames(pairs, next)).toEqual([`${p}[points]`, `${p}[rubric_score]`, `${p}[comment]`]);
    expect(changedNames(pairs, next).every(n => namesAt(p).includes(n))).toBe(true);
    expect(fieldsAt(next, submissionPrefix('702', '5002'))).toMatchObject({ points: 3, comment: 'C702' });
  });
  test('the rubric entry for each attempt on the page', () => {
    expect(byQuestionRubrics(html)).toEqual({ 5001: { rubricId: '91', enrollmentId: '81', qid: '2001' }, 5002: { rubricId: '91', enrollmentId: '82', qid: '2001' } });
  });
  test('the essay wrappers still work on the attempt form', () => {
    expect(essayNames('21')).toEqual(namesAt('components[0][21]'));
  });
});
```

- [ ] **Step 2: Run, see it fail**: `npx vitest run server/lib/attemptForm.test.js` (FAIL: not exported).

- [ ] **Step 3: Implement** in `server/lib/attemptForm.js`: replace `name`, `essayNames`, `essayFields`, `withEssayMark` with:

```js
export const BYQ_FORM = '#s-assessment-view-question-responses-form';
export const submissionPrefix = (uid, attemptId) => `students[${uid}][submissions][${attemptId}]`;
const at = (prefix, field) => `${prefix}[${field}]`;
const essayPrefix = (qid) => `components[0][${qid}]`;

export const namesAt = (prefix) => ['points', 'override', 'rubric_score', 'comment'].map(f => at(prefix, f));
export function fieldsAt(pairs, prefix) {
  const m = new Map(pairs);
  if (!m.has(at(prefix, 'points'))) return null;
  return {
    rubricScore: num(m.get(at(prefix, 'rubric_score'))), points: num(m.get(at(prefix, 'points'))),
    override: num(m.get(at(prefix, 'override'))), comment: m.get(at(prefix, 'comment')) ?? '',
    maxPoints: num(m.get(at(prefix, 'max_points'))),
  };
}
export function withMarkAt(pairs, prefix, { points, comment }) {
  const set = {
    [at(prefix, 'points')]: String(points), [at(prefix, 'override')]: '1', [at(prefix, 'rubric_score')]: String(points),
    [at(prefix, 'comment')]: String(comment ?? '').replace(/\r?\n/g, '\r\n'),
  };
  return pairs.map(([k, v]) => [k, k in set ? set[k] : v]);
}
export const essayNames = (qid) => namesAt(essayPrefix(qid));
export const essayFields = (pairs, qid) => fieldsAt(pairs, essayPrefix(qid));
export const withEssayMark = (pairs, qid, mark) => withMarkAt(pairs, essayPrefix(qid), mark);

// One rubric launch entry per student on the by-question page: args are rubric id, enrollment id,
// question id, grade html, two numbers, attempt id, max points, two booleans (stage D page).
export function byQuestionRubrics(html) {
  const out = {};
  const re = /"template":"s_grades_rubric_grading_launch_btn"[^{}]*?"args":\[\s*"?(\d+)"?\s*,\s*"?(\d+)"?\s*,\s*"?(\d+)"?\s*,[^\]]*?,\s*"?\d+"?\s*,\s*"?\d+"?\s*,\s*"?(\d+)"?\s*,/g;
  for (const m of String(html).matchAll(re)) out[m[4]] = { rubricId: m[1], enrollmentId: m[2], qid: m[3] };
  return out;
}
```

- [ ] **Step 4: Run** `npx vitest run server/lib/attemptForm.test.js server/services/quizWriteback.test.js` (PASS: the wrappers keep phase 4b's tests green). **Commit** `feat(quizzes): submission fields and rubric entries on the grade-by-question form`.

---

### Task 2: The writer posts by question

**Files:** Modify `server/services/quizWriteback.js`; rewrite the fake in `server/services/quizWriteback.test.js` and port its tests.

**Interfaces:**
- Consumes: Task 1; `parseQuizQuestions` (`server/lib/parseQuizQuestions.js`).
- Produces: `postWritebacks` (unchanged signature and results); `waitingMarks` entries gain `uid`, `memberSid`, `schoologyAttemptId`.

- [ ] **Step 1: Rewrite the test fake** to model the by-question pages, and port the tests. The fake holds, per member test: a question list (`qid → number`), the `question_stats` index (links `/assignment/{sid}/assessment_results/question_stats/77/{number}`), and per question page the submissions `{ uid, attemptId, points, override, score, grade, comment }`. `get` serves the three pages and `rubric_grade_info` (by attempt id); `putRubric` sets the grade; `post` parses the body and applies every `students[uid][submissions][attemptId][…]` field (options: `ignorePost`, `applyPoints`, `gradeInfoStale`, `putStatus`/`putError`, `mutateOther` (changes another student's comment), `expireAfterPosts`, `maxPoints`, `onPost`). Port every phase 4b test to it with the same expectations, except:
  - the request sequence for one first: `GET assessment_questions`, `GET question_stats`, `GET page`, `GET grade`, `PUT`, `GET grade`, `POST page`, `GET page`, `GET grade`;
  - "then the rest": two students on the same copy produce **one** POST whose body changes only those two students' fields;
  - "nothing but the essay fields changes": replaced by "only the posted students' fields change in the body".

  New tests (Review Focus):

```js
test('two students on one page, one refused: the other is posted in the same form save, the refused one unchanged', async () => { /* 701 changed by hand (points), 703 waiting on the same copy; expect 701 failed 'Changed in Schoology since the last load', 703 posted, one POST whose body keeps 701's fields as loaded */ });
test('the extra-time copy uses its own question number for its page', async () => { /* copy 901 lists qid 3001 as number 5; expect GET .../901/assessment_results/question_stats/77/5 */ });
test('another student\'s field changed in the read-back stops the batch', async () => { /* mutateOther; expect rejects UNSAFE, posted students recorded failed */ });
test('a student whose page attempt is not Prism\'s stored attempt is refused', async () => { /* page lists 701 with attempt 9999; expect failed 'The attempt on the question page is not the one Prism loaded: load the results again' */ });
test('the form save throws after rubric saves: each of them is recorded half-written', async () => { /* expireAfterPosts: 0 with two students; both marks failed with the half-written message; rejects NO_SESSION */ });
```

  Write each body in full in the test file (the comments above state what each asserts), using the fake's options.

- [ ] **Step 2: Run, see them fail**: `npx vitest run server/services/quizWriteback.test.js`.

- [ ] **Step 3: Implement** in `quizWriteback.js`:
  - `BYQ_PATH = /^\/assignment\/\d+\/assessment_results\/question_stats\/\d+\/\d+$/`; `openClient().post` accepts `BYQ_PATH` (and no longer `ATTEMPT_PATH`).
  - `waitingMarks` selects `s.schoology_uid AS uid`, `a.schoology_assignment_id AS member_sid`, `qa.schoology_attempt_id` and returns them as `uid`, `memberSid`, `schoologyAttemptId`.
  - `postGroup(db, client, marks)` for one `(memberSid, qid)`, returning `[{ w, status, error, unsafe? }]`:
    1. `GET /assignment/{memberSid}/assessment_questions` → `parseQuizQuestions` → the copy's `number` for `qid` (else every mark failed "The question was not found in this test").
    2. `GET /assignment/{memberSid}/assessment_results/question_stats` → the link `question_stats/{n}/{number}` (else failed "No grade-by-question page for this question").
    3. `GET` the page → `serializeForm(text, BYQ_FORM)` and `byQuestionRubrics(text)`.
    4. Per mark, in order, the checks of phase 4b with the submission prefix: `stillWaiting`; the rubric entry exists for `schoologyAttemptId` (else "The attempt on the question page is not the one Prism loaded: load the results again"), names `qid`, and `rubricId === w.rubric.id`; `fieldsAt` exists; max points equal the top level; the grade pre-read; points, comment and grade unchanged (the grade may already be final).
    5. Per checked mark: the rubric PUT and its re-read when the grade is not final; a refused or untaken PUT fails that mark ("…: the form was not posted").
    6. If any mark is left: one `POST` of `withMarkAt` folded over them. On a throw, every remaining mark is half-written; rethrow `NO_SESSION`.
    7. Read the page back; names changed outside the remaining marks' `namesAt` (tokens ignored) → each remaining mark `{ status: 'failed', unsafe: true, error: 'Posted, but other fields changed: …' }`. Otherwise per mark: fields equal final (points, rubric score, override 1, comment) else half-written; then its grade re-read equals final else "The form saved, but Schoology's rubric shows …"; posted marks update `quiz_responses` as in 4b.
  - `postWritebacks` groups the batch by `memberSid:qid` (in batch order), calls `postGroup`, records each result with the guarded `record`, and throws `UNSAFE` after recording when any result is unsafe.
  - Remove `postOne`, `ATTEMPT_PATH`'s use in `post`, and `inPagePost`'s attempt-only comment.

- [ ] **Step 4: Run** `npx vitest run server/ mcp/` (PASS). **Commit** `feat(quizzes): post FRQ marks through the grade-by-question page (one form save per question)`.

---

### Task 3: Docs, review, live round trip, landing

- [ ] Suites and build. Update `.claude/build-progress.md` (phase 4c), `docs/design-language.md` only if the UI changed (it does not).
- [ ] Fresh reviewer on the 4c range.
- [ ] **Stop and ask Graham** for the live round trip on the 2024-25 Q21 page through dev Prism (one student to Exhibiting with " (test)", then back), compared field by field with the 4a capture and the stage D page.
- [ ] Land on `main` with his approval.
