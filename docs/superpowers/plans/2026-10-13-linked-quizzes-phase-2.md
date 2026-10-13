# Linked Quizzes, Phase 2 (FRQ Marking) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent suggests a rubric level and a comment for each student's free-response answer, the teacher accepts or edits it on a Free response tab, and the accepted mark reaches the student's attempt in Schoology through an agent or by hand, with Prism detecting the post on the next load. Quiz results also refresh nightly.

**Architecture:** One new table (`frq_marks`) holds the suggestion layer and the teacher's mark side by side, keyed on the stable attempt row. `server/services/frqMarks.js` holds every state rule (suggest, accept, save, keep, write-back, detection); `server/services/frqResponses.js` is the read model that the REST route, the MCP tools and the client share. The loader calls the detection after each load, and a new `quizzes` phase of the unified sync reloads recently loaded groups at night. The client adds a sanitizer, a rubric grid, a card and the tab.

**Tech Stack:** Node ESM, Express, better-sqlite3, node-html-parser, Vitest (server and client), React + React Testing Library, DOMPurify 3.1.6 (client), PrisMCP (`@modelcontextprotocol/sdk`, zod).

**Spec:** `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md`, §12 (phase 2), with §4, §6 and §8 for context.

## Global Constraints

- ESM only. New tables use `CREATE TABLE IF NOT EXISTS` in `server/db/schema.sql`; existing tables stay as they are, so `MIGRATIONS` is unchanged.
- Prism keeps a full copy; **nothing on a page or in a tool reads Schoology live**. Only the loader (Load results, `load_quiz_results`, the nightly phase) reads Schoology, and it stays read-only (`assertReadOnlyUrl`).
- **Phase 2 sends nothing to Schoology.** Posting is by an agent or by hand; Prism only records and detects.
- A new suggestion **never changes `final_*`**. It replaces `suggested_*`, pushes the old suggestion onto `suggestion_history_json`, and sets `suggestion_revised` when the teacher's mark exists and differs.
- Levels from an agent are **names or Prism codes, never numbers**; Prism converts to points from the stored Schoology rubric. An FRQ without a rubric takes `points` (0 to `max_points`).
- Cells are stored as `{ "<rowId>": points }`; an FRQ without a rubric uses the single key `"points"`.
- Student answer HTML reaches the DOM **only** through `sanitizeAnswerHtml` (DOMPurify). MCP tools return answers as plain text with line breaks kept.
- The nightly reload covers groups whose `loaded_at` is within **28 days**, in courses that are not archived, only when the `quizzes` feature is on; a failure is logged and never fails the sync.
- UI colours only through CSS custom properties in `client/src/app.css` (the level fills come from `LEVEL_COLORS`, as in `RubricDescriptorGrid`). Buttons use `.primary` / `.secondary` / `.ghost` / `.tab-btn` / `.filter-btn`.
- **No em dashes** in UI copy or `mcp/` strings (guard tests). Dates through `formatDateTime`.
- Every notable UI decision is appended to `docs/design-language.md`.
- Server tests: `npx vitest run <path>` from the repo root. Client tests: `cd client && npx vitest run <path>`.

## Decisions taken while planning (differences from the spec)

- **Shuffled options are matched by text, not reported.** Spec §12 said a shuffled question would be a load warning with its counts left out. The loader already has each attempt's options, so a chosen option is stored under the stored letter with the same normalized text; counts stay correct and nothing is left out. Options whose texts differ as a set are still the existing "different answer options" mismatch. Task 2 updates §12 to match.
- **`get_frq_responses` also returns each student's MCQ score** (`correct`, `total`, `percent`, from `groupStats`). With it the grade-theory-test skill needs no CSV export on the Prism route; phase 3's `get_quiz_results` will add the per-tag detail.
- **A card accepted when its mark already matches Schoology** is `posted` at once (nothing to post).
- **"Changed in Schoology" is derived, not stored:** a `posted` mark whose stored Schoology copy now differs from `posted_*`.

## Review Focus

1. **A student who retook the test after a mark was written:** the older attempt is pruned on load and its mark goes with it (cascade); the new attempt starts unmarked. Test in Task 1.
2. **A teacher's hand edit in Schoology after Prism recorded `posted`:** the card shows "Changed in Schoology" and the next suggestion or load never overwrites the teacher's Prism mark. Test in Task 3.
3. **An agent sending a numeric level, an unknown row title, or a level for a rubric row that does not exist:** that student gets an error naming the problem and the rest are written. Test in Task 3.
4. **An answer containing `<img src=x onerror=...>` or `<script>`:** the answer renders as text only, without running or loading anything. Test in Task 9.
5. **The nightly phase when the Schoology session has expired:** one `NO_SESSION` stops the quiz phase after the first group (no repeated failures), the sync still finishes. Test in Task 8.

---

## File Structure

**Server:**
- `server/db/schema.sql`: `frq_marks`.
- `server/lib/quizText.js`: `plainTextLines`.
- `server/services/quizParity.js`, `server/services/quizStore.js`: options matched by text.
- `server/services/quizGroups.js`: `frq_count` on a group; exported `attemptUrl`.
- `server/services/frqMarks.js` (new): mark rules.
- `server/services/frqResponses.js` (new): read model and write-back list.
- `server/services/quizLoader.js`: detection after each load.
- `server/services/quizRefresh.js` (new), `server/services/syncOrchestrator.js`, `server/services/syncScheduler.js`: nightly phase.
- `server/routes/quizzes.js`: two routes.

**MCP:** `mcp/handlers.js`, `mcp/server.js` (four tools).

**Client:**
- `client/package.json`: `dompurify@3.1.6`.
- `client/src/lib/sanitizeHtml.js` (new).
- `client/src/components/quiz/FrqRubricGrid.jsx`, `FrqCard.jsx`, `FreeResponseTab.jsx` (new).
- `client/src/services/api.js`, `client/src/pages/AssessmentSummaryPage.jsx`, `client/src/lib/syncEvents.js`, `client/src/lib/syncRunLog.js`, `client/src/app.css`.

**Docs and the skill:** `docs/design-language.md`, `.claude/build-progress.md`, the spec; `~/repos/graham-plugins/assessment-grader/skills/grade-theory-test/SKILL.md`.

---

### Task 1: The `frq_marks` table and the group's FRQ count

**Files:**
- Modify: `server/db/schema.sql` (append after `quiz_tag_texts`, before `-- Indexes for common queries`)
- Modify: `server/services/quizGroups.js` (`getGroup`, `linkOf`)
- Test: `server/services/quizSchema.test.js`, `server/services/quizStore.test.js`

**Interfaces:**
- Produces: table `frq_marks (attempt_id, question_id, suggested_cells_json, suggested_comment, suggestion_history_json, suggestion_revised, final_cells_json, final_comment, state, writeback_status, writeback_at, writeback_error, posted_cells_json, posted_comment, updated_at)`, primary key `(attempt_id, question_id)`, cascading from `quiz_attempts` and `quiz_questions`.
- Produces: `getGroup(db, id).frq_count` (number); `attemptUrl({ member_sid, schoology_uid, schoology_attempt_id })` exported from `quizGroups.js`.

- [ ] **Step 1: Write the failing tests**

In `server/services/quizSchema.test.js`, replace the first test:

```js
  test('creates the quiz tables and frq_marks', () => {
    const names = getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'quiz_%' OR name = 'frq_marks') ORDER BY name`).all().map(r => r.name);
    expect(names).toEqual(['frq_marks', 'quiz_attempts', 'quiz_group_members', 'quiz_groups', 'quiz_question_copies', 'quiz_questions', 'quiz_responses', 'quiz_tag_texts']);
  });
```

In `server/services/quizStore.test.js`, add (reuse the file's existing seed helpers; read its `beforeEach` first and add `DELETE FROM frq_marks;` at the front of its cleanup `db.exec`):

```js
test('removing or pruning an attempt removes its FRQ marks', () => {
  const db = getDb();
  const attemptIds = db.prepare('SELECT id FROM quiz_attempts').all().map(r => r.id);
  const qid = db.prepare(`SELECT id FROM quiz_questions LIMIT 1`).get().id;
  for (const a of attemptIds) db.prepare(`INSERT INTO frq_marks (attempt_id, question_id, state) VALUES (?, ?, 'suggested')`).run(a, qid);
  db.prepare('DELETE FROM quiz_attempts WHERE id = ?').run(attemptIds[0]);
  expect(db.prepare('SELECT COUNT(*) n FROM frq_marks WHERE attempt_id = ?').get(attemptIds[0]).n).toBe(0);
});
```

If the file's seed creates no attempt before this test, seed one in the test with the same `storeAttempt` call the file's other tests use.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run server/services/quizSchema.test.js server/services/quizStore.test.js`
Expected: FAIL (`frq_marks` missing).

- [ ] **Step 3: Add the table**

In `server/db/schema.sql`, before `-- Indexes for common queries`:

```sql
-- Phase 2: a Prism mark on one free-response answer (spec §12). The suggestion layer
-- (suggested_*, history, revised flag) and the teacher's mark (final_*) are separate, so a
-- new suggestion never replaces the teacher's work. Cells: { "<rowId>": points }, or
-- { "points": n } without a rubric. state: 'suggested' | 'accepted' | 'edited'.
-- writeback_status: NULL (no teacher mark) | 'pending' | 'posted' | 'failed'.
-- Deleting the attempt (removed in Schoology, or replaced by a newer one) deletes its marks.
CREATE TABLE IF NOT EXISTS frq_marks (
  attempt_id INTEGER NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  suggested_cells_json TEXT,
  suggested_comment TEXT,
  suggestion_history_json TEXT NOT NULL DEFAULT '[]',
  suggestion_revised INTEGER NOT NULL DEFAULT 0,
  final_cells_json TEXT,
  final_comment TEXT,
  state TEXT NOT NULL DEFAULT 'suggested',
  writeback_status TEXT,
  writeback_at TEXT,
  writeback_error TEXT,
  posted_cells_json TEXT,
  posted_comment TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (attempt_id, question_id)
);
```

Then add `DELETE FROM frq_marks;` at the start of every test cleanup that deletes from `quiz_attempts` or `quiz_questions` (`grep -rln "DELETE FROM quiz_responses" server mcp`), so foreign keys never block a cleanup.

- [ ] **Step 4: Add `frq_count` and export `attemptUrl`**

In `server/services/quizGroups.js`, in `getGroup`'s returned object, after `load_summary`:

```js
    frq_count: db.prepare(`SELECT COUNT(*) AS n FROM quiz_questions WHERE group_id = ? AND kind = 'frq'`).get(g.id).n,
```

Replace `linkOf` with:

```js
export const attemptUrl = (r) =>
  `${SCHOOLOGY_BASE}/assignment/${r.member_sid}/assessment_results/student_stats/${r.schoology_uid}/${r.schoology_attempt_id}`;

const linkOf = (r) => ({ url: attemptUrl(r), completedAt: r.completed_at });
```

- [ ] **Step 5: Run the quiz and MCP suites**

Run: `npx vitest run server/services mcp server/routes/quizzes.test.js`
Expected: PASS. A test that compares a whole group with `toEqual` now needs `frq_count: <n>` in its expectation; add it (it is the number of `kind = 'frq'` questions that test seeded).

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.sql server/services/quizGroups.js server/services/*.test.js server/routes/quizzes.test.js mcp/handlers.test.js
git commit -m "feat(quizzes): frq_marks table and the group's FRQ count"
```

---

### Task 2: Options matched by text (shuffle guard)

**Files:**
- Modify: `server/services/quizParity.js` (`compareLoadedQuestion`, new `storedLetterFor`)
- Modify: `server/services/quizStore.js` (`storeAttempt`)
- Modify: `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md` (§12, "Shuffle guard")
- Test: `server/services/quizParity.test.js`, `server/services/quizStore.test.js`

**Interfaces:**
- Produces: `storedLetterFor(storedOptions, loadedOptions, letter) -> string | null`; `compareLoadedQuestion` compares option texts and key texts as sets.

- [ ] **Step 1: Write the failing tests**

In `server/services/quizParity.test.js`, inside `describe('compareLoadedQuestion', ...)`:

```js
  test('the same options in another order are not a mismatch', () => {
    const a = [{ letter: 'A', html: 'x', isKey: false }, { letter: 'B', html: 'y', isKey: true }, { letter: 'C', html: 'z', isKey: false }];
    const b = [{ letter: 'A', html: 'z', isKey: false }, { letter: 'B', html: 'x', isKey: false }, { letter: 'C', html: 'y', isKey: true }];
    expect(compareLoadedQuestion({ options: a }, { options: b })).toBeNull();
  });

  test('a key on a different option text is still a different key', () => {
    const a = [{ letter: 'A', html: 'x', isKey: true }, { letter: 'B', html: 'y', isKey: false }];
    const b = [{ letter: 'A', html: 'y', isKey: true }, { letter: 'B', html: 'x', isKey: false }];
    expect(compareLoadedQuestion({ options: a }, { options: b })).toMatch(/key/);
  });
```

And a new block:

```js
describe('storedLetterFor', () => {
  const stored = [{ letter: 'A', html: '<p>x</p>' }, { letter: 'B', html: 'y' }, { letter: 'C', html: 'z' }];
  const loaded = [{ letter: 'A', html: 'z' }, { letter: 'B', html: 'x' }, { letter: 'C', html: 'y' }];
  test('maps a chosen letter to the stored letter with the same text', () => {
    expect(storedLetterFor(stored, loaded, 'A')).toBe('C');
    expect(storedLetterFor(stored, loaded, 'B')).toBe('A');
  });
  test('null for no answer or an unknown letter', () => {
    expect(storedLetterFor(stored, loaded, null)).toBeNull();
    expect(storedLetterFor(stored, loaded, 'E')).toBeNull();
  });
});
```

Update the import line to `import { compareQuestionLists, matchCopies, compareLoadedQuestion, storedLetterFor } from './quizParity.js';`. If an existing test asserts that the same options in a different order are a mismatch, delete that assertion (the behaviour changes on purpose).

In `server/services/quizStore.test.js` add a test that stores a first attempt whose options are `x, y(key), z`, then a second student's attempt whose page shows `z, x, y(key)` with `C` chosen, and asserts the second response row has `chosen_letter = 'B'`, `is_correct = 1`, and that `storeAttempt` returned `mismatches: []`. Build both `parsed` objects in the shape the file's other tests use (`{ questions: [{ qid, options: [{ letter, html, isKey }], chosenLetter, isCorrect, points, maxPoints, answerHtml: null, comment: null }] }`).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run server/services/quizParity.test.js server/services/quizStore.test.js`
Expected: FAIL (`storedLetterFor` is not exported; the reordered attempt reports "different answer options").

- [ ] **Step 3: Implement**

In `server/services/quizParity.js`, replace `compareLoadedQuestion` and add `storedLetterFor`:

```js
// Copies and attempts may show a question's options in another order, so options and the
// key are compared by their text as sets; letters are display positions only.
export function compareLoadedQuestion(a, b) {
  if (a.options && b.options) {
    const texts = (o) => o.map(x => normalizeStem(x.html)).sort().join('|');
    if (texts(a.options) !== texts(b.options)) return 'different answer options';
    const keyTexts = (o) => o.filter(x => x.isKey).map(x => normalizeStem(x.html)).sort().join('|');
    if (keyTexts(a.options) !== keyTexts(b.options)) return 'a different key';
  }
  if (a.rubricId && b.rubricId && a.rubricId !== b.rubricId) return 'a different rubric';
  return null;
}

// The stored letter for the option shown under `letter` on a loaded attempt, matched by text.
export function storedLetterFor(storedOptions, loadedOptions, letter) {
  if (letter == null) return null;
  const chosen = loadedOptions.find(o => o.letter === letter);
  if (!chosen) return null;
  const text = normalizeStem(chosen.html);
  return storedOptions.find(o => normalizeStem(o.html) === text)?.letter ?? null;
}
```

In `server/services/quizStore.js`, import `storedLetterFor` beside `compareLoadedQuestion`, and in `storeAttempt` replace the `addResponse.run(` call's first arguments so the chosen letter is the stored one:

```js
      const storedOptions = l.options_json ? JSON.parse(l.options_json) : null;
      const chosenLetter = storedOptions && q.options
        ? storedLetterFor(storedOptions, q.options, q.chosenLetter) ?? q.chosenLetter
        : q.chosenLetter;
      addResponse.run(
        attemptRowId, l.id, chosenLetter, q.isCorrect == null ? null : (q.isCorrect ? 1 : 0),
        q.points, q.maxPoints, q.answerHtml, json(gradeInfo[q.qid] ?? null), q.comment || null,
      );
```

(`isCorrect` comes from the attempt's own key, so it is right in either order.)

In the spec's §12 "Shuffle guard", replace the paragraph with:

```markdown
The probe of a test with shuffled options is skipped (no test of Graham's shuffles). Instead the
loader compares options and the key by their text as sets, and stores each chosen option under the
stored letter with the same text, so counts stay correct when a copy or attempt shows the options in
another order. Options whose texts differ as a set remain a "different answer options" warning.
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run server/services`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/quizParity.js server/services/quizStore.js server/services/quizParity.test.js server/services/quizStore.test.js docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md
git commit -m "feat(quizzes): match answer options by text, so shuffled options count correctly"
```

---

### Task 3: FRQ mark rules

**Files:**
- Create: `server/services/frqMarks.js`
- Test: `server/services/frqMarks.test.js`

**Interfaces:**
- Consumes: `getGroup` (quizGroups), `resolveStudentId` (idResolvers), `normalizeLevel` (proficiencyScale), `plainText` (quizText), `QuizError`.
- Produces:
  - `POINTS_KEY = 'points'`
  - `schoologyMarkOf(responseRow, rubric) -> { cells, comment } | null`
  - `sameMark(a, b) -> boolean`
  - `resolveCells(questionRow, { cells?, level?, points? }) -> { cells } | { error }` (levels by name or code)
  - `validatePointCells(questionRow, cells) -> { cells } | { error }` (cells in points, from the UI)
  - `markView(markRow, schoologyMark) -> { state, suggested, final, suggestion_revised, writeback: { status, at, error }, changed_in_schoology } | null`
  - `writeFrqSuggestions(db, { groupId, position, students: [{ student, cells?, level?, points?, comment? }] }) -> { written, results: [{ student, status: 'written' | 'error', message? }] }`
  - `setFrqMark(db, { groupId, attemptId, position, action: 'accept' | 'save' | 'keep', cells?, comment? }) -> markView`
  - `recordWriteback(db, { groupId, student, position, status: 'posted' | 'failed', error? }) -> markView`
  - `reconcileMarks(db, { groupId }) -> { posted }`

- [ ] **Step 1: Write the failing tests**

Create `server/services/frqMarks.test.js`:

```js
import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import {
  schoologyMarkOf, sameMark, resolveCells, writeFrqSuggestions, setFrqMark, recordWriteback, reconcileMarks,
} from './frqMarks.js';

const RUBRIC = { id: 'r1', title: 'FRQ', totalPoints: 4, rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth: all correct' },
  { points: 3, name: 'Exhibiting', descriptionHtml: 'Exhibiting: main ideas correct' },
  { points: 2, name: 'Developing', descriptionHtml: 'Developing: one part' },
  { points: 1, name: 'Emerging', descriptionHtml: 'Emerging: attempted' }] }] };

let db, g, q, qNoRubric, a1, a2;
const cellsOf = (row) => JSON.parse(row);
const mark = (attempt, question = q) => db.prepare('SELECT * FROM frq_marks WHERE attempt_id = ? AND question_id = ?').get(attempt, question);
const setSchoology = (attempt, points, comment) => db.prepare('UPDATE quiz_responses SET schoology_rubric_cells_json = ?, schoology_comment = ? WHERE attempt_id = ? AND question_id = ?')
  .run(points == null ? null : JSON.stringify({ 146: { points, comment: '' } }), comment, attempt, q);

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM frq_marks; DELETE FROM quiz_tag_texts; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'C')`).run().lastInsertRowid;
  const t = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'T', 1)`).run(c).lastInsertRowid;
  g = db.prepare(`INSERT INTO quiz_groups (course_id, title) VALUES (?, 'T')`).run(c).lastInsertRowid;
  db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)').run(g, t);
  q = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json) VALUES (?, 21, 'frq', 'Explain', 4, ?)`).run(g, JSON.stringify(RUBRIC)).lastInsertRowid;
  qNoRubric = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points) VALUES (?, 22, 'frq', 'Describe', 5)`).run(g).lastInsertRowid;
  const ids = [];
  for (const [uid, last] of [['u1', 'Lee'], ['u2', 'Ng']]) {
    const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Ana', ?)`).run(uid, last).lastInsertRowid;
    const a = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, ?, 'now')`).run(g, t, s, `9${uid}`).lastInsertRowid;
    for (const qq of [q, qNoRubric]) db.prepare('INSERT INTO quiz_responses (attempt_id, question_id, answer_html, max_points) VALUES (?, ?, ?, 4)').run(a, qq, '<p>answer</p>');
    ids.push(a);
  }
  [a1, a2] = ids;
});

describe('Schoology mark and comparison', () => {
  test('the stored Schoology copy as cells in points and the comment', () => {
    setSchoology(a1, 2, 'Good start');
    const r = db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ? AND question_id = ?').get(a1, q);
    expect(schoologyMarkOf(r, RUBRIC)).toEqual({ cells: { 146: 2 }, comment: 'Good start' });
    expect(schoologyMarkOf({ points: null, schoology_comment: null }, null)).toBeNull();
  });
  test('sameMark compares points per row and the comment, ignoring spacing and HTML', () => {
    expect(sameMark({ cells: { 146: 2 }, comment: '<p>Good  start</p>' }, { cells: { 146: '2' }, comment: 'Good start' })).toBe(true);
    expect(sameMark({ cells: { 146: 2 }, comment: 'a' }, { cells: { 146: 3 }, comment: 'a' })).toBe(false);
    expect(sameMark({ cells: { 146: 2 }, comment: 'a' }, null)).toBe(false);
  });
});

describe('resolveCells (agent input)', () => {
  const row = { schoology_rubric_json: JSON.stringify(RUBRIC), max_points: 4 };
  test('levels by row title or id, by name or Prism code', () => {
    expect(resolveCells(row, { cells: { 'content knowledge': 'Developing' } })).toEqual({ cells: { 146: 2 } });
    expect(resolveCells(row, { cells: { 146: 'ED' } })).toEqual({ cells: { 146: 4 } });
    expect(resolveCells(row, { level: 'Exhibiting' })).toEqual({ cells: { 146: 3 } });
  });
  test('refuses numbers, unknown rows and unknown levels, naming the problem', () => {
    expect(resolveCells(row, { cells: { 146: 3 } }).error).toMatch(/unknown level 3/);
    expect(resolveCells(row, { cells: { Style: 'Developing' } }).error).toMatch(/unknown rubric row "Style"/);
    expect(resolveCells(row, { level: 'Great' }).error).toMatch(/levels: Exhibiting Depth, Exhibiting, Developing, Emerging/);
  });
  test('without a rubric, points from 0 to max_points', () => {
    const plain = { schoology_rubric_json: null, max_points: 5 };
    expect(resolveCells(plain, { points: 4 })).toEqual({ cells: { points: 4 } });
    expect(resolveCells(plain, { points: 6 }).error).toMatch(/0 to 5/);
  });
});

describe('suggestions', () => {
  test('writes a suggestion per student and reports a bad one without stopping', () => {
    const r = writeFrqSuggestions(db, { groupId: g, position: 21, students: [
      { student: 'u1', level: 'Developing', comment: 'Part (a) is right.' },
      { student: 'u2', cells: { 146: 3 }, comment: 'x' },
      { student: 'nobody', level: 'Developing', comment: 'x' },
    ] });
    expect(r.written).toBe(1);
    expect(r.results.map(x => x.status)).toEqual(['written', 'error', 'error']);
    expect(r.results[2].message).toMatch(/Student not found/);
    const m = mark(a1);
    expect([cellsOf(m.suggested_cells_json), m.suggested_comment, m.state, m.final_cells_json]).toEqual([{ 146: 2 }, 'Part (a) is right.', 'suggested', null]);
  });

  test('a new suggestion replaces the old one, keeps it in history, and never touches the teacher mark', () => {
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Developing', comment: 'v1' }] });
    setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Exhibiting', comment: 'v2' }] });
    const m = mark(a1);
    expect([cellsOf(m.final_cells_json), m.final_comment, m.state]).toEqual([{ 146: 2 }, 'v1', 'accepted']);
    expect([cellsOf(m.suggested_cells_json), m.suggested_comment, m.suggestion_revised]).toEqual([{ 146: 3 }, 'v2', 1]);
    expect(JSON.parse(m.suggestion_history_json).map(h => h.comment)).toEqual(['v1']);
  });

  test('an unknown question is NOT_FOUND', () => {
    expect(() => writeFrqSuggestions(db, { groupId: g, position: 9, students: [] })).toThrow(/no free-response question 9/);
  });
});

describe('teacher actions and write-back', () => {
  beforeEach(() => {
    setSchoology(a1, 3, 'Old comment');
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Developing', comment: 'New comment' }] });
  });

  test('accept copies the suggestion to final and waits to post', () => {
    const v = setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
    expect([v.state, v.final, v.writeback.status]).toEqual(['accepted', { cells: { 146: 2 }, comment: 'New comment' }, 'pending']);
  });

  test('save with a different cell is edited; save equal to the suggestion is accepted', () => {
    expect(setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'save', cells: { 146: 4 }, comment: 'Mine' }).state).toBe('edited');
    expect(setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'save', cells: { 146: 2 }, comment: 'New comment' }).state).toBe('accepted');
  });

  test('save refuses a cell that is not a level of the row', () => {
    expect(() => setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'save', cells: { 146: 7 }, comment: 'x' })).toThrow(/Choose a level/);
  });

  test('a mark equal to Schoology is posted at once', () => {
    const v = setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'save', cells: { 146: 3 }, comment: 'Old comment' });
    expect(v.writeback.status).toBe('posted');
  });

  test('a card started from Schoology and edited, with no suggestion, is edited', () => {
    setSchoology(a2, 2, 'S');
    expect(setFrqMark(db, { groupId: g, attemptId: a2, position: 21, action: 'save', cells: { 146: 3 }, comment: 'T' }).state).toBe('edited');
  });

  test('accept without a suggestion and keep without a mark are refused', () => {
    expect(() => setFrqMark(db, { groupId: g, attemptId: a2, position: 21, action: 'accept' })).toThrow(/no suggestion/);
    expect(() => setFrqMark(db, { groupId: g, attemptId: a2, position: 21, action: 'keep' })).toThrow(/no mark of yours/);
  });

  test('keep clears the revised flag and leaves final alone', () => {
    setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'save', cells: { 146: 4 }, comment: 'Mine' });
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Emerging', comment: 'v3' }] });
    const v = setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'keep' });
    expect([v.suggestion_revised, v.final.comment]).toEqual([false, 'Mine']);
  });

  test('recordWriteback: posted copies final to posted; failed keeps the error', () => {
    setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
    expect(recordWriteback(db, { groupId: g, student: 'u1', position: 21, status: 'failed', error: 'Timed out' }).writeback).toMatchObject({ status: 'failed', error: 'Timed out' });
    expect(recordWriteback(db, { groupId: g, student: 'u1', position: 21, status: 'posted' }).writeback.status).toBe('posted');
    expect(mark(a1).posted_comment).toBe('New comment');
  });

  test('recordWriteback refuses an answer with no teacher mark', () => {
    expect(() => recordWriteback(db, { groupId: g, student: 'u2', position: 21, status: 'posted' })).toThrow(/no accepted mark/);
  });

  test('reconcile: a waiting mark that Schoology now shows becomes posted', () => {
    setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
    expect(reconcileMarks(db, { groupId: g })).toEqual({ posted: 0 });
    setSchoology(a1, 2, ' New   comment ');
    expect(reconcileMarks(db, { groupId: g })).toEqual({ posted: 1 });
    expect(mark(a1).writeback_status).toBe('posted');
  });

  test('a posted mark later changed by hand in Schoology shows as changed, and nothing overwrites it', () => {
    setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
    recordWriteback(db, { groupId: g, student: 'u1', position: 21, status: 'posted' });
    setSchoology(a1, 4, 'Teacher typed this in Schoology');
    reconcileMarks(db, { groupId: g });
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Emerging', comment: 'v9' }] });
    const v = setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'keep' });
    expect([v.writeback.status, v.changed_in_schoology, v.final.comment]).toEqual(['posted', true, 'New comment']);
  });

  test('without a rubric the mark is points', () => {
    const v = setFrqMark(db, { groupId: g, attemptId: a1, position: 22, action: 'save', cells: { points: 4 }, comment: 'ok' });
    expect(v.final.cells).toEqual({ points: 4 });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run server/services/frqMarks.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `server/services/frqMarks.js`**

```js
// FRQ marks (spec §12). Two layers on one answer: the agent's suggestion (suggested_*, with
// history and a revised flag) and the teacher's mark (final_*). A new suggestion never changes
// final_*. Write-back state compares final_* with the stored Schoology copy; nothing here reads
// or writes Schoology.
import { QuizError } from './quizError.js';
import { getGroup } from './quizGroups.js';
import { resolveStudentId } from './idResolvers.js';
import { normalizeLevel } from '../lib/proficiencyScale.js';
import { plainText } from '../lib/quizText.js';

export const POINTS_KEY = 'points';
const parse = (t, fallback = null) => (t ? JSON.parse(t) : fallback);
const normComment = (c) => plainText(c ?? '');

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
  const q = questionAt(db, group.id, position);
  const found = attemptForStudent(db, group.id, student);
  if (found.error) throw new QuizError('NOT_FOUND', found.error);
  const row = markRow(db, found.attemptId, q.id);
  if (!row?.final_cells_json) throw new QuizError('NOT_ELIGIBLE', 'This answer has no accepted mark to post');
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
    const schoology = schoologyMarkOf(responseRow(db, m.attempt_id, m.question_id), parse(m.schoology_rubric_json));
    if (!sameMark(final, schoology)) continue;
    db.prepare(`UPDATE frq_marks SET writeback_status = 'posted', writeback_at = datetime('now'), writeback_error = NULL,
        posted_cells_json = final_cells_json, posted_comment = final_comment WHERE attempt_id = ? AND question_id = ?`)
      .run(m.attempt_id, m.question_id);
    posted++;
  }
  return { posted };
}
```

- [ ] **Step 4: Run it**

Run: `npx vitest run server/services/frqMarks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/frqMarks.js server/services/frqMarks.test.js
git commit -m "feat(quizzes): FRQ mark rules (suggestion layer, teacher mark, write-back, detection)"
```

---

### Task 4: The FRQ read model and the write-back list

**Files:**
- Modify: `server/lib/quizText.js` (add `plainTextLines`)
- Create: `server/services/frqResponses.js`
- Test: `server/lib/quizText.test.js`, `server/services/frqResponses.test.js`

**Interfaces:**
- Consumes: `schoologyMarkOf`, `markView` (Task 3); `getGroup`, `attemptUrl` (Task 1); `groupStats` (`mcq.students`); `levelNameFor` (parseQuizRubric); `studentFullName`.
- Produces:
  - `plainTextLines(html) -> string`
  - `frqResponses(db, { groupId, position? }) -> { group_id, questions: [{ id, position, stem_html, max_points, rubric }], students: [{ student_id, name, schoology_uid, attempt_id, attempt_url, completed_at, mcq: { correct, total, percent } | null, responses: { [position]: { answer_html, schoology, mark } } }] }` sorted by name.
  - `levelsOf(rubric, cells) -> [{ row, level, points }]`
  - `listWritebacks(db, { groupId }) -> { writebacks: [{ student_id, name, question, attempt_url, levels, comment, status, error }] }`

- [ ] **Step 1: Write the failing tests**

In `server/lib/quizText.test.js` add:

```js
test('plainTextLines keeps line breaks and collapses spaces within a line', () => {
  expect(plainTextLines('<p>a)  first&nbsp;line</p><p>seconds &larr; 4<br>DISPLAY(x)</p><p></p><p></p>'))
    .toBe('a) first line\nseconds ← 4\nDISPLAY(x)');
});
```

(add `plainTextLines` to the file's import from `./quizText.js`).

Create `server/services/frqResponses.test.js` with the same seed as `frqMarks.test.js` (copy its `RUBRIC`, `beforeEach` and `setSchoology`), then:

```js
import { frqResponses, listWritebacks, levelsOf } from './frqResponses.js';
import { writeFrqSuggestions, setFrqMark } from './frqMarks.js';

test('one entry per attempt, sorted by name, with the Schoology copy and the Prism mark per FRQ', () => {
  setSchoology(a2, 3, 'Fine');
  writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Developing', comment: 'c' }] });
  const r = frqResponses(db, { groupId: g });
  expect(r.questions.map(x => x.position)).toEqual([21, 22]);
  expect(r.students.map(s => s.name)).toEqual(['Ana Lee', 'Ana Ng']);
  expect(r.students[0].attempt_url).toBe('https://schoology.hkis.edu.hk/assignment/900/assessment_results/student_stats/u1/9u1');
  expect(r.students[0].responses[21].mark.state).toBe('suggested');
  expect(r.students[1].responses[21]).toMatchObject({ answer_html: '<p>answer</p>', schoology: { cells: { 146: 3 }, comment: 'Fine' }, mark: null });
});

test('position limits the questions; an unknown position is NOT_FOUND', () => {
  expect(frqResponses(db, { groupId: g, position: 22 }).questions.map(x => x.position)).toEqual([22]);
  expect(() => frqResponses(db, { groupId: g, position: 3 })).toThrow(/no free-response question 3/);
});

test('levelsOf names each row\'s level', () => {
  expect(levelsOf(RUBRIC, { 146: 2 })).toEqual([{ row: 'Content Knowledge', level: 'Developing', points: 2 }]);
  expect(levelsOf(null, { points: 4 })).toEqual([{ row: 'Points', level: null, points: 4 }]);
});

test('listWritebacks lists waiting and failed marks only', () => {
  writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Developing', comment: 'c1' }, { student: 'u2', level: 'Emerging', comment: 'c2' }] });
  setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
  const { writebacks } = listWritebacks(db, { groupId: g });
  expect(writebacks).toEqual([expect.objectContaining({ name: 'Ana Lee', question: 21, comment: 'c1', status: 'pending', levels: [{ row: 'Content Knowledge', level: 'Developing', points: 2 }] })]);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run server/lib/quizText.test.js server/services/frqResponses.test.js`
Expected: FAIL (`plainTextLines` and the module are missing).

- [ ] **Step 3: Implement**

In `server/lib/quizText.js`, after `plainText`:

```js
// Like plainText, but keeps line breaks, because answers often hold code: each break or
// block end is a newline, spaces collapse within a line, and blank lines collapse to one.
const LINE_BREAKS = /<br\s*\/?>|<\/(p|div|li|pre|h[1-6]|tr)\s*>/gi;
export function plainTextLines(html) {
  const cleaned = String(html ?? '').replace(DROPPED_BLOCKS, ' ').replace(LINE_BREAKS, '\n');
  return parse(cleaned, { blockTextElements: {} }).text
    .split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).join('\n')
    .replace(/\n{2,}/g, '\n').trim();
}
```

Create `server/services/frqResponses.js`:

```js
// The FRQ read model (spec §12): what the Free response tab, the REST route and the MCP tools
// show. Built only from Prism's stored copy; nothing here reads Schoology.
import { QuizError } from './quizError.js';
import { getGroup, attemptUrl } from './quizGroups.js';
import { groupStats } from './quizStats.js';
import { schoologyMarkOf, markView } from './frqMarks.js';
import { levelNameFor } from '../lib/parseQuizRubric.js';
import { studentFullName } from './studentNames.js';

const parse = (t, fallback = null) => (t ? JSON.parse(t) : fallback);

export function levelsOf(rubric, cells) {
  if (!rubric) return [{ row: 'Points', level: null, points: cells?.points ?? null }];
  return rubric.rows.map(r => ({ row: r.title, level: levelNameFor(rubric, r.id, cells?.[r.id]), points: cells?.[r.id] ?? null }));
}

export function frqResponses(db, { groupId, position = null }) {
  const group = getGroup(db, groupId);
  const qs = db.prepare(`SELECT * FROM quiz_questions WHERE group_id = ? AND kind = 'frq' ORDER BY position`).all(group.id)
    .filter(q => position == null || q.position === Number(position));
  if (position != null && !qs.length) throw new QuizError('NOT_FOUND', `Quiz group ${group.id} has no free-response question ${position}`);
  const mcqByStudent = new Map((groupStats(db, { groupId: group.id }).mcq.students || []).map(s => [s.student_id, s]));
  const attempts = db.prepare(`SELECT qa.id, qa.student_id, qa.schoology_attempt_id, qa.completed_at,
      s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher, a.schoology_assignment_id AS member_sid
    FROM quiz_attempts qa JOIN students s ON s.id = qa.student_id JOIN assignments a ON a.id = qa.assignment_id
    WHERE qa.group_id = ?`).all(group.id);
  const responseQ = db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ? AND question_id = ?');
  const markQ = db.prepare('SELECT * FROM frq_marks WHERE attempt_id = ? AND question_id = ?');
  const students = attempts.map(a => {
    const responses = {};
    for (const q of qs) {
      const r = responseQ.get(a.id, q.id);
      const schoology = schoologyMarkOf(r, parse(q.schoology_rubric_json));
      responses[q.position] = { answer_html: r?.answer_html ?? null, schoology, mark: markView(markQ.get(a.id, q.id), schoology) };
    }
    const m = mcqByStudent.get(a.student_id);
    return {
      student_id: a.student_id, name: studentFullName(a), schoology_uid: a.schoology_uid,
      attempt_id: a.id, attempt_url: attemptUrl(a), completed_at: a.completed_at,
      mcq: m ? { correct: m.correct, total: m.total, percent: m.percent } : null,
      responses,
    };
  }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return {
    group_id: group.id,
    questions: qs.map(q => ({ id: q.id, position: q.position, stem_html: q.stem_html, max_points: q.max_points, rubric: parse(q.schoology_rubric_json) })),
    students,
  };
}

export function listWritebacks(db, { groupId }) {
  const data = frqResponses(db, { groupId });
  const writebacks = [];
  for (const s of data.students) {
    for (const q of data.questions) {
      const m = s.responses[q.position]?.mark;
      if (!m?.final || !['pending', 'failed'].includes(m.writeback.status)) continue;
      writebacks.push({
        student_id: s.student_id, name: s.name, question: q.position, attempt_url: s.attempt_url,
        levels: levelsOf(q.rubric, m.final.cells), comment: m.final.comment, status: m.writeback.status, error: m.writeback.error,
      });
    }
  }
  return { writebacks };
}
```

(`attemptUrl(a)` works on these rows because they carry `member_sid`, `schoology_uid` and `schoology_attempt_id`.)

- [ ] **Step 4: Run them**

Run: `npx vitest run server/lib/quizText.test.js server/services/frqResponses.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/quizText.js server/lib/quizText.test.js server/services/frqResponses.js server/services/frqResponses.test.js
git commit -m "feat(quizzes): FRQ read model and the write-back list"
```

---

### Task 5: Detection after every load

**Files:**
- Modify: `server/services/quizLoader.js` (`loadGroup`)
- Test: `server/services/quizLoader.test.js`

**Interfaces:**
- Consumes: `reconcileMarks` (Task 3).
- Produces: `loadGroup` summary gains `marksPosted` (number).

- [ ] **Step 1: Write the failing test**

In `server/services/quizLoader.test.js` (its `beforeEach` cleanup gained `DELETE FROM frq_marks;` in Task 1), inside `describe('loadGroup', ...)`. The fixture's FRQ (`1003`) carries grade 2 on row `146012384` and the comment "Good start on part (a).":

```js
  test('a mark Schoology now shows becomes posted on the next load (marksPosted)', async () => {
    await loadGroup(db, { groupId }, { openPage: fakeOpenPage(happyPages()).openPage, pauseMs: 0 });
    const attempt = db.prepare('SELECT id FROM quiz_attempts WHERE student_id = ?').get(studentA).id;
    const q = db.prepare(`SELECT id FROM quiz_questions WHERE group_id = ? AND kind = 'frq'`).get(groupId).id;
    db.prepare(`INSERT INTO frq_marks (attempt_id, question_id, final_cells_json, final_comment, state, writeback_status)
      VALUES (?, ?, '{"146012384":2}', 'Good start on part (a).', 'accepted', 'pending')`).run(attempt, q);
    const r = await loadGroup(db, { groupId }, { openPage: fakeOpenPage(happyPages()).openPage, pauseMs: 0 });
    expect(r.marksPosted).toBe(1);
    expect(db.prepare('SELECT writeback_status FROM frq_marks').get().writeback_status).toBe('posted');
  });
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run server/services/quizLoader.test.js`
Expected: FAIL (`marksPosted` is undefined).

- [ ] **Step 3: Implement**

In `server/services/quizLoader.js`, import `reconcileMarks` from `./frqMarks.js`, add `marksPosted: 0` to the initial `summary` object, and after `pruneOlderDuplicates(db, { groupId: group.id });` add:

```js
    // A mark posted in Schoology (by an agent or by hand) shows in the copy just stored.
    summary.marksPosted = reconcileMarks(db, { groupId: group.id }).posted;
```

- [ ] **Step 4: Run the loader, route and MCP tests**

Run: `npx vitest run server/services/quizLoader.test.js server/routes/quizzes.test.js mcp`
Expected: PASS. A test comparing a whole summary with `toEqual` needs `marksPosted: 0` added.

- [ ] **Step 5: Commit**

```bash
git add server/services/quizLoader.js server/services/quizLoader.test.js
git commit -m "feat(quizzes): detect FRQ marks posted in Schoology on every load"
```

---

### Task 6: REST routes and client API calls

**Files:**
- Modify: `server/routes/quizzes.js`
- Modify: `client/src/services/api.js`
- Test: `server/routes/quizzes.test.js`

**Interfaces:**
- Produces: `GET /api/quizzes/:id/frq?question=` → `frqResponses`; `PUT /api/quizzes/:id/frq/:attemptId/:position` body `{ action, cells?, comment? }` → `{ mark }`.
- Produces (client): `getFrqResponses(groupId)`, `saveFrqMark(groupId, attemptId, position, body)`.

- [ ] **Step 1: Write the failing test**

In `server/routes/quizzes.test.js`, add a test using the file's `call` helper and seed. Insert an FRQ question with the `RUBRIC` from Task 3, one attempt and one response, then:

```js
  test('FRQ responses and a teacher action', async () => {
    const r = await call('GET', `/api/quizzes/${id}/frq`);
    expect(r.status).toBe(200);
    expect(r.body.questions[0].position).toBe(21);
    const attemptId = r.body.students[0].attempt_id;
    const saved = await call('PUT', `/api/quizzes/${id}/frq/${attemptId}/21`, { action: 'save', cells: { 146: 3 }, comment: 'Good' });
    expect(saved.body.mark).toMatchObject({ state: 'edited', final: { cells: { 146: 3 }, comment: 'Good' }, writeback: { status: 'pending' } });
    expect((await call('PUT', `/api/quizzes/${id}/frq/${attemptId}/21`, { action: 'accept' })).status).toBe(400);
    expect((await call('GET', `/api/quizzes/${id}/frq?question=5`)).status).toBe(404);
  });
```

Seed what the test needs (question, student, attempt, response) inside the test with the same `db.prepare` style the file already uses for its group.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run server/routes/quizzes.test.js`
Expected: FAIL (404 on the new routes).

- [ ] **Step 3: Implement**

In `server/routes/quizzes.js`, import `frqResponses` from `../services/frqResponses.js` and `setFrqMark` from `../services/frqMarks.js`, then before `export default router;`:

```js
router.get('/:id/frq', handle((req, db) => frqResponses(db, { groupId: req.params.id, position: req.query.question ?? null })));
router.put('/:id/frq/:attemptId/:position', handle((req, db) => ({
  mark: setFrqMark(db, {
    groupId: req.params.id, attemptId: req.params.attemptId, position: req.params.position,
    action: req.body.action, cells: req.body.cells, comment: req.body.comment,
  }),
})));
```

In `client/src/services/api.js`, after `setQuizTags`:

```js
export const getFrqResponses = (groupId) => request(`/quizzes/${groupId}/frq`);
export const saveFrqMark = (groupId, attemptId, position, body) =>
  request(`/quizzes/${groupId}/frq/${attemptId}/${position}`, { method: 'PUT', body: JSON.stringify(body) });
```

- [ ] **Step 4: Run it**

Run: `npx vitest run server/routes/quizzes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/quizzes.js server/routes/quizzes.test.js client/src/services/api.js
git commit -m "feat(quizzes): FRQ routes and client calls"
```

---

### Task 7: PrisMCP tools

**Files:**
- Modify: `mcp/handlers.js`, `mcp/server.js`
- Test: `mcp/handlers.test.js`

**Interfaces:**
- Consumes: `frqResponses`, `listWritebacks`, `levelsOf` (Task 4); `writeFrqSuggestions`, `recordWriteback` (Task 3); `plainTextLines` (Task 4).
- Produces: `getFrqResponsesTool(db, { group_id, question? })`, `writeFrqSuggestionsTool(db, { group_id, question, students })`, `listFrqWritebacksTool(db, { group_id })`, `markFrqWritebackTool(db, { group_id, student, question, status, error? })`; tools `get_frq_responses`, `write_frq_suggestions`, `list_frq_writebacks`, `mark_frq_writeback`.

- [ ] **Step 1: Write the failing tests**

In `mcp/handlers.test.js`, extend the quiz `describe` block. Add a seed helper beside `seedQuiz`:

```js
  function seedFrq() {
    const db = getDb();
    const { c, g } = seedQuiz();
    const t = db.prepare('SELECT assignment_id FROM quiz_group_members WHERE group_id = ?').get(g).assignment_id;
    const rubric = { id: 'r1', title: 'FRQ', totalPoints: 4, rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
      { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth: all' }, { points: 2, name: 'Developing', descriptionHtml: 'Developing: some' }] }] };
    const q = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json) VALUES (?, 21, 'frq', '<p>Explain</p>', 4, ?)`).run(g, JSON.stringify(rubric)).lastInsertRowid;
    const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'Ana', 'Lee')`).run().lastInsertRowid;
    const a = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, '5001', 'now')`).run(g, t, s).lastInsertRowid;
    db.prepare(`INSERT INTO quiz_responses (attempt_id, question_id, answer_html, schoology_rubric_cells_json, schoology_comment) VALUES (?, ?, ?, ?, 'Old')`)
      .run(a, q, '<p>a) because</p><p>b) abstraction</p>', JSON.stringify({ 146: { points: 2, comment: '' } }));
    return { c, g, a };
  }

  test('get_frq_responses gives plain answers, levels by name and the attempt link', () => {
    const { g } = seedFrq();
    const r = getFrqResponsesTool(getDb(), { group_id: g });
    expect(r.questions[0]).toMatchObject({ position: 21, stem: 'Explain', rubric: [{ row: 'Content Knowledge', levels: [{ name: 'Exhibiting Depth', points: 4, description: 'all' }, { name: 'Developing', points: 2, description: 'some' }] }] });
    expect(r.students[0]).toMatchObject({ student: 'Ana Lee', schoology_uid: '701', attempt_url: expect.stringContaining('/student_stats/701/5001') });
    expect(r.students[0].answers[0]).toMatchObject({ question: 21, answer_text: 'a) because\nb) abstraction', schoology: { levels: [{ row: 'Content Knowledge', level: 'Developing', points: 2 }], comment: 'Old' }, prism: null });
  });

  test('write_frq_suggestions, then list and mark the write-back', () => {
    const { g, a } = seedFrq();
    expect(writeFrqSuggestionsTool(getDb(), { group_id: g, question: 21, students: [{ student: '701', level: 'Exhibiting Depth', comment: 'All correct.' }] })).toMatchObject({ written: 1 });
    setFrqMark(getDb(), { groupId: g, attemptId: a, position: 21, action: 'accept' });
    expect(listFrqWritebacksTool(getDb(), { group_id: g }).writebacks).toHaveLength(1);
    expect(markFrqWritebackTool(getDb(), { group_id: g, student: '701', question: 21, status: 'posted' }).writeback.status).toBe('posted');
    expect(listFrqWritebacksTool(getDb(), { group_id: g }).writebacks).toHaveLength(0);
  });
```

Add the four tool names to the file's import from `./handlers.js`, and `import { setFrqMark } from '../server/services/frqMarks.js';`. Add `DELETE FROM frq_marks;` to the file's cleanup (Task 1 did this if the cleanup deletes quiz tables).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run mcp/handlers.test.js`
Expected: FAIL (the tools are not exported).

- [ ] **Step 3: Implement the handlers**

In `mcp/handlers.js`, import:

```js
import { frqResponses, listWritebacks, levelsOf } from '../server/services/frqResponses.js';
import { writeFrqSuggestions, recordWriteback } from '../server/services/frqMarks.js';
import { plainTextLines } from '../server/lib/quizText.js';
```

and after `setQuestionTagsTool`:

```js
// Phase 2 (spec §12): FRQ marking. Answers go out as plain text; levels by name.
const describeLevel = (l) => l.descriptionHtml.replace(/^[^:]*:\s*/, '').trim();

export function getFrqResponsesTool(db, { group_id, question }) {
  const data = frqResponses(db, { groupId: group_id, position: question ?? null });
  const layer = (rubric, m) => (m ? { levels: levelsOf(rubric, m.cells), comment: m.comment } : null);
  return {
    questions: data.questions.map(q => ({
      position: q.position, stem: plainTextLines(q.stem_html), max_points: q.max_points,
      rubric: q.rubric ? q.rubric.rows.map(r => ({ row: r.title, levels: r.levels.map(l => ({ name: l.name, points: l.points, description: plainTextLines(describeLevel(l)) })) })) : null,
    })),
    students: data.students.map(s => ({
      student: s.name, student_id: s.student_id, schoology_uid: s.schoology_uid, attempt_url: s.attempt_url, mcq: s.mcq,
      answers: data.questions.map(q => {
        const r = s.responses[q.position];
        const m = r.mark;
        return {
          question: q.position,
          answer_text: plainTextLines(r.answer_html),
          schoology: layer(q.rubric, r.schoology),
          prism: m ? {
            state: m.state, suggestion: layer(q.rubric, m.suggested), final: layer(q.rubric, m.final),
            suggestion_revised: m.suggestion_revised, writeback: m.writeback.status, changed_in_schoology: m.changed_in_schoology,
          } : null,
        };
      }),
    })),
  };
}

export function writeFrqSuggestionsTool(db, { group_id, question, students }) {
  return writeFrqSuggestions(db, { groupId: group_id, position: question, students });
}

export function listFrqWritebacksTool(db, { group_id }) {
  return listWritebacks(db, { groupId: group_id });
}

export function markFrqWritebackTool(db, { group_id, student, question, status, error }) {
  return recordWriteback(db, { groupId: group_id, student, position: question, status, error });
}
```

- [ ] **Step 4: Register the tools**

In `mcp/server.js`, import the four handlers and register after `set_question_tags`:

```js
  server.registerTool(
    'get_frq_responses',
    {
      description: "Read a quiz group's free-response answers from Prism's stored copy (no Schoology request). For each FRQ: the stem and the Schoology rubric (rows, level names, points, descriptions). For each student: the MCQ score, the attempt URL, and per FRQ the answer as plain text with line breaks kept, Schoology's current mark (level per row, comment), and any Prism mark (state suggested/accepted/edited, the suggestion, the teacher's final mark, write-back pending/posted/failed). Load the results first (load_quiz_results) if they are old.",
      inputSchema: {
        group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups'),
        question: z.number().optional().describe('One FRQ by question number; omit for every FRQ'),
      },
    },
    async ({ group_id, question }) => text(() => getFrqResponsesTool(getDb(), { group_id, question }))
  );

  server.registerTool(
    'write_frq_suggestions',
    {
      description: 'Write suggested FRQ marks for teacher review in Prism (never sent to Schoology). Per student: cells as { rubric row title or id: level name } (for example { "Content Knowledge": "Exhibiting" }), or level alone for a one-row rubric, or points for an FRQ without a rubric; and a student-facing comment. Levels are names or codes (ED, EX, D, EM), never numbers: Prism converts them to points. A new suggestion replaces the earlier one and never changes a mark the teacher accepted or edited; if it differs, the teacher sees it as a revised suggestion. Returns { written, results: [{ student, status: written|error, message }] }.',
      inputSchema: {
        group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups'),
        question: z.number().describe('FRQ question number'),
        students: z.array(z.object({
          student: z.union([z.number(), z.string()]).describe('schoology_uid or local student id'),
          cells: z.record(z.string(), z.string()).optional().describe('{ rubric row title or id: level name }'),
          level: z.string().optional().describe('Level name, for a one-row rubric'),
          points: z.number().optional().describe('Points, for an FRQ without a rubric'),
          comment: z.string().describe('Student-facing feedback on this answer'),
        })),
      },
    },
    async ({ group_id, question, students }) => text(() => writeFrqSuggestionsTool(getDb(), { group_id, question, students }))
  );

  server.registerTool(
    'list_frq_writebacks',
    {
      description: "FRQ marks the teacher accepted or edited that Schoology does not show yet (write-back pending or failed): student, question number, the attempt URL to open, the level and points per rubric row, and the comment to enter. After entering one in Schoology, record it with mark_frq_writeback; the next load_quiz_results also detects it.",
      inputSchema: { group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups') },
    },
    async ({ group_id }) => text(() => listFrqWritebacksTool(getDb(), { group_id }))
  );

  server.registerTool(
    'mark_frq_writeback',
    {
      description: 'Record that an accepted FRQ mark was entered in Schoology (status posted), or that entering it failed (status failed, with error). Only for a mark listed by list_frq_writebacks.',
      inputSchema: {
        group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups'),
        student: z.union([z.number(), z.string()]).describe('schoology_uid or local student id'),
        question: z.number().describe('FRQ question number'),
        status: z.enum(['posted', 'failed']),
        error: z.string().optional().describe('What went wrong, for status failed'),
      },
    },
    async ({ group_id, student, question, status, error }) => text(() => markFrqWritebackTool(getDb(), { group_id, student, question, status, error }))
  );
```

Also extend the server's `instructions` string (the `'quizzes: per-question results ...'` part near the top of `mcp/server.js`) with one sentence: `FRQ marking: get_frq_responses, write_frq_suggestions, then the teacher accepts in Prism; list_frq_writebacks and mark_frq_writeback for posting.`

- [ ] **Step 5: Run the MCP tests**

Run: `npx vitest run mcp`
Expected: PASS, including the copy guard (`mcp/copy.test.js`: no em dashes) and `mcp/server.test.js` (if it pins the tool list, add the four names).

- [ ] **Step 6: Commit**

```bash
git add mcp/handlers.js mcp/server.js mcp/handlers.test.js mcp/server.test.js
git commit -m "feat(prismcp): get_frq_responses, write_frq_suggestions, list_frq_writebacks, mark_frq_writeback"
```

---

### Task 8: Nightly refresh of recent quizzes

**Files:**
- Create: `server/services/quizRefresh.js`, `server/services/quizRefresh.test.js`
- Modify: `server/services/syncOrchestrator.js`, `server/services/syncScheduler.js`
- Modify: `client/src/lib/syncEvents.js`, `client/src/lib/syncRunLog.js`
- Test: `server/services/syncOrchestrator.test.js`, `server/services/syncScheduler.test.js`, `client/src/lib/syncEvents.test.js`, `client/src/lib/syncRunLog.test.js`

**Interfaces:**
- Produces: `REFRESH_DAYS = 28`; `groupsToRefresh(db, { now?, days? }) -> [{ id, title }]`; `refreshRecentQuizzes(db, { now?, days?, load?, onGroup? }) -> [{ groupId, title, status: 'done' | 'error', attempts?, code?, message? }]`.
- Produces: `runUnifiedSync` option `refreshQuizzes` (default false) and phase events `{ phase: 'quizzes', status, records?, message? }`; `scheduledSyncOptions(...).refreshQuizzes === true`.

- [ ] **Step 1: Write the failing tests**

Create `server/services/quizRefresh.test.js`:

```js
import { test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { groupsToRefresh, refreshRecentQuizzes } from './quizRefresh.js';
import { QuizError } from './quizError.js';

let db, recent, old, never, archived;
const NOW = new Date('2026-10-13T20:00:00Z');
beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM courses;');
  const live = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('a', 'Live')`).run().lastInsertRowid;
  const gone = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('b', 'Old', 1)`).run().lastInsertRowid;
  const add = (course, title, loadedAt) => db.prepare('INSERT INTO quiz_groups (course_id, title, loaded_at) VALUES (?, ?, ?)').run(course, title, loadedAt).lastInsertRowid;
  recent = add(live, 'Recent', '2026-10-01 08:00:00');
  old = add(live, 'Old', '2026-09-01 08:00:00');
  never = add(live, 'Never', null);
  archived = add(gone, 'Archived', '2026-10-10 08:00:00');
});

test('groups loaded in the last 28 days, in courses that are not archived', () => {
  expect(groupsToRefresh(db, { now: NOW }).map(g => g.title)).toEqual(['Recent']);
});

test('reloads each group and reports per group', async () => {
  const load = vi.fn(async () => ({ attempts: 9, failed: [] }));
  expect(await refreshRecentQuizzes(db, { now: NOW, load })).toEqual([{ groupId: recent, title: 'Recent', status: 'done', attempts: 9 }]);
  expect(load).toHaveBeenCalledWith(db, { groupId: recent });
});

test('an expired session stops after the first group', async () => {
  db.prepare(`UPDATE quiz_groups SET loaded_at = '2026-10-12 08:00:00' WHERE id = ?`).run(old);
  const load = vi.fn(async () => { throw new QuizError('NO_SESSION', 'Reconnect Schoology'); });
  const r = await refreshRecentQuizzes(db, { now: NOW, load });
  expect(r).toEqual([{ groupId: recent, title: 'Recent', status: 'error', code: 'NO_SESSION', message: 'Reconnect Schoology' }]);
  expect(load).toHaveBeenCalledTimes(1);
});

test('another failure moves on to the next group', async () => {
  db.prepare(`UPDATE quiz_groups SET loaded_at = '2026-10-12 08:00:00' WHERE id = ?`).run(old);
  const load = vi.fn().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce({ attempts: 3, failed: [] });
  expect((await refreshRecentQuizzes(db, { now: NOW, load })).map(x => x.status)).toEqual(['error', 'done']);
});
```

In `server/services/syncOrchestrator.test.js`, add `vi.mock('./quizRefresh.js', () => ({ refreshRecentQuizzes: vi.fn() }));` and `vi.mock('../middleware/featureGate.js', async (orig) => ({ ...(await orig()), getFeatures: () => ({ quizzes: true }) }));` with the other mocks, import `refreshRecentQuizzes`, and add:

```js
  test('refreshQuizzes runs the quizzes phase last; a failure is not fatal', async () => {
    fullSync.mockResolvedValue({ records: 1 });
    refreshRecentQuizzes.mockResolvedValue([{ status: 'done' }, { status: 'error', message: 'HTTP 500' }]);
    const events = [];
    const summary = await runUnifiedSync({ refreshQuizzes: true, syncBlocks: false }, (e) => events.push(e));
    const phases = events.filter(e => e.phase).map(e => `${e.phase}:${e.status}`);
    expect(phases).toEqual(['schoology:running', 'schoology:done', 'quizzes:running', 'quizzes:error']);
    expect(summary.quizzes).toEqual({ refreshed: 1, failed: 1 });
  });

  test('no quizzes phase without refreshQuizzes', async () => {
    fullSync.mockResolvedValue({ records: 1 });
    const events = [];
    await runUnifiedSync({ syncBlocks: false }, (e) => events.push(e));
    expect(events.some(e => e.phase === 'quizzes')).toBe(false);
  });
```

(Read the file's existing tests first and follow how they set `fullSync` and the other mocks. If an existing test compares the whole summary with `toEqual`, add `quizzes: null` to it.)

In `server/services/syncScheduler.test.js`, add `refreshQuizzes: true,` to the object in the existing `expect(opts).toEqual({ ... })` assertion.

In `client/src/lib/syncEvents.test.js` add:

```js
it('reduces the quizzes phase', () => {
  const s = reduceSyncEvents([{ phase: 'quizzes', status: 'running' }, { phase: 'quizzes', status: 'done', records: 2 }]);
  expect(s.phases).toEqual([{ key: 'quizzes', kind: 'quizzes', label: 'Quiz results', status: 'done', records: 2 }]);
});
```

In `client/src/lib/syncRunLog.test.js` add:

```js
it('names the quizzes phase and option', () => {
  expect(describeRunEvent({ phase: 'quizzes', status: 'running' }).text).toMatch(/^Quiz results/);
  expect(describeOptions({ trigger: 'scheduled', skipSchoology: false, refreshQuizzes: true })).toBe('Scheduled · Schoology · quiz results');
});
```

(use the imports the test files already have; add `describeOptions`/`describeRunEvent` if missing).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run server/services/quizRefresh.test.js server/services/syncOrchestrator.test.js server/services/syncScheduler.test.js` and `cd client && npx vitest run src/lib/syncEvents.test.js src/lib/syncRunLog.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `server/services/quizRefresh.js`:

```js
// Nightly refresh of quiz results (spec §12): every group loaded in the last REFRESH_DAYS
// days, in a course that is not archived, is reloaded through the same read-only loader.
// One group failing never stops the others, except an expired session, which would fail
// every later group the same way.
import { loadGroup } from './quizLoader.js';

export const REFRESH_DAYS = 28;

export function groupsToRefresh(db, { now = new Date(), days = REFRESH_DAYS } = {}) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  return db.prepare(`SELECT g.id, g.title FROM quiz_groups g JOIN courses c ON c.id = g.course_id
    WHERE g.loaded_at IS NOT NULL AND g.loaded_at >= ? AND COALESCE(c.archived, 0) = 0 ORDER BY g.id`).all(since);
}

export async function refreshRecentQuizzes(db, { now, days, load = loadGroup, onGroup = () => {} } = {}) {
  const results = [];
  for (const g of groupsToRefresh(db, { now, days })) {
    let result;
    try {
      const summary = await load(db, { groupId: g.id });
      result = { groupId: g.id, title: g.title, status: 'done', attempts: summary.attempts };
    } catch (err) {
      result = { groupId: g.id, title: g.title, status: 'error', code: err.code ?? null, message: err.message };
    }
    results.push(result);
    onGroup(result);
    if (result.code === 'NO_SESSION') break;
  }
  return results;
}
```

In `server/services/syncOrchestrator.js`, import `refreshRecentQuizzes` from `./quizRefresh.js` and `getFeatures` from `../middleware/featureGate.js`; add `refreshQuizzes = false` to the destructured options; add `quizzes: null` to `summary`; and just before the final `emit({ type: 'summary', ...})`:

```js
  // Spec §12: the nightly run reloads quizzes loaded in the last 28 days. Best effort: a
  // failure is reported in the run and never fails the sync.
  if (refreshQuizzes && getFeatures().quizzes) {
    emit({ phase: 'quizzes', status: 'running' });
    try {
      const results = await refreshRecentQuizzes(db, {
        onGroup: (r) => emit({ type: 'log', message: `[quizzes] ${r.title}: ${r.status === 'done' ? `${r.attempts} attempts` : r.message}` }),
      });
      const failed = results.filter(r => r.status === 'error');
      summary.quizzes = { refreshed: results.length - failed.length, failed: failed.length };
      emit(failed.length
        ? { phase: 'quizzes', status: 'error', message: `${failed.length} of ${results.length} quizzes not refreshed: ${failed[0].message}` }
        : { phase: 'quizzes', status: 'done', records: results.length });
    } catch (err) {
      summary.quizzes = { error: err.message };
      emit({ phase: 'quizzes', status: 'error', message: err.message });
    }
  }
```

In `server/services/syncScheduler.js`, `scheduledSyncOptions` returns `refreshQuizzes: true,` after `syncBlocks`.

In `client/src/lib/syncEvents.js`, before the `mastery` branch:

```js
    } else if (evt.phase === 'quizzes') {
      let p = find('quizzes');
      if (!p) { p = { key: 'quizzes', kind: 'quizzes', label: 'Quiz results' }; phases.push(p); }
      p.status = evt.status;
      if (evt.records != null) p.records = evt.records;
      if (evt.message) p.message = evt.message;
```

In `client/src/lib/syncRunLog.js`: in `phaseLabel` add `if (evt.phase === 'quizzes') return 'Quiz results';`, and in `describeOptions` after the mastery part add `if (options.refreshQuizzes) parts.push('quiz results');`.

- [ ] **Step 4: Run them**

Run the commands from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/quizRefresh.js server/services/quizRefresh.test.js server/services/syncOrchestrator.js server/services/syncOrchestrator.test.js server/services/syncScheduler.js server/services/syncScheduler.test.js client/src/lib/syncEvents.js client/src/lib/syncEvents.test.js client/src/lib/syncRunLog.js client/src/lib/syncRunLog.test.js
git commit -m "feat(sync): nightly refresh of quizzes loaded in the last 28 days"
```

---

### Task 9: Sanitizer and the FRQ rubric grid

**Files:**
- Modify: `client/package.json` (`dompurify`)
- Create: `client/src/lib/sanitizeHtml.js`, `client/src/lib/sanitizeHtml.test.js`
- Create: `client/src/components/quiz/FrqRubricGrid.jsx`, `client/src/components/quiz/FrqRubricGrid.test.jsx`
- Modify: `client/src/app.css`

**Interfaces:**
- Produces: `sanitizeAnswerHtml(html) -> string`.
- Produces: `<FrqRubricGrid rubric final suggested schoology onSelect />` where `final`, `suggested`, `schoology` are `{ rowId: points }` or null and `onSelect(rowId, points)`; each cell is a button named `"<row title>: <level name>"`, `aria-pressed` when it is the final cell.

- [ ] **Step 1: Install DOMPurify**

Run: `cd client && npm install dompurify@3.1.6`
Expected: `client/package.json` lists `"dompurify": "^3.1.6"`.

- [ ] **Step 2: Write the failing tests**

Create `client/src/lib/sanitizeHtml.test.js`:

```js
import { it, expect } from 'vitest';
import { sanitizeAnswerHtml } from './sanitizeHtml.js';

it('keeps text formatting, lists and code', () => {
  expect(sanitizeAnswerHtml('<p>a) <strong>bold</strong><br>next</p><pre><code>x ← 1</code></pre><ul><li>i</li></ul>'))
    .toBe('<p>a) <strong>bold</strong><br>next</p><pre><code>x ← 1</code></pre><ul><li>i</li></ul>');
});

it('removes anything that runs, loads or links', () => {
  const out = sanitizeAnswerHtml('<p onclick="x()">hi</p><script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">link</a><iframe src="https://e.com"></iframe><p style="background:url(x)">s</p>');
  expect(out).toBe('<p>hi</p>link<p>s</p>');
});

it('treats null as empty', () => {
  expect(sanitizeAnswerHtml(null)).toBe('');
});
```

Create `client/src/components/quiz/FrqRubricGrid.test.jsx`:

```jsx
import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import FrqRubricGrid from './FrqRubricGrid.jsx';

const RUBRIC = { id: 'r1', rows: [{ id: '146', title: 'Content Knowledge', levels: [
  { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth:\n\nEvery part correct.' },
  { points: 2, name: 'Developing', descriptionHtml: 'Developing:\n\nOne part correct.' }] }] };

it('a button per level with its description, the final cell pressed', () => {
  render(<FrqRubricGrid rubric={RUBRIC} final={{ 146: 2 }} onSelect={() => {}} />);
  expect(screen.getByRole('button', { name: 'Content Knowledge: Developing' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Content Knowledge: Exhibiting Depth' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByText('Every part correct.')).toBeInTheDocument();
});

it('marks the AI cell and Schoology\'s cell', () => {
  render(<FrqRubricGrid rubric={RUBRIC} suggested={{ 146: 4 }} schoology={{ 146: 2 }} onSelect={() => {}} />);
  const ed = screen.getByRole('button', { name: 'Content Knowledge: Exhibiting Depth' });
  expect(ed).toHaveClass('frq-cell--ai');
  expect(within(screen.getByRole('button', { name: 'Content Knowledge: Developing' })).getByTitle("Schoology's current mark")).toBeInTheDocument();
});

it('clicking a cell selects it', () => {
  const onSelect = vi.fn();
  render(<FrqRubricGrid rubric={RUBRIC} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: 'Content Knowledge: Exhibiting Depth' }));
  expect(onSelect).toHaveBeenCalledWith('146', 4);
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `cd client && npx vitest run src/lib/sanitizeHtml.test.js src/components/quiz/FrqRubricGrid.test.jsx`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

Create `client/src/lib/sanitizeHtml.js`:

```js
// Student-authored answer HTML (linked quizzes, spec §12) goes into the DOM only through
// here: text formatting, lists, code and tables. No attributes at all, so nothing can run,
// load or link.
import DOMPurify from 'dompurify';

const CONFIG = {
  ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup',
    'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: [],
};

export const sanitizeAnswerHtml = (html) => DOMPurify.sanitize(String(html ?? ''), CONFIG);
```

Create `client/src/components/quiz/FrqRubricGrid.jsx`:

```jsx
// The Schoology rubric stored with an FRQ, one row per criterion and one button per level
// (spec §12). The final cell is filled in its level colour; the AI's cell carries the
// fuchsia sparkle; Schoology's current cell carries a small "S". Clicking sets the final cell.
import AiSparkle from '../AiSparkle.jsx';
import { LEVEL_COLORS, masteryCodeForLevel } from '../../lib/masteryLevels.js';

const colorsFor = (name) => LEVEL_COLORS[masteryCodeForLevel(name)] || null;
// Schoology's descriptions open with the level name ("Exhibiting:\n\nYou answer ...").
const descriptionOf = (level) => String(level.descriptionHtml || '').replace(/^[^:]*:\s*/, '').trim();

export default function FrqRubricGrid({ rubric, final = null, suggested = null, schoology = null, onSelect }) {
  return (
    <table className="frq-grid">
      <tbody>
        {rubric.rows.map(row => (
          <tr key={row.id}>
            <th scope="row" className="frq-grid__row">{row.title}</th>
            {row.levels.map(l => {
              const c = colorsFor(l.name);
              const isFinal = final?.[row.id] === l.points;
              const isAi = suggested?.[row.id] === l.points;
              const isSchoology = schoology?.[row.id] === l.points;
              return (
                <td key={l.points}>
                  <button
                    type="button"
                    className={`frq-cell${isFinal ? ' frq-cell--final' : ''}${isAi ? ' frq-cell--ai' : ''}`}
                    aria-label={`${row.title}: ${l.name}`}
                    aria-pressed={isFinal}
                    onClick={() => onSelect(row.id, l.points)}
                    style={isFinal && c ? { background: c.headerFill, boxShadow: `inset 0 0 0 2px ${c.finalBorder}` } : undefined}
                  >
                    <span className="frq-cell__head" style={c ? { background: c.headerFill } : undefined}>
                      {l.name} <span className="frq-cell__pts">{l.points}</span>
                      {isAi && <AiSparkle size={14} />}
                      {isSchoology && <span className="frq-cell__s" title="Schoology's current mark">S</span>}
                    </span>
                    <span className="frq-cell__desc">{descriptionOf(l)}</span>
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

In `client/src/app.css`, after the Questions tab chart rules (the `.level-bar__swatch` rule), add:

```css
/* Free response tab (linked quizzes phase 2): the stored Schoology rubric as level buttons. */
.frq-grid { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 0.74rem; }
.frq-grid td, .frq-grid th { border: 1px solid var(--border); padding: 0; vertical-align: top; }
.frq-grid__row { width: 9rem; padding: 0.4rem 0.5rem; text-align: left; font-weight: 600; background: var(--bg-subtle); }
.frq-cell { display: flex; flex-direction: column; gap: 0.3rem; width: 100%; height: 100%; padding: 0; border: 0; background: var(--card-bg); color: var(--text); text-align: left; cursor: pointer; font: inherit; }
.frq-cell:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.frq-cell--ai:not(.frq-cell--final) { background: var(--ai-suggest-wash); }
.frq-cell__head { display: flex; align-items: center; gap: 0.3rem; padding: 0.25rem 0.45rem; font-weight: 700; }
.frq-cell__head svg { color: var(--ai-suggest); margin-left: auto; }
.frq-cell__pts { font-weight: 400; color: var(--text-muted); }
.frq-cell__s { margin-left: auto; font-size: 0.62rem; font-weight: 800; border: 1px solid currentColor; border-radius: 3px; padding: 0 3px; }
.frq-cell__desc { padding: 0 0.45rem 0.4rem; line-height: 1.35; white-space: pre-line; }
```

- [ ] **Step 5: Run them**

Run: `cd client && npx vitest run src/lib/sanitizeHtml.test.js src/components/quiz/FrqRubricGrid.test.jsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/package.json client/package-lock.json client/src/lib/sanitizeHtml.js client/src/lib/sanitizeHtml.test.js client/src/components/quiz/FrqRubricGrid.jsx client/src/components/quiz/FrqRubricGrid.test.jsx client/src/app.css
git commit -m "feat(quizzes): answer sanitizer and the FRQ rubric grid"
```

---

### Task 10: The FRQ card

**Files:**
- Create: `client/src/components/quiz/FrqCard.jsx`, `client/src/components/quiz/FrqCard.test.jsx`
- Modify: `client/src/app.css`

**Interfaces:**
- Consumes: `saveFrqMark` (Task 6), `sanitizeAnswerHtml`, `FrqRubricGrid` (Task 9), `AttemptLink` (phase 1).
- Produces: `<FrqCard groupId student question response onSaved />` where `student` is a `frqResponses` student, `question` a `frqResponses` question, `response` = `student.responses[question.position]`, and `onSaved(mark)` receives the new mark view. Exported helper `stateChips(response) -> [{ key, label, tone }]`.

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/quiz/FrqCard.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FrqCard, { stateChips } from './FrqCard.jsx';
import { saveFrqMark } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({ saveFrqMark: vi.fn() }));

const RUBRIC = { id: 'r1', rows: [{ id: '146', title: 'Content Knowledge', levels: [
  { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth: all' }, { points: 2, name: 'Developing', descriptionHtml: 'Developing: some' }] }] };
const question = { id: 9, position: 21, stem_html: '<p>Explain</p>', max_points: 4, rubric: RUBRIC };
const student = { student_id: 1, name: 'Ana Lee', attempt_id: 55, attempt_url: 'https://schoology.hkis.edu.hk/x', completed_at: '2026-10-09 10:00' };
const suggested = { cells: { 146: 4 }, comment: 'All correct.' };
const view = (over = {}) => ({ state: 'suggested', suggested, final: null, suggestion_revised: false, writeback: { status: null, at: null, error: null }, changed_in_schoology: false, ...over });

beforeEach(() => { vi.clearAllMocks(); });

describe('FrqCard', () => {
  it('shows the sanitized answer, the attempt link, and starts from the suggestion', () => {
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: '<p>because</p><img src=x onerror="alert(1)">', schoology: null, mark: view() }} onSaved={() => {}} />);
    expect(screen.getByText('because')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: /Attempt/ })).toHaveAttribute('href', 'https://schoology.hkis.edu.hk/x');
    expect(screen.getByRole('textbox', { name: 'Comment for Ana Lee' })).toHaveValue('All correct.');
    expect(screen.getByRole('button', { name: 'Content Knowledge: Exhibiting Depth' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('starts from Schoology\'s mark when there is no Prism mark', () => {
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: 'x', schoology: { cells: { 146: 2 }, comment: 'From Schoology' }, mark: null }} onSaved={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'Comment for Ana Lee' })).toHaveValue('From Schoology');
    expect(screen.getByText('In Schoology')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('Accept sends accept and reports the new mark', async () => {
    const mark = view({ state: 'accepted', final: suggested, writeback: { status: 'pending' } });
    saveFrqMark.mockResolvedValue({ mark });
    const onSaved = vi.fn();
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: 'x', schoology: null, mark: view() }} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(mark));
    expect(saveFrqMark).toHaveBeenCalledWith(7, 55, 21, { action: 'accept' });
  });

  it('Save edit sends the chosen cell and the edited comment', async () => {
    saveFrqMark.mockResolvedValue({ mark: view({ state: 'edited' }) });
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: 'x', schoology: null, mark: view() }} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Content Knowledge: Developing' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment for Ana Lee' }), { target: { value: 'Part (b) needs more.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    await waitFor(() => expect(saveFrqMark).toHaveBeenCalledWith(7, 55, 21, { action: 'save', cells: { 146: 2 }, comment: 'Part (b) needs more.' }));
  });

  it('shows a failed save and keeps the edit', async () => {
    saveFrqMark.mockRejectedValue(new Error('Choose a level for Content Knowledge'));
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: 'x', schoology: null, mark: view() }} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(await screen.findByText('Choose a level for Content Knowledge')).toBeInTheDocument();
  });

  it('a revised suggestion offers Keep mine', async () => {
    saveFrqMark.mockResolvedValue({ mark: view() });
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: 'x', schoology: null, mark: view({ state: 'edited', final: { cells: { 146: 2 }, comment: 'Mine' }, suggestion_revised: true }) }} onSaved={() => {}} />);
    expect(screen.getByText('Revised suggestion')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(saveFrqMark).toHaveBeenCalledWith(7, 55, 21, { action: 'keep' }));
  });

  it('an FRQ without a rubric takes points', () => {
    render(<FrqCard groupId={7} student={student} question={{ ...question, rubric: null, max_points: 5 }} response={{ answer_html: 'x', schoology: null, mark: null }} onSaved={() => {}} />);
    expect(screen.getByRole('spinbutton', { name: 'Points for Ana Lee' })).toHaveAttribute('max', '5');
  });

  it('Copy comment copies the comment', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: 'x', schoology: null, mark: view() }} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy comment' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('All correct.'));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});

describe('stateChips', () => {
  it('names the state, the write-back and a change in Schoology', () => {
    expect(stateChips({ schoology: null, mark: null }).map(c => c.label)).toEqual(['Not marked']);
    expect(stateChips({ mark: view({ state: 'accepted', writeback: { status: 'pending' } }) }).map(c => c.label)).toEqual(['Accepted', 'Waiting to post']);
    expect(stateChips({ mark: view({ state: 'edited', writeback: { status: 'posted' }, changed_in_schoology: true }) }).map(c => c.label)).toEqual(['Edited', 'Posted', 'Changed in Schoology']);
    expect(stateChips({ mark: view({ writeback: { status: 'failed', error: 'x' } }) }).map(c => c.label)).toEqual(['Suggested', 'Post failed']);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd client && npx vitest run src/components/quiz/FrqCard.test.jsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `client/src/components/quiz/FrqCard.jsx`**

```jsx
// One student's answer to one FRQ (spec §12): the answer, the stored Schoology rubric, and
// the comment, with Accept, Save edit, Keep mine and Copy comment. The card starts from the
// teacher's mark, else the suggestion, else Schoology's mark.
import { useState } from 'react';
import { saveFrqMark } from '../../services/api.js';
import { sanitizeAnswerHtml } from '../../lib/sanitizeHtml.js';
import FrqRubricGrid from './FrqRubricGrid.jsx';
import AttemptLink from './AttemptLink.jsx';

const STATE_LABEL = { suggested: 'Suggested', accepted: 'Accepted', edited: 'Edited' };
const WRITEBACK = { pending: ['Waiting to post', 'badge-amber'], posted: ['Posted', 'badge-green'], failed: ['Post failed', 'badge-red'] };

export function stateChips({ schoology, mark }) {
  if (!mark) return [{ key: 'state', label: schoology ? 'In Schoology' : 'Not marked', tone: 'badge-gray' }];
  const chips = [{ key: 'state', label: STATE_LABEL[mark.state] ?? mark.state, tone: mark.state === 'suggested' ? 'badge-purple' : 'badge-blue' }];
  const wb = WRITEBACK[mark.writeback?.status];
  if (wb) chips.push({ key: 'writeback', label: wb[0], tone: wb[1] });
  if (mark.changed_in_schoology) chips.push({ key: 'changed', label: 'Changed in Schoology', tone: 'badge-amber' });
  return chips;
}

export default function FrqCard({ groupId, student, question, response, onSaved }) {
  const { mark, schoology } = response;
  const start = mark?.final ?? mark?.suggested ?? schoology ?? { cells: {}, comment: '' };
  const [cells, setCells] = useState(start.cells || {});
  const [comment, setComment] = useState(start.comment || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  async function send(body) {
    setBusy(true);
    try {
      const r = await saveFrqMark(groupId, student.attempt_id, question.position, body);
      setError(null);
      onSaved(r.mark);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(comment);
      setCopied(true);
    } catch {
      setError('Copy is not available here: select the comment and copy it.');
    }
  }

  return (
    <div className="card frq-card" data-testid="frq-card">
      <div className="frq-card__head">
        <strong>{student.name}</strong>
        <AttemptLink link={{ url: student.attempt_url, completedAt: student.completed_at }} name={student.name} />
        {stateChips(response).map(c => <span key={c.key} className={`badge ${c.tone}`} title={c.key === 'writeback' && mark?.writeback?.error ? mark.writeback.error : undefined}>{c.label}</span>)}
        {mark?.suggestion_revised && <span className="badge badge-purple">Revised suggestion</span>}
      </div>
      {response.answer_html
        ? <div className="frq-answer" dangerouslySetInnerHTML={{ __html: sanitizeAnswerHtml(response.answer_html) }} />
        : <p className="text-muted">No answer.</p>}
      {question.rubric ? (
        <FrqRubricGrid
          rubric={question.rubric}
          final={cells}
          suggested={mark?.suggested?.cells ?? null}
          schoology={schoology?.cells ?? null}
          onSelect={(rowId, points) => setCells(c => ({ ...c, [rowId]: points }))}
        />
      ) : (
        <label className="text-sm">
          Points (0 to {question.max_points}){' '}
          <input type="number" min="0" max={question.max_points} step="0.5" aria-label={`Points for ${student.name}`}
            value={cells.points ?? ''} onChange={(e) => setCells({ points: e.target.value === '' ? '' : Number(e.target.value) })} />
        </label>
      )}
      <textarea className="frq-comment" aria-label={`Comment for ${student.name}`} rows={4} value={comment}
        onChange={(e) => { setComment(e.target.value); setCopied(false); }} />
      {error && <div className="alert alert-warning">{error}</div>}
      <div className="frq-card__actions">
        {mark?.suggested && <button type="button" className="primary" disabled={busy} onClick={() => send({ action: 'accept' })}>Accept</button>}
        <button type="button" className="secondary" disabled={busy} onClick={() => send({ action: 'save', cells, comment })}>Save edit</button>
        {mark?.suggestion_revised && mark?.final && <button type="button" className="ghost" disabled={busy} onClick={() => send({ action: 'keep' })}>Keep mine</button>}
        <button type="button" className="ghost" onClick={copy}>Copy comment</button>
        {copied && <span className="text-sm text-muted">Copied</span>}
      </div>
    </div>
  );
}
```

Check that `badge-purple`, `badge-green`, `badge-amber`, `badge-red`, `badge-blue`, `badge-gray` exist in `client/src/app.css` (`grep -n "\.badge-" client/src/app.css`); use the nearest existing tone for any that does not.

In `client/src/app.css`, after the `.frq-cell__desc` rule:

```css
.frq-card { display: grid; gap: 0.6rem; }
.frq-card__head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.frq-card__actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.frq-answer { background: var(--bg-subtle); border-radius: 6px; padding: 0.6rem 0.8rem; line-height: 1.5; overflow-x: auto; }
.frq-answer pre { white-space: pre-wrap; }
.frq-comment { width: 100%; font: inherit; }
```

- [ ] **Step 4: Run them**

Run: `cd client && npx vitest run src/components/quiz/FrqCard.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/quiz/FrqCard.jsx client/src/components/quiz/FrqCard.test.jsx client/src/app.css
git commit -m "feat(quizzes): FRQ card (answer, rubric, comment, accept, edit, copy)"
```

---

### Task 11: The Free response tab and its place on the assessment page

**Files:**
- Create: `client/src/components/quiz/FreeResponseTab.jsx`, `client/src/components/quiz/FreeResponseTab.test.jsx`
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (the quiz `tablist` and the tab body)
- Test: `client/src/pages/AssessmentSummaryPage.quiz.test.jsx`

**Interfaces:**
- Consumes: `getFrqResponses`, `getFeatures` (api), `FrqCard` (Task 10), `group.frq_count` (Task 1).
- Produces: `<FreeResponseTab groupId reloadKey />`; exported `FILTERS` and `matchesFilter(response, key)`.

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/quiz/FreeResponseTab.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import FreeResponseTab, { matchesFilter } from './FreeResponseTab.jsx';
import { getFrqResponses, getFeatures, saveFrqMark } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({ getFrqResponses: vi.fn(), getFeatures: vi.fn(), saveFrqMark: vi.fn() }));

const RUBRIC = { id: 'r1', rows: [{ id: '146', title: 'Content Knowledge', levels: [{ points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth: all' }, { points: 2, name: 'Developing', descriptionHtml: 'Developing: some' }] }] };
const mark = (over) => ({ state: 'suggested', suggested: { cells: { 146: 4 }, comment: 's' }, final: null, suggestion_revised: false, writeback: { status: null }, changed_in_schoology: false, ...over });
const DATA = {
  group_id: 7,
  questions: [{ id: 1, position: 21, stem_html: '<p>Q21 stem</p>', max_points: 4, rubric: RUBRIC }, { id: 2, position: 22, stem_html: '<p>Q22 stem</p>', max_points: 4, rubric: RUBRIC }],
  students: [
    { student_id: 1, name: 'Ana Lee', attempt_id: 11, attempt_url: 'u1', responses: { 21: { answer_html: 'Ana 21', schoology: null, mark: mark() }, 22: { answer_html: 'Ana 22', schoology: null, mark: null } } },
    { student_id: 2, name: 'Ben Ho', attempt_id: 12, attempt_url: 'u2', responses: { 21: { answer_html: 'Ben 21', schoology: null, mark: mark({ state: 'accepted', final: { cells: { 146: 4 }, comment: 's' }, writeback: { status: 'pending' } }) }, 22: { answer_html: 'Ben 22', schoology: { cells: { 146: 2 }, comment: 'c' }, mark: null } } },
  ],
};

beforeEach(() => { vi.clearAllMocks(); getFrqResponses.mockResolvedValue(DATA); getFeatures.mockResolvedValue({ quizzes: true, quiz_writeback: false }); });

describe('FreeResponseTab', () => {
  it('opens by question: the first FRQ for every student', async () => {
    render(<FreeResponseTab groupId={7} />);
    expect(await screen.findByText('Ana 21')).toBeInTheDocument();
    expect(screen.getByText('Ben 21')).toBeInTheDocument();
    expect(screen.queryByText('Ana 22')).toBeNull();
    expect(screen.getByText('Q21 stem')).toBeInTheDocument();
  });

  it('the picker sets the FRQ for every card', async () => {
    render(<FreeResponseTab groupId={7} />);
    await screen.findByText('Ana 21');
    fireEvent.change(screen.getByRole('combobox', { name: 'Question' }), { target: { value: '22' } });
    expect(screen.getByText('Ana 22')).toBeInTheDocument();
    expect(screen.queryByText('Ana 21')).toBeNull();
  });

  it('by student stacks each student\'s FRQs', async () => {
    render(<FreeResponseTab groupId={7} />);
    await screen.findByText('Ana 21');
    fireEvent.click(screen.getByRole('button', { name: 'By student' }));
    expect(screen.getByText('Ana 21')).toBeInTheDocument();
    expect(screen.getByText('Ana 22')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Question' })).toBeNull();
  });

  it('filters, and shows how many marks wait for the agent', async () => {
    render(<FreeResponseTab groupId={7} />);
    await screen.findByText('Ana 21');
    expect(screen.getByText('1 waiting for the agent')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Waiting to post/ }));
    expect(screen.queryByText('Ana 21')).toBeNull();
    expect(screen.getByText('Ben 21')).toBeInTheDocument();
  });

  it('a saved card updates in place', async () => {
    saveFrqMark.mockResolvedValue({ mark: mark({ state: 'accepted', final: { cells: { 146: 4 }, comment: 's' }, writeback: { status: 'pending' } }) });
    render(<FreeResponseTab groupId={7} />);
    await screen.findByText('Ana 21');
    const ana = screen.getAllByTestId('frq-card')[0];
    fireEvent.click(within(ana).getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('2 waiting for the agent')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    getFrqResponses.mockRejectedValue(new Error('No quiz group 7'));
    render(<FreeResponseTab groupId={7} />);
    expect(await screen.findByText('No quiz group 7')).toBeInTheDocument();
  });
});

describe('matchesFilter', () => {
  it('to review: unmarked with nothing in Schoology, a suggestion not yet acted on, or a revised one', () => {
    expect(matchesFilter({ schoology: null, mark: null }, 'review')).toBe(true);
    expect(matchesFilter({ schoology: { cells: {}, comment: 'x' }, mark: null }, 'review')).toBe(false);
    expect(matchesFilter({ mark: mark() }, 'review')).toBe(true);
    expect(matchesFilter({ mark: mark({ state: 'edited', suggestion_revised: true }) }, 'review')).toBe(true);
  });
});
```

In `client/src/pages/AssessmentSummaryPage.quiz.test.jsx`, mock `FreeResponseTab` the way the file mocks `QuestionsTab` (read it first), then add:

```jsx
  it('shows a Free response tab only when the group has an FRQ', async () => {
    getQuizGroupFor.mockResolvedValue({ group: { ...GROUP, frq_count: 1 } });
    renderAt('/course/5/assessment/950');
    fireEvent.click(await screen.findByRole('tab', { name: 'Free response' }));
    expect(await screen.findByText('Free response for group 7')).toBeInTheDocument();
  });

  it('no Free response tab without an FRQ', async () => {
    getQuizGroupFor.mockResolvedValue({ group: { ...GROUP, frq_count: 0 } });
    renderAt('/course/5/assessment/950');
    await screen.findByRole('tab', { name: 'Questions' });
    expect(screen.queryByRole('tab', { name: 'Free response' })).toBeNull();
  });
```

with the mock `vi.mock('../components/quiz/FreeResponseTab.jsx', () => ({ default: ({ groupId }) => <div>Free response for group {groupId}</div> }));`.

- [ ] **Step 2: Run them and see them fail**

Run: `cd client && npx vitest run src/components/quiz/FreeResponseTab.test.jsx src/pages/AssessmentSummaryPage.quiz.test.jsx`
Expected: FAIL.

- [ ] **Step 3: Implement `client/src/components/quiz/FreeResponseTab.jsx`**

```jsx
// Free response tab (spec §12): by question (one picker for every card) or by student.
// Reads Prism's stored copy only; a saved card replaces its mark in place.
import { useEffect, useMemo, useState } from 'react';
import { getFrqResponses, getFeatures } from '../../services/api.js';
import { sanitizeAnswerHtml } from '../../lib/sanitizeHtml.js';
import FrqCard from './FrqCard.jsx';

export const FILTERS = [
  ['all', 'All'], ['review', 'To review'], ['accepted', 'Accepted'], ['waiting', 'Waiting to post'],
  ['posted', 'Posted'], ['failed', 'Failed'], ['changed', 'Changed in Schoology'],
];

export function matchesFilter(response, key) {
  const m = response.mark;
  switch (key) {
    case 'review': return m ? m.state === 'suggested' || m.suggestion_revised : !response.schoology;
    case 'accepted': return !!m && (m.state === 'accepted' || m.state === 'edited');
    case 'waiting': return m?.writeback?.status === 'pending';
    case 'posted': return m?.writeback?.status === 'posted' && !m.changed_in_schoology;
    case 'failed': return m?.writeback?.status === 'failed';
    case 'changed': return !!m?.changed_in_schoology;
    default: return true;
  }
}

export default function FreeResponseTab({ groupId, reloadKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [features, setFeatures] = useState({});
  const [view, setView] = useState('question');
  const [position, setPosition] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let active = true;
    setError(null);
    getFrqResponses(groupId)
      .then(d => { if (!active) return; setData(d); setPosition(p => p ?? d.questions[0]?.position ?? null); })
      .catch(e => { if (active) setError(e.message); });
    Promise.resolve().then(() => getFeatures()).then(f => { if (active) setFeatures(f || {}); }).catch(() => {});
    return () => { active = false; };
  }, [groupId, reloadKey]);

  const waiting = useMemo(() => (data ? data.students.reduce((n, s) =>
    n + Object.values(s.responses).filter(r => r.mark?.writeback?.status === 'pending').length, 0) : 0), [data]);

  if (error) return <div className="alert alert-warning">{error}</div>;
  if (!data) return <div className="loading">Loading...</div>;
  if (!data.questions.length) return <div className="card"><p className="text-muted">This quiz has no free-response questions.</p></div>;
  if (!data.students.length) return <div className="card"><p className="text-muted">No results loaded yet. Use Load results above.</p></div>;

  const replaceMark = (studentId, pos, mark) => setData(d => ({
    ...d,
    students: d.students.map(s => (s.student_id !== studentId ? s
      : { ...s, responses: { ...s.responses, [pos]: { ...s.responses[pos], mark } } })),
  }));
  const card = (s, q) => (
    <FrqCard key={`${s.student_id}-${q.position}-${s.responses[q.position].mark?.state ?? 'none'}`}
      groupId={groupId} student={s} question={q} response={s.responses[q.position]}
      onSaved={(m) => replaceMark(s.student_id, q.position, m)} />
  );
  const question = data.questions.find(q => q.position === position) ?? data.questions[0];

  return (
    <div className="fade-in frq-tab">
      <div className="card frq-tab__bar">
        <div role="group" aria-label="View" style={{ display: 'flex', gap: '0.25rem' }}>
          <button type="button" className={`filter-btn${view === 'question' ? ' active' : ''}`} aria-pressed={view === 'question'} onClick={() => setView('question')}>By question</button>
          <button type="button" className={`filter-btn${view === 'student' ? ' active' : ''}`} aria-pressed={view === 'student'} onClick={() => setView('student')}>By student</button>
        </div>
        {view === 'question' && (
          <select aria-label="Question" value={question.position} onChange={(e) => setPosition(Number(e.target.value))}>
            {data.questions.map(q => <option key={q.position} value={q.position}>{`Q${q.position}`}</option>)}
          </select>
        )}
        <div role="group" aria-label="Filter" style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
          {FILTERS.map(([key, label]) => (
            <button key={key} type="button" className={`filter-btn${filter === key ? ' active' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
        {!features.quiz_writeback && waiting > 0 && <span className="text-sm text-muted">{waiting} waiting for the agent</span>}
      </div>

      {view === 'question' ? (
        <>
          <div className="card frq-stem" dangerouslySetInnerHTML={{ __html: sanitizeAnswerHtml(question.stem_html) }} />
          {data.students.filter(s => matchesFilter(s.responses[question.position], filter)).map(s => card(s, question))}
        </>
      ) : (
        data.students
          .filter(s => data.questions.some(q => matchesFilter(s.responses[q.position], filter)))
          .map(s => (
            <section key={s.student_id} className="frq-student">
              {data.questions.filter(q => matchesFilter(s.responses[q.position], filter)).map(q => (
                <div key={q.position}>
                  <h3 className="frq-student__q">{`Q${q.position}`}</h3>
                  {card(s, q)}
                </div>
              ))}
            </section>
          ))
      )}
    </div>
  );
}
```

(The stem is teacher-authored HTML; it goes through the same sanitizer anyway, so the tab never renders unsanitized HTML.)

In `client/src/app.css`, after the `.frq-comment` rule:

```css
.frq-tab { display: grid; gap: 0.75rem; }
.frq-tab__bar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; }
.frq-stem { line-height: 1.5; }
.frq-student { display: grid; gap: 0.5rem; }
.frq-student__q { margin: 0.25rem 0 0; font-size: 0.85rem; color: var(--text-muted); }
```

- [ ] **Step 4: Wire the tab into the assessment page**

In `client/src/pages/AssessmentSummaryPage.jsx`, import `FreeResponseTab from '../components/quiz/FreeResponseTab.jsx'`. In the quiz `tablist`, after the Questions button:

```jsx
            {quizGroup.frq_count > 0 && (
              <button role="tab" aria-selected={quizTab === 'frq'} className={`tab-btn${quizTab === 'frq' ? ' active' : ''}`} onClick={() => setQuizTab('frq')}>Free response</button>
            )}
```

and change the body's first branch to:

```jsx
      {quizGroup && quizTab === 'questions' ? (
        <QuestionsTab groupId={quizGroup.id} reloadKey={quizGroup.loaded_at} />
      ) : quizGroup && quizTab === 'frq' && quizGroup.frq_count > 0 ? (
        <FreeResponseTab groupId={quizGroup.id} reloadKey={quizGroup.loaded_at} />
      ) : students.length === 0 ? (
```

- [ ] **Step 5: Run the client suite**

Run: `cd client && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/quiz/FreeResponseTab.jsx client/src/components/quiz/FreeResponseTab.test.jsx client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.quiz.test.jsx client/src/app.css
git commit -m "feat(quizzes): Free response tab, by question and by student"
```

---

### Task 12: Docs, a live check on the Ep 1 data, and landing

**Files:**
- Modify: `docs/design-language.md`, `.claude/build-progress.md`, `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md` (status line)

- [ ] **Step 1: Full suites and build**

Run: `npx vitest run` and `cd client && npx vitest run && npm run build`
Expected: all pass; the build succeeds.

- [ ] **Step 2: Live check in the dev clone (never prod)**

With the dev database restored and the Ep 1 groups loaded (`scripts/verify-quiz-phase1.js`), start `PORT=3002 npm run dev`. Then:
1. Load results for BK 6 from the page and confirm the summary shows `marksPosted: 0` (in the load line or the network response).
2. Write two suggestions with the handler directly against the dev database: `DB_PATH=<dev db> node -e "import('./mcp/handlers.js').then(async h => { const { getDb } = await import('./server/db/index.js'); console.log(JSON.stringify(h.writeFrqSuggestionsTool(getDb(), { group_id: 1, question: 21, students: [{ student: '<uid of one taker>', level: 'Exhibiting', comment: 'Example suggestion for the dev check.' }] }))); })"`; take the uid from `get_frq_responses` output (`getFrqResponsesTool`), never from memory.
3. Open the Free response tab: by question and by student, the AI cell with the sparkle, Schoology's "S", Accept, Save edit with another cell, Copy comment, the filters, "n waiting for the agent".
4. Take screenshots (student names replaced in the page before capture, as in phase 1b) and add them to the review page `https://claude.ai/artifact/6G95czH7tcXdzZG4oxBgc3` in a "Phase 2" section; show Graham.

- [ ] **Step 3: Docs**

Append to `docs/design-language.md` a section "Free response tab (October 2026, linked quizzes phase 2)" covering: the two views and the one picker; the filter chips; the card order (name and Attempt, chips, answer, grid, comment, actions); the grid marks (the final cell in its level colour, the AI sparkle, Schoology's "S"); the comment prefill order; Copy comment; and "n waiting for the agent". In `.claude/build-progress.md`, add "Linked quizzes, phase 2" with the suites' counts, what the live check showed, and the follow-ups. In the spec's status line, mark phase 2 as built.

Run the writing checker on the new lines:
`git diff -U0 docs .claude | grep '^+' | grep -v '^+++' | sed 's/^+//' | python3 ~/.claude/plugins/marketplaces/graham-plugins/writing-style/scripts/check_text.py --kind general --register informal --format md -`
Expected: 0 refused; decide each review item.

- [ ] **Step 4: Commit, and land only when Graham says so**

```bash
git add docs .claude/build-progress.md
git commit -m "docs(quizzes): phase 2 design language and hand-off"
git push -u origin claude/angry-hopper-5c1f00
```

When Graham approves: `git fetch origin main && git merge-base --is-ancestor origin/main HEAD && git push origin HEAD:main` (fast-forward only; a push to main deploys prod once CI is green).

---

### Task 13: grade-theory-test reads FRQs from Prism (graham-plugins)

**Files:**
- Modify: `~/repos/graham-plugins/assessment-grader/skills/grade-theory-test/SKILL.md`
- Modify: `~/repos/graham-plugins/assessment-grader/.claude-plugin/plugin.json` (version)

**Interfaces:**
- Consumes: the four phase 2 tools and `list_quiz_groups`, `load_quiz_results` (Task 7, phase 1).

- [ ] **Step 1: Load the writing rules**

Invoke `writing-style:apply-writing-style` (the skill text is read by agents and by Graham).

- [ ] **Step 2: Edit the skill**

Replace "## Required inputs" and "## The flow" in `SKILL.md` with:

```markdown
## Required inputs
- **The test's results, from one of two sources:**
  - **Prism (preferred):** the test is in a Prism quiz group (`list_quiz_groups` for the course). Prism holds every answer, the Schoology rubric and each student's MCQ score.
  - **The Schoology CSV export (fallback):** when Prism is unreachable or the test is not in a quiz group. One file with all MCQ and FRQ submissions.
- the **current marking guides**: the FRQ Marking Guide and the Achievement Cut-Off Guide, read fresh
  every run from their master (see the reference, "Find the marking guides"). **This plugin carries no
  copy of either**: they change, and a copy would grade against last month's wording. If the master
  cannot be found, ask Graham for the file or a paste, and stop until he gives one.
- the measurement topic(s) the test maps to, via the orchestration source ladder

## The flow (detail in `references/theory-test-process.md`)

### Prism route
1. **Load:** if the group's `loaded_at` is older than today, call `load_quiz_results` (read-only; about a minute a class).
2. **Read:** `get_frq_responses` returns each student's answers as plain text, the Schoology rubric for each FRQ, Schoology's current mark, any Prism mark, and the MCQ score (`correct`, `total`, `percent`).
3. **AI-grade the FRQs** against the FRQ Marking Guide read this run, then write them with `write_frq_suggestions`, one call per FRQ: a level name per rubric row (never a number) and the student-facing comment. A student whose FRQ Graham already accepted or edited keeps his mark; a different suggestion shows to him as revised.
4. **Teacher review (HITL gate):** Graham accepts or edits each mark on the Free response tab. Check with `get_frq_responses` that every FRQ is `accepted` or `edited` before the next step. **Overall proficiency cannot be finalised until the FRQ marks are confirmed.**
5. **Cross-reference** each student's MCQ percent with the confirmed FRQ level, as below, and write the overall suggestion with `write_student_suggestions` on the result task.
6. **Posting the FRQ marks:** `list_frq_writebacks` lists each accepted mark with its attempt URL, level and comment. Enter them in Schoology only when Graham asks (a browser session, or Graham pastes them from the card), and record each with `mark_frq_writeback`. The next load also detects them.

### CSV route (fallback; keep it working)
1. **Extract** MCQ scores and FRQ responses from the CSV with the two scripts in `scripts/`
   (`extract_mcq_scores.py`, `extract_frq_responses.py`). Verify the detected column mappings; the
   `Username` field is the shared student key.
2. **AI-grade the FRQs** → a per-student level + short teacher-voice feedback. Grade against the FRQ
   Marking Guide read this run. Apply the theory-specific notes (algorithm-trace
   handling, truncated-CSV check) in the reference; everything about *voice and calibration* defers to
   the shared brain.
3. **Teacher review (HITL gate).** Present the FRQ grades + feedback for confirmation. **Overall
   proficiency cannot be finalised until the teacher confirms the FRQ grades.**

### Both routes: the overall result
**Cross-reference** each student's MCQ % with their confirmed FRQ level → an **overall proficiency**,
using the Achievement Cut-Off Guide read this run (a holistic guide, not a formula). Flag large MCQ/FRQ
discrepancies and students missing from a source for review.
```

Update the paragraph after the flow: replace "the per-question (MCQ/FRQ) detail lives in the Model A markdown until per-question Prism storage lands (a pending Prism enhancement)" with "on the Prism route the per-question detail lives in Prism; on the CSV route it lives in the Model A markdown". Update the frontmatter `description` to say the FRQs come from Prism's quiz group when available, with the Schoology CSV export as the fallback, and add "Prism quiz group, Free response tab" to `when_to_use`. Delete nothing from `scripts/` or `references/`.

- [ ] **Step 3: Check, release and push**

Run `writing-style:check-writing` on the changed `SKILL.md`. Bump `assessment-grader/.claude-plugin/plugin.json` `version` by a minor step (new behaviour). Then, in `~/repos/graham-plugins`:

```bash
claude plugin validate . && claude plugin validate ./assessment-grader
git add assessment-grader
git commit -m "assessment-grader: grade-theory-test reads FRQs from Prism, CSV kept as the fallback"
git push
```

Remind Graham that each machine picks it up with `claude plugin marketplace update graham-plugins` or at the next session start.
