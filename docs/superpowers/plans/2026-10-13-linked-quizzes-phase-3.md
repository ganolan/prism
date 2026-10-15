# Linked Quizzes, Phase 3 (Overall Result) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent reads each student's quiz numbers from Prism and writes the overall result (levels per measurement topic and a short impression) to the linked result task; Prism builds the comment from the group's template, the Grading cards show the quiz line, and a stale comment can be rebuilt with one click. Four phase 2 follow-ups are fixed first.

**Architecture:** A pure comment builder (`server/lib/quizComment.js`) owns the template rules. A read model (`server/services/quizResults.js`) turns Prism's stored copy into per-student numbers, confirmed FRQ marks, readiness and the state of any overall suggestion. A write module (`server/services/quizOverall.js`) gates on readiness, builds the comment and stores it through the existing `upsertStudentSuggestion`, which gains a `quiz_overall` field in `feedback_json`. REST, MCP and the client all read the same `quizResults` output.

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest (server and client), React + React Testing Library, DOMPurify 3.1.6 (client), PrisMCP (`@modelcontextprotocol/sdk`, zod).

**Spec:** `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md`, §13 (phase 3), with §6, §7 and §12 for context.

## Global Constraints

- ESM only. The one new column, `quiz_groups.comment_template`, goes in `server/db/schema.sql` **and** the `MIGRATIONS` array in `server/db/index.js`.
- Prism keeps a full copy; **nothing in phase 3 reads or writes Schoology**.
- The overall result is an **ordinary suggestion** on the linked result task (`feedback` table, through `upsertStudentSuggestion`); it never writes `mastery_scores`, `grades` or Schoology.
- **Confirmed FRQ mark:** Prism `accepted`/`edited` final (source `prism`); else, with no Prism mark, the stored Schoology mark with a cell for every rubric row, or points for an FRQ without a rubric (source `schoology`). Prism `suggested` is "to review"; nothing is "not marked".
- **Placeholders:** exactly `{mcq_correct}`, `{mcq_total}`, `{mcq_percent}`, `{frq_levels}`, `{impression}`. A saved template must contain `{impression}`; an empty one resets to the default.
- **Default template** (spec §7; student-facing, British spelling):
  ```
  Multiple choice: {mcq_correct}/{mcq_total} ({mcq_percent}%)
  Free response: {frq_levels}
  {impression}
  Open your attempt on the test to read the feedback on each free-response question.
  ```
  The MCQ line only when the group has an MCQ; both free-response lines only when it has an FRQ.
- **`{frq_levels}`:** `Q21 Exhibiting` (one row), `Q21 (Content: Exhibiting, Code: Developing)` (several rows), `Q21 3/4 points` (no rubric); FRQs in question order, joined with `, `.
- UI colours only through CSS custom properties in `client/src/app.css`; buttons `.primary` / `.secondary` / `.ghost`; badges `badge badge-amber` etc. as in `FrqCard.jsx`.
- **No em dashes** in UI copy or `mcp/` strings (guard tests). Dates through `formatDateTime`.
- Every notable UI decision is appended to `docs/design-language.md`.
- Server tests: `npx vitest run <path>` from the repo root. Client tests: `npm --prefix client run test -- run <path>` from the repo root.
- Dev on the mini: a worktree with its own DB, `PORT=3002`; never kill by port; never touch `~/prism/releases` or `~/prism/data`.

## Review Focus

1. **A template that names a placeholder for a kind the group lacks** (for example `{frq_levels}` on an MCQ-only quiz): the line is dropped, not printed as `Free response: `. Test in Task 3.
2. **A Schoology mark with a cell for only some rubric rows** (a teacher who clicked one row in Schoology): it is "not marked", never a half level in the comment. Test in Task 5.
3. **A student whose FRQ goes back to "to review" after the overall suggestion** (a new agent suggestion on an edited mark is fine, but a fresh FRQ suggestion on an unmarked answer): no stale prompt and **Update numbers** is refused with the reason. Test in Task 6.
4. **The teacher edits the template after suggestions exist:** every overall suggestion whose comment now differs shows "Numbers changed"; Update numbers rewrites it with the stored impression. Test in Task 6.
5. **An agent sends `rubric_scores` with a numeric level or an unknown topic** to `write_quiz_overall_suggestions`: the comment is still written, and the result reports the ignored key, as `write_student_suggestions` does. Test in Task 7.

---

## File Structure

**Server:**
- `server/db/schema.sql`, `server/db/index.js`: `comment_template`.
- `server/lib/quizComment.js` (new): template rules (pure).
- `server/services/quizGroups.js`: `comment_template`, `default_comment_template` on a group; `setCommentTemplate`.
- `server/services/quizResults.js` (new): the read model.
- `server/services/suggestions.js`: `quiz_overall` passthrough.
- `server/services/quizOverall.js` (new): write and rebuild.
- `server/services/frqMarks.js`: `recordWriteback` guard (follow-up).
- `server/routes/quizzes.js`: three routes.

**MCP:** `mcp/handlers.js`, `mcp/server.js` (two tools, the `cells` union, instructions).

**Client:**
- `client/src/lib/sanitizeHtml.js`: no data/aria attributes; `sanitizeStemHtml`.
- `client/src/components/quiz/FreeResponseTab.jsx`: stems through `sanitizeStemHtml`.
- `client/src/services/api.js`: three calls.
- `client/src/components/quiz/QuizResultLine.jsx` (new) and `client/src/hooks/useQuizResults.js` (new).
- `client/src/pages/AssessmentSummaryPage.jsx`: the line on cards; `onUpdated` for the modal.
- `client/src/components/quiz/QuizSetupModal.jsx`: the template editor.

**Docs:** `docs/design-language.md`, `.claude/build-progress.md`, the spec status line.

---

### Task 1: Server follow-ups (numeric `cells`, write-back guard)

**Files:**
- Modify: `mcp/server.js` (the `write_frq_suggestions` schema)
- Modify: `server/services/frqMarks.js` (`recordWriteback`)
- Test: `mcp/server.test.js`, `server/services/frqMarks.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `recordWriteback` throws `QuizError('NOT_ELIGIBLE', …)` unless the mark's `writeback_status` is `pending` or `failed`.

- [ ] **Step 1: Write the failing tests**

In `server/services/frqMarks.test.js`, inside the existing write-back `describe` (or a new `describe('recordWriteback guard')`):

```js
test('recordWriteback refuses a mark that is not waiting or failed', () => {
  writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Developing', comment: 'x' }] });
  setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
  recordWriteback(db, { groupId: g, student: 'u1', position: 21, status: 'posted' });
  // The teacher then changes it in Schoology; a second "posted" must not overwrite posted_*.
  setSchoology(a1, 3, 'hand edit');
  expect(() => recordWriteback(db, { groupId: g, student: 'u1', position: 21, status: 'posted' }))
    .toThrow(/only a mark waiting to post or failed/i);
  expect(cellsOf(mark(a1).posted_cells_json)).toEqual({ 146: 2 });
});
```

In `mcp/server.test.js`, add a `describe('PrisMCP quiz tools')` with its own seed (the file's `beforeEach` does not clear quiz tables, so clear them here):

```js
describe('PrisMCP quiz tools', () => {
  const RUBRIC = { id: 'r1', title: 'FRQ', totalPoints: 4, rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
    { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth: all' }, { points: 2, name: 'Developing', descriptionHtml: 'Developing: some' }] }] };
  let g;
  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups;');
    const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('8458134135', 'AP CSP')`).run().lastInsertRowid;
    const t = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'Ep 1', 1)`).run(c).lastInsertRowid;
    g = db.prepare(`INSERT INTO quiz_groups (course_id, title) VALUES (?, 'Ep 1')`).run(c).lastInsertRowid;
    db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)').run(g, t);
    const q = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json) VALUES (?, 21, 'frq', 'Explain', 4, ?)`).run(g, JSON.stringify(RUBRIC)).lastInsertRowid;
    for (const [uid, last] of [['701', 'Lee'], ['702', 'Ng']]) {
      const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Ana', ?)`).run(uid, last).lastInsertRowid;
      const a = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, ?, 'now')`).run(g, t, s, `5${uid}`).lastInsertRowid;
      db.prepare('INSERT INTO quiz_responses (attempt_id, question_id, answer_html) VALUES (?, ?, ?)').run(a, q, '<p>a</p>');
    }
  });

  test('write_frq_suggestions: a numeric level fails that student only', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'write_frq_suggestions', arguments: { group_id: g, question: 21, students: [
      { student: '701', cells: { 146: 3 }, comment: 'x' },
      { student: '702', level: 'Developing', comment: 'y' },
    ] } });
    const body = JSON.parse(res.content[0].text);
    expect(body.written).toBe(1);
    expect(body.results[0]).toMatchObject({ status: 'error', message: expect.stringMatching(/unknown level 3/) });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run server/services/frqMarks.test.js mcp/server.test.js`
Expected: FAIL. The guard test does not throw; the MCP call returns an input validation error (`isError`), so `JSON.parse` fails.

- [ ] **Step 3: Implement**

In `mcp/server.js`, the `write_frq_suggestions` input schema:

```js
cells: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('{ rubric row title or id: level name }'),
```

In `server/services/frqMarks.js`, `recordWriteback`, after the `if (!row?.final_cells_json)` line:

```js
  if (!['pending', 'failed'].includes(row.writeback_status)) {
    throw new QuizError('NOT_ELIGIBLE', `Only a mark waiting to post or failed can be recorded (this one is ${row.writeback_status})`);
  }
```

Update the `mark_frq_writeback` tool description in `mcp/server.js` to end: `Refused for a mark that is not waiting to post or failed.`

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run server/services/frqMarks.test.js mcp/`
Expected: PASS (the existing `mark_frq_writeback` handler test records `posted` on a `pending` mark, so it still passes).

- [ ] **Step 5: Commit**

```bash
git add mcp/server.js mcp/server.test.js server/services/frqMarks.js server/services/frqMarks.test.js
git commit -m "fix(quizzes): numeric FRQ level fails one student; write-back only from pending or failed"
```

---

### Task 2: Client follow-ups (sanitizer attributes, stem images)

**Files:**
- Modify: `client/src/lib/sanitizeHtml.js`
- Modify: `client/src/components/quiz/FreeResponseTab.jsx:89`
- Test: `client/src/lib/sanitizeHtml.test.js`

**Interfaces:**
- Produces: `sanitizeStemHtml(html) => string`: the answer rules plus `img` with an `http(s)` `src` and `alt`.

- [ ] **Step 1: Write the failing tests** (append to `client/src/lib/sanitizeHtml.test.js`, and import `sanitizeStemHtml` beside `sanitizeAnswerHtml`)

```js
it('keeps no data- or aria- attributes', () => {
  expect(sanitizeAnswerHtml('<p data-x="1" aria-label="y">hi</p>')).toBe('<p>hi</p>');
});

it('a stem keeps an http(s) image with its alt text, and nothing that runs', () => {
  const out = sanitizeStemHtml('<p>Look:</p><img src="https://schoology.hkis.edu.hk/system/files/a.png" alt="diagram" onerror="alert(1)" width="9"><img src="javascript:alert(1)"><img src="data:image/png;base64,AAAA"><script>x()</script>');
  expect(out).toBe('<p>Look:</p><img src="https://schoology.hkis.edu.hk/system/files/a.png" alt="diagram"><img><img>');
});

it('an answer still drops images', () => {
  expect(sanitizeAnswerHtml('<img src="https://e.com/a.png" alt="a">')).toBe('');
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm --prefix client run test -- run src/lib/sanitizeHtml.test.js`
Expected: FAIL (`data-x` kept; `sanitizeStemHtml` is not exported).

- [ ] **Step 3: Implement** (`client/src/lib/sanitizeHtml.js`, whole file)

```js
// Student-authored answer HTML (linked quizzes, spec §12) goes into the DOM only through
// sanitizeAnswerHtml: text formatting, lists, code and tables, with no attributes at all
// (data- and aria- included), so nothing can run, load or link. Teacher-authored stems go
// through sanitizeStemHtml, which also keeps an image from an http(s) address with its alt text.
import DOMPurify from 'dompurify';

const TAGS = ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup',
  'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];

const ANSWER = { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false };
const STEM = {
  ALLOWED_TAGS: [...TAGS, 'img'], ALLOWED_ATTR: ['src', 'alt'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
};

export const sanitizeAnswerHtml = (html) => DOMPurify.sanitize(String(html ?? ''), ANSWER);
export const sanitizeStemHtml = (html) => DOMPurify.sanitize(String(html ?? ''), STEM);
```

In `FreeResponseTab.jsx`, import `sanitizeStemHtml` alongside (or instead of, if it is the only use) `sanitizeAnswerHtml`, and change line 89 to `sanitizeStemHtml(question.stem_html)`. Add `.frq-stem img { max-width: 100%; height: auto; }` to `client/src/app.css` beside the existing `.frq-stem` rules.

- [ ] **Step 4: Run to see them pass**

Run: `npm --prefix client run test -- run src/lib/sanitizeHtml.test.js src/components/quiz`
Expected: PASS. If DOMPurify keeps `src` on the `javascript:`/`data:` images differently from the expected string, read the actual output and keep the assertion strict on what matters (no `javascript:`, no `data:`, no `onerror`) rather than weakening it to `toContain`.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/sanitizeHtml.js client/src/lib/sanitizeHtml.test.js client/src/components/quiz/FreeResponseTab.jsx client/src/app.css
git commit -m "fix(quizzes): sanitizer drops data/aria attributes; FRQ stems keep their images"
```

---

### Task 3: The comment builder

**Files:**
- Create: `server/lib/quizComment.js`
- Test: `server/lib/quizComment.test.js`

**Interfaces:**
- Produces:
  - `PLACEHOLDERS: string[]`
  - `defaultTemplate({ hasMcq, hasFrq }) => string`
  - `validateTemplate(template) => { ok: true } | { error: string }`
  - `buildComment(template, values) => string`; `values` keys are the placeholder names, `null`/missing means empty.
  - `frqLevelsText(frqs) => string`; each `frq` is `{ question, has_rubric, levels: [{ row, level, points }], points, max_points }`.

- [ ] **Step 1: Write the failing tests** (`server/lib/quizComment.test.js`)

```js
import { describe, test, expect } from 'vitest';
import { defaultTemplate, validateTemplate, buildComment, frqLevelsText, PLACEHOLDERS } from './quizComment.js';

const FULL = 'Multiple choice: {mcq_correct}/{mcq_total} ({mcq_percent}%)\nFree response: {frq_levels}\n{impression}\nOpen your attempt on the test to read the feedback on each free-response question.';

describe('defaultTemplate', () => {
  test('MCQ and FRQ: the spec §7 template', () => {
    expect(defaultTemplate({ hasMcq: true, hasFrq: true })).toBe(FULL);
  });
  test('MCQ only: no free-response lines', () => {
    expect(defaultTemplate({ hasMcq: true, hasFrq: false })).toBe('Multiple choice: {mcq_correct}/{mcq_total} ({mcq_percent}%)\n{impression}');
  });
  test('FRQ only: no multiple-choice line', () => {
    expect(defaultTemplate({ hasMcq: false, hasFrq: true }).split('\n')[0]).toBe('Free response: {frq_levels}');
  });
});

describe('validateTemplate', () => {
  test('accepts the known placeholders', () => {
    expect(validateTemplate(FULL)).toEqual({ ok: true });
    expect(PLACEHOLDERS).toEqual(['mcq_correct', 'mcq_total', 'mcq_percent', 'frq_levels', 'impression']);
  });
  test('names each unknown placeholder once', () => {
    expect(validateTemplate('{impression} {score} {score} {name}')).toEqual({ error: 'Unknown placeholders: {score}, {name}' });
  });
  test('requires {impression}', () => {
    expect(validateTemplate('Multiple choice: {mcq_percent}%')).toEqual({ error: 'The template needs {impression}' });
  });
});

describe('buildComment', () => {
  const values = { mcq_correct: 17, mcq_total: 20, mcq_percent: 85, frq_levels: 'Q21 Exhibiting', impression: 'A secure start.' };
  test('fills every placeholder', () => {
    expect(buildComment(FULL, values)).toBe('Multiple choice: 17/20 (85%)\nFree response: Q21 Exhibiting\nA secure start.\nOpen your attempt on the test to read the feedback on each free-response question.');
  });
  test('drops a line whose placeholders are all empty, keeps lines without placeholders', () => {
    const t = 'Multiple choice: {mcq_percent}%\nFree response: {frq_levels}\n{impression}\nWell done.';
    expect(buildComment(t, { mcq_percent: 90, frq_levels: null, impression: 'Good.' })).toBe('Multiple choice: 90%\nGood.\nWell done.');
  });
  test('trims blank lines at the start and the end, keeps blank lines inside', () => {
    expect(buildComment('\n\n{impression}\n\nThanks.\n\n', { impression: 'Hi.' })).toBe('Hi.\n\nThanks.');
  });
  test('a multi-line impression stays as written; 0 is a value, not empty', () => {
    expect(buildComment('MCQ {mcq_correct}\n{impression}', { mcq_correct: 0, impression: 'One.\nTwo.' })).toBe('MCQ 0\nOne.\nTwo.');
  });
});

describe('frqLevelsText', () => {
  test('one row, several rows, no rubric, in the order given', () => {
    expect(frqLevelsText([
      { question: 21, has_rubric: true, levels: [{ row: 'Content Knowledge', level: 'Exhibiting', points: 3 }] },
      { question: 22, has_rubric: true, levels: [{ row: 'Content', level: 'Exhibiting', points: 3 }, { row: 'Code', level: 'Developing', points: 2 }] },
      { question: 23, has_rubric: false, levels: [{ row: 'Points', level: null, points: 3 }], points: 3, max_points: 4 },
    ])).toBe('Q21 Exhibiting, Q22 (Content: Exhibiting, Code: Developing), Q23 3/4 points');
  });
  test('no FRQs is empty', () => {
    expect(frqLevelsText([])).toBe('');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run server/lib/quizComment.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`server/lib/quizComment.js`)

```js
// The overall comment on a quiz's result task (spec §7, §13). Prism builds it from the group's
// template so the numbers always match the stored data; the agent writes only {impression}.
// Pure: no database, no Schoology.
export const PLACEHOLDERS = ['mcq_correct', 'mcq_total', 'mcq_percent', 'frq_levels', 'impression'];

const MCQ_LINE = 'Multiple choice: {mcq_correct}/{mcq_total} ({mcq_percent}%)';
const FRQ_LINE = 'Free response: {frq_levels}';
const ATTEMPT_LINE = 'Open your attempt on the test to read the feedback on each free-response question.';
const TOKEN = /\{([^{}]*)\}/g;

export function defaultTemplate({ hasMcq, hasFrq }) {
  return [
    ...(hasMcq ? [MCQ_LINE] : []),
    ...(hasFrq ? [FRQ_LINE] : []),
    '{impression}',
    ...(hasFrq ? [ATTEMPT_LINE] : []),
  ].join('\n');
}

export function validateTemplate(template) {
  const used = [...String(template ?? '').matchAll(TOKEN)].map(m => m[1]);
  const unknown = [...new Set(used.filter(p => !PLACEHOLDERS.includes(p)))];
  if (unknown.length) {
    return { error: `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map(p => `{${p}}`).join(', ')}` };
  }
  if (!used.includes('impression')) return { error: 'The template needs {impression}' };
  return { ok: true };
}

const isEmpty = (v) => v == null || String(v).trim() === '';

export function buildComment(template, values) {
  const lines = String(template ?? '').replace(/\r\n?/g, '\n').split('\n').flatMap((line) => {
    const names = [...line.matchAll(TOKEN)].map(m => m[1]);
    if (names.length && names.every(k => isEmpty(values[k]))) return [];
    return [line.replace(TOKEN, (_, k) => (isEmpty(values[k]) ? '' : String(values[k]))).replace(/\s+$/, '')];
  });
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

export function frqLevelsText(frqs) {
  return (frqs || []).map((f) => {
    if (!f.has_rubric) return `Q${f.question} ${f.points}/${f.max_points} points`;
    if (f.levels.length === 1) return `Q${f.question} ${f.levels[0].level}`;
    return `Q${f.question} (${f.levels.map(l => `${l.row}: ${l.level}`).join(', ')})`;
  }).join(', ');
}
```

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run server/lib/quizComment.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/quizComment.js server/lib/quizComment.test.js
git commit -m "feat(quizzes): overall comment builder (template, placeholders, FRQ levels)"
```

---

### Task 4: The template on the group (column, service, route, client call)

**Files:**
- Modify: `server/db/schema.sql` (`quiz_groups`), `server/db/index.js` (`MIGRATIONS`)
- Modify: `server/services/quizGroups.js` (`getGroup`, new `setCommentTemplate`)
- Modify: `server/routes/quizzes.js`, `client/src/services/api.js`
- Test: `server/services/quizGroups.test.js`, `server/routes/quizzes.test.js`, `server/services/quizSchema.test.js` if it pins `quiz_groups` columns

**Interfaces:**
- Consumes: `defaultTemplate`, `validateTemplate` (Task 3).
- Produces:
  - `getGroup(db, id)` gains `comment_template: string | null` and `default_comment_template: string`.
  - `setCommentTemplate(db, { groupId, template }) => group` (throws `QuizError('NOT_ELIGIBLE', message)` on an invalid template).
  - `PUT /api/quizzes/:id/template` body `{ template }` → `{ group }`.
  - Client `setQuizTemplate(groupId, template)`.

- [ ] **Step 1: Write the failing tests**

In `server/services/quizGroups.test.js` (import `setCommentTemplate`; the file's `make()` creates a group whose `LIST` has two MCQs and one FRQ):

```js
describe('comment template', () => {
  test('a group shows the default built from its question kinds until a template is saved', () => {
    const g = make().id;
    let group = getGroup(db, g);
    expect(group.comment_template).toBeNull();
    expect(group.default_comment_template.split('\n')).toEqual([
      'Multiple choice: {mcq_correct}/{mcq_total} ({mcq_percent}%)', 'Free response: {frq_levels}', '{impression}',
      'Open your attempt on the test to read the feedback on each free-response question.']);
    db.prepare(`DELETE FROM quiz_questions WHERE group_id = ? AND kind = 'frq'`).run(g);
    expect(getGroup(db, g).default_comment_template).toBe('Multiple choice: {mcq_correct}/{mcq_total} ({mcq_percent}%)\n{impression}');
    group = setCommentTemplate(db, { groupId: g, template: 'Score {mcq_percent}%\r\n{impression}' });
    expect(group.comment_template).toBe('Score {mcq_percent}%\n{impression}');
  });

  test('refuses an invalid template; an empty one resets to the default', () => {
    const g = make().id;
    expect(() => setCommentTemplate(db, { groupId: g, template: '{grade}' })).toThrow(/Unknown placeholder: \{grade\}/);
    setCommentTemplate(db, { groupId: g, template: '{impression}!' });
    expect(setCommentTemplate(db, { groupId: g, template: '  \n ' }).comment_template).toBeNull();
  });
});
```

In `server/routes/quizzes.test.js`:

```js
test('PUT /:id/template saves, refuses an unknown placeholder with 400', async () => {
  const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
  const ok = await call('PUT', `/api/quizzes/${id}/template`, { template: '{impression}' });
  expect([ok.status, ok.body.group.comment_template]).toEqual([200, '{impression}']);
  const bad = await call('PUT', `/api/quizzes/${id}/template`, { template: '{score}' });
  expect([bad.status, bad.body.error]).toEqual([400, 'Unknown placeholder: {score}']);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run server/services/quizGroups.test.js server/routes/quizzes.test.js`
Expected: FAIL (`setCommentTemplate` not exported; route 404).

- [ ] **Step 3: Implement**

`server/db/schema.sql`, in `quiz_groups` after `result_assignment_id`:

```sql
  -- The overall comment's template (spec §13); NULL means the default built from the question kinds.
  comment_template TEXT,
```

`server/db/index.js`, append to `MIGRATIONS`:

```js
  `ALTER TABLE quiz_groups ADD COLUMN comment_template TEXT`,
```

`server/services/quizGroups.js`: import `{ defaultTemplate, validateTemplate }` from `'../lib/quizComment.js'`. In `getGroup`, replace the `frq_count` line with a kinds query and add the two fields:

```js
  const kinds = db.prepare(`SELECT SUM(kind = 'mcq') AS mcq, SUM(kind = 'frq') AS frq FROM quiz_questions WHERE group_id = ?`).get(g.id);
  ...
    frq_count: kinds.frq || 0,
    comment_template: g.comment_template ?? null,
    default_comment_template: defaultTemplate({ hasMcq: kinds.mcq > 0, hasFrq: kinds.frq > 0 }),
```

Add:

```js
// The overall comment's template (spec §13). Blank resets to the default.
export function setCommentTemplate(db, { groupId, template }) {
  const g = groupRow(db, groupId);
  const text = String(template ?? '').replace(/\r\n?/g, '\n');
  let stored = null;
  if (text.trim()) {
    const v = validateTemplate(text);
    if (v.error) throw new QuizError('NOT_ELIGIBLE', v.error);
    stored = text;
  }
  db.prepare(`UPDATE quiz_groups SET comment_template = ?, updated_at = datetime('now') WHERE id = ?`).run(stored, g.id);
  return getGroup(db, g.id);
}
```

`server/routes/quizzes.js`: import `setCommentTemplate`; add

```js
router.put('/:id/template', handle((req, db) => ({ group: setCommentTemplate(db, { groupId: req.params.id, template: req.body.template }) })));
```

`client/src/services/api.js`, in the linked-quizzes block:

```js
export const setQuizTemplate = (groupId, template) => request(`/quizzes/${groupId}/template`, { method: 'PUT', body: JSON.stringify({ template }) });
```

`server/services/quizSchema.test.js` pins table names only, so it is unchanged. Add one assertion there that the column exists: `expect(db.prepare('PRAGMA table_info(quiz_groups)').all().map(c => c.name)).toContain('comment_template');`

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run server/`
Expected: PASS (whole server suite; `frq_count` keeps its value).

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.sql server/db/index.js server/services/quizGroups.js server/services/quizGroups.test.js server/routes/quizzes.js server/routes/quizzes.test.js server/services/quizSchema.test.js client/src/services/api.js
git commit -m "feat(quizzes): comment template on the quiz group"
```

---

### Task 5: The results read model

**Files:**
- Create: `server/services/quizResults.js`
- Test: `server/services/quizResults.test.js`

**Interfaces:**
- Consumes: `getGroup`, `attemptUrl` (`quizGroups.js`); `schoologyMarkOf` (`frqMarks.js`); `levelsOf` (`frqResponses.js`); `getAlignedTopics` (`assessmentContext.js`); `studentFullName`; `defaultTemplate`, `buildComment`, `frqLevelsText` (Task 3).
- Produces: `confirmedMark(markRow, schoology, rubric) => { source, cells } | { reason: 'to review' | 'not marked' }` and `quizResults(db, { groupId })` returning:

```js
{
  group: { id, title, loaded_at, template, template_is_default,
    result: { id, schoology_assignment_id, title, topics: [{ external_id, title }] } | null },
  questions: { mcq: number, frq: [{ position, has_rubric, max_points }] },
  students: [{
    student_id, name, schoology_uid, attempt_url,
    mcq: { correct, total, percent } | null,
    by_tag: [{ tag, correct, total, percent }],              // MCQs only, tag order as first seen
    frq: [{ question, has_rubric, confirmed, source, reason, levels: [{ row, level, points }], points, max_points }],
    ready: boolean, blocked: string[],                         // e.g. ['Q21 to review']
    comment_values: { mcq_correct, mcq_total, mcq_percent, frq_levels },  // null where a kind is absent
    overall: { feedback_id, rubric_scores, impression, status, suggestion_state, stale } | null,
  }],                                                          // sorted by name
  not_taken: [{ student_id, name, schoology_uid }],
}
```

- [ ] **Step 0: `quiz_overall` passthrough in `upsertStudentSuggestion`, test first**

The overall tests below write suggestions with `quiz_overall`, so this one-field change comes first. Append to `server/services/suggestions.test.js`:

```js
test('quiz_overall is stored in feedback_json when given, and absent otherwise', () => {
  const db = getDb();
  seed(db);
  const a = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'n', quiz_overall: { group_id: 4, impression: 'Good.' } });
  expect(JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(a.feedback_id).feedback_json).quiz_overall).toEqual({ group_id: 4, impression: 'Good.' });
  const b = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'n2' });
  expect(JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(b.feedback_id).feedback_json)).not.toHaveProperty('quiz_overall');
});
```

Run `npx vitest run server/services/suggestions.test.js` and see it fail; then in `server/services/suggestions.js` add `quiz_overall` to the destructured parameters of `upsertStudentSuggestion` and to `feedbackJson`:

```js
    evidence: evidence ?? null,
    ...(quiz_overall ? { quiz_overall } : {}),
```

Run again: PASS.

- [ ] **Step 1: Write the failing tests** (`server/services/quizResults.test.js`)

```js
import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { quizResults, confirmedMark } from './quizResults.js';
import { writeFrqSuggestions, setFrqMark } from './frqMarks.js';
import { upsertStudentSuggestion } from './suggestions.js';

const RUBRIC = { id: 'r1', title: 'FRQ', totalPoints: 4, rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'x' }, { points: 3, name: 'Exhibiting', descriptionHtml: 'x' },
  { points: 2, name: 'Developing', descriptionHtml: 'x' }, { points: 1, name: 'Emerging', descriptionHtml: 'x' }] }] };
const TWO_ROWS = { ...RUBRIC, rows: [RUBRIC.rows[0], { ...RUBRIC.rows[0], id: '147', title: 'Code' }] };

let db, c, g, result, q1, q2, q21, att, stu;
const respond = (a, q, fields) => db.prepare(`INSERT INTO quiz_responses (attempt_id, question_id, chosen_letter, is_correct, points, answer_html, schoology_rubric_cells_json, schoology_comment)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(a, q, fields.letter ?? null, fields.correct ?? null, fields.points ?? null, fields.answer ?? null,
  fields.cells ? JSON.stringify(fields.cells) : null, fields.comment ?? null);

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM feedback; DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'AP CSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'CSP.1', 'Theory')`).run(c);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat', ?, 'CSP.1.1', 'Knowledge')`).run(c);
  const test = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'Ep 1', 1)`).run(c).lastInsertRowid;
  result = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, '950', 'Ep 1 - Result (S)')`).run(c).lastInsertRowid;
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('950', 't1', ?)`).run(c);
  g = db.prepare(`INSERT INTO quiz_groups (course_id, title, result_assignment_id, loaded_at) VALUES (?, 'Ep 1', ?, '2026-10-13 01:00:00')`).run(c, result).lastInsertRowid;
  db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)').run(g, test);
  const addQ = (pos, kind, tags, rubric = null, max = 1) => db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json, tags_json) VALUES (?, ?, ?, 'S', ?, ?, ?)`)
    .run(g, pos, kind, max, rubric ? JSON.stringify(rubric) : null, JSON.stringify(tags)).lastInsertRowid;
  q1 = addQ(1, 'mcq', ['AAP-1.A']);
  q2 = addQ(2, 'mcq', ['AAP-1.A', 'CRD-2.G']);
  q21 = addQ(21, 'frq', [], RUBRIC, 4);
  stu = {}; att = {};
  for (const [uid, last] of [['u1', 'Lee'], ['u2', 'Ng'], ['u3', 'Wu']]) {
    stu[uid] = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Ana', ?)`).run(uid, last).lastInsertRowid;
    db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(stu[uid], c);
  }
  for (const uid of ['u1', 'u2']) {
    att[uid] = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, ?, 'now')`).run(g, test, stu[uid], `5${uid}`).lastInsertRowid;
  }
  respond(att.u1, q1, { letter: 'a', correct: 1 });
  respond(att.u1, q2, { letter: 'b', correct: 0 });
  respond(att.u1, q21, { answer: '<p>x</p>', cells: { 146: { points: 3, comment: '' } } });   // marked in Schoology
  respond(att.u2, q1, { letter: null, correct: 0 });                                         // blank
  respond(att.u2, q2, { letter: 'a', correct: 1 });
  respond(att.u2, q21, { answer: '<p>y</p>' });                                             // not marked
});

describe('confirmedMark', () => {
  const sch = (cells) => ({ cells, comment: '' });
  test('Prism final wins; suggested is to review; Schoology needs every row', () => {
    expect(confirmedMark({ state: 'edited', final_cells_json: '{"146":2}' }, sch({ 146: 3 }), RUBRIC)).toEqual({ source: 'prism', cells: { 146: 2 } });
    expect(confirmedMark({ state: 'suggested', final_cells_json: null }, sch({ 146: 3 }), RUBRIC)).toEqual({ reason: 'to review' });
    expect(confirmedMark(null, sch({ 146: 3 }), RUBRIC)).toEqual({ source: 'schoology', cells: { 146: 3 } });
    expect(confirmedMark(null, sch({ 146: 3 }), TWO_ROWS)).toEqual({ reason: 'not marked' });
    expect(confirmedMark(null, null, RUBRIC)).toEqual({ reason: 'not marked' });
    expect(confirmedMark(null, sch({ points: 3 }), null)).toEqual({ source: 'schoology', cells: { points: 3 } });
  });
});

describe('quizResults', () => {
  test('numbers per student, by tag with blanks as wrong, readiness and not taken', () => {
    const r = quizResults(db, { groupId: g });
    expect(r.group).toMatchObject({ id: g, template_is_default: true, result: { schoology_assignment_id: '950', topics: [{ external_id: 'CSP.1.1', title: 'Knowledge' }] } });
    expect(r.questions).toEqual({ mcq: 2, frq: [{ position: 21, has_rubric: true, max_points: 4 }] });
    const [lee, ng] = r.students;
    expect(lee).toMatchObject({ name: 'Ana Lee', mcq: { correct: 1, total: 2, percent: 50 }, ready: true, blocked: [],
      by_tag: [{ tag: 'AAP-1.A', correct: 1, total: 2, percent: 50 }, { tag: 'CRD-2.G', correct: 0, total: 1, percent: 0 }],
      comment_values: { mcq_correct: 1, mcq_total: 2, mcq_percent: 50, frq_levels: 'Q21 Exhibiting' }, overall: null });
    expect(lee.frq[0]).toMatchObject({ question: 21, confirmed: true, source: 'schoology', levels: [{ row: 'Content Knowledge', level: 'Exhibiting', points: 3 }], points: 3 });
    expect(ng).toMatchObject({ ready: false, blocked: ['Q21 not marked'], by_tag: [{ tag: 'AAP-1.A', correct: 1, total: 2 }, { tag: 'CRD-2.G', correct: 1, total: 1 }] });
    expect(r.not_taken.map(s => s.name)).toEqual(['Ana Wu']);
  });

  test('a Prism suggestion blocks until the teacher accepts it', () => {
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u2', level: 'Developing', comment: 'c' }] });
    expect(quizResults(db, { groupId: g }).students[1].blocked).toEqual(['Q21 to review']);
    setFrqMark(db, { groupId: g, attemptId: att.u2, position: 21, action: 'accept' });
    const ng = quizResults(db, { groupId: g }).students[1];
    expect([ng.ready, ng.frq[0].source, ng.comment_values.frq_levels]).toEqual([true, 'prism', 'Q21 Developing']);
  });

  test('an MCQ-only group has every student ready and null FRQ values', () => {
    db.prepare('DELETE FROM quiz_responses WHERE question_id = ?').run(q21);
    db.prepare('DELETE FROM quiz_questions WHERE id = ?').run(q21);
    const r = quizResults(db, { groupId: g });
    expect(r.students.every(s => s.ready)).toBe(true);
    expect(r.students[0].comment_values.frq_levels).toBeNull();
    expect(r.group.template).toBe('Multiple choice: {mcq_correct}/{mcq_total} ({mcq_percent}%)\n{impression}');
  });

  test('an existing overall suggestion shows its impression, and stale when the comment would now differ', () => {
    const built = 'Multiple choice: 1/2 (50%)\nFree response: Q21 Exhibiting\nGood.\nOpen your attempt on the test to read the feedback on each free-response question.';
    upsertStudentSuggestion(db, { assignmentId: '950', student: 'u1', narrative_feedback: built, rubric_scores: { 'CSP.1.1': 'EX' }, quiz_overall: { group_id: g, impression: 'Good.' } });
    expect(quizResults(db, { groupId: g }).students[0].overall).toMatchObject({ impression: 'Good.', rubric_scores: { 'CSP.1.1': 'EX' }, stale: false });
    db.prepare(`UPDATE quiz_responses SET is_correct = 1 WHERE attempt_id = ? AND question_id = ?`).run(att.u1, q2);
    expect(quizResults(db, { groupId: g }).students[0].overall.stale).toBe(true);
  });

  test('a suggestion written without quiz_overall, or for another group, is not this quiz\'s overall', () => {
    upsertStudentSuggestion(db, { assignmentId: '950', student: 'u1', narrative_feedback: 'by hand', rubric_scores: {} });
    expect(quizResults(db, { groupId: g }).students[0].overall).toBeNull();
  });

  test('an unlinked group has result null and no overall', () => {
    db.prepare('UPDATE quiz_groups SET result_assignment_id = NULL WHERE id = ?').run(g);
    const r = quizResults(db, { groupId: g });
    expect([r.group.result, r.students[0].overall]).toEqual([null, null]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run server/services/quizResults.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`server/services/quizResults.js`)

```js
// The overall-result read model (spec §13): per student, the MCQ score, percent by tag,
// confirmed FRQ marks, readiness for an overall suggestion, and the state of that suggestion.
// Built only from Prism's stored copy; nothing here reads Schoology.
import { getGroup, attemptUrl } from './quizGroups.js';
import { schoologyMarkOf } from './frqMarks.js';
import { levelsOf } from './frqResponses.js';
import { getAlignedTopics } from './assessmentContext.js';
import { studentFullName } from './studentNames.js';
import { buildComment, frqLevelsText } from '../lib/quizComment.js';

const parse = (t, fallback = null) => (t ? JSON.parse(t) : fallback);
const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);
const byName = (x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);

// The mark the overall result may use: the teacher's Prism mark, else Schoology's own mark
// when it covers every rubric row. A Prism suggestion the teacher has not acted on blocks.
export function confirmedMark(markRow, schoology, rubric) {
  if (markRow?.final_cells_json && markRow.state !== 'suggested') return { source: 'prism', cells: parse(markRow.final_cells_json) };
  if (markRow?.state === 'suggested') return { reason: 'to review' };
  const cells = schoology?.cells || {};
  const complete = rubric ? rubric.rows.every(r => cells[r.id] != null) : cells.points != null;
  return complete ? { source: 'schoology', cells } : { reason: 'not marked' };
}

function overallFor(db, group, studentId, template, values, ready) {
  if (!group.result) return null;
  const fb = db.prepare(`SELECT * FROM feedback WHERE student_id = ? AND assignment_id = ?
    ORDER BY updated_at DESC, id DESC LIMIT 1`).get(studentId, group.result.id);
  const fj = parse(fb?.feedback_json, {});
  if (!fb || fj.quiz_overall?.group_id !== group.id) return null;
  const rebuilt = buildComment(template, { ...values, impression: fj.quiz_overall.impression });
  return {
    feedback_id: fb.id, rubric_scores: fj.rubric_scores || {}, impression: fj.quiz_overall.impression,
    status: fb.status, suggestion_state: fb.suggestion_state ?? null,
    stale: ready && rebuilt !== (fj.narrative_feedback ?? ''),
  };
}

export function quizResults(db, { groupId }) {
  const group = getGroup(db, groupId);
  const questions = db.prepare('SELECT * FROM quiz_questions WHERE group_id = ? ORDER BY position').all(group.id);
  const mcqs = questions.filter(q => q.kind === 'mcq');
  const frqs = questions.filter(q => q.kind === 'frq');
  const template = group.comment_template ?? group.default_comment_template;

  const attempts = db.prepare(`SELECT qa.id, qa.student_id, qa.schoology_attempt_id, qa.completed_at,
      s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher, a.schoology_assignment_id AS member_sid
    FROM quiz_attempts qa JOIN students s ON s.id = qa.student_id JOIN assignments a ON a.id = qa.assignment_id
    WHERE qa.group_id = ?`).all(group.id);
  const responseQ = db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ? AND question_id = ?');
  const markQ = db.prepare('SELECT * FROM frq_marks WHERE attempt_id = ? AND question_id = ?');

  const students = attempts.map((a) => {
    const correctOf = (q) => responseQ.get(a.id, q.id)?.is_correct === 1;
    const mcqCorrect = mcqs.filter(correctOf).length;
    const tags = new Map();
    for (const q of mcqs) {
      for (const tag of parse(q.tags_json, [])) {
        const t = tags.get(tag) || { tag, correct: 0, total: 0 };
        t.total += 1;
        if (correctOf(q)) t.correct += 1;
        tags.set(tag, t);
      }
    }
    const frq = frqs.map((q) => {
      const rubric = parse(q.schoology_rubric_json);
      const c = confirmedMark(markQ.get(a.id, q.id), schoologyMarkOf(responseQ.get(a.id, q.id), rubric), rubric);
      const base = { question: q.position, has_rubric: !!rubric, max_points: q.max_points };
      if (!c.cells) return { ...base, confirmed: false, source: null, reason: c.reason, levels: [], points: null };
      const levels = levelsOf(rubric, c.cells);
      return { ...base, confirmed: true, source: c.source, reason: null, levels, points: levels.reduce((n, l) => n + Number(l.points ?? 0), 0) };
    });
    const blocked = frq.filter(f => !f.confirmed).map(f => `Q${f.question} ${f.reason}`);
    const ready = blocked.length === 0;
    const mcq = mcqs.length ? { correct: mcqCorrect, total: mcqs.length, percent: pct(mcqCorrect, mcqs.length) } : null;
    const comment_values = {
      mcq_correct: mcq?.correct ?? null, mcq_total: mcq?.total ?? null, mcq_percent: mcq?.percent ?? null,
      frq_levels: frqs.length && ready ? frqLevelsText(frq) : null,
    };
    return {
      student_id: a.student_id, name: studentFullName(a), schoology_uid: a.schoology_uid, attempt_url: attemptUrl(a),
      mcq, by_tag: [...tags.values()].map(t => ({ ...t, percent: pct(t.correct, t.total) })),
      frq, ready, blocked, comment_values,
      overall: overallFor(db, group, a.student_id, template, comment_values, ready),
    };
  }).sort(byName);

  const taken = new Set(attempts.map(a => a.student_id));
  const not_taken = db.prepare(`SELECT s.id, s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher
    FROM enrolments e JOIN students s ON s.id = e.student_id WHERE e.course_id = ? AND e.dropped_at IS NULL`).all(group.course_id)
    .filter(s => !taken.has(s.id)).map(s => ({ student_id: s.id, name: studentFullName(s), schoology_uid: s.schoology_uid })).sort(byName);

  const resultRow = group.result
    ? db.prepare('SELECT course_id, schoology_assignment_id FROM assignments WHERE id = ?').get(group.result.id)
    : null;
  return {
    group: {
      id: group.id, title: group.title, loaded_at: group.loaded_at, template, template_is_default: group.comment_template == null,
      result: group.result ? {
        ...group.result,
        topics: getAlignedTopics(db, resultRow.course_id, resultRow.schoology_assignment_id).map(t => ({ external_id: t.external_id, title: t.title })),
      } : null,
    },
    questions: { mcq: mcqs.length, frq: frqs.map(q => ({ position: q.position, has_rubric: !!q.schoology_rubric_json, max_points: q.max_points })) },
    students,
    not_taken,
  };
}
```

Check `attemptUrl`'s expected fields in `quizGroups.js:195` (it reads `member_sid`, `schoology_uid`, `schoology_attempt_id`, the same query as `frqResponses.js`); keep the select aligned with it.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run server/services/quizResults.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/quizResults.js server/services/quizResults.test.js server/services/suggestions.js server/services/suggestions.test.js
git commit -m "feat(quizzes): quiz results read model (scores, tags, confirmed FRQs, readiness)"
```

---

### Task 6: Writing and rebuilding the overall suggestion

**Files:**
- Create: `server/services/quizOverall.js`
- Modify: `server/routes/quizzes.js`, `client/src/services/api.js`
- Test: `server/services/quizOverall.test.js`, `server/routes/quizzes.test.js`

**Interfaces:**
- Consumes: `quizResults` (Task 5), `buildComment` (Task 3), `upsertStudentSuggestion` with `quiz_overall` (Task 5 Step 0), `resolveStudentId`.
- Produces:
  - `writeOverallSuggestions(db, { groupId, students }) => { written, results: [{ student, status: 'written'|'error', message?, feedback_id?, unresolved_topics? }] }`.
  - `rebuildOverallSuggestion(db, { groupId, studentId }) => student` (the updated `quizResults` student entry).
  - Routes `GET /api/quizzes/:id/results` and `POST /api/quizzes/:id/overall/:studentId/rebuild` (`{ student }`).
  - Client `getQuizResults(groupId)`, `rebuildQuizOverall(groupId, studentId)`.

- [ ] **Step 1: Write the failing tests** (`server/services/quizOverall.test.js`)

Copy the `beforeEach` seed and imports from `quizResults.test.js` (Task 5) into this file verbatim (the engineer may read tasks out of order), then:

```js
import { writeOverallSuggestions, rebuildOverallSuggestion } from './quizOverall.js';
import { quizResults } from './quizResults.js';
import { setFrqMark, writeFrqSuggestions } from './frqMarks.js';

const latest = (studentId) => db.prepare(`SELECT * FROM feedback WHERE student_id = ? AND assignment_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`).get(studentId, result);

describe('writeOverallSuggestions', () => {
  test('builds the comment from the template; refuses the not-ready, the absent and the unknown per student', () => {
    const r = writeOverallSuggestions(db, { groupId: g, students: [
      { student: 'u1', rubric_scores: { 'CSP.1.1': 'Exhibiting' }, impression: 'A secure start on variables.' },
      { student: 'u2', rubric_scores: { 'CSP.1.1': 'Developing' }, impression: 'x' },
      { student: 'u3', rubric_scores: {}, impression: 'x' },
      { student: 'nobody', rubric_scores: {}, impression: 'x' },
    ] });
    expect(r.written).toBe(1);
    expect(r.results.map(x => [x.status, x.message ?? null])).toEqual([
      ['written', null],
      ['error', 'Not ready: Q21 not marked'],
      ['error', 'No attempt on this quiz'],
      ['error', 'Student not found: nobody'],
    ]);
    const fj = JSON.parse(latest(stu.u1).feedback_json);
    expect(fj.narrative_feedback).toBe('Multiple choice: 1/2 (50%)\nFree response: Q21 Exhibiting\nA secure start on variables.\nOpen your attempt on the test to read the feedback on each free-response question.');
    expect(fj.rubric_scores).toEqual({ 'CSP.1.1': 'EX' });
    expect(fj.quiz_overall).toEqual({ group_id: g, impression: 'A secure start on variables.' });
  });

  test('requires an impression', () => {
    const r = writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: {}, impression: '  ' }] });
    expect(r.results[0]).toMatchObject({ status: 'error', message: 'impression is required' });
  });

  test('passes on an unresolved topic and a numeric level as written-with-notes', () => {
    const r = writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.9.9': 'EX', 'CSP.1.1': '3' }, impression: 'Good.' }] });
    expect(r.results[0]).toMatchObject({ status: 'written', unresolved_topics: ['CSP.9.9'], message: expect.stringMatching(/numeric/) });
  });

  test('refuses the whole call for an unlinked or never-loaded group', () => {
    db.prepare('UPDATE quiz_groups SET loaded_at = NULL WHERE id = ?').run(g);
    expect(() => writeOverallSuggestions(db, { groupId: g, students: [] })).toThrow(/Load the results first/);
    db.prepare(`UPDATE quiz_groups SET loaded_at = 'x', result_assignment_id = NULL WHERE id = ?`).run(g);
    expect(() => writeOverallSuggestions(db, { groupId: g, students: [] })).toThrow(/Link this quiz group to its result task first/);
  });
});

describe('rebuildOverallSuggestion', () => {
  const write = () => writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.1.1': 'EX' }, impression: 'Good.', reviewer_flags_brief: ['Check Q2'] }] });

  test('rewrites the numbers with the stored impression, levels and flags; a used comment comes back revised', () => {
    write();
    db.prepare(`UPDATE feedback SET suggestion_state = 'used' WHERE id = ?`).run(latest(stu.u1).id);
    db.prepare('UPDATE quiz_responses SET is_correct = 1 WHERE attempt_id = ? AND question_id = ?').run(att.u1, q2);
    expect(quizResults(db, { groupId: g }).students[0].overall.stale).toBe(true);
    const s = rebuildOverallSuggestion(db, { groupId: g, studentId: stu.u1 });
    expect(s.overall).toMatchObject({ stale: false, impression: 'Good.', rubric_scores: { 'CSP.1.1': 'EX' }, suggestion_state: 'revised' });
    const fj = JSON.parse(latest(stu.u1).feedback_json);
    expect(fj.narrative_feedback.split('\n')[0]).toBe('Multiple choice: 2/2 (100%)');
    expect(fj.reviewer_flags_brief).toEqual(['Check Q2']);
  });

  test('a template edit makes it stale too', () => {
    write();
    db.prepare(`UPDATE quiz_groups SET comment_template = '{impression}\nMCQ {mcq_percent}%' WHERE id = ?`).run(g);
    expect(quizResults(db, { groupId: g }).students[0].overall.stale).toBe(true);
    expect(JSON.parse(latest(stu.u1).feedback_json).narrative_feedback).toMatch(/^Multiple choice/);
    rebuildOverallSuggestion(db, { groupId: g, studentId: stu.u1 });
    expect(JSON.parse(latest(stu.u1).feedback_json).narrative_feedback).toBe('Good.\nMCQ 50%');
  });

  test('refused when the student is no longer ready, with no stale prompt', () => {
    write();
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Developing', comment: 'new' }] });
    expect(quizResults(db, { groupId: g }).students[0].overall.stale).toBe(false);
    expect(() => rebuildOverallSuggestion(db, { groupId: g, studentId: stu.u1 })).toThrow(/Not ready: Q21 to review/);
  });

  test('refused when there is no overall suggestion', () => {
    expect(() => rebuildOverallSuggestion(db, { groupId: g, studentId: stu.u1 })).toThrow(/no overall suggestion/i);
  });
});
```

Note on the third rebuild test: u1's FRQ was confirmed from Schoology (no Prism mark). A new Prism suggestion creates a `suggested` mark, so u1 becomes "to review": that is spec §13's rule (Review Focus 3).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run server/services/quizOverall.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`server/services/quizOverall.js`)

```js
// The overall result on a quiz's linked result task (spec §13): an ordinary suggestion whose
// comment Prism builds from the group's template. The agent supplies levels and an impression;
// Prism refuses a student whose FRQ marks are not confirmed yet.
import { QuizError } from './quizError.js';
import { quizResults } from './quizResults.js';
import { resolveStudentId } from './idResolvers.js';
import { upsertStudentSuggestion } from './suggestions.js';
import { buildComment } from '../lib/quizComment.js';

function eligibleResults(db, groupId) {
  const data = quizResults(db, { groupId });
  if (!data.group.result) throw new QuizError('NOT_ELIGIBLE', 'Link this quiz group to its result task first');
  if (!data.group.loaded_at) throw new QuizError('NOT_ELIGIBLE', 'Load the results first');
  return data;
}

function store(db, data, st, fields) {
  return upsertStudentSuggestion(db, {
    ...fields,
    assignmentId: data.group.result.schoology_assignment_id,
    student: st.student_id,
    narrative_feedback: buildComment(data.group.template, { ...st.comment_values, impression: fields.quiz_overall.impression }),
  });
}

export function writeOverallSuggestions(db, { groupId, students }) {
  const data = eligibleResults(db, groupId);
  const results = (students || []).map((s) => {
    const fail = (message) => ({ student: s.student, status: 'error', message });
    const studentId = resolveStudentId(db, s.student);
    if (!studentId) return fail(`Student not found: ${s.student}`);
    const st = data.students.find(x => x.student_id === studentId);
    if (!st) return fail('No attempt on this quiz');
    if (!st.ready) return fail(`Not ready: ${st.blocked.join(', ')}`);
    const impression = String(s.impression ?? '').trim();
    if (!impression) return fail('impression is required');
    const r = store(db, data, st, {
      rubric_scores: s.rubric_scores, reviewer_flags: s.reviewer_flags, reviewer_flags_brief: s.reviewer_flags_brief,
      quiz_overall: { group_id: data.group.id, impression },
    });
    return { ...r, student: s.student };
  });
  return { written: results.filter(r => r.status === 'written').length, results };
}

// Update numbers: the same suggestion with the current numbers and template.
export function rebuildOverallSuggestion(db, { groupId, studentId }) {
  const data = eligibleResults(db, groupId);
  const st = data.students.find(x => x.student_id === Number(studentId));
  if (!st) throw new QuizError('NOT_FOUND', 'No attempt on this quiz for that student');
  if (!st.overall) throw new QuizError('NOT_ELIGIBLE', 'There is no overall suggestion to update');
  if (!st.ready) throw new QuizError('NOT_ELIGIBLE', `Not ready: ${st.blocked.join(', ')}`);
  const fj = JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(st.overall.feedback_id).feedback_json);
  store(db, data, st, {
    rubric_scores: fj.rubric_scores, reviewer_flags: fj.reviewer_flags, reviewer_flags_brief: fj.reviewer_flags_brief,
    strengths: fj.strengths, suggestions: fj.suggestions, scale_level: fj.scale_level, evidence: fj.evidence,
    quiz_overall: fj.quiz_overall,
  });
  return quizResults(db, { groupId }).students.find(x => x.student_id === st.student_id);
}
```

Note: `upsertStudentSuggestion` re-normalizes stored codes (`'EX'` stays `'EX'`) and re-resolves topic keys, so a rebuild reports nothing new. `scale_level` is `null` for an aligned result task; passing `null` keeps it unset.

- [ ] **Step 4: Routes and client calls, test first**

Append to `server/routes/quizzes.test.js`:

```js
test('GET /:id/results and POST rebuild', async () => {
  const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
  const r = await call('GET', `/api/quizzes/${id}/results`);
  expect([r.status, r.body.students, r.body.group.result]).toEqual([200, [], null]);
  const rebuilt = await call('POST', `/api/quizzes/${id}/overall/1/rebuild`);
  expect([rebuilt.status, rebuilt.body.code]).toEqual([400, 'NOT_ELIGIBLE']);
});
```

Run it (FAIL), then in `server/routes/quizzes.js` import `quizResults` and `rebuildOverallSuggestion` and add:

```js
router.get('/:id/results', handle((req, db) => quizResults(db, { groupId: req.params.id })));
router.post('/:id/overall/:studentId/rebuild', handle((req, db) => ({
  student: rebuildOverallSuggestion(db, { groupId: req.params.id, studentId: req.params.studentId }),
})));
```

`client/src/services/api.js`:

```js
export const getQuizResults = (groupId) => request(`/quizzes/${groupId}/results`);
export const rebuildQuizOverall = (groupId, studentId) => request(`/quizzes/${groupId}/overall/${studentId}/rebuild`, { method: 'POST' });
```

- [ ] **Step 5: Run to see them pass**

Run: `npx vitest run server/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/quizOverall.js server/services/quizOverall.test.js server/routes/quizzes.js server/routes/quizzes.test.js client/src/services/api.js
git commit -m "feat(quizzes): write and rebuild the overall suggestion on the result task"
```

---

### Task 7: PrisMCP tools `get_quiz_results` and `write_quiz_overall_suggestions`

**Files:**
- Modify: `mcp/handlers.js`, `mcp/server.js`
- Test: `mcp/handlers.test.js`, `mcp/server.test.js`

**Interfaces:**
- Consumes: `quizResults` (Task 5), `writeOverallSuggestions` (Task 6).
- Produces: `getQuizResultsTool(db, { group_id })` (the `quizResults` output with `comment_values` and `attempt_url` kept, `overall.feedback_id` dropped) and `writeQuizOverallSuggestionsTool(db, { group_id, students })`.

- [ ] **Step 1: Write the failing tests**

In `mcp/handlers.test.js`, inside `describe('quiz tools')`, add (import the two tools at the top beside the other quiz tools):

```js
function seedOverall() {
  const db = getDb();
  const { c, g, a } = seedFrq();
  const r = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, '950', 'Ep 1 - Result (S)')`).run(c).lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('qc', ?, 'CSP.1', 'Theory')`).run(c);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('qt', 'qc', ?, 'CSP.1.1', 'Knowledge')`).run(c);
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('950', 'qt', ?)`).run(c);
  db.prepare(`UPDATE quiz_groups SET result_assignment_id = ?, loaded_at = '2026-10-13 01:00:00' WHERE id = ?`).run(r, g);
  return { g, a };
}

test('get_quiz_results gives numbers, confirmed FRQs and the result task topics', () => {
  const { g } = seedOverall();
  const r = getQuizResultsTool(getDb(), { group_id: g });
  expect(r.group.result.topics).toEqual([{ external_id: 'CSP.1.1', title: 'Knowledge' }]);
  expect(r.students[0]).toMatchObject({ student: 'Ana Lee', schoology_uid: '701', ready: true, frq: [{ question: 21, source: 'schoology', levels: [{ level: 'Developing' }] }] });
});

test('write_quiz_overall_suggestions writes the built comment and reports per student', () => {
  const { g } = seedOverall();
  const r = writeQuizOverallSuggestionsTool(getDb(), { group_id: g, students: [
    { student: '701', rubric_scores: { 'CSP.1.1': 'Developing' }, impression: 'Part (b) needs the term abstraction.' },
    { student: '999', rubric_scores: {}, impression: 'x' },
  ] });
  expect(r.written).toBe(1);
  expect(r.results[1]).toMatchObject({ status: 'error', message: 'Student not found: 999' });
  expect(getQuizResultsTool(getDb(), { group_id: g }).students[0].overall).toMatchObject({ impression: 'Part (b) needs the term abstraction.', stale: false });
});
```

`seedFrq`'s rubric has levels Exhibiting Depth (4) and Developing (2) and Schoology's cell at 2, so the confirmed level is Developing. Its `beforeEach` clears `feedback` already only if the file's top-level `beforeEach` does; check the `DELETE FROM …` list at the top of `mcp/handlers.test.js` and add `DELETE FROM feedback;` and `DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories;` if missing.

In `mcp/server.test.js`, inside `describe('PrisMCP quiz tools')` (Task 1), add:

```js
test('the overall tools are registered with their schemas', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  expect(names).toEqual(expect.arrayContaining(['get_quiz_results', 'write_quiz_overall_suggestions']));
  const w = tools.find(t => t.name === 'write_quiz_overall_suggestions');
  expect(w.inputSchema.properties.students.items.required).toEqual(expect.arrayContaining(['student', 'impression']));
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run mcp/`
Expected: FAIL (tools not exported or registered).

- [ ] **Step 3: Implement**

`mcp/handlers.js` (imports beside the other quiz imports):

```js
import { quizResults } from '../server/services/quizResults.js';
import { writeOverallSuggestions } from '../server/services/quizOverall.js';

// Phase 3 (spec §13): the overall result on the linked result task.
export function getQuizResultsTool(db, { group_id }) {
  const data = quizResults(db, { groupId: group_id });
  return {
    ...data,
    students: data.students.map(({ name, student_id, overall, ...rest }) => ({
      student: name, student_id, ...rest,
      overall: overall ? { rubric_scores: overall.rubric_scores, impression: overall.impression, status: overall.status, suggestion_state: overall.suggestion_state, stale: overall.stale } : null,
    })),
  };
}

export function writeQuizOverallSuggestionsTool(db, { group_id, students }) {
  return writeOverallSuggestions(db, { groupId: group_id, students });
}
```

`mcp/server.js`: import both tools; register after `mark_frq_writeback`:

```js
  server.registerTool(
    'get_quiz_results',
    {
      description: "A quiz group's results per student from Prism's stored copy (no Schoology request), for suggesting the overall result on the linked result task: the MCQ score (correct, total, percent), percent correct per tag, each FRQ's confirmed level (the teacher's Prism mark, else Schoology's own mark) or why it is not confirmed (to review, not marked), ready, any existing overall suggestion (levels, impression, stale), the result task's measurement topics, the comment template, and the students who have not taken it. Apply the course's cut-off guide to these numbers, then call write_quiz_overall_suggestions.",
      inputSchema: { group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups') },
    },
    async ({ group_id }) => text(() => getQuizResultsTool(getDb(), { group_id }))
  );

  server.registerTool(
    'write_quiz_overall_suggestions',
    {
      description: 'Write the overall result of a quiz as suggestions on its linked result task, for teacher review in Prism (never sent to Schoology). Per student: rubric_scores as { topic external_id or title: level name or code } (levels only; Prism owns the points) and a short student-facing impression (British spelling, one to three sentences). Prism builds the comment from the group template, so the MCQ score and FRQ levels always match its data: do not repeat the numbers in the impression. Refused for a student whose FRQs are not all confirmed (accept them on the Free response tab first) or who has no attempt. Returns { written, results: [{ student, status: written|error, message }] }.',
      inputSchema: {
        group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups'),
        students: z.array(z.object({
          student: z.union([z.number(), z.string()]).describe('schoology_uid or local student id'),
          rubric_scores: z.record(z.string(), z.string()).describe('{ topic external_id|title: proficiency level code or name }'),
          impression: z.string().describe('Student-facing overall impression; Prism adds the numbers and the line about the attempt'),
          reviewer_flags: z.string().nullable().optional().describe('Teacher-facing detail, one paragraph per flag'),
          reviewer_flags_brief: z.array(z.string()).optional().describe('One short line per reviewer flag'),
        })),
      },
    },
    async ({ group_id, students }) => text(() => writeQuizOverallSuggestionsTool(getDb(), { group_id, students }))
  );
```

Append to `INSTRUCTIONS` (before the closing `'`):

```js
  ' Overall result: get_quiz_results, then write_quiz_overall_suggestions (levels and an impression; Prism builds the comment).'
```

(Keep the string concatenation style; the `INSTRUCTIONS` test, if any, checks the text has no em dash.)

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run mcp/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/handlers.js mcp/handlers.test.js mcp/server.js mcp/server.test.js
git commit -m "feat(prismcp): get_quiz_results and write_quiz_overall_suggestions"
```

---

### Task 8: The quiz line and Update numbers on the Grading cards

**Files:**
- Create: `client/src/components/quiz/QuizResultLine.jsx`, `client/src/components/quiz/QuizResultLine.test.jsx`
- Create: `client/src/hooks/useQuizResults.js`
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (card prop `quizResult`, `onRebuildQuiz`; page wiring)
- Test: `client/src/pages/AssessmentSummaryPage.test.jsx`

**Interfaces:**
- Consumes: `getQuizResults`, `rebuildQuizOverall` (Task 6); the `quizResults` student shape (Task 5).
- Produces: `quizLineText(result) => string`; `<QuizResultLine result onRebuild />`; `useQuizResults({ groupId, enabled, reloadKey }) => { [studentId]: student }`.

- [ ] **Step 1: Write the failing component tests** (`client/src/components/quiz/QuizResultLine.test.jsx`)

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import QuizResultLine, { quizLineText } from './QuizResultLine.jsx';

const BASE = { mcq: { correct: 17, total: 20, percent: 85 }, frq: [
  { question: 21, has_rubric: true, confirmed: true, levels: [{ row: 'Content Knowledge', level: 'Exhibiting', points: 3 }], points: 3, max_points: 4 },
], overall: null };

describe('quizLineText', () => {
  it('MCQ and confirmed FRQ', () => {
    expect(quizLineText(BASE)).toBe('MCQ 17/20 (85%), FRQ Q21: Exhibiting');
  });
  it('an unconfirmed FRQ shows its reason; several rows and no rubric', () => {
    expect(quizLineText({ mcq: null, frq: [
      { question: 21, has_rubric: true, confirmed: false, reason: 'to review', levels: [] },
      { question: 22, has_rubric: true, confirmed: true, levels: [{ level: 'Exhibiting' }, { level: 'Developing' }] },
      { question: 23, has_rubric: false, confirmed: true, levels: [{ level: null, points: 3 }], points: 3, max_points: 4 },
    ] })).toBe('FRQ Q21: to review, Q22: Exhibiting / Developing, Q23: 3/4');
  });
});

describe('QuizResultLine', () => {
  it('shows the line, and no button while the comment is current', () => {
    render(<QuizResultLine result={{ ...BASE, overall: { stale: false } }} onRebuild={vi.fn()} />);
    expect(screen.getByText('MCQ 17/20 (85%), FRQ Q21: Exhibiting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update numbers' })).not.toBeInTheDocument();
  });

  it('a stale comment shows "Numbers changed" and Update numbers calls onRebuild', async () => {
    const onRebuild = vi.fn().mockResolvedValue();
    render(<QuizResultLine result={{ ...BASE, overall: { stale: true } }} onRebuild={onRebuild} />);
    expect(screen.getByText('Numbers changed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update numbers' }));
    await waitFor(() => expect(onRebuild).toHaveBeenCalledTimes(1));
  });

  it('shows a refused update as an error', async () => {
    render(<QuizResultLine result={{ ...BASE, overall: { stale: true } }} onRebuild={vi.fn().mockRejectedValue(new Error('Not ready: Q21 to review'))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update numbers' }));
    expect(await screen.findByText('Not ready: Q21 to review')).toBeInTheDocument();
  });

  it('renders nothing without a result', () => {
    const { container } = render(<QuizResultLine result={null} />);
    expect(container.innerHTML).toBe('');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm --prefix client run test -- run src/components/quiz/QuizResultLine.test.jsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the component** (`client/src/components/quiz/QuizResultLine.jsx`)

```jsx
// The quiz line on a result task's Grading card (spec §8, §13): the student's MCQ score and FRQ
// levels, live from Prism's copy. When the overall suggestion's comment no longer matches the
// numbers or the template, "Numbers changed" with Update numbers rebuilds it.
import { useState } from 'react';

const frqText = (f) => {
  if (!f.confirmed) return f.reason;
  if (!f.has_rubric) return `${f.points}/${f.max_points}`;
  return f.levels.map(l => l.level).join(' / ');
};

export function quizLineText(r) {
  const parts = [];
  if (r.mcq) parts.push(`MCQ ${r.mcq.correct}/${r.mcq.total} (${r.mcq.percent}%)`);
  if (r.frq?.length) parts.push(`FRQ ${r.frq.map(f => `Q${f.question}: ${frqText(f)}`).join(', ')}`);
  return parts.join(', ');
}

export default function QuizResultLine({ result, onRebuild }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!result) return null;
  async function rebuild() {
    setBusy(true); setError(null);
    try { await onRebuild(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <span className="quiz-result-line">
      <span>{quizLineText(result)}</span>
      {result.overall?.stale && (
        <>
          <span className="badge badge-amber" title="The suggested comment shows older numbers, or an older template">Numbers changed</span>
          <button className="ghost accent" disabled={busy} onClick={rebuild}>Update numbers</button>
        </>
      )}
      {error && <span className="badge badge-red">{error}</span>}
    </span>
  );
}
```

`client/src/app.css` (outside the PHONE LAYOUT block):

```css
.quiz-result-line { display: inline-flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; font-size: 0.78rem; color: var(--text-muted); }
.quiz-result-line button { font-size: 0.72rem; padding: 0.1rem 0.4rem; }
```


Run the component tests: PASS.

- [ ] **Step 4: The hook** (`client/src/hooks/useQuizResults.js`)

```js
// Per-student quiz results for a linked quiz group (spec §13), keyed by local student id.
// Keyed to the group it was fetched for; a failed call leaves {}.
import { useEffect, useState } from 'react';
import { getQuizResults } from '../services/api.js';

const NONE = {};

export function useQuizResults({ groupId = null, enabled = false, reloadKey = '' } = {}) {
  const [loaded, setLoaded] = useState({ groupId: null, byStudent: NONE });
  useEffect(() => {
    if (!enabled || groupId == null) return undefined;
    let active = true;
    Promise.resolve()
      .then(() => getQuizResults(groupId))
      .then(r => Object.fromEntries((r?.students || []).map(s => [s.student_id, s])))
      .catch(() => NONE)
      .then(byStudent => { if (active) setLoaded({ groupId, byStudent }); });
    return () => { active = false; };
  }, [groupId, enabled, reloadKey]);
  return loaded.groupId === groupId && enabled ? loaded.byStudent : NONE;
}
```

- [ ] **Step 5: Page and card tests** (append to `client/src/pages/AssessmentSummaryPage.test.jsx`; add `getQuizResults: vi.fn().mockResolvedValue({ students: [] })` and `rebuildQuizOverall: vi.fn()` to the `vi.mock('../services/api.js', …)` factory and the import list)

```jsx
describe('AssessmentSummaryPage - quiz line (linked quizzes, phase 3)', () => {
  const RESULT = { student_id: 1, mcq: { correct: 17, total: 20, percent: 85 }, frq: [
    { question: 21, has_rubric: true, confirmed: true, levels: [{ row: 'C', level: 'Exhibiting', points: 3 }], points: 3, max_points: 4 }], overall: { stale: true } };

  it('StudentRubricCard shows the quiz line and Update numbers', async () => {
    const onRebuildQuiz = vi.fn().mockResolvedValue();
    renderCard({ quizResult: RESULT, onRebuildQuiz });
    expect(screen.getByText('MCQ 17/20 (85%), FRQ Q21: Exhibiting')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update numbers' }));
    await waitFor(() => expect(onRebuildQuiz).toHaveBeenCalledWith(1));
  });

  it('the page fetches results for a linked group on the result task and passes them to the card', async () => {
    getFeatures.mockResolvedValue({ quizzes: true });
    getQuizGroupFor.mockResolvedValue({ group: { id: 7, title: 'Ep 1', members: [], result: { id: 50, schoology_assignment_id: '8', title: 'Launch' }, canonical_schoology_id: '8', frq_count: 1, loaded_at: '2026-10-13 01:00:00' } });
    getMasteryForAssignment.mockResolvedValue({
      assignment: { id: 50, schoology_assignment_id: '8', title: 'Launch', mastery_grading_period_id: 1, mastery_grading_category_id: 2 },
      topics: TOPICS, students: [makeStudent()],
    });
    getQuizResults.mockResolvedValue({ students: [RESULT] });
    render(
      <MemoryRouter initialEntries={['/course/4/assessment/8']}>
        <Routes><Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} /></Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('MCQ 17/20 (85%), FRQ Q21: Exhibiting')).toBeInTheDocument();
    expect(getQuizResults).toHaveBeenCalledWith(7);
  });
});
```

`renderCard` and `makeStudent` are the file's existing helpers (`makeStudent()` has `id: 1`); `getFeatures` and `getQuizGroupFor` are already in the mock, so import them and reset them after this `describe` (`afterEach(() => { getFeatures.mockResolvedValue({}); getQuizGroupFor.mockResolvedValue({ group: null }); })`) so later tests keep a page without a group.

- [ ] **Step 6: Wire the page**

In `AssessmentSummaryPage.jsx`:

1. Import `QuizResultLine` and `useQuizResults`, and `rebuildQuizOverall` from the api module.
2. `StudentRubricCard` gains props `quizResult = null, onRebuildQuiz = null`; right after `<AttemptLink … />`:

```jsx
        {/* The student's quiz numbers on a linked result task (linked quizzes, phase 3). */}
        <QuizResultLine result={quizResult} onRebuild={() => onRebuildQuiz(student.id)} />
```

3. In the page, after the `quizTab` state (`useStickyTab('assessment-quiz', …)`; the key below reads `quizTab`, so it must come after that line):

```jsx
  const [quizResultsKey, setQuizResultsKey] = useState(0);
  // Only on the linked result task; refetched after a load, an FRQ change on the other tabs, or an update.
  const quizResults = useQuizResults({
    groupId: quizGroup?.id ?? null,
    enabled: !!quizGroup?.result,
    reloadKey: `${dataVersion}|${quizGroup?.loaded_at ?? ''}|${quizGroup?.comment_template ?? ''}|${quizTab}|${quizResultsKey}`,
  });
  async function handleRebuildQuiz(studentId) {
    await rebuildQuizOverall(quizGroup.id, studentId);
    setQuizResultsKey(k => k + 1);
    load();
  }
```

4. On the `<StudentRubricCard … />` in the list, add `quizResult={quizResults[student.id] || null}` and `onRebuildQuiz={handleRebuildQuiz}`.

- [ ] **Step 7: Run to see them pass**

Run: `npm --prefix client run test -- run src/components/quiz src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/quiz/QuizResultLine.jsx client/src/components/quiz/QuizResultLine.test.jsx client/src/hooks/useQuizResults.js client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx client/src/app.css
git commit -m "feat(quizzes): quiz line and Update numbers on the result task's Grading cards"
```

---

### Task 9: The template editor in Quiz setup

**Files:**
- Modify: `client/src/components/quiz/QuizSetupModal.jsx`
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (the modal's `onUpdated`)
- Test: `client/src/components/quiz/QuizSetupModal.test.jsx`

**Interfaces:**
- Consumes: `setQuizTemplate` (Task 4); `group.comment_template`, `group.default_comment_template` (Task 4).
- Produces: `QuizSetupModal` prop `onUpdated(group)`: the group changed and the modal stays open (the page sets the group without closing).

- [ ] **Step 1: Write the failing tests** (in `QuizSetupModal.test.jsx`; add `setQuizTemplate: vi.fn()` to the mock factory and import)

```jsx
describe('QuizSetupModal - comment template', () => {
  const WITH_TEMPLATE = { ...LINKED, comment_template: null, default_comment_template: 'Multiple choice: {mcq_percent}%\n{impression}' };

  it('shows the default, lists the placeholders, saves an edit and stays open', async () => {
    const onUpdated = vi.fn();
    setQuizTemplate.mockResolvedValue({ group: { ...WITH_TEMPLATE, comment_template: 'Score {mcq_percent}%\n{impression}' } });
    render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={WITH_TEMPLATE} onClose={() => {}} onChanged={() => {}} onUpdated={onUpdated} />);
    const box = await screen.findByRole('textbox', { name: 'Overall comment template' });
    expect(box.value).toBe('Multiple choice: {mcq_percent}%\n{impression}');
    expect(screen.getByText(/\{mcq_correct\}/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'Score {mcq_percent}%\n{impression}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(setQuizTemplate).toHaveBeenCalledWith(7, 'Score {mcq_percent}%\n{impression}'));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ comment_template: 'Score {mcq_percent}%\n{impression}' }));
  });

  it('shows a refused template', async () => {
    setQuizTemplate.mockRejectedValue(new Error('Unknown placeholder: {score}'));
    render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={WITH_TEMPLATE} onClose={() => {}} onChanged={() => {}} onUpdated={() => {}} />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Overall comment template' }), { target: { value: '{score}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findByText('Unknown placeholder: {score}')).toBeInTheDocument();
  });

  it('Reset to default saves an empty template', async () => {
    setQuizTemplate.mockResolvedValue({ group: WITH_TEMPLATE });
    render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={{ ...WITH_TEMPLATE, comment_template: 'Hi {impression}' }} onClose={() => {}} onChanged={() => {}} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(setQuizTemplate).toHaveBeenCalledWith(7, ''));
  });

  it('no editor for an unlinked group', async () => {
    render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={{ ...GROUP, default_comment_template: '{impression}' }} onClose={() => {}} onChanged={() => {}} onUpdated={() => {}} />);
    await screen.findByText(/Result task/);
    expect(screen.queryByRole('textbox', { name: 'Overall comment template' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm --prefix client run test -- run src/components/quiz/QuizSetupModal.test.jsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `QuizSetupModal.jsx`: add `onUpdated` to the props; import `setQuizTemplate`; state and a reset effect:

```jsx
  const savedTemplate = group?.comment_template ?? group?.default_comment_template ?? '';
  const [template, setTemplate] = useState(savedTemplate);
  useEffect(() => { setTemplate(savedTemplate); }, [savedTemplate]);
```

Inside the `{group && (<> … </>)}` block, after the link buttons row and before the closing fragment, only when `group.result`:

```jsx
            {group.result && (
              <div style={{ marginTop: '1rem' }}>
                <label className="text-sm" htmlFor="quiz-comment-template"><strong>Overall comment</strong></label>
                <p className="text-sm text-muted" style={{ margin: '0.2rem 0' }}>
                  Prism fills {'{mcq_correct}'}, {'{mcq_total}'}, {'{mcq_percent}'} and {'{frq_levels}'} from the results; {'{impression}'} is the suggestion's own text.
                </p>
                <textarea id="quiz-comment-template" aria-label="Overall comment template" rows={5} style={{ width: '100%' }}
                  value={template} onChange={(e) => setTemplate(e.target.value)} />
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
                  <button className="secondary" disabled={busy || template === savedTemplate}
                    onClick={() => run(async () => onUpdated((await setQuizTemplate(group.id, template)).group))}>Save template</button>
                  {group.comment_template != null && (
                    <button className="ghost" disabled={busy}
                      onClick={() => run(async () => onUpdated((await setQuizTemplate(group.id, '')).group))}>Reset to default</button>
                  )}
                </div>
              </div>
            )}
```

In `AssessmentSummaryPage.jsx`, on `<QuizSetupModal … />` add `onUpdated={(g) => setQuizGroup(g)}`.

- [ ] **Step 4: Run to see them pass**

Run: `npm --prefix client run test -- run src/components/quiz src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/quiz/QuizSetupModal.jsx client/src/components/quiz/QuizSetupModal.test.jsx client/src/pages/AssessmentSummaryPage.jsx
git commit -m "feat(quizzes): edit the overall comment template in Quiz setup"
```

---

### Task 10: Docs, the live check on the Ep 1 data, and landing

**Files:**
- Modify: `docs/design-language.md`, `.claude/build-progress.md`, `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md` (status line)

- [ ] **Step 1: Full suites and build**

Run: `npx vitest run` (server and MCP), `npm --prefix client run test -- run`, `npm run build`.
Expected: all pass; record the counts.

- [ ] **Step 2: Live check (dev clone on the mini)**

1. Own DB: `DB_PATH=<worktree>/server/db/students.db npm run db:refresh`, then `DB_PATH=<same> node scripts/verify-quiz-phase1.js` (loads the Ep 1 groups).
2. `PORT=3002 DB_PATH=<same> npm run dev` (in the background; it stops at the 2-hour limit).
3. In the BK 6 group: accept the FRQ marks needed (or rely on Schoology's marks), then, in a script under `scripts/` or with the handlers directly, call `getQuizResultsTool` and `writeQuizOverallSuggestionsTool` for two students with test impressions.
4. In the browser (`http://127.0.0.1:<vite port>/course/<id>/assessment/8544307980`): the Grading tab shows the quiz line on each card and the built comment in the suggestion; edit the template in Quiz setup, see "Numbers changed", click **Update numbers**, see the comment change.
5. Screenshots (names replaced) on the review page `https://claude.ai/artifact/6G95czH7tcXdzZG4oxBgc3`; ask Graham with AskUserQuestion.

- [ ] **Step 3: Docs**

- `docs/design-language.md`: the quiz line (muted, beside the Attempt link; "Numbers changed" amber badge with a small ghost button), the template editor (textarea with placeholders listed; Save disabled until changed; Reset shown only for a saved template).
- `.claude/build-progress.md`: a "Linked quizzes, phase 3" section above phase 2 (state, live check, suites, deferred follow-ups, next: phase 4). Remove the four fixed items from phase 2's deferred list, keeping the no-rubric ungraded item.
- Spec status line: phase 3 built (§13).

- [ ] **Step 4: Commit, then land with Graham's approval**

```bash
git add docs/design-language.md .claude/build-progress.md docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md
git commit -m "docs(quizzes): phase 3 design language and hand-off"
```

Landing on `main` deploys prod once CI is green: ask Graham before merging and pushing.

---

### Task 11: grade-theory-test writes the overall result through Prism (graham-plugins)

**Files:**
- Modify: `~/repos/graham-plugins/assessment-grader/skills/grade-theory-test/SKILL.md` (and its version in the plugin manifest)

- [ ] **Step 1: Read the skill's current Prism route** (added in 0.7.0) and its overall-proficiency step (MCQ percent plus confirmed FRQ level, then the cut-off guide).
- [ ] **Step 2: Edit the Prism route:** after the teacher confirms the FRQ marks on the Free response tab, call `get_quiz_results(group)`; apply the cut-off guide to each `ready` student's `mcq.percent` and confirmed FRQ levels; call `write_quiz_overall_suggestions` with `rubric_scores` and a one-to-three-sentence impression (British spelling, no numbers, which Prism adds); report refusals (students to review or not marked) to the teacher. The CSV route is unchanged.
- [ ] **Step 3:** Run the plugin's own checks if it has any (`scripts/` validation), bump the patch or minor version, commit and push in `graham-plugins` (its own repo and rules; ask Graham before pushing if unsure).

---

## Self-Review Notes

- Spec §13 coverage: follow-ups (Tasks 1, 2), confirmed marks and readiness (Task 5), template storage, placeholders, default, building, `{frq_levels}`, saving, editing (Tasks 3, 4, 9), results service (Task 5), stale and Update numbers (Tasks 5, 6, 8), MCP tools (Task 7), REST (Tasks 4, 6), UI (Tasks 8, 9), skill (Task 11), testing (each task; live in Task 10).
- Names used across tasks: `quizResults`, `confirmedMark`, `writeOverallSuggestions`, `rebuildOverallSuggestion`, `setCommentTemplate`, `getQuizResults`, `rebuildQuizOverall`, `setQuizTemplate`, `QuizResultLine`, `quizLineText`, `useQuizResults`, `onUpdated`, `onRebuildQuiz`, `quiz_overall`, `comment_values`.
