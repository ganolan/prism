# Linked Quizzes, Phase 1 (Read and Stats) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teachers combine unaligned Schoology tests into a quiz group, optionally link it to an aligned summative, load every attempt through Prism's browser session, and see per-question statistics plus a link to each student's attempt.

**Architecture:** Pure HTML/JSON parsers in `server/lib/` turn the four Schoology pages (question list, results, student stats, attempt) and the rubric JSON into plain objects. `server/services/quiz*.js` hold the DB rules (groups, links, parity), storage, the browser loader and the statistics. One Express router (`/api/quizzes`, behind the `quizzes` flag) and three PrisMCP tools expose them. The client adds a Quiz setup modal, a Questions tab on the assessment page, an attempt link on the three feedback surfaces, and a chip in the course's assessment list.

**Tech Stack:** Node ESM, Express, better-sqlite3, node-html-parser, Playwright (lazy, through `sessionDeps.openPage`), Vitest (server + client), React + React Testing Library, PrisMCP (`@modelcontextprotocol/sdk`, zod).

**Spec:** `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md` (phase 1 of §10). Page shapes: `.claude/schoology-api-reference.md`, "Questions, attempts and FRQ rubrics (read-only probe, 2026-10-12)".

## Global Constraints

- ESM only (`import`/`export`), matching the repo.
- New tables use `CREATE TABLE IF NOT EXISTS` in `server/db/schema.sql`. No existing table changes, so nothing goes in `MIGRATIONS`.
- Browser work only through `sessionDeps.openPage()` (`server/services/schoologySession.js`); tests replace it and never launch a browser.
- **Read-only:** the loader refuses any URL containing `unsubmit` or `delete` (case-insensitive). Phase 1 sends no POST to Schoology.
- A failed page leaves that student unknown and is reported; nothing is guessed, and the loader never throws into its caller except for `NO_SESSION` and `BUSY`.
- Links are allowed only from an **unaligned test** (`is_test = 1`, not aligned) group to an **aligned** summative in the same course; one each.
- Statistics are counts, percentages, bands and distractor flags only. **No discrimination indices, point-biserials or reliability coefficients**, anywhere.
- Bands: facility `>= 0.90` Strong, `>= 0.70` Mixed, otherwise Divided.
- UI colors only through CSS custom properties in `client/src/app.css`; buttons use `.primary` / `.secondary` / `.ghost` / `.tab-btn` / `.filter-btn`; each new page section uses existing classes.
- **No em dashes** in UI copy or in `mcp/` strings (guard tests enforce it). Dates through `formatDate` / `formatDateTime` (`client/src/lib/formatDate.js`).
- Feature flags: `quizzes: true` and `quiz_writeback: false` in `config.yaml`.
- Every notable UI decision is appended to `docs/design-language.md`.
- Run server tests with `npx vitest run <path>` from the repo root; client tests with `cd client && npx vitest run <path>`.

## Decisions taken while planning (differences from the spec)

- **FRQ rubric parity moves to load time.** The probe shows the question list page carries no rubric id, so combining compares type, normalized stem and points; options, key and rubric id are compared when attempts load (spec §3 already does this for options and key).
- **The Grading tab is always present.** It is the page's existing content for the canonical assignment (the result task when linked, otherwise the first member test). Hiding it for an unlinked group would remove the test's existing score view.
- **One canonical URL per group.** Opening any other member (or a member of a linked group) redirects to the canonical assignment's page, keeping `?tab=`.
- **Gradebook columns are not folded.** The course's Assessments list folds member tests under the canonical row; the gradebook keeps one column per test, because each still carries a score.

## Review Focus

1. **Two questions with the same stem in one test** (for example two "Which of the following is true?" items): matching must pair them by occurrence order, never merge them. Test in Task 6.
2. **A student who sat both the standard and the extra-time copy** (or has an attempt on two members): stats count one counted attempt per student, the latest. Test in Task 7.
3. **A student whose Schoology uid is not in Prism** (joined after the last sync): skipped with a warning naming the uid, and the load still succeeds. Test in Task 8.
4. **A taker whose attempt page fails or bounces to SSO mid-load**: that student is reported as failed and the rest load; an SSO bounce stops the load with `NO_SESSION` and keeps what was stored. Test in Task 8.
5. **An MCQ left blank**: counted in the question's total as "no answer", never as correct, and shown as a flag. Test in Task 9.

---

## File Structure

**Server, pure (no DB, no browser):**
- `server/lib/quizText.js`: stem normalization, option letters, US date parsing, fingerprints.
- `server/lib/parseQuizQuestions.js`: question list page → questions.
- `server/lib/parseQuizResults.js`: results page → takers; student stats page → attempts.
- `server/lib/parseQuizAttempt.js`: attempt page → per-question responses and rubric buttons.
- `server/lib/parseQuizRubric.js`: rubric JSON and grade-info JSON.

**Server, DB and browser:**
- `server/services/quizError.js`: `QuizError` with a `code`.
- `server/services/quizParity.js`: compares question lists; matches copies to logical questions.
- `server/services/quizGroups.js`: groups, links, tags, candidates, canonical assignment, attempt links.
- `server/services/quizStore.js`: stores questions, copies, attempts, responses.
- `server/services/quizLoader.js`: reads the pages through the browser session.
- `server/services/quizStats.js`: statistics for the Questions tab.
- `server/routes/quizzes.js`: `/api/quizzes`.

**MCP:** `mcp/handlers.js`, `mcp/server.js` (three tools).

**Client:**
- `client/src/services/api.js`: quiz API calls.
- `client/src/components/quiz/AttemptLink.jsx`, `QuizChip.jsx`, `QuizSetupModal.jsx`, `QuestionsTab.jsx`.
- `client/src/hooks/useQuizGroup.js`.
- `client/src/pages/AssessmentSummaryPage.jsx`, `CoursePage.jsx`, `StudentPage.jsx`: wiring.

**Scripts and docs:** `scripts/parity-quiz-results.js`, `docs/design-language.md`, `.claude/schoology-api-reference.md`, `.claude/build-progress.md`.

---

### Task 1: Schema, flags and the error type

**Files:**
- Modify: `server/db/schema.sql` (append before the indexes block at the end)
- Modify: `config.yaml` (`features:`)
- Create: `server/services/quizError.js`
- Test: `server/services/quizSchema.test.js`

**Interfaces:**
- Produces: tables `quiz_groups`, `quiz_group_members`, `quiz_questions`, `quiz_question_copies`, `quiz_attempts`, `quiz_responses`; `class QuizError extends Error { code }`.

- [ ] **Step 1: Write the failing test**

```js
// server/services/quizSchema.test.js
import { describe, test, expect, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { QuizError } from './quizError.js';

describe('quiz schema', () => {
  test('creates the six quiz tables', () => {
    const names = getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'quiz_%' ORDER BY name`).all().map(r => r.name);
    expect(names).toEqual(['quiz_attempts', 'quiz_group_members', 'quiz_groups', 'quiz_question_copies', 'quiz_questions', 'quiz_responses']);
  });

  test('a test belongs to one group, and a result task to one group', () => {
    const db = getDb();
    const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('qs1', 'C')`).run().lastInsertRowid;
    const t = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'qt1', 'T')`).run(c).lastInsertRowid;
    const r = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'qr1', 'R')`).run(c).lastInsertRowid;
    const g1 = db.prepare(`INSERT INTO quiz_groups (course_id, title, result_assignment_id) VALUES (?, 'G1', ?)`).run(c, r).lastInsertRowid;
    const g2 = db.prepare(`INSERT INTO quiz_groups (course_id, title) VALUES (?, 'G2')`).run(c).lastInsertRowid;
    db.prepare(`INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)`).run(g1, t);
    expect(() => db.prepare(`INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)`).run(g2, t)).toThrow(/UNIQUE/);
    expect(() => db.prepare(`UPDATE quiz_groups SET result_assignment_id = ? WHERE id = ?`).run(r, g2)).toThrow(/UNIQUE/);
  });

  test('QuizError carries a code', () => {
    const e = new QuizError('PARITY', 'Questions differ');
    expect(e).toBeInstanceOf(Error);
    expect([e.code, e.message]).toEqual(['PARITY', 'Questions differ']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/quizSchema.test.js`
Expected: FAIL (`Cannot find module './quizError.js'`).

- [ ] **Step 3: Write the schema, flags and error type**

Append to `server/db/schema.sql`, above the `CREATE INDEX` block at the end of the file:

```sql
-- Linked quizzes (docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md).
-- A quiz group: one or more unaligned Schoology tests in one course, treated as one
-- quiz, optionally linked to one aligned summative (the result task).
CREATE TABLE IF NOT EXISTS quiz_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  title TEXT NOT NULL,
  result_assignment_id INTEGER UNIQUE REFERENCES assignments(id),
  -- 'ok' | 'mismatch' (a load found options, key or rubric differing between copies)
  parity_status TEXT NOT NULL DEFAULT 'ok',
  parity_detail_json TEXT,
  loaded_at TEXT,
  load_summary_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quiz_group_members (
  group_id INTEGER NOT NULL REFERENCES quiz_groups(id) ON DELETE CASCADE,
  assignment_id INTEGER NOT NULL UNIQUE REFERENCES assignments(id),
  PRIMARY KEY (group_id, assignment_id)
);

-- One logical question per group. kind: 'mcq' | 'frq' | 'other'.
-- options_json: [{letter, html, is_key}] (filled by a load). schoology_rubric_json: the
-- FRQ's Schoology rubric, parsed (parseQuizRubric). tags_json: ["CRD-2.G", ...].
CREATE TABLE IF NOT EXISTS quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES quiz_groups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  stem_html TEXT,
  options_json TEXT,
  max_points REAL,
  schoology_rubric_json TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (group_id, position)
);

-- Each member test's own Schoology question id for a logical question (copies get new ids).
CREATE TABLE IF NOT EXISTS quiz_question_copies (
  question_id INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  schoology_question_id TEXT NOT NULL,
  PRIMARY KEY (assignment_id, schoology_question_id)
);

-- The counted attempt per student per member test (latest when there are several).
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES quiz_groups(id) ON DELETE CASCADE,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  schoology_attempt_id TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  score REAL,
  max_score REAL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT NOT NULL,
  UNIQUE (assignment_id, student_id)
);

CREATE TABLE IF NOT EXISTS quiz_responses (
  attempt_id INTEGER NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  chosen_letter TEXT,
  is_correct INTEGER,
  points REAL,
  max_points REAL,
  answer_html TEXT,
  schoology_rubric_cells_json TEXT,
  schoology_comment TEXT,
  PRIMARY KEY (attempt_id, question_id)
);
```

In `config.yaml`, under `features:` after `rubric_descriptors: true`:

```yaml
  quizzes: true
  quiz_writeback: false
```

Create `server/services/quizError.js`:

```js
// Errors from the linked-quiz services. `code` drives the HTTP status in
// server/routes/quizzes.js and the MCP tool error text:
// NOT_FOUND, NOT_ELIGIBLE, PARITY, NO_SESSION, BUSY.
export class QuizError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/quizSchema.test.js server/db/index.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.sql config.yaml server/services/quizError.js server/services/quizSchema.test.js
git commit -m "feat(quizzes): schema, feature flags and QuizError"
```

---

### Task 2: Text helpers

**Files:**
- Create: `server/lib/quizText.js`
- Test: `server/lib/quizText.test.js`

**Interfaces:**
- Produces: `normalizeStem(html) → string`, `optionLetter(index) → 'A'..`, `parseUsDateTime(text) → 'YYYY-MM-DD HH:MM' | null`, `questionFingerprint({kind, stemHtml, points}) → string`, `plainText(html) → string`.

- [ ] **Step 1: Write the failing test**

```js
// server/lib/quizText.test.js
import { describe, test, expect } from 'vitest';
import { normalizeStem, optionLetter, parseUsDateTime, questionFingerprint, plainText } from './quizText.js';

describe('normalizeStem', () => {
  test('ignores tags, entities, case, spacing and the arrow', () => {
    const a = '<p>Set <code>count &larr; 3</code><br />then&nbsp;DISPLAY</p>';
    const b = 'set count ← 3 then display';
    expect(normalizeStem(a)).toBe(normalizeStem(b));
    expect(normalizeStem(a)).toBe('setcount3thendisplay');
  });
  test('a different word gives a different key', () => {
    expect(normalizeStem('<p>Which is true?</p>')).not.toBe(normalizeStem('<p>Which is false?</p>'));
  });
  test('empty input gives an empty key', () => {
    expect(normalizeStem(null)).toBe('');
  });
});

test('optionLetter', () => {
  expect([0, 1, 2, 3, 4].map(optionLetter)).toEqual(['A', 'B', 'C', 'D', 'E']);
});

describe('parseUsDateTime', () => {
  test('Schoology M/DD/YY h:mmam', () => {
    expect(parseUsDateTime('10/09/26 8:51am')).toBe('2026-10-09 08:51');
    expect(parseUsDateTime(' 9/8/26 2:13pm ')).toBe('2026-09-08 14:13');
    expect(parseUsDateTime('12/1/26 12:05am')).toBe('2026-12-01 00:05');
    expect(parseUsDateTime('12/1/26 12:05pm')).toBe('2026-12-01 12:05');
  });
  test('anything else is null', () => {
    expect(parseUsDateTime('-')).toBeNull();
    expect(parseUsDateTime('')).toBeNull();
  });
});

test('questionFingerprint joins kind, stem key and points', () => {
  expect(questionFingerprint({ kind: 'mcq', stemHtml: '<p>Hi</p>', points: 1 })).toBe('mcq|hi|1');
});

test('plainText keeps words and decodes entities', () => {
  expect(plainText('<p>a &amp; b<br/>c</p>')).toBe('a & b c');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/lib/quizText.test.js`
Expected: FAIL (`Cannot find module './quizText.js'`).

- [ ] **Step 3: Write the implementation**

```js
// server/lib/quizText.js
// Text helpers for linked quizzes. normalizeStem is the comparison key used to
// match a question across copies of a test (copies get new question ids). It is
// ported from csp-tools' build_theory_test_review.py `norm`: tags out, entities
// decoded, then only [a-z0-9] kept, so the HTML and the plain export of one
// question give the same key and the code arrow drops out on both sides.
import { parse } from 'node-html-parser';

export function plainText(html) {
  const withBreaks = String(html ?? '').replace(/<br\s*\/?>/gi, ' ');
  return parse(withBreaks).text.replace(/\s+/g, ' ').trim();
}

export function normalizeStem(html) {
  return plainText(html).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export const optionLetter = (index) => String.fromCharCode(65 + index);

// Schoology's results pages print "10/09/26 8:51am" (US month first, 2-digit year,
// no time zone: the school's display zone). → 'YYYY-MM-DD HH:MM' local, or null.
export function parseUsDateTime(text) {
  const m = String(text ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  const [, mo, d, yy, h, min, ap] = m;
  let hour = Number(h) % 12;
  if (ap.toLowerCase() === 'pm') hour += 12;
  const pad = (n) => String(n).padStart(2, '0');
  return `20${yy}-${pad(mo)}-${pad(d)} ${pad(hour)}:${min}`;
}

export function questionFingerprint({ kind, stemHtml, points }) {
  return `${kind}|${normalizeStem(stemHtml)}|${Number(points)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/lib/quizText.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/quizText.js server/lib/quizText.test.js
git commit -m "feat(quizzes): stem normalization and Schoology date parsing"
```

---

### Task 3: Question list, results and student stats parsers

**Files:**
- Create: `server/lib/parseQuizQuestions.js`, `server/lib/parseQuizResults.js`
- Create: `server/lib/__fixtures__/quiz/questions.html`, `results.html`, `student-stats.html`
- Test: `server/lib/parseQuizQuestions.test.js`, `server/lib/parseQuizResults.test.js`

**Interfaces:**
- Consumes: `plainText`, `parseUsDateTime` (Task 2).
- Produces:
  - `parseQuizQuestions(html) → [{ qid, number, delta, kind: 'mcq'|'frq'|'other', stemHtml, points }]` sorted by `delta`, or `null` when the page has no question rows.
  - `parseQuizResults(html) → [{ uid, attempted: boolean }]` or `null` when no student rows.
  - `parseStudentStats(html, { uid }) → [{ attemptId, startedAt, completedAt, score, maxScore }]` in page order.

The fixtures are trimmed copies of the probed markup with every name and answer replaced. Keep them exactly as below.

- [ ] **Step 1: Write the fixtures**

`server/lib/__fixtures__/quiz/questions.html`:

```html
<table><tbody>
<tr class="draggable odd"><td class="s-assessment-components-list-delta-cell"><input type="hidden" name="components[1001][delta]" value="0" /></td><td>
  <div class="component-summary-wrapper component-multiple_choice"><div class="component-summary">
    <ul class="action-links"><li class="action-edit"><a href="/assignment/900/assessment_questions/edit_question/1001">Edit</a></li><li class="action-delete"><a href="/assignment/900/assessment_questions/delete_question/1001">Delete</a></li></ul>
    <table><tr><td class="component-number">1</td><td class="component-main-cell">
      <div class="component-title s-rte">Which protocol sends web pages?</div>
      <div class="component-attributes"><span class="component-type">Multiple Choice</span> - <span class="component-points">1 point</span></div>
    </td></tr></table>
  </div></div></td></tr>
<tr class="draggable odd"><td class="s-assessment-components-list-delta-cell"><input type="hidden" name="components[1003][delta]" value="37" /></td><td>
  <div class="component-summary-wrapper component-essay"><div class="component-summary">
    <table><tr><td class="component-number">3</td><td class="component-main-cell">
      <div class="component-title s-rte"><p>Explain the program.</p><pre>x &larr; INPUT()<br />DISPLAY(x)</pre></div>
      <div class="component-attributes"><span class="component-type">Free Response</span> - <span class="component-points">4 points</span></div>
    </td></tr></table>
  </div></div></td></tr>
<tr class="draggable even"><td class="s-assessment-components-list-delta-cell"><input type="hidden" name="components[1002][delta]" value="1" /></td><td>
  <div class="component-summary-wrapper component-multiple_choice"><div class="component-summary">
    <table><tr><td class="component-number">2</td><td class="component-main-cell">
      <div class="component-title s-rte">Which is a lossless format?</div>
      <div class="component-attributes"><span class="component-type">Multiple Choice</span> - <span class="component-points">1 point</span></div>
    </td></tr></table>
  </div></div></td></tr>
</tbody></table>
```

`server/lib/__fixtures__/quiz/results.html`:

```html
<table><tbody>
<tr class="student-row-701 odd"><td class="cell-name"><a href="/user/701">Student A</a></td><td class="cell-submissions">1/1</td><td class="cell-latest-attempt"><span class="small gray">10/09/26 8:51am</span></td><td class="cell-score"><input type="text" name="enrollments[701][score]" value="17" /></td></tr>
<tr class="student-row-702 even"><td class="cell-name"><a href="/user/702">Student B</a></td><td class="cell-submissions">-</td><td class="cell-latest-attempt">-</td><td class="cell-score"><input type="text" name="enrollments[702][score]" value="" /></td></tr>
<tr class="student-row-703 odd"><td class="cell-name"><a href="/user/703">Student C</a></td><td class="cell-submissions">2/2</td><td class="cell-latest-attempt"><span class="small gray">10/10/26 9:00am</span></td><td class="cell-score"><input type="text" name="enrollments[703][score]" value="20" /></td></tr>
</tbody></table>
```

`server/lib/__fixtures__/quiz/student-stats.html`:

```html
<table class="sticky-enabled"><tbody>
<tr class=" odd"><td class="sub-count">1</td><td class="sub-started"><span class="small gray">10/09/26 8:51am</span></td><td class="sub-completed"><span class="small gray">10/09/26 9:31am</span></td><td class="sub-elapsed">40 min</td><td class="sub-score"><div class="score"><span class="score-score"><span class="rounded-grade" title="17">17</span></span>/24</div></td><td class="sub-edit"><ul class="action-links"><li class="action-view"><a href="/assignment/900/assessment_results/student_stats/703/5001">view/edit</a></li><li class="action-unsubmit"><a href="/assignment/900/assessment_results/student_stats/703/5001/unsubmit" class="unsubmit-submission">unsubmit</a></li><li class="action-delete"><a href="/assignment/900/assessment_results/student_stats/703/5001/delete" class="delete-submission">delete</a></li></ul></td></tr>
<tr class=" even"><td class="sub-count">2</td><td class="sub-started"><span class="small gray">10/10/26 9:00am</span></td><td class="sub-completed"><span class="small gray">10/10/26 9:35am</span></td><td class="sub-elapsed">35 min</td><td class="sub-score"><div class="score"><span class="score-score"><span class="rounded-grade" title="20">20</span></span>/24</div></td><td class="sub-edit"><ul class="action-links"><li class="action-view"><a href="/assignment/900/assessment_results/student_stats/703/5002">view/edit</a></li></ul></td></tr>
</tbody></table>
```

- [ ] **Step 2: Write the failing tests**

```js
// server/lib/parseQuizQuestions.test.js
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseQuizQuestions } from './parseQuizQuestions.js';

const html = readFileSync(new URL('./__fixtures__/quiz/questions.html', import.meta.url), 'utf8');

describe('parseQuizQuestions', () => {
  test('one entry per question, in delta order, with kind, number, stem and points', () => {
    const qs = parseQuizQuestions(html);
    expect(qs.map(q => [q.qid, q.delta, q.number, q.kind, q.points])).toEqual([
      ['1001', 0, 1, 'mcq', 1],
      ['1002', 1, 2, 'mcq', 1],
      ['1003', 37, 3, 'frq', 4],
    ]);
    expect(qs[2].stemHtml).toContain('<pre>');
  });
  test('null for a page with no question rows (a login page, an error)', () => {
    expect(parseQuizQuestions('<html><body>Sign in</body></html>')).toBeNull();
  });
});
```

```js
// server/lib/parseQuizResults.test.js
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseQuizResults, parseStudentStats } from './parseQuizResults.js';

const fixture = (n) => readFileSync(new URL(`./__fixtures__/quiz/${n}`, import.meta.url), 'utf8');

describe('parseQuizResults', () => {
  test('one row per assignee; attempted when the submissions cell starts with a count of 1 or more', () => {
    expect(parseQuizResults(fixture('results.html'))).toEqual([
      { uid: '701', attempted: true },
      { uid: '702', attempted: false },
      { uid: '703', attempted: true },
    ]);
  });
  test('null with no student rows', () => {
    expect(parseQuizResults('<table></table>')).toBeNull();
  });
});

describe('parseStudentStats', () => {
  test('every attempt with its times and score; never the unsubmit or delete links', () => {
    const rows = parseStudentStats(fixture('student-stats.html'), { uid: '703' });
    expect(rows).toEqual([
      { attemptId: '5001', startedAt: '2026-10-09 08:51', completedAt: '2026-10-09 09:31', score: 17, maxScore: 24 },
      { attemptId: '5002', startedAt: '2026-10-10 09:00', completedAt: '2026-10-10 09:35', score: 20, maxScore: 24 },
    ]);
  });
  test('empty for a page without attempts', () => {
    expect(parseStudentStats('<table></table>', { uid: '703' })).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run server/lib/parseQuizQuestions.test.js server/lib/parseQuizResults.test.js`
Expected: FAIL (modules not found).

- [ ] **Step 4: Write the parsers**

```js
// server/lib/parseQuizQuestions.js
// Pure parser for a Schoology test's question list,
// GET /assignment/{id}/assessment_questions (browser session, read-only).
// Shape verified 2026-10-12: .claude/schoology-api-reference.md, "Questions,
// attempts and FRQ rubrics". The page has no answer options and no key; those
// come from attempt pages (parseQuizAttempt).
import { parse } from 'node-html-parser';

const KIND = { multiple_choice: 'mcq', essay: 'frq' };

export function parseQuizQuestions(html) {
  const root = parse(String(html ?? ''));
  const out = [];
  for (const input of root.querySelectorAll('input')) {
    const m = (input.getAttribute('name') || '').match(/^components\[(\d+)\]\[delta\]$/);
    if (!m) continue;
    const row = input.closest('tr');
    const wrapper = row?.querySelector('.component-summary-wrapper');
    if (!wrapper) continue;
    const typeClass = (wrapper.getAttribute('class') || '').split(/\s+/).find(c => c.startsWith('component-') && c !== 'component-summary-wrapper');
    const type = typeClass ? typeClass.slice('component-'.length) : '';
    const points = Number((row.querySelector('.component-points')?.text || '').match(/[\d.]+/)?.[0] ?? NaN);
    out.push({
      qid: m[1],
      number: Number(row.querySelector('.component-number')?.text.trim()),
      delta: Number(input.getAttribute('value')),
      kind: KIND[type] || 'other',
      stemHtml: row.querySelector('.component-title')?.innerHTML.trim() ?? '',
      points: Number.isFinite(points) ? points : null,
    });
  }
  if (!out.length) return null;
  return out.sort((a, b) => a.delta - b.delta);
}
```

```js
// server/lib/parseQuizResults.js
// Pure parsers for a test's results pages (browser session, read-only):
//   GET /assignment/{id}/assessment_results              → who attempted
//   GET /assignment/{id}/assessment_results/student_stats/{uid} → their attempts
// Shapes: .claude/schoology-api-reference.md, "Did the student take the test?".
// The stats page also links /unsubmit and /delete (GET-href write actions): only
// the bare view link `student_stats/{uid}/{attemptId}` is read here.
import { parse } from 'node-html-parser';
import { parseUsDateTime } from './quizText.js';

export function parseQuizResults(html) {
  const root = parse(String(html ?? ''));
  const out = [];
  for (const tr of root.querySelectorAll('tr')) {
    const m = (tr.getAttribute('class') || '').match(/\bstudent-row-(\d+)\b/);
    if (!m) continue;
    const cell = tr.querySelector('td.cell-submissions')?.text.trim() || '';
    const count = cell.match(/^(\d+)\s*\//);
    out.push({ uid: m[1], attempted: !!count && Number(count[1]) >= 1 });
  }
  return out.length ? out : null;
}

export function parseStudentStats(html, { uid }) {
  const root = parse(String(html ?? ''));
  const viewLink = new RegExp(`/student_stats/${uid}/(\\d+)$`);
  const out = [];
  for (const tr of root.querySelectorAll('tr')) {
    if (!tr.querySelector('td.sub-count')) continue;
    const href = tr.querySelectorAll('a').map(a => a.getAttribute('href') || '').find(h => viewLink.test(h));
    if (!href) continue;
    const scoreText = tr.querySelector('td.sub-score')?.text.replace(/\s+/g, '') || '';
    const score = scoreText.match(/^([\d.]+)\/([\d.]+)/);
    out.push({
      attemptId: href.match(viewLink)[1],
      startedAt: parseUsDateTime(tr.querySelector('td.sub-started')?.text),
      completedAt: parseUsDateTime(tr.querySelector('td.sub-completed')?.text),
      score: score ? Number(score[1]) : null,
      maxScore: score ? Number(score[2]) : null,
    });
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/lib/parseQuizQuestions.test.js server/lib/parseQuizResults.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/lib/parseQuizQuestions.js server/lib/parseQuizResults.js server/lib/parseQuizQuestions.test.js server/lib/parseQuizResults.test.js server/lib/__fixtures__/quiz
git commit -m "feat(quizzes): parse question list, results and attempt list pages"
```

---

### Task 4: Attempt page and rubric parsers

**Files:**
- Create: `server/lib/parseQuizAttempt.js`, `server/lib/parseQuizRubric.js`
- Create: `server/lib/__fixtures__/quiz/attempt.html`
- Test: `server/lib/parseQuizAttempt.test.js`, `server/lib/parseQuizRubric.test.js`

**Interfaces:**
- Consumes: `optionLetter` (Task 2).
- Produces:
  - `parseQuizAttempt(html) → { questions: [{ qid, kind, points, maxPoints, rubricScore, comment, options: [{letter, html, selected, isKey}] | null, chosenLetter, isCorrect, answerHtml, rubric: {rubricId, enrollmentId} | null }] } | null`.
  - `parseQuizRubric(json) → { id, title, totalPoints, rows: [{ id, title, maxPoints, levels: [{ points, name, descriptionHtml }] }] } | null` (levels sorted by points, highest first).
  - `parseRubricGradeInfo(json) → { [rowId]: { points: number|null, comment: string } } | null`.
  - `levelNameFor(rubric, rowId, points) → string | null`.

- [ ] **Step 1: Write the fixture**

`server/lib/__fixtures__/quiz/attempt.html` (structure as probed, text replaced):

```html
<html><body>
<form id="s-assessment-edit-submission-form">
<div class="question-review question-multiple_choice"><div class="grade-score">
  <input type="text" name="components[0][1001][points]" value="1" />
  <input type="hidden" name="components[0][1001][override]" value="0" />
  <input type="hidden" name="components[0][1001][original_points]" value="1" />
  <input type="hidden" name="components[0][1001][max_points]" value="1" />
  <input type="hidden" name="components[0][1001][rubric_score]" value="" />
</div><span class="question-number">Question 1</span><div class="question-view"><div class="component-title s-rte">Which protocol sends web pages?</div>
<ul class="multiple-choice-review" id="question-1001-review">
  <li class=" "><span class="question-content"><span class="option-span">a. FTP</span></span></li>
  <li class=" selected correct"><span class="question-content"><span class="visually-hidden">Selected: </span><span class="option-span">b. HTTP</span><span class="visually-hidden">This answer is correct.</span></span></li>
  <li class=" "><span class="question-content"><span class="option-span">c. SMTP</span></span></li>
  <li class=" "><span class="question-content"><span class="option-span">d. DNS</span></span></li>
</ul></div>
<div class="question-comment-wrapper"><textarea name="components[0][1001][comment]"></textarea></div></div>

<div class="question-review question-multiple_choice"><div class="grade-score">
  <input type="text" name="components[0][1002][points]" value="0" />
  <input type="hidden" name="components[0][1002][max_points]" value="1" />
  <input type="hidden" name="components[0][1002][rubric_score]" value="" />
</div><div class="question-view"><div class="component-title s-rte">Which is a lossless format?</div>
<ul class="multiple-choice-review" id="question-1002-review">
  <li class=" correct"><span class="question-content"><span class="option-span">a. PNG</span></span></li>
  <li class=" "><span class="question-content"><span class="option-span">b. JPEG</span></span></li>
  <li class=" "><span class="question-content"><span class="option-span">c. MP3</span></span></li>
  <li class=" selected incorrect"><span class="question-content"><span class="option-span">d. MP4</span></span></li>
</ul></div>
<div class="question-comment-wrapper"><textarea name="components[0][1002][comment]"></textarea></div></div>

<div class="question-review question-essay"><div class="grade-score override">
  <input type="text" name="components[0][1003][points]" value="2" />
  <input type="hidden" name="components[0][1003][override]" value="1" />
  <input type="hidden" name="components[0][1003][max_points]" value="4" />
  <input type="hidden" name="components[0][1003][rubric_score]" value="2" />
  <div tpl-id="s_grades_rubric_grading_launch_btn_0" class="grade-item tpl-placeholder s-grades-rubric-grading-launch-btn"></div>
</div><div class="question-view"><div class="component-title s-rte"><p>Explain the program.</p></div>
<div class="essay-review"><p>(a) The answer text &lt;- with an arrow.</p><p>(b) Second part.</p></div></div>
<div class="question-comment-wrapper"><textarea name="components[0][1003][comment]">Good start on part (a).</textarea></div></div>
<input type="hidden" name="form_token" value="x" />
</form>
<script>jQuery.extend(Drupal.settings, {"basePath":"\/","theme_js":{"s_grades_rubric_grading_launch_btn_0":{"template":"s_grades_rubric_grading_launch_btn","module":"gradingRubric","args":["55233026","3561143308","1003","<span class="grade-val">2<\/span>",1,1,"5002",4,false,false]}}});</script>
</body></html>
```

- [ ] **Step 2: Write the failing tests**

```js
// server/lib/parseQuizAttempt.test.js
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseQuizAttempt } from './parseQuizAttempt.js';

const html = readFileSync(new URL('./__fixtures__/quiz/attempt.html', import.meta.url), 'utf8');

describe('parseQuizAttempt', () => {
  const { questions } = parseQuizAttempt(html);

  test('one entry per question in page order', () => {
    expect(questions.map(q => [q.qid, q.kind])).toEqual([['1001', 'mcq'], ['1002', 'mcq'], ['1003', 'frq']]);
  });

  test('MCQ: options by position, the chosen letter, the key and correctness', () => {
    expect(questions[0]).toMatchObject({ chosenLetter: 'B', isCorrect: true, points: 1, maxPoints: 1 });
    expect(questions[0].options.map(o => [o.letter, o.selected, o.isKey])).toEqual([
      ['A', false, false], ['B', true, true], ['C', false, false], ['D', false, false],
    ]);
    expect(questions[1]).toMatchObject({ chosenLetter: 'D', isCorrect: false });
    expect(questions[1].options.find(o => o.isKey).letter).toBe('A');
    expect(questions[0].options[1].html).toContain('HTTP');
  });

  test('FRQ: full answer HTML, points, rubric score, comment and the rubric button ids', () => {
    expect(questions[2]).toMatchObject({
      kind: 'frq', points: 2, maxPoints: 4, rubricScore: 2, comment: 'Good start on part (a).',
      rubric: { rubricId: '55233026', enrollmentId: '3561143308' }, options: null, chosenLetter: null, isCorrect: null,
    });
    expect(questions[2].answerHtml).toContain('&lt;- with an arrow');
    expect(questions[2].answerHtml).toContain('Second part');
  });

  test('null for a page without the attempt form', () => {
    expect(parseQuizAttempt('<html>Sign in</html>')).toBeNull();
  });

  test('an MCQ with nothing selected has a null chosen letter and is not correct', () => {
    const blank = html.replace(' selected correct', ' correct');
    expect(parseQuizAttempt(blank).questions[0]).toMatchObject({ chosenLetter: null, isCorrect: false });
  });
});
```

```js
// server/lib/parseQuizRubric.test.js
import { describe, test, expect } from 'vitest';
import { parseQuizRubric, parseRubricGradeInfo, levelNameFor } from './parseQuizRubric.js';

const RUBRIC = { response_code: 200, body: {
  id: 55233026, title: 'AP CSP Free Response Question', total_points: 4, realm: 'course', realm_id: 1,
  rows: [{ id: 146012384, title: 'AP CS: Content Knowledge', description: 'General', max_points: 4, weight: 1, columns: [
    { pts: 1, description: 'Emerging:\n\nYou attempt the question.' },
    { pts: 4, description: 'Exhibiting Depth:\n\nEverything at Exhibiting, plus.' },
    { pts: 3, description: 'Exhibiting:\n\nEvery part.' },
    { pts: 2, description: 'Developing:\n\nAt least one part.' },
  ] }],
} };

describe('parseQuizRubric', () => {
  test('rows with levels highest first, the level name taken from before the first colon', () => {
    const r = parseQuizRubric(RUBRIC);
    expect([r.id, r.title, r.totalPoints]).toEqual(['55233026', 'AP CSP Free Response Question', 4]);
    expect(r.rows[0].levels.map(l => [l.points, l.name])).toEqual([
      [4, 'Exhibiting Depth'], [3, 'Exhibiting'], [2, 'Developing'], [1, 'Emerging'],
    ]);
  });
  test('null without a body.rows array', () => {
    expect(parseQuizRubric({ body: null })).toBeNull();
  });
});

describe('parseRubricGradeInfo', () => {
  test('points per row', () => {
    expect(parseRubricGradeInfo({ body: { gradeInfo: { 146012384: { grade: '2', comment: '' } }, overrideGrade: null } }))
      .toEqual({ 146012384: { points: 2, comment: '' } });
  });
  test('an empty grade is null points', () => {
    expect(parseRubricGradeInfo({ body: { gradeInfo: { 9: { grade: '', comment: '' } } } })).toEqual({ 9: { points: null, comment: '' } });
  });
  test('null on a bad payload', () => {
    expect(parseRubricGradeInfo({})).toBeNull();
  });
});

test('levelNameFor', () => {
  const r = parseQuizRubric(RUBRIC);
  expect(levelNameFor(r, '146012384', 3)).toBe('Exhibiting');
  expect(levelNameFor(r, '146012384', 7)).toBeNull();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run server/lib/parseQuizAttempt.test.js server/lib/parseQuizRubric.test.js`
Expected: FAIL (modules not found).

- [ ] **Step 4: Write the parsers**

```js
// server/lib/parseQuizAttempt.js
// Pure parser for one attempt page,
// GET /assignment/{id}/assessment_results/student_stats/{uid}/{attemptId}
// (browser session, read-only). Shape verified 2026-10-12:
// .claude/schoology-api-reference.md, "Questions, attempts and FRQ rubrics".
// Each question is a div.question-review.question-{type} holding its
// components[0][{qid}][...] inputs. The FRQ rubric button is rendered by
// JavaScript, so its ids come from Drupal.settings.theme_js, not from the HTML.
import { parse } from 'node-html-parser';
import { optionLetter } from './quizText.js';

const KIND = { multiple_choice: 'mcq', essay: 'frq' };
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function rubricButtons(html) {
  const m = String(html).match(/jQuery\.extend\(Drupal\.settings,\s*(\{[\s\S]*?\})\);/);
  if (!m) return {};
  let settings;
  try { settings = JSON.parse(m[1]); } catch { return {}; }
  const out = {};
  for (const entry of Object.values(settings.theme_js || {})) {
    if (entry?.template !== 's_grades_rubric_grading_launch_btn' || !Array.isArray(entry.args)) continue;
    const [rubricId, enrollmentId, qid] = entry.args;
    out[String(qid)] = { rubricId: String(rubricId), enrollmentId: String(enrollmentId) };
  }
  return out;
}

export function parseQuizAttempt(html) {
  const root = parse(String(html ?? ''));
  if (!root.querySelector('#s-assessment-edit-submission-form')) return null;
  const buttons = rubricButtons(html);
  const questions = [];
  for (const block of root.querySelectorAll('div.question-review')) {
    const cls = (block.getAttribute('class') || '').split(/\s+/).find(c => c.startsWith('question-') && c !== 'question-review');
    const field = (name) => block.querySelectorAll('input, textarea')
      .find(el => new RegExp(`^components\\[0\\]\\[\\d+\\]\\[${name}\\]$`).test(el.getAttribute('name') || ''));
    const pointsInput = field('points');
    if (!pointsInput) continue;
    const qid = pointsInput.getAttribute('name').match(/^components\[0\]\[(\d+)\]/)[1];
    const kind = KIND[cls?.slice('question-'.length)] || 'other';
    const ul = block.querySelector(`ul.multiple-choice-review`);
    const options = ul ? ul.querySelectorAll('li').map((li, i) => {
      const classes = (li.getAttribute('class') || '').split(/\s+/);
      return {
        letter: optionLetter(i),
        html: li.querySelector('.option-span')?.innerHTML.trim() ?? '',
        selected: classes.includes('selected'),
        isKey: classes.includes('correct'),
      };
    }) : null;
    const chosen = options?.find(o => o.selected) || null;
    questions.push({
      qid,
      kind,
      points: num(pointsInput.getAttribute('value')),
      maxPoints: num(field('max_points')?.getAttribute('value')),
      rubricScore: num(field('rubric_score')?.getAttribute('value')),
      comment: field('comment')?.text ?? '',
      options,
      chosenLetter: chosen ? chosen.letter : null,
      isCorrect: options ? !!(chosen && chosen.isKey) : null,
      answerHtml: block.querySelector('.essay-review')?.innerHTML.trim() ?? null,
      rubric: buttons[qid] || null,
    });
  }
  return { questions };
}
```

```js
// server/lib/parseQuizRubric.js
// Pure parsers for the rubric attached to an essay question (browser session,
// read-only; verified 2026-10-12, .claude/schoology-api-reference.md):
//   GET /iapi/grades/rubric/{rubricId}
//   GET /iapi/grades/assessment_component_submission_rubric_grade_info/{rubricId}/{qid}/{enrollmentId}/{attemptId}
// Each column description opens with the level name and a colon ("Exhibiting:").
export function parseQuizRubric(json) {
  const b = json?.body;
  if (!b || !Array.isArray(b.rows)) return null;
  return {
    id: String(b.id),
    title: b.title ?? '',
    totalPoints: Number(b.total_points),
    rows: b.rows.map(r => ({
      id: String(r.id),
      title: r.title ?? '',
      maxPoints: Number(r.max_points),
      levels: (r.columns || [])
        .map(c => ({
          points: Number(c.pts),
          name: String(c.description ?? '').split(':')[0].trim(),
          descriptionHtml: String(c.description ?? ''),
        }))
        .sort((a, b2) => b2.points - a.points),
    })),
  };
}

export function parseRubricGradeInfo(json) {
  const info = json?.body?.gradeInfo;
  if (!info || typeof info !== 'object') return null;
  const out = {};
  for (const [rowId, v] of Object.entries(info)) {
    const g = v?.grade;
    out[rowId] = { points: g === '' || g == null ? null : Number(g), comment: v?.comment ?? '' };
  }
  return out;
}

export function levelNameFor(rubric, rowId, points) {
  const row = rubric?.rows.find(r => r.id === String(rowId));
  return row?.levels.find(l => l.points === Number(points))?.name ?? null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/lib/parseQuizAttempt.test.js server/lib/parseQuizRubric.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/lib/parseQuizAttempt.js server/lib/parseQuizRubric.js server/lib/parseQuizAttempt.test.js server/lib/parseQuizRubric.test.js server/lib/__fixtures__/quiz/attempt.html
git commit -m "feat(quizzes): parse attempt pages and FRQ rubrics"
```

---

### Task 5: Parity and question matching

**Files:**
- Create: `server/services/quizParity.js`
- Test: `server/services/quizParity.test.js`

**Interfaces:**
- Consumes: `questionFingerprint`, `plainText` (Task 2); question objects from `parseQuizQuestions` (Task 3).
- Produces:
  - `compareQuestionLists(lists: [{ assignmentId, title, questions }]) → { ok, differences: [{ assignmentId, title, missing: [string], extra: [string] }] }`. `missing`/`extra` hold short plain-text stems (first 80 characters) relative to the first list.
  - `matchCopies(reference: questions, other: questions) → Map<otherQid, referenceQid>`; throws `QuizError('PARITY')` when the sets differ. Questions with the same fingerprint pair by occurrence order.
  - `compareLoadedQuestion(a, b) → string | null`: a reason when two copies of one logical question differ in options, key or rubric id (`a`/`b` are `{ options, rubricId }`).

- [ ] **Step 1: Write the failing test**

```js
// server/services/quizParity.test.js
import { describe, test, expect } from 'vitest';
import { compareQuestionLists, matchCopies, compareLoadedQuestion } from './quizParity.js';

const q = (qid, stem, kind = 'mcq', points = 1) => ({ qid, stemHtml: stem, kind, points });
const STD = [q('1', 'Which is true?'), q('2', 'Which is true?'), q('3', 'Explain', 'frq', 4)];

describe('compareQuestionLists', () => {
  test('same questions in another order and with markup differences: ok', () => {
    const copy = [q('9', '<p>Explain</p>', 'frq', 4), q('7', 'which is TRUE?'), q('8', 'Which is true?')];
    expect(compareQuestionLists([{ assignmentId: 1, title: 'A', questions: STD }, { assignmentId: 2, title: 'A *', questions: copy }]))
      .toEqual({ ok: true, differences: [] });
  });
  test('a changed question is listed as missing and extra', () => {
    const copy = [q('7', 'Which is true?'), q('8', 'Which is false?'), q('9', 'Explain', 'frq', 4)];
    const r = compareQuestionLists([{ assignmentId: 1, title: 'A', questions: STD }, { assignmentId: 2, title: 'A *', questions: copy }]);
    expect(r.ok).toBe(false);
    expect(r.differences).toEqual([{ assignmentId: 2, title: 'A *', missing: ['Which is true?'], extra: ['Which is false?'] }]);
  });
  test('different points are a difference', () => {
    const copy = [q('7', 'Which is true?'), q('8', 'Which is true?'), q('9', 'Explain', 'frq', 6)];
    expect(compareQuestionLists([{ assignmentId: 1, title: 'A', questions: STD }, { assignmentId: 2, title: 'B', questions: copy }]).ok).toBe(false);
  });
  test('a single list is ok', () => {
    expect(compareQuestionLists([{ assignmentId: 1, title: 'A', questions: STD }]).ok).toBe(true);
  });
});

describe('matchCopies', () => {
  test('duplicate stems pair by occurrence order', () => {
    const copy = [q('9', 'Explain', 'frq', 4), q('7', 'Which is true?'), q('8', 'Which is true?')];
    expect([...matchCopies(STD, copy)]).toEqual([['9', '3'], ['7', '1'], ['8', '2']]);
  });
  test('throws PARITY when the sets differ', () => {
    expect(() => matchCopies(STD, [q('7', 'Other')])).toThrow(expect.objectContaining({ code: 'PARITY' }));
  });
});

describe('compareLoadedQuestion', () => {
  const opts = (key) => ['A', 'B'].map(l => ({ letter: l, html: `opt ${l}`, isKey: l === key }));
  test('same options and key: null', () => {
    expect(compareLoadedQuestion({ options: opts('A') }, { options: opts('A') })).toBeNull();
  });
  test('a different key is reported', () => {
    expect(compareLoadedQuestion({ options: opts('A') }, { options: opts('B') })).toMatch(/key/);
  });
  test('a different rubric is reported', () => {
    expect(compareLoadedQuestion({ options: null, rubricId: '1' }, { options: null, rubricId: '2' })).toMatch(/rubric/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/quizParity.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```js
// server/services/quizParity.js
// Parity between copies of a test (spec §3). Copies get new question ids, so a
// question is matched by its fingerprint (kind, normalized stem, points) and,
// when one test repeats a stem, by the order those repeats appear in. Order of
// questions is otherwise ignored: a test can randomize it.
import { questionFingerprint, normalizeStem, plainText } from '../lib/quizText.js';
import { QuizError } from './quizError.js';

const short = (html) => plainText(html).slice(0, 80);

function keyed(questions) {
  const seen = new Map();
  return questions.map(q => {
    const fp = questionFingerprint(q);
    const n = (seen.get(fp) || 0) + 1;
    seen.set(fp, n);
    return { key: `${fp}#${n}`, q };
  });
}

export function compareQuestionLists(lists) {
  const [ref, ...rest] = lists;
  const refKeys = keyed(ref.questions);
  const differences = [];
  for (const other of rest) {
    const otherKeys = keyed(other.questions);
    const otherSet = new Set(otherKeys.map(k => k.key));
    const refSet = new Set(refKeys.map(k => k.key));
    const missing = refKeys.filter(k => !otherSet.has(k.key)).map(k => short(k.q.stemHtml));
    const extra = otherKeys.filter(k => !refSet.has(k.key)).map(k => short(k.q.stemHtml));
    if (missing.length || extra.length) differences.push({ assignmentId: other.assignmentId, title: other.title, missing, extra });
  }
  return { ok: differences.length === 0, differences };
}

export function matchCopies(reference, other) {
  const byKey = new Map(keyed(reference).map(k => [k.key, k.q.qid]));
  const out = new Map();
  for (const { key, q } of keyed(other)) {
    const refQid = byKey.get(key);
    if (!refQid) throw new QuizError('PARITY', `Question not in the first test: ${short(q.stemHtml)}`);
    out.set(q.qid, refQid);
  }
  if (out.size !== reference.length) throw new QuizError('PARITY', 'The tests have a different number of questions');
  return out;
}

export function compareLoadedQuestion(a, b) {
  if (a.options && b.options) {
    const texts = (o) => o.map(x => normalizeStem(x.html)).join('|');
    if (texts(a.options) !== texts(b.options)) return 'different answer options';
    const key = (o) => o.filter(x => x.isKey).map(x => x.letter).join('');
    if (key(a.options) !== key(b.options)) return 'a different key';
  }
  if (a.rubricId && b.rubricId && a.rubricId !== b.rubricId) return 'a different rubric';
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/quizParity.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/quizParity.js server/services/quizParity.test.js
git commit -m "feat(quizzes): parity check and copy matching"
```

---

### Task 6: Groups, links, tags and candidates

**Files:**
- Create: `server/services/quizGroups.js`
- Test: `server/services/quizGroups.test.js`

**Interfaces:**
- Consumes: `QuizError` (Task 1), `compareQuestionLists`, `matchCopies` (Task 5), `ALIGNED_SQL` (`server/services/triageCommon.js`), `SCHOOLOGY_BASE` (`server/lib/browserSession.js`).
- Produces (all take `db` first; assignment arguments accept a local id or a Schoology id):
  - `resolveAssignment(db, ref) → row | null` (row has `id, course_id, schoology_assignment_id, title, is_test, aligned`).
  - `createGroup(db, { courseId, assignmentRefs, title, questionLists }) → group`. `questionLists` is `[{ assignmentId (local), questions }]` from `parseQuizQuestions`, one per member, in the same order as `assignmentRefs`. Validates, checks parity, stores members, logical questions (from the first list) and copies.
  - `linkResult(db, { groupId, resultRef }) → group`; `unlinkResult(db, { groupId }) → group`; `deleteGroup(db, { groupId })`.
  - `getGroup(db, groupId) → { id, course_id, title, result, members: [{id, schoology_assignment_id, title}], parity_status, parity_detail, loaded_at, load_summary, canonical_schoology_id }`.
  - `listGroups(db, { courseId }) → group[]`.
  - `groupForAssignment(db, ref) → group | null` (member or result task).
  - `setQuestionTags(db, { groupId, tags: { [position]: string[] } }) → { updated, unknownPositions }`.
  - `listCandidates(db, { courseId }) → { tests: [{id, schoology_assignment_id, title, suggestedWith: [schoology ids]}], summatives: [{id, schoology_assignment_id, title}] }`.
  - `attemptLinks(db, { assignmentRef }) → { [studentId]: { url, completedAt } }` and `attemptLinksForStudent(db, { studentId }) → { [schoologyAssignmentId]: { url, completedAt } }`.

Canonical assignment: the result task when linked, otherwise the member with the lowest local id.

- [ ] **Step 1: Write the failing test**

```js
// server/services/quizGroups.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import {
  createGroup, linkResult, unlinkResult, deleteGroup, getGroup, listGroups, groupForAssignment,
  setQuestionTags, listCandidates, attemptLinks, attemptLinksForStudent,
} from './quizGroups.js';

const Q = (qid, stem, kind = 'mcq', points = 1, delta = 0) => ({ qid, stemHtml: stem, kind, points, delta, number: delta + 1 });
const LIST = [Q('1001', 'Which is true?', 'mcq', 1, 0), Q('1002', 'Which is true?', 'mcq', 1, 1), Q('1003', 'Explain', 'frq', 4, 2)];
const COPY = [Q('2003', 'Explain', 'frq', 4, 0), Q('2001', 'Which is true?', 'mcq', 1, 1), Q('2002', 'Which is true?', 'mcq', 1, 2)];

let db, course, std, ext, result, other, formative, stu;
beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  course = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'AP CSP')`).run().lastInsertRowid;
  // Foreign keys are on (server/db/index.js), so an alignment needs a real topic.
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'X', 'C')`).run(course);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat', ?, 'X.1', 'T')`).run(course);
  const other_course = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s2', 'Other')`).run().lastInsertRowid;
  const add = (cid, sid, title, isTest) => db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, ?, ?, ?)`).run(cid, sid, title, isTest).lastInsertRowid;
  std = add(course, '900', 'Ep 1 Theory Test', 1);
  ext = add(course, '901', 'Ep 1 Theory Test *', 1);
  result = add(course, '950', 'Ep 1 Theory Test - Result (S)', 0);
  formative = add(course, '960', 'Practice', 0);
  other = add(other_course, '990', 'Elsewhere', 1);
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('950', 't1', ?)`).run(course);
  stu = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'A', 'B')`).run().lastInsertRowid;
});

const make = () => createGroup(db, {
  courseId: course, assignmentRefs: ['900', '901'], title: 'Ep 1 Theory Test',
  questionLists: [{ assignmentId: std, questions: LIST }, { assignmentId: ext, questions: COPY }],
});

describe('createGroup', () => {
  test('stores members, logical questions from the first list, and every copy id', () => {
    const g = make();
    expect(g.members.map(m => m.schoology_assignment_id)).toEqual(['900', '901']);
    expect(g.canonical_schoology_id).toBe('900');
    const qs = db.prepare('SELECT position, kind, max_points FROM quiz_questions WHERE group_id = ? ORDER BY position').all(g.id);
    expect(qs).toEqual([{ position: 1, kind: 'mcq', max_points: 1 }, { position: 2, kind: 'mcq', max_points: 1 }, { position: 3, kind: 'frq', max_points: 4 }]);
    const copies = db.prepare(`SELECT qq.position, c.schoology_question_id FROM quiz_question_copies c JOIN quiz_questions qq ON qq.id = c.question_id WHERE c.assignment_id = ? ORDER BY qq.position`).all(ext);
    expect(copies.map(c => [c.position, c.schoology_question_id])).toEqual([[1, '2001'], [2, '2002'], [3, '2003']]);
  });
  test('refuses a parity mismatch and stores nothing', () => {
    expect(() => createGroup(db, { courseId: course, assignmentRefs: ['900', '901'], title: 'X',
      questionLists: [{ assignmentId: std, questions: LIST }, { assignmentId: ext, questions: COPY.slice(1) }] }))
      .toThrow(expect.objectContaining({ code: 'PARITY' }));
    expect(db.prepare('SELECT COUNT(*) n FROM quiz_groups').get().n).toBe(0);
  });
  test('refuses an aligned item, a non-test, another course, or a test already grouped', () => {
    const one = (ref) => createGroup(db, { courseId: course, assignmentRefs: [ref], title: 'X', questionLists: [{ assignmentId: 0, questions: LIST }] });
    expect(() => one('950')).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(() => one('960')).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(() => one('990')).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    make();
    expect(() => one('900')).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
  });
});

describe('links', () => {
  test('link an aligned summative; the result task becomes canonical; unlink keeps the group', () => {
    const g = make();
    const linked = linkResult(db, { groupId: g.id, resultRef: '950' });
    expect([linked.result.schoology_assignment_id, linked.canonical_schoology_id]).toEqual(['950', '950']);
    expect(groupForAssignment(db, '950').id).toBe(g.id);
    expect(groupForAssignment(db, '901').id).toBe(g.id);
    expect(unlinkResult(db, { groupId: g.id }).result).toBeNull();
  });
  test('refuses an unaligned task, another course, or a task linked elsewhere', () => {
    const g = make();
    expect(() => linkResult(db, { groupId: g.id, resultRef: '960' })).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(() => linkResult(db, { groupId: g.id, resultRef: '990' })).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
  });
  test('deleteGroup removes the group and frees its tests', () => {
    const g = make();
    deleteGroup(db, { groupId: g.id });
    expect(groupForAssignment(db, '900')).toBeNull();
    expect(listGroups(db, { courseId: course })).toEqual([]);
  });
});

test('setQuestionTags trims, drops blanks, and reports unknown positions', () => {
  const g = make();
  expect(setQuestionTags(db, { groupId: g.id, tags: { 1: [' CRD-2.G ', ''], 9: ['X'] } })).toEqual({ updated: 1, unknownPositions: [9] });
  expect(JSON.parse(db.prepare('SELECT tags_json FROM quiz_questions WHERE group_id = ? AND position = 1').get(g.id).tags_json)).toEqual(['CRD-2.G']);
});

test('listCandidates: ungrouped unaligned tests with similar-title suggestions, and unlinked aligned tasks', () => {
  const c = listCandidates(db, { courseId: course });
  expect(c.tests.map(t => [t.schoology_assignment_id, t.suggestedWith])).toEqual([['900', ['901']], ['901', ['900']]]);
  expect(c.summatives.map(s => s.schoology_assignment_id)).toEqual(['950']);
  make();
  expect(listCandidates(db, { courseId: course }).tests).toEqual([]);
});

test('attemptLinks: by member test, by result task, and by student', () => {
  const g = linkResult(db, { groupId: make().id, resultRef: '950' });
  db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, completed_at, fetched_at) VALUES (?, ?, ?, '5002', '2026-10-10 09:35', 'now')`).run(g.id, ext, stu);
  const want = { url: 'https://schoology.hkis.edu.hk/assignment/901/assessment_results/student_stats/701/5002', completedAt: '2026-10-10 09:35' };
  expect(attemptLinks(db, { assignmentRef: '901' })).toEqual({ [stu]: want });
  expect(attemptLinks(db, { assignmentRef: '950' })).toEqual({ [stu]: want });
  expect(attemptLinks(db, { assignmentRef: '960' })).toEqual({});
  expect(attemptLinksForStudent(db, { studentId: stu })).toEqual({ 901: want, 950: want });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/quizGroups.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```js
// server/services/quizGroups.js
// Quiz groups and links (docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md §3).
// A group is one or more unaligned Schoology tests in one course; it may link to one
// aligned summative in the same course. Nothing here touches Schoology: callers read
// the question lists through quizLoader and pass them in.
import { ALIGNED_SQL } from './triageCommon.js';
import { SCHOOLOGY_BASE } from '../lib/browserSession.js';
import { QuizError } from './quizError.js';
import { compareQuestionLists, matchCopies } from './quizParity.js';
import { normalizeStem } from '../lib/quizText.js';

const ASSIGNMENT_SQL = `SELECT a.id, a.course_id, a.schoology_assignment_id, a.title, a.is_test, ${ALIGNED_SQL} AS aligned
  FROM assignments a`;

export function resolveAssignment(db, ref) {
  return db.prepare(`${ASSIGNMENT_SQL} WHERE a.schoology_assignment_id = ?`).get(String(ref))
    || (/^\d+$/.test(String(ref)) && Number(ref) < 1e9 ? db.prepare(`${ASSIGNMENT_SQL} WHERE a.id = ?`).get(Number(ref)) : null)
    || null;
}

function groupRow(db, groupId) {
  const g = db.prepare('SELECT * FROM quiz_groups WHERE id = ?').get(Number(groupId));
  if (!g) throw new QuizError('NOT_FOUND', `No quiz group ${groupId}`);
  return g;
}

export function getGroup(db, groupId) {
  const g = groupRow(db, groupId);
  const members = db.prepare(`SELECT a.id, a.schoology_assignment_id, a.title FROM quiz_group_members m
    JOIN assignments a ON a.id = m.assignment_id WHERE m.group_id = ? ORDER BY a.id`).all(g.id);
  const result = g.result_assignment_id
    ? db.prepare('SELECT id, schoology_assignment_id, title FROM assignments WHERE id = ?').get(g.result_assignment_id)
    : null;
  return {
    id: g.id, course_id: g.course_id, title: g.title, result, members,
    parity_status: g.parity_status, parity_detail: g.parity_detail_json ? JSON.parse(g.parity_detail_json) : null,
    loaded_at: g.loaded_at, load_summary: g.load_summary_json ? JSON.parse(g.load_summary_json) : null,
    canonical_schoology_id: result ? result.schoology_assignment_id : members[0]?.schoology_assignment_id ?? null,
  };
}

export function listGroups(db, { courseId }) {
  return db.prepare('SELECT id FROM quiz_groups WHERE course_id = ? ORDER BY id').all(Number(courseId)).map(r => getGroup(db, r.id));
}

export function groupForAssignment(db, ref) {
  const a = resolveAssignment(db, ref);
  if (!a) return null;
  const row = db.prepare(`SELECT id FROM quiz_groups WHERE result_assignment_id = ?
    UNION SELECT group_id AS id FROM quiz_group_members WHERE assignment_id = ?`).get(a.id, a.id);
  return row ? getGroup(db, row.id) : null;
}

function assertEligibleTest(db, a, courseId) {
  if (!a) throw new QuizError('NOT_FOUND', 'Unknown assignment');
  if (a.course_id !== Number(courseId)) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is in another course`);
  if (a.is_test !== 1) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is not a Schoology test or quiz`);
  if (a.aligned) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is aligned: only unaligned tests can be combined`);
  if (db.prepare('SELECT 1 FROM quiz_group_members WHERE assignment_id = ?').get(a.id)) {
    throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is already in a quiz group`);
  }
}

export function createGroup(db, { courseId, assignmentRefs, title, questionLists }) {
  const tests = assignmentRefs.map(ref => resolveAssignment(db, ref));
  tests.forEach(a => assertEligibleTest(db, a, courseId));
  const lists = questionLists.map((l, i) => ({ assignmentId: tests[i].id, title: tests[i].title, questions: l.questions }));
  const parity = compareQuestionLists(lists);
  if (!parity.ok) {
    throw Object.assign(new QuizError('PARITY', 'The tests have different questions'), { differences: parity.differences });
  }
  const tx = db.transaction(() => {
    const groupId = db.prepare('INSERT INTO quiz_groups (course_id, title) VALUES (?, ?)').run(Number(courseId), title || tests[0].title).lastInsertRowid;
    const addMember = db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)');
    tests.forEach(a => addMember.run(groupId, a.id));
    const addQ = db.prepare('INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points) VALUES (?, ?, ?, ?, ?)');
    const addCopy = db.prepare('INSERT INTO quiz_question_copies (question_id, assignment_id, schoology_question_id) VALUES (?, ?, ?)');
    const logicalByQid = new Map();
    lists[0].questions.forEach((q, i) => {
      const id = addQ.run(groupId, i + 1, q.kind, q.stemHtml, q.points).lastInsertRowid;
      logicalByQid.set(q.qid, id);
      addCopy.run(id, lists[0].assignmentId, q.qid);
    });
    for (const l of lists.slice(1)) {
      for (const [otherQid, refQid] of matchCopies(lists[0].questions, l.questions)) {
        addCopy.run(logicalByQid.get(refQid), l.assignmentId, otherQid);
      }
    }
    return groupId;
  });
  return getGroup(db, tx());
}

export function linkResult(db, { groupId, resultRef }) {
  const g = groupRow(db, groupId);
  const a = resolveAssignment(db, resultRef);
  if (!a) throw new QuizError('NOT_FOUND', 'Unknown result task');
  if (a.course_id !== g.course_id) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is in another course`);
  if (!a.aligned) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is not aligned to measurement topics`);
  if (a.is_test === 1) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is a test: link an aligned summative task`);
  const taken = db.prepare('SELECT id FROM quiz_groups WHERE result_assignment_id = ? AND id != ?').get(a.id, g.id);
  if (taken) throw new QuizError('NOT_ELIGIBLE', `"${a.title}" is already linked to another quiz`);
  db.prepare(`UPDATE quiz_groups SET result_assignment_id = ?, updated_at = datetime('now') WHERE id = ?`).run(a.id, g.id);
  return getGroup(db, g.id);
}

export function unlinkResult(db, { groupId }) {
  const g = groupRow(db, groupId);
  db.prepare(`UPDATE quiz_groups SET result_assignment_id = NULL, updated_at = datetime('now') WHERE id = ?`).run(g.id);
  return getGroup(db, g.id);
}

export function deleteGroup(db, { groupId }) {
  const g = groupRow(db, groupId);
  db.transaction(() => {
    const attempts = db.prepare('SELECT id FROM quiz_attempts WHERE group_id = ?').all(g.id).map(r => r.id);
    for (const id of attempts) db.prepare('DELETE FROM quiz_responses WHERE attempt_id = ?').run(id);
    db.prepare('DELETE FROM quiz_attempts WHERE group_id = ?').run(g.id);
    db.prepare('DELETE FROM quiz_question_copies WHERE question_id IN (SELECT id FROM quiz_questions WHERE group_id = ?)').run(g.id);
    db.prepare('DELETE FROM quiz_questions WHERE group_id = ?').run(g.id);
    db.prepare('DELETE FROM quiz_group_members WHERE group_id = ?').run(g.id);
    db.prepare('DELETE FROM quiz_groups WHERE id = ?').run(g.id);
  })();
}

export function setQuestionTags(db, { groupId, tags }) {
  const g = groupRow(db, groupId);
  const update = db.prepare('UPDATE quiz_questions SET tags_json = ? WHERE group_id = ? AND position = ?');
  let updated = 0;
  const unknownPositions = [];
  for (const [pos, list] of Object.entries(tags || {})) {
    const clean = [...new Set((list || []).map(t => String(t).trim()).filter(Boolean))];
    const r = update.run(JSON.stringify(clean), g.id, Number(pos));
    if (r.changes) updated++; else unknownPositions.push(Number(pos));
  }
  return { updated, unknownPositions };
}

// Titles count as similar when one normalized title starts with the other
// (for example "Ep 1 Theory Test" and "Ep 1 Theory Test *"). A suggestion only:
// the teacher confirms every combine.
function similar(a, b) {
  const x = normalizeStem(a), y = normalizeStem(b);
  return x.length > 3 && y.length > 3 && x !== y ? x.startsWith(y) || y.startsWith(x) : x === y;
}

export function listCandidates(db, { courseId }) {
  const rows = db.prepare(`${ASSIGNMENT_SQL} WHERE a.course_id = ? AND a.removed_at IS NULL ORDER BY a.id`).all(Number(courseId));
  const grouped = new Set(db.prepare('SELECT assignment_id FROM quiz_group_members').all().map(r => r.assignment_id));
  const linked = new Set(db.prepare('SELECT result_assignment_id FROM quiz_groups WHERE result_assignment_id IS NOT NULL').all().map(r => r.result_assignment_id));
  const tests = rows.filter(a => a.is_test === 1 && !a.aligned && !grouped.has(a.id));
  return {
    tests: tests.map(t => ({
      id: t.id, schoology_assignment_id: t.schoology_assignment_id, title: t.title,
      suggestedWith: tests.filter(o => o.id !== t.id && similar(o.title, t.title)).map(o => o.schoology_assignment_id),
    })),
    summatives: rows.filter(a => a.aligned && a.is_test !== 1 && !linked.has(a.id))
      .map(a => ({ id: a.id, schoology_assignment_id: a.schoology_assignment_id, title: a.title })),
  };
}

const ATTEMPT_SQL = `SELECT qa.student_id, qa.schoology_attempt_id, qa.completed_at, s.schoology_uid,
    a.schoology_assignment_id AS member_sid, g.result_assignment_id, ra.schoology_assignment_id AS result_sid
  FROM quiz_attempts qa
  JOIN students s ON s.id = qa.student_id
  JOIN assignments a ON a.id = qa.assignment_id
  JOIN quiz_groups g ON g.id = qa.group_id
  LEFT JOIN assignments ra ON ra.id = g.result_assignment_id`;

const linkOf = (r) => ({
  url: `${SCHOOLOGY_BASE}/assignment/${r.member_sid}/assessment_results/student_stats/${r.schoology_uid}/${r.schoology_attempt_id}`,
  completedAt: r.completed_at,
});

export function attemptLinks(db, { assignmentRef }) {
  const a = resolveAssignment(db, assignmentRef);
  if (!a) return {};
  const rows = db.prepare(`${ATTEMPT_SQL} WHERE qa.assignment_id = ? OR g.result_assignment_id = ? ORDER BY qa.completed_at`).all(a.id, a.id);
  const out = {};
  for (const r of rows) out[r.student_id] = linkOf(r);
  return out;
}

export function attemptLinksForStudent(db, { studentId }) {
  const out = {};
  for (const r of db.prepare(`${ATTEMPT_SQL} WHERE qa.student_id = ? ORDER BY qa.completed_at`).all(Number(studentId))) {
    out[r.member_sid] = linkOf(r);
    if (r.result_sid) out[r.result_sid] = linkOf(r);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/quizGroups.test.js`
Expected: PASS. If `resolveAssignment` picks the wrong row for a small numeric Schoology id in a test, note that real Schoology ids are 10 digits; the `< 1e9` guard keeps local ids and Schoology ids apart.

- [ ] **Step 5: Commit**

```bash
git add server/services/quizGroups.js server/services/quizGroups.test.js
git commit -m "feat(quizzes): quiz groups, result links, tags and attempt links"
```

---

### Task 7: Storing a load

**Files:**
- Create: `server/services/quizStore.js`
- Test: `server/services/quizStore.test.js`

**Interfaces:**
- Consumes: `compareLoadedQuestion` (Task 5); parser outputs (Tasks 3 and 4); `QuizError`.
- Produces:
  - `storeAttempt(db, { groupId, assignmentId, studentId, attempt: {attemptId, startedAt, completedAt, score, maxScore}, attemptCount, parsed: parseQuizAttempt result, rubrics: { [rubricId]: parsedRubric }, gradeInfo: { [qid]: parsedGradeInfo } }) → { stored: true, mismatches: string[] }`. Replaces this student's attempt on this member test and its responses in one transaction. Fills `options_json` and `schoology_rubric_json` on a logical question the first time a load sees them, and returns a mismatch reason when a later copy differs.
  - `pruneOlderDuplicates(db, { groupId }) → number`: when one student has attempts on two members, keeps the one with the later `completed_at` (then `started_at`, then attempt id) and deletes the other with its responses. Returns rows removed.
  - `finishLoad(db, { groupId, summary, mismatches }) → void`: sets `loaded_at`, `load_summary_json`, `parity_status` (`mismatch` when any) and `parity_detail_json`.

- [ ] **Step 1: Write the failing test**

```js
// server/services/quizStore.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { readFileSync } from 'fs';
import { getDb } from '../db/index.js';
import { createGroup } from './quizGroups.js';
import { storeAttempt, pruneOlderDuplicates, finishLoad } from './quizStore.js';
import { parseQuizAttempt } from '../lib/parseQuizAttempt.js';

const ATTEMPT = parseQuizAttempt(readFileSync(new URL('../lib/__fixtures__/quiz/attempt.html', import.meta.url), 'utf8'));
const Q = (qid, stem, kind, points, delta) => ({ qid, stemHtml: stem, kind, points, delta, number: delta + 1 });
const LIST = [Q('1001', 'Which protocol sends web pages?', 'mcq', 1, 0), Q('1002', 'Which is a lossless format?', 'mcq', 1, 1), Q('1003', 'Explain the program.', 'frq', 4, 2)];
const COPY = LIST.map(q => ({ ...q, qid: String(Number(q.qid) + 1000) }));
const RUBRIC = { id: '55233026', title: 'FRQ', totalPoints: 4, rows: [{ id: '146012384', title: 'Row', maxPoints: 4, levels: [{ points: 2, name: 'Developing', descriptionHtml: 'Developing: x' }] }] };

let db, groupId, std, ext, s1;
beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'C')`).run().lastInsertRowid;
  std = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'T', 1)`).run(c).lastInsertRowid;
  ext = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '901', 'T *', 1)`).run(c).lastInsertRowid;
  s1 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'A', 'B')`).run().lastInsertRowid;
  groupId = createGroup(db, { courseId: c, assignmentRefs: ['900', '901'], title: 'T',
    questionLists: [{ assignmentId: std, questions: LIST }, { assignmentId: ext, questions: COPY }] }).id;
});

const store = (assignmentId, parsed, extra = {}) => storeAttempt(db, {
  groupId, assignmentId, studentId: s1,
  attempt: { attemptId: '5002', startedAt: '2026-10-10 09:00', completedAt: '2026-10-10 09:35', score: 3, maxScore: 6, ...extra },
  attemptCount: 1, parsed, rubrics: { 55233026: RUBRIC },
  gradeInfo: { 1003: { 146012384: { points: 2, comment: '' } } },
});

describe('storeAttempt', () => {
  test('stores the attempt and one response per logical question; fills options and rubric once', () => {
    expect(store(std, ATTEMPT)).toEqual({ stored: true, mismatches: [] });
    const rows = db.prepare(`SELECT qq.position, r.chosen_letter, r.is_correct, r.points, r.answer_html IS NOT NULL AS has_answer, r.schoology_rubric_cells_json
      FROM quiz_responses r JOIN quiz_questions qq ON qq.id = r.question_id ORDER BY qq.position`).all();
    expect(rows.map(r => [r.position, r.chosen_letter, r.is_correct, r.points, r.has_answer])).toEqual([
      [1, 'B', 1, 1, 0], [2, 'D', 0, 0, 0], [3, null, null, 2, 1],
    ]);
    expect(JSON.parse(rows[2].schoology_rubric_cells_json)).toEqual({ 146012384: { points: 2, comment: '' } });
    const q1 = db.prepare('SELECT options_json FROM quiz_questions WHERE group_id = ? AND position = 1').get(groupId);
    expect(JSON.parse(q1.options_json).map(o => [o.letter, o.is_key])).toEqual([['A', false], ['B', true], ['C', false], ['D', false]]);
    expect(JSON.parse(db.prepare('SELECT schoology_rubric_json FROM quiz_questions WHERE group_id = ? AND position = 3').get(groupId).schoology_rubric_json).id).toBe('55233026');
  });

  test('reloading replaces the attempt instead of adding one', () => {
    store(std, ATTEMPT);
    store(std, ATTEMPT);
    expect(db.prepare('SELECT COUNT(*) n FROM quiz_attempts').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM quiz_responses').get().n).toBe(3);
  });

  test('a copy with a different key is reported as a mismatch', () => {
    store(std, ATTEMPT);
    const changed = structuredClone(ATTEMPT);
    changed.questions.forEach(q => { q.qid = String(Number(q.qid) + 1000); });
    changed.questions[0].options = changed.questions[0].options.map(o => ({ ...o, isKey: o.letter === 'A' }));
    const s2 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('702', 'C', 'D')`).run().lastInsertRowid;
    const r = storeAttempt(db, { groupId, assignmentId: ext, studentId: s2, attempt: { attemptId: '6001' }, attemptCount: 1, parsed: changed, rubrics: {}, gradeInfo: {} });
    expect(r.mismatches).toEqual(['Question 1: a different key']);
  });
});

test('pruneOlderDuplicates keeps the later attempt when a student sat two copies', () => {
  store(std, ATTEMPT, { completedAt: '2026-10-09 09:00' });
  const copy = structuredClone(ATTEMPT);
  copy.questions.forEach(q => { q.qid = String(Number(q.qid) + 1000); });
  store(ext, copy, { attemptId: '6001', completedAt: '2026-10-10 09:00' });
  expect(pruneOlderDuplicates(db, { groupId })).toBe(1);
  expect(db.prepare('SELECT assignment_id FROM quiz_attempts').all()).toEqual([{ assignment_id: ext }]);
  expect(db.prepare('SELECT COUNT(*) n FROM quiz_responses').get().n).toBe(3);
});

test('finishLoad records the summary and parity', () => {
  finishLoad(db, { groupId, summary: { attempts: 1 }, mismatches: ['Question 1: a different key'] });
  const g = db.prepare('SELECT * FROM quiz_groups WHERE id = ?').get(groupId);
  expect([g.parity_status, JSON.parse(g.parity_detail_json), JSON.parse(g.load_summary_json)]).toEqual(['mismatch', ['Question 1: a different key'], { attempts: 1 }]);
  expect(g.loaded_at).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/quizStore.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```js
// server/services/quizStore.js
// Stores what a load read (spec §5). One counted attempt per student per member
// test; responses keyed by logical question. Never touches anything a teacher
// writes in Prism (FRQ marks arrive in phase 2 in their own table).
import { compareLoadedQuestion } from './quizParity.js';

const json = (v) => (v == null ? null : JSON.stringify(v));

export function storeAttempt(db, { groupId, assignmentId, studentId, attempt, attemptCount, parsed, rubrics, gradeInfo }) {
  const logical = db.prepare(`SELECT qq.id, qq.position, qq.options_json, qq.schoology_rubric_json, c.schoology_question_id AS qid
    FROM quiz_question_copies c JOIN quiz_questions qq ON qq.id = c.question_id
    WHERE qq.group_id = ? AND c.assignment_id = ?`).all(groupId, assignmentId);
  const byQid = new Map(logical.map(l => [l.qid, l]));
  const mismatches = [];

  db.transaction(() => {
    const old = db.prepare('SELECT id FROM quiz_attempts WHERE assignment_id = ? AND student_id = ?').get(assignmentId, studentId);
    if (old) {
      db.prepare('DELETE FROM quiz_responses WHERE attempt_id = ?').run(old.id);
      db.prepare('DELETE FROM quiz_attempts WHERE id = ?').run(old.id);
    }
    const attemptRowId = db.prepare(`INSERT INTO quiz_attempts
      (group_id, assignment_id, student_id, schoology_attempt_id, started_at, completed_at, score, max_score, attempt_count, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
      groupId, assignmentId, studentId, String(attempt.attemptId), attempt.startedAt ?? null, attempt.completedAt ?? null,
      attempt.score ?? null, attempt.maxScore ?? null, attemptCount ?? 1,
    ).lastInsertRowid;

    const addResponse = db.prepare(`INSERT INTO quiz_responses
      (attempt_id, question_id, chosen_letter, is_correct, points, max_points, answer_html, schoology_rubric_cells_json, schoology_comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const q of parsed.questions) {
      const l = byQid.get(q.qid);
      if (!l) continue;
      const options = q.options ? q.options.map(o => ({ letter: o.letter, html: o.html, is_key: o.isKey })) : null;
      const rubric = q.rubric ? rubrics[q.rubric.rubricId] ?? null : null;
      if (l.options_json || l.schoology_rubric_json) {
        const stored = { options: l.options_json ? JSON.parse(l.options_json).map(o => ({ ...o, isKey: o.is_key })) : null,
          rubricId: l.schoology_rubric_json ? JSON.parse(l.schoology_rubric_json).id : null };
        const reason = compareLoadedQuestion(stored, { options: q.options, rubricId: rubric?.id ?? null });
        if (reason) mismatches.push(`Question ${l.position}: ${reason}`);
      }
      if (!l.options_json && options) db.prepare('UPDATE quiz_questions SET options_json = ? WHERE id = ?').run(json(options), l.id);
      if (!l.schoology_rubric_json && rubric) db.prepare('UPDATE quiz_questions SET schoology_rubric_json = ? WHERE id = ?').run(json(rubric), l.id);
      addResponse.run(
        attemptRowId, l.id, q.chosenLetter, q.isCorrect == null ? null : (q.isCorrect ? 1 : 0),
        q.points, q.maxPoints, q.answerHtml, json(gradeInfo[q.qid] ?? null), q.comment || null,
      );
    }
  })();
  return { stored: true, mismatches };
}

export function pruneOlderDuplicates(db, { groupId }) {
  const rows = db.prepare(`SELECT id, student_id FROM quiz_attempts WHERE group_id = ?
    ORDER BY student_id, COALESCE(completed_at, '') DESC, COALESCE(started_at, '') DESC, CAST(schoology_attempt_id AS INTEGER) DESC`).all(groupId);
  const keep = new Set();
  const drop = [];
  for (const r of rows) {
    if (keep.has(r.student_id)) drop.push(r.id); else keep.add(r.student_id);
  }
  db.transaction(() => {
    for (const id of drop) {
      db.prepare('DELETE FROM quiz_responses WHERE attempt_id = ?').run(id);
      db.prepare('DELETE FROM quiz_attempts WHERE id = ?').run(id);
    }
  })();
  return drop.length;
}

export function finishLoad(db, { groupId, summary, mismatches }) {
  db.prepare(`UPDATE quiz_groups SET loaded_at = datetime('now'), load_summary_json = ?,
    parity_status = ?, parity_detail_json = ?, updated_at = datetime('now') WHERE id = ?`).run(
    json(summary), mismatches.length ? 'mismatch' : 'ok', mismatches.length ? json([...new Set(mismatches)]) : null, groupId,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/quizStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/quizStore.js server/services/quizStore.test.js
git commit -m "feat(quizzes): store attempts and responses, keep one counted attempt"
```

---

### Task 8: The browser loader

**Files:**
- Create: `server/services/quizLoader.js`
- Test: `server/services/quizLoader.test.js`

**Interfaces:**
- Consumes: `sessionDeps.openPage` (`server/services/schoologySession.js`), `SCHOOLOGY_BASE`, `isLoggedInUrl` (`server/lib/browserSession.js`), all parsers (Tasks 3 and 4), `storeAttempt`, `pruneOlderDuplicates`, `finishLoad` (Task 7), `getGroup` (Task 6), `QuizError`.
- Produces:
  - `readQuestionLists(db, { assignmentRefs }, { openPage, pauseMs } = {}) → [{ assignmentId, schoologyId, title, questions }]`. Throws `NO_SESSION` or `NOT_FOUND` (a page without questions).
  - `loadGroup(db, { groupId }, { openPage, pauseMs, onProgress } = {}) → { attempts, notTaken, failed: [{uid, reason}], unknownUids: [uid], mismatches, multipleAttempts: [uid] }`. Throws `NO_SESSION` when there is no session or the first page bounces to sign-in, and `BUSY` when the same group is already loading.
  - `assertReadOnlyUrl(path)` (exported for its test).

The loader fetches each page as text inside the logged-in page (`page.evaluate` with `fetch`), and parses it in Node. It waits `pauseMs` (default 400) between requests.

- [ ] **Step 1: Write the failing test**

```js
// server/services/quizLoader.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { readFileSync } from 'fs';
import { getDb } from '../db/index.js';
import { createGroup } from './quizGroups.js';
import { loadGroup, readQuestionLists, assertReadOnlyUrl } from './quizLoader.js';
import { parseQuizQuestions } from '../lib/parseQuizQuestions.js';

const fx = (n) => readFileSync(new URL(`../lib/__fixtures__/quiz/${n}`, import.meta.url), 'utf8');
const BASE = 'https://schoology.hkis.edu.hk';
const RUBRIC = JSON.stringify({ response_code: 200, body: { id: 55233026, title: 'FRQ', total_points: 4, rows: [{ id: 146012384, title: 'Row', max_points: 4, columns: [{ pts: 2, description: 'Developing: x' }] }] } });
const GRADE = JSON.stringify({ response_code: 200, body: { gradeInfo: { 146012384: { grade: '2', comment: '' } } } });

// A fake session page: `pages` maps a path (no host) to { status, text }, or to a function.
function fakeOpenPage(pages, { landing = `${BASE}/home` } = {}) {
  const requested = [];
  const page = {
    goto: vi.fn(async () => {}),
    url: () => landing,
    evaluate: vi.fn(async (_fn, { url }) => {
      const path = url.replace(BASE, '');
      requested.push(path);
      const hit = pages[path];
      if (!hit) return { status: 404, text: '', finalUrl: url };
      const r = typeof hit === 'function' ? await hit() : hit;
      return { finalUrl: url, ...r };
    }),
  };
  const close = vi.fn(async () => {});
  return { openPage: vi.fn(async () => ({ page, close })), requested, close };
}

let db, groupId, studentA, studentC;
beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'C')`).run().lastInsertRowid;
  const t = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'T', 1)`).run(c).lastInsertRowid;
  studentA = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'A', 'A')`).run().lastInsertRowid;
  studentC = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('703', 'C', 'C')`).run().lastInsertRowid;
  groupId = createGroup(db, { courseId: c, assignmentRefs: ['900'], title: 'T', questionLists: [{ assignmentId: t, questions: parseQuizQuestions(fx('questions.html')) }] }).id;
});

const happyPages = () => ({
  '/assignment/900/assessment_results': { status: 200, text: fx('results.html') },
  '/assignment/900/assessment_results/student_stats/701': { status: 200, text: fx('student-stats.html').replaceAll('/703/', '/701/') },
  '/assignment/900/assessment_results/student_stats/703': { status: 200, text: fx('student-stats.html') },
  '/assignment/900/assessment_results/student_stats/701/5002': { status: 200, text: fx('attempt.html') },
  '/assignment/900/assessment_results/student_stats/703/5002': { status: 200, text: fx('attempt.html') },
  '/iapi/grades/rubric/55233026': { status: 200, text: RUBRIC },
  '/iapi/grades/assessment_component_submission_rubric_grade_info/55233026/1003/3561143308/5002': { status: 200, text: GRADE },
});

describe('loadGroup', () => {
  test('reads results, the latest attempt for each taker, and each rubric once; stores them', async () => {
    const f = fakeOpenPage(happyPages());
    const r = await loadGroup(db, { groupId }, { openPage: f.openPage, pauseMs: 0 });
    expect(r).toMatchObject({ attempts: 2, notTaken: 1, failed: [], unknownUids: [], mismatches: [], multipleAttempts: ['701', '703'] });
    expect(db.prepare('SELECT student_id, schoology_attempt_id FROM quiz_attempts ORDER BY student_id').all())
      .toEqual([{ student_id: studentA, schoology_attempt_id: '5002' }, { student_id: studentC, schoology_attempt_id: '5002' }]);
    expect(f.requested.filter(p => p === '/iapi/grades/rubric/55233026')).toHaveLength(1);
    expect(f.requested.some(p => /unsubmit|delete/.test(p))).toBe(false);
    expect(f.close).toHaveBeenCalled();
    expect(db.prepare('SELECT loaded_at FROM quiz_groups WHERE id = ?').get(groupId).loaded_at).toBeTruthy();
  });

  test('an unknown uid is skipped with a warning and the rest still load', async () => {
    db.prepare(`DELETE FROM students WHERE schoology_uid = '701'`).run();
    const r = await loadGroup(db, { groupId }, { openPage: fakeOpenPage(happyPages()).openPage, pauseMs: 0 });
    expect(r.unknownUids).toEqual(['701']);
    expect(r.attempts).toBe(1);
  });

  test('a failed attempt page is reported for that student only', async () => {
    const pages = happyPages();
    pages['/assignment/900/assessment_results/student_stats/701/5002'] = { status: 500, text: '' };
    const r = await loadGroup(db, { groupId }, { openPage: fakeOpenPage(pages).openPage, pauseMs: 0 });
    expect(r.failed).toEqual([{ uid: '701', reason: 'attempt page HTTP 500' }]);
    expect(r.attempts).toBe(1);
  });

  test('a bounce to sign-in mid-load stops with NO_SESSION and keeps what was stored', async () => {
    const pages = happyPages();
    pages['/assignment/900/assessment_results/student_stats/703/5002'] = () => ({ status: 200, text: '<html>sign in</html>', finalUrl: 'https://login.microsoftonline.com/x' });
    await expect(loadGroup(db, { groupId }, { openPage: fakeOpenPage(pages).openPage, pauseMs: 0 }))
      .rejects.toMatchObject({ code: 'NO_SESSION' });
    expect(db.prepare('SELECT COUNT(*) n FROM quiz_attempts').get().n).toBe(1);
  });

  test('no saved session: NO_SESSION before any request', async () => {
    await expect(loadGroup(db, { groupId }, { openPage: async () => null, pauseMs: 0 })).rejects.toMatchObject({ code: 'NO_SESSION' });
  });

  test('a second load of the same group while one runs: BUSY', async () => {
    let release;
    const pages = happyPages();
    pages['/assignment/900/assessment_results'] = () => new Promise(r => { release = () => r({ status: 200, text: fx('results.html') }); });
    const f = fakeOpenPage(pages);
    const first = loadGroup(db, { groupId }, { openPage: f.openPage, pauseMs: 0 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(loadGroup(db, { groupId }, { openPage: f.openPage, pauseMs: 0 })).rejects.toMatchObject({ code: 'BUSY' });
    release();
    await first;
  });
});

describe('readQuestionLists', () => {
  test('one parsed list per test', async () => {
    const f = fakeOpenPage({ '/assignment/900/assessment_questions': { status: 200, text: fx('questions.html') } });
    const lists = await readQuestionLists(db, { assignmentRefs: ['900'] }, { openPage: f.openPage, pauseMs: 0 });
    expect(lists[0]).toMatchObject({ schoologyId: '900', title: 'T' });
    expect(lists[0].questions).toHaveLength(3);
  });
});

test('assertReadOnlyUrl refuses write-action paths', () => {
  expect(() => assertReadOnlyUrl('/assignment/1/assessment_results/student_stats/2/3/unsubmit')).toThrow();
  expect(() => assertReadOnlyUrl('/x/DELETE')).toThrow();
  expect(() => assertReadOnlyUrl('/assignment/1/assessment_results')).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/quizLoader.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```js
// server/services/quizLoader.js
// Reads a quiz group's Schoology pages through the saved browser session (spec §5).
// GET only. Pages are fetched as text inside the logged-in page and parsed in Node,
// one request at a time with a short pause. Any URL holding "unsubmit" or "delete"
// is refused: the results pages carry GET-href write actions.
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { sessionDeps, noteSessionLive } from './schoologySession.js';
import { QuizError } from './quizError.js';
import { getGroup, resolveAssignment } from './quizGroups.js';
import { parseQuizQuestions } from '../lib/parseQuizQuestions.js';
import { parseQuizResults, parseStudentStats } from '../lib/parseQuizResults.js';
import { parseQuizAttempt } from '../lib/parseQuizAttempt.js';
import { parseQuizRubric, parseRubricGradeInfo } from '../lib/parseQuizRubric.js';
import { storeAttempt, pruneOlderDuplicates, finishLoad } from './quizStore.js';

const FETCH_TIMEOUT_MS = 30000;
const loading = new Set();

export function assertReadOnlyUrl(path) {
  if (/unsubmit|delete/i.test(path)) throw new Error(`Refusing a write-action URL: ${path}`);
}

async function inPageFetch({ url, accept, timeoutMs }) {
  try {
    const r = await fetch(url, { credentials: 'include', headers: accept ? { Accept: accept } : {}, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, text: await r.text(), finalUrl: r.url };
  } catch (err) {
    return { status: 0, text: '', finalUrl: url, error: String(err?.message || err) };
  }
}

async function openReader({ openPage, pauseMs }) {
  const session = await openPage();
  if (!session) throw new QuizError('NO_SESSION', 'No saved Schoology session: reconnect in Settings');
  await session.page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  if (!isLoggedInUrl(session.page.url())) {
    await session.close().catch(() => {});
    noteSessionLive('expired', 'Schoology sent the saved session to the login page');
    throw new QuizError('NO_SESSION', 'Schoology connection expired: reconnect in Settings');
  }
  let first = true;
  const get = async (path, { json = false } = {}) => {
    assertReadOnlyUrl(path);
    if (!first && pauseMs) await new Promise(r => setTimeout(r, pauseMs));
    first = false;
    const r = await session.page.evaluate(inPageFetch, { url: `${SCHOOLOGY_BASE}${path}`, accept: json ? 'application/json' : null, timeoutMs: FETCH_TIMEOUT_MS });
    if (r.finalUrl && !isLoggedInUrl(r.finalUrl)) {
      noteSessionLive('expired', 'Schoology sent the saved session to the login page');
      throw new QuizError('NO_SESSION', 'Schoology connection expired during the load: reconnect in Settings');
    }
    if (!json) return r;
    try { return { ...r, json: JSON.parse(r.text) }; } catch { return { ...r, json: null }; }
  };
  return { get, close: () => session.close().catch(() => {}) };
}

export async function readQuestionLists(db, { assignmentRefs }, { openPage = () => sessionDeps.openPage(), pauseMs = 400 } = {}) {
  const reader = await openReader({ openPage, pauseMs });
  try {
    const out = [];
    for (const ref of assignmentRefs) {
      const a = resolveAssignment(db, ref);
      if (!a) throw new QuizError('NOT_FOUND', `Unknown assignment ${ref}`);
      const r = await reader.get(`/assignment/${a.schoology_assignment_id}/assessment_questions`);
      const questions = r.status === 200 ? parseQuizQuestions(r.text) : null;
      if (!questions) throw new QuizError('NOT_FOUND', `Could not read the questions of "${a.title}" (HTTP ${r.status})`);
      out.push({ assignmentId: a.id, schoologyId: a.schoology_assignment_id, title: a.title, questions });
    }
    return out;
  } finally {
    await reader.close();
  }
}

export async function loadGroup(db, { groupId }, { openPage = () => sessionDeps.openPage(), pauseMs = 400, onProgress = () => {} } = {}) {
  const group = getGroup(db, groupId);
  if (loading.has(group.id)) throw new QuizError('BUSY', 'This quiz is already loading');
  loading.add(group.id);
  const summary = { attempts: 0, notTaken: 0, failed: [], unknownUids: [], mismatches: [], multipleAttempts: [] };
  const rubrics = {};
  let reader;
  try {
    reader = await openReader({ openPage, pauseMs });
    const studentByUid = new Map(db.prepare('SELECT id, schoology_uid FROM students').all().map(s => [String(s.schoology_uid), s.id]));
    for (const member of group.members) {
      const sid = member.schoology_assignment_id;
      const res = await reader.get(`/assignment/${sid}/assessment_results`);
      const rows = res.status === 200 ? parseQuizResults(res.text) : null;
      if (!rows) { summary.failed.push({ uid: null, reason: `results page for "${member.title}" HTTP ${res.status}` }); continue; }
      for (const row of rows) {
        if (!row.attempted) { summary.notTaken++; continue; }
        const studentId = studentByUid.get(row.uid);
        if (!studentId) { summary.unknownUids.push(row.uid); continue; }
        onProgress({ uid: row.uid, member: sid });
        const stats = await reader.get(`/assignment/${sid}/assessment_results/student_stats/${row.uid}`);
        const attempts = stats.status === 200 ? parseStudentStats(stats.text, { uid: row.uid }) : [];
        if (!attempts.length) { summary.failed.push({ uid: row.uid, reason: `attempt list HTTP ${stats.status}` }); continue; }
        if (attempts.length > 1) summary.multipleAttempts.push(row.uid);
        const counted = attempts[attempts.length - 1];
        const page = await reader.get(`/assignment/${sid}/assessment_results/student_stats/${row.uid}/${counted.attemptId}`);
        const parsed = page.status === 200 ? parseQuizAttempt(page.text) : null;
        if (!parsed) { summary.failed.push({ uid: row.uid, reason: `attempt page HTTP ${page.status}` }); continue; }
        const gradeInfo = {};
        for (const q of parsed.questions) {
          if (!q.rubric) continue;
          if (!(q.rubric.rubricId in rubrics)) {
            const rj = await reader.get(`/iapi/grades/rubric/${q.rubric.rubricId}`, { json: true });
            rubrics[q.rubric.rubricId] = parseQuizRubric(rj.json);
          }
          const gi = await reader.get(`/iapi/grades/assessment_component_submission_rubric_grade_info/${q.rubric.rubricId}/${q.qid}/${q.rubric.enrollmentId}/${counted.attemptId}`, { json: true });
          gradeInfo[q.qid] = parseRubricGradeInfo(gi.json);
        }
        const stored = storeAttempt(db, { groupId: group.id, assignmentId: member.id, studentId, attempt: counted, attemptCount: attempts.length, parsed, rubrics, gradeInfo });
        summary.mismatches.push(...stored.mismatches);
        summary.attempts++;
      }
    }
    pruneOlderDuplicates(db, { groupId: group.id });
    summary.attempts = db.prepare('SELECT COUNT(*) n FROM quiz_attempts WHERE group_id = ?').get(group.id).n;
    finishLoad(db, { groupId: group.id, summary, mismatches: summary.mismatches });
    return summary;
  } finally {
    loading.delete(group.id);
    await reader?.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/quizLoader.test.js`
Expected: PASS. The fake `evaluate` receives `inPageFetch` and its argument object; it ignores the function and answers from `pages`.

- [ ] **Step 5: Commit**

```bash
git add server/services/quizLoader.js server/services/quizLoader.test.js
git commit -m "feat(quizzes): read-only loader through the saved browser session"
```

---

### Task 9: Statistics

**Files:**
- Create: `server/services/quizStats.js`
- Test: `server/services/quizStats.test.js`

**Interfaces:**
- Consumes: `getGroup` (Task 6), `levelNameFor` (Task 4), `plainText` (Task 2).
- Produces: `groupStats(db, { groupId }) → {`
  - `takers, classSize, byMember: [{ schoology_assignment_id, title, takers }]`,
  - `mcq: { count, median_percent }` (`median_percent` of per-student MCQ percent, rounded to a whole number; `null` without takers),
  - `frq: { count, levels: [{ name, count }] }` (from Schoology's current rubric cell; highest level first; plus `{ name: 'Not marked', count }` when any),
  - `byTag: [{ tag, positions, correct, total, percent }]` sorted by `percent` ascending (MCQs only),
  - `questions: [{ position, kind, stem_html, tags, total, correct, facility, band, options: [{letter, html, count, is_key}], blank, flags: [{level, text}] }]` sorted by position `}`.

Flags (MCQ only, wording fixed here; `critical` / `warning` / `note`):
- a distractor drew more students than the key → `critical`: `Distractor C drew more students than the key.`
- facility below 0.5 → `critical`: `Fewer than half answered correctly.`
- facility 1 → `note`: `Nobody missed it.`
- a distractor nobody chose, with at least 10 answers → `note`: `Nobody chose D.`
- at least 3 distractors, each chosen by exactly one student → `warning`: `Every distractor drew exactly one student: a sign of guessing.`
- blank answers → `warning`: `2 left blank.`

- [ ] **Step 1: Write the failing test**

```js
// server/services/quizStats.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { groupStats } from './quizStats.js';

let db, g, qMcq, qFrq;
const RUBRIC = { id: 'r', rows: [{ id: '9', title: 'Row', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth' }, { points: 3, name: 'Exhibiting' }, { points: 2, name: 'Developing' }, { points: 1, name: 'Emerging' }] }] };

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'C')`).run().lastInsertRowid;
  const t = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'T', 1)`).run(c).lastInsertRowid;
  g = db.prepare(`INSERT INTO quiz_groups (course_id, title) VALUES (?, 'T')`).run(c).lastInsertRowid;
  db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)').run(g, t);
  const opts = JSON.stringify(['A', 'B', 'C', 'D'].map(l => ({ letter: l, html: l, is_key: l === 'B' })));
  qMcq = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, options_json, max_points, tags_json) VALUES (?, 1, 'mcq', 'Q1', ?, 1, '["CRD-2.G"]')`).run(g, opts).lastInsertRowid;
  qFrq = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json) VALUES (?, 2, 'frq', 'Q2', 4, ?)`).run(g, JSON.stringify(RUBRIC)).lastInsertRowid;
  // 4 students: choices B, C, C, blank; FRQ cells 3, 2, 2, none. 5 enrolled.
  const choices = ['B', 'C', 'C', null];
  const cells = [3, 2, 2, null];
  for (let i = 0; i < 5; i++) {
    const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'S', ?)`).run(`u${i}`, `S${i}`).lastInsertRowid;
    db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(s, c);
    if (i === 4) continue;
    const a = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, ?, 'now')`).run(g, t, s, `a${i}`).lastInsertRowid;
    db.prepare('INSERT INTO quiz_responses (attempt_id, question_id, chosen_letter, is_correct, points, max_points) VALUES (?, ?, ?, ?, ?, 1)')
      .run(a, qMcq, choices[i], choices[i] === 'B' ? 1 : 0, choices[i] === 'B' ? 1 : 0);
    db.prepare('INSERT INTO quiz_responses (attempt_id, question_id, points, max_points, schoology_rubric_cells_json) VALUES (?, ?, ?, 4, ?)')
      .run(a, qFrq, cells[i], cells[i] == null ? null : JSON.stringify({ 9: { points: cells[i], comment: '' } }));
  }
});

describe('groupStats', () => {
  test('takers, MCQ median and FRQ levels', () => {
    const s = groupStats(db, { groupId: g });
    expect([s.takers, s.classSize]).toEqual([4, 5]);
    expect(s.byMember).toEqual([{ schoology_assignment_id: '900', title: 'T', takers: 4 }]);
    expect(s.mcq).toEqual({ count: 1, median_percent: 0 });
    expect(s.frq).toEqual({ count: 1, levels: [{ name: 'Exhibiting', count: 1 }, { name: 'Developing', count: 2 }, { name: 'Not marked', count: 1 }] });
  });

  test('per question: counts, blank, band and flags', () => {
    const q = groupStats(db, { groupId: g }).questions[0];
    expect([q.total, q.correct, q.facility, q.band, q.blank]).toEqual([4, 1, 0.25, 'Divided', 1]);
    expect(q.options.map(o => [o.letter, o.count, o.is_key])).toEqual([['A', 0, false], ['B', 1, true], ['C', 2, false], ['D', 0, false]]);
    expect(q.flags.map(f => f.text)).toEqual([
      'Distractor C drew more students than the key.',
      'Fewer than half answered correctly.',
      '1 left blank.',
    ]);
  });

  test('by tag, lowest first', () => {
    expect(groupStats(db, { groupId: g }).byTag).toEqual([{ tag: 'CRD-2.G', positions: [1], correct: 1, total: 4, percent: 25 }]);
  });

  test('a group with no attempts has empty statistics', () => {
    db.exec('DELETE FROM quiz_responses; DELETE FROM quiz_attempts;');
    const s = groupStats(db, { groupId: g });
    expect([s.takers, s.mcq.median_percent, s.questions[0].facility, s.questions[0].band]).toEqual([0, null, null, null]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/quizStats.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```js
// server/services/quizStats.js
// Statistics for the Questions tab (spec §8). Counts, percentages, bands and
// distractor flags only: no discrimination indices or reliability coefficients,
// which a class-sized cohort cannot support. Bands and flags follow csp-tools'
// build_theory_test_review.py.
import { getGroup } from './quizGroups.js';
import { levelNameFor } from '../lib/parseQuizRubric.js';

const band = (p) => (p == null ? null : p >= 0.9 ? 'Strong' : p >= 0.7 ? 'Mixed' : 'Divided');
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function mcqFlags(options, correct, total, blank) {
  const flags = [];
  const keyCount = options.filter(o => o.is_key).reduce((n, o) => n + o.count, 0);
  const distractors = options.filter(o => !o.is_key);
  const top = distractors.reduce((best, o) => (!best || o.count > best.count ? o : best), null);
  const p = total ? correct / total : null;
  if (top && top.count > keyCount) flags.push({ level: 'critical', text: `Distractor ${top.letter} drew more students than the key.` });
  if (p != null && p < 0.5) flags.push({ level: 'critical', text: 'Fewer than half answered correctly.' });
  if (p === 1) flags.push({ level: 'note', text: 'Nobody missed it.' });
  const dead = distractors.filter(o => o.count === 0).map(o => o.letter);
  if (dead.length && total >= 10) flags.push({ level: 'note', text: `Nobody chose ${dead.join(', ')}.` });
  if (distractors.length >= 3 && distractors.every(o => o.count === 1)) {
    flags.push({ level: 'warning', text: 'Every distractor drew exactly one student: a sign of guessing.' });
  }
  if (blank) flags.push({ level: 'warning', text: `${blank} left blank.` });
  return flags;
}

export function groupStats(db, { groupId }) {
  const group = getGroup(db, groupId);
  const attempts = db.prepare(`SELECT qa.id, qa.assignment_id FROM quiz_attempts qa WHERE qa.group_id = ?`).all(group.id);
  const classSize = db.prepare('SELECT COUNT(*) n FROM enrolments WHERE course_id = ? AND dropped_at IS NULL').get(group.course_id).n;
  const questions = db.prepare('SELECT * FROM quiz_questions WHERE group_id = ? ORDER BY position').all(group.id);
  const responses = db.prepare(`SELECT r.* FROM quiz_responses r JOIN quiz_attempts qa ON qa.id = r.attempt_id WHERE qa.group_id = ?`).all(group.id);
  const byQuestion = new Map(questions.map(q => [q.id, []]));
  for (const r of responses) byQuestion.get(r.question_id)?.push(r);

  const outQuestions = questions.map(q => {
    const rs = byQuestion.get(q.id);
    const tags = JSON.parse(q.tags_json || '[]');
    if (q.kind !== 'mcq') {
      return { position: q.position, kind: q.kind, stem_html: q.stem_html, tags, total: rs.length, correct: null, facility: null, band: null, options: [], blank: 0, flags: [] };
    }
    const opts = JSON.parse(q.options_json || '[]').map(o => ({ ...o, count: rs.filter(r => r.chosen_letter === o.letter).length }));
    const total = rs.length;
    const correct = rs.filter(r => r.is_correct === 1).length;
    const blank = rs.filter(r => !r.chosen_letter).length;
    const facility = total ? correct / total : null;
    return { position: q.position, kind: 'mcq', stem_html: q.stem_html, tags, total, correct, facility, band: band(facility), options: opts, blank, flags: total ? mcqFlags(opts, correct, total, blank) : [] };
  });

  const mcqIds = new Set(questions.filter(q => q.kind === 'mcq').map(q => q.id));
  const perStudent = attempts.map(a => {
    const rs = responses.filter(r => r.attempt_id === a.id && mcqIds.has(r.question_id));
    return mcqIds.size ? (100 * rs.filter(r => r.is_correct === 1).length) / mcqIds.size : null;
  }).filter(x => x != null);
  const med = median(perStudent);

  const frqQuestions = questions.filter(q => q.kind === 'frq');
  const levelCounts = new Map();
  let notMarked = 0;
  for (const q of frqQuestions) {
    const rubric = q.schoology_rubric_json ? JSON.parse(q.schoology_rubric_json) : null;
    for (const r of byQuestion.get(q.id)) {
      const cells = r.schoology_rubric_cells_json ? JSON.parse(r.schoology_rubric_cells_json) : null;
      const [rowId, cell] = cells ? Object.entries(cells)[0] ?? [] : [];
      const name = rubric && cell?.points != null ? levelNameFor(rubric, rowId, cell.points) : null;
      if (name) levelCounts.set(name, (levelCounts.get(name) || 0) + 1); else notMarked++;
    }
  }
  const order = frqQuestions[0]?.schoology_rubric_json ? JSON.parse(frqQuestions[0].schoology_rubric_json).rows[0].levels.map(l => l.name) : [];
  const levels = [...levelCounts].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([name, count]) => ({ name, count }));
  if (notMarked) levels.push({ name: 'Not marked', count: notMarked });

  const tagAgg = new Map();
  for (const q of outQuestions.filter(x => x.kind === 'mcq')) {
    for (const tag of q.tags) {
      const t = tagAgg.get(tag) || { tag, positions: [], correct: 0, total: 0 };
      t.positions.push(q.position); t.correct += q.correct; t.total += q.total;
      tagAgg.set(tag, t);
    }
  }
  const byTag = [...tagAgg.values()]
    .map(t => ({ ...t, percent: t.total ? Math.round((100 * t.correct) / t.total) : null }))
    .sort((a, b) => (a.percent ?? 101) - (b.percent ?? 101));

  return {
    takers: attempts.length,
    classSize,
    byMember: group.members.map(m => ({ schoology_assignment_id: m.schoology_assignment_id, title: m.title, takers: attempts.filter(a => a.assignment_id === m.id).length })),
    mcq: { count: mcqIds.size, median_percent: med == null ? null : Math.round(med) },
    frq: { count: frqQuestions.length, levels },
    byTag,
    questions: outQuestions,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/quizStats.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/quizStats.js server/services/quizStats.test.js
git commit -m "feat(quizzes): per-question, per-tag and per-type statistics"
```

---

### Task 10: The `/api/quizzes` router and client API calls

**Files:**
- Create: `server/routes/quizzes.js`
- Modify: `server/index.js` (import + `app.use('/api/quizzes', quizzesRouter);` after the triage line)
- Modify: `client/src/services/api.js` (append)
- Test: `server/routes/quizzes.test.js`

**Interfaces:**
- Consumes: Tasks 6, 8 and 9; `featureGate('quizzes')`.
- Produces (HTTP; error body `{ error, code, differences? }`):

| Method and path | Body / query | Returns |
|---|---|---|
| `GET /api/quizzes?course_id=` | | `{ groups }` |
| `GET /api/quizzes/candidates?course_id=` | | `{ tests, summatives }` |
| `GET /api/quizzes/for-assignment/:ref` | | `{ group }` (`null` when none) |
| `POST /api/quizzes/check-parity` | `{ assignment_ids }` | `{ ok, differences }` |
| `POST /api/quizzes` | `{ course_id, assignment_ids, title }` | `{ group }` |
| `PUT /api/quizzes/:id/link` | `{ result_assignment_id }` (`null` unlinks) | `{ group }` |
| `DELETE /api/quizzes/:id` | | `{ ok: true }` |
| `POST /api/quizzes/:id/load` | | `{ summary, group }` |
| `GET /api/quizzes/:id/stats` | | stats (Task 9) |
| `PUT /api/quizzes/:id/tags` | `{ tags: { [position]: string[] } }` | `{ updated, unknownPositions }` |
| `GET /api/quizzes/attempt-links?assignment_id=` or `?student_id=` | | `{ links }` |

- Status codes: `NOT_FOUND` 404, `NOT_ELIGIBLE` 400, `PARITY` 409, `BUSY` 409, `NO_SESSION` 503, anything else 500.
- Client functions: `getQuizGroups(courseId)`, `getQuizCandidates(courseId)`, `getQuizGroupFor(assignmentRef)`, `checkQuizParity(assignmentIds)`, `createQuizGroup({courseId, assignmentIds, title})`, `linkQuizResult(groupId, resultAssignmentId)`, `deleteQuizGroup(groupId)`, `loadQuizResults(groupId)`, `getQuizStats(groupId)`, `setQuizTags(groupId, tags)`, `getAttemptLinks({ assignmentId, studentId })`.

- [ ] **Step 1: Write the failing test**

```js
// server/routes/quizzes.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../services/quizLoader.js', () => ({ readQuestionLists: vi.fn(), loadGroup: vi.fn() }));
vi.mock('../middleware/featureGate.js', async (orig) => ({ ...(await orig()), featureGate: () => (req, res, next) => next() }));

import router from './quizzes.js';
import { getDb } from '../db/index.js';
import { readQuestionLists, loadGroup } from '../services/quizLoader.js';
import { QuizError } from '../services/quizError.js';

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/quizzes', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

const Q = (qid, stem) => ({ qid, stemHtml: stem, kind: 'mcq', points: 1, delta: 0, number: 1 });
let course;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM assignments; DELETE FROM courses;');
  course = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'C')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'X', 'C')`).run(course);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t', 'cat', ?, 'X.1', 'T')`).run(course);
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'T', 1), (?, '901', 'T *', 1), (?, '950', 'T - Result (S)', 0)`).run(course, course, course);
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('950', 't', ?)`).run(course);
  vi.mocked(readQuestionLists).mockImplementation(async (db2, { assignmentRefs }) => assignmentRefs.map((ref) => {
    const a = db2.prepare('SELECT id, title FROM assignments WHERE schoology_assignment_id = ?').get(String(ref));
    return { assignmentId: a.id, schoologyId: String(ref), title: a.title, questions: [Q(`${ref}1`, 'Same question')] };
  }));
});

describe('/api/quizzes', () => {
  test('combine, link, find by either assignment, list', async () => {
    const created = await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900', '901'], title: 'T' });
    expect(created.status).toBe(200);
    const id = created.body.group.id;
    expect((await call('PUT', `/api/quizzes/${id}/link`, { result_assignment_id: '950' })).body.group.canonical_schoology_id).toBe('950');
    expect((await call('GET', '/api/quizzes/for-assignment/901')).body.group.id).toBe(id);
    expect((await call('GET', `/api/quizzes?course_id=${course}`)).body.groups).toHaveLength(1);
    expect((await call('PUT', `/api/quizzes/${id}/link`, { result_assignment_id: null })).body.group.result).toBeNull();
  });

  test('a parity mismatch is 409 with the differences', async () => {
    vi.mocked(readQuestionLists).mockResolvedValueOnce([
      { assignmentId: 1, schoologyId: '900', title: 'T', questions: [Q('1', 'One')] },
      { assignmentId: 2, schoologyId: '901', title: 'T *', questions: [Q('2', 'Two')] },
    ]);
    const r = await call('POST', '/api/quizzes/check-parity', { assignment_ids: ['900', '901'] });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.differences[0].title).toBe('T *');
  });

  test('no session is 503', async () => {
    vi.mocked(readQuestionLists).mockRejectedValueOnce(new QuizError('NO_SESSION', 'No saved Schoology session'));
    const r = await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' });
    expect([r.status, r.body.code]).toEqual([503, 'NO_SESSION']);
  });

  test('load returns the summary; BUSY is 409', async () => {
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    vi.mocked(loadGroup).mockResolvedValueOnce({ attempts: 3 });
    expect((await call('POST', `/api/quizzes/${id}/load`)).body.summary).toEqual({ attempts: 3 });
    vi.mocked(loadGroup).mockRejectedValueOnce(new QuizError('BUSY', 'already loading'));
    expect((await call('POST', `/api/quizzes/${id}/load`)).status).toBe(409);
  });

  test('stats, tags, attempt links, candidates and delete', async () => {
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    expect((await call('GET', `/api/quizzes/${id}/stats`)).body.questions).toHaveLength(1);
    expect((await call('PUT', `/api/quizzes/${id}/tags`, { tags: { 1: ['AAP-1.A'] } })).body).toEqual({ updated: 1, unknownPositions: [] });
    expect((await call('GET', '/api/quizzes/attempt-links?assignment_id=900')).body).toEqual({ links: {} });
    expect((await call('GET', `/api/quizzes/candidates?course_id=${course}`)).body.tests.map(t => t.schoology_assignment_id)).toEqual(['901']);
    expect((await call('DELETE', `/api/quizzes/${id}`)).body).toEqual({ ok: true });
    expect((await call('GET', `/api/quizzes/${id}/stats`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/routes/quizzes.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the router, mount it, add client calls**

```js
// server/routes/quizzes.js
// Linked quizzes (docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md).
// Combining reads each test's question list through the browser session first,
// so a parity mismatch is refused before anything is stored.
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { featureGate } from '../middleware/featureGate.js';
import { QuizError } from '../services/quizError.js';
import {
  createGroup, linkResult, unlinkResult, deleteGroup, getGroup, listGroups, groupForAssignment,
  setQuestionTags, listCandidates, attemptLinks, attemptLinksForStudent,
} from '../services/quizGroups.js';
import { compareQuestionLists } from '../services/quizParity.js';
import { readQuestionLists, loadGroup } from '../services/quizLoader.js';
import { groupStats } from '../services/quizStats.js';

const router = Router();
router.use(featureGate('quizzes'));

const STATUS = { NOT_FOUND: 404, NOT_ELIGIBLE: 400, PARITY: 409, BUSY: 409, NO_SESSION: 503 };
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, getDb()));
  } catch (err) {
    if (err instanceof QuizError) {
      return res.status(STATUS[err.code] ?? 500).json({ error: err.message, code: err.code, differences: err.differences });
    }
    console.error('quizzes route failed:', err);
    res.status(500).json({ error: 'Quiz request failed' });
  }
};

router.get('/', handle((req, db) => ({ groups: listGroups(db, { courseId: req.query.course_id }) })));
router.get('/candidates', handle((req, db) => listCandidates(db, { courseId: req.query.course_id })));
router.get('/for-assignment/:ref', handle((req, db) => ({ group: groupForAssignment(db, req.params.ref) })));
router.get('/attempt-links', handle((req, db) => ({
  links: req.query.student_id
    ? attemptLinksForStudent(db, { studentId: req.query.student_id })
    : attemptLinks(db, { assignmentRef: req.query.assignment_id }),
})));

router.post('/check-parity', handle(async (req, db) => {
  const lists = await readQuestionLists(db, { assignmentRefs: req.body.assignment_ids || [] });
  return compareQuestionLists(lists);
}));

router.post('/', handle(async (req, db) => {
  const refs = req.body.assignment_ids || [];
  const lists = await readQuestionLists(db, { assignmentRefs: refs });
  return { group: createGroup(db, { courseId: req.body.course_id, assignmentRefs: refs, title: req.body.title, questionLists: lists }) };
}));

router.put('/:id/link', handle((req, db) => ({
  group: req.body.result_assignment_id == null
    ? unlinkResult(db, { groupId: req.params.id })
    : linkResult(db, { groupId: req.params.id, resultRef: req.body.result_assignment_id }),
})));

router.delete('/:id', handle((req, db) => { deleteGroup(db, { groupId: req.params.id }); return { ok: true }; }));

router.post('/:id/load', handle(async (req, db) => {
  const summary = await loadGroup(db, { groupId: req.params.id });
  return { summary, group: getGroup(db, req.params.id) };
}));

router.get('/:id/stats', handle((req, db) => groupStats(db, { groupId: req.params.id })));
router.put('/:id/tags', handle((req, db) => setQuestionTags(db, { groupId: req.params.id, tags: req.body.tags })));

export default router;
```

In `server/index.js`, add with the other route imports:

```js
import quizzesRouter from './routes/quizzes.js';
```

and after `app.use('/api/triage', triageRouter);`:

```js
app.use('/api/quizzes', quizzesRouter);
```

Append to `client/src/services/api.js`:

```js
// Linked quizzes (docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md).
export const getQuizGroups = (courseId) => request(`/quizzes?course_id=${courseId}`);
export const getQuizCandidates = (courseId) => request(`/quizzes/candidates?course_id=${courseId}`);
export const getQuizGroupFor = (assignmentRef) => request(`/quizzes/for-assignment/${assignmentRef}`);
export const checkQuizParity = (assignmentIds) => request('/quizzes/check-parity', { method: 'POST', body: JSON.stringify({ assignment_ids: assignmentIds }) });
export const createQuizGroup = ({ courseId, assignmentIds, title }) =>
  request('/quizzes', { method: 'POST', body: JSON.stringify({ course_id: courseId, assignment_ids: assignmentIds, title }) });
export const linkQuizResult = (groupId, resultAssignmentId) =>
  request(`/quizzes/${groupId}/link`, { method: 'PUT', body: JSON.stringify({ result_assignment_id: resultAssignmentId }) });
export const deleteQuizGroup = (groupId) => request(`/quizzes/${groupId}`, { method: 'DELETE' });
export const loadQuizResults = (groupId) => request(`/quizzes/${groupId}/load`, { method: 'POST' });
export const getQuizStats = (groupId) => request(`/quizzes/${groupId}/stats`);
export const setQuizTags = (groupId, tags) => request(`/quizzes/${groupId}/tags`, { method: 'PUT', body: JSON.stringify({ tags }) });
export const getAttemptLinks = ({ assignmentId, studentId }) =>
  request(`/quizzes/attempt-links?${studentId ? `student_id=${studentId}` : `assignment_id=${assignmentId}`}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/routes/quizzes.test.js server/index.test.js server/copy.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/quizzes.js server/routes/quizzes.test.js server/index.js client/src/services/api.js
git commit -m "feat(quizzes): /api/quizzes router and client calls"
```

---

### Task 11: PrisMCP tools

**Files:**
- Modify: `mcp/handlers.js` (append three handlers)
- Modify: `mcp/server.js` (import, register three tools, extend `INSTRUCTIONS`)
- Test: `mcp/handlers.test.js` (append a `describe` block), `mcp/server.test.js` (append one test)

**Interfaces:**
- Consumes: `resolveCourseRef(db, ref) → course id` (existing in `mcp/handlers.js`), Tasks 6, 8 and 9.
- Produces: `listQuizGroupsTool(db, { course })`, `loadQuizResultsTool(db, { group_id }, deps?)`, `setQuestionTagsTool(db, { group_id, tags })`; MCP tools `list_quiz_groups`, `load_quiz_results`, `set_question_tags`.

- [ ] **Step 1: Write the failing tests**

Append to `mcp/handlers.test.js` (add `quiz_*` tables to the `beforeEach` `DELETE` list at the front: `DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups;`, and import the three handlers from `./handlers.js`):

```js
describe('quiz tools', () => {
  function seedQuiz() {
    const db = getDb();
    const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('8458134135', 'AP CSP')`).run().lastInsertRowid;
    const t = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'Ep 1 Theory Test', 1)`).run(c).lastInsertRowid;
    const g = db.prepare(`INSERT INTO quiz_groups (course_id, title) VALUES (?, 'Ep 1 Theory Test')`).run(c).lastInsertRowid;
    db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)').run(g, t);
    db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points) VALUES (?, 1, 'mcq', 'Q', 1)`).run(g);
    return { c, g };
  }

  test('list_quiz_groups by course id or course name', () => {
    const { c, g } = seedQuiz();
    expect(listQuizGroupsTool(getDb(), { course: c }).map(x => x.id)).toEqual([g]);
    expect(listQuizGroupsTool(getDb(), { course: 'AP CSP' })[0].members[0].schoology_assignment_id).toBe('900');
  });

  test('set_question_tags', () => {
    const { g } = seedQuiz();
    expect(setQuestionTagsTool(getDb(), { group_id: g, tags: { 1: ['CRD-2.G'] } })).toEqual({ updated: 1, unknownPositions: [] });
  });

  test('load_quiz_results returns the loader summary, or the error code as text', async () => {
    const { g } = seedQuiz();
    const ok = await loadQuizResultsTool(getDb(), { group_id: g }, { loadGroup: async () => ({ attempts: 2 }) });
    expect(ok).toEqual({ summary: { attempts: 2 } });
    const bad = await loadQuizResultsTool(getDb(), { group_id: g }, { loadGroup: async () => { throw Object.assign(new Error('No saved Schoology session'), { code: 'NO_SESSION' }); } });
    expect(bad).toEqual({ error: 'NO_SESSION: No saved Schoology session' });
  });
});
```

Append to `mcp/server.test.js` (inside its main `describe`, using its existing `client` from `beforeEach`):

```js
  test('lists the quiz tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['list_quiz_groups', 'load_quiz_results', 'set_question_tags']));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run mcp/handlers.test.js mcp/server.test.js`
Expected: FAIL (`listQuizGroupsTool` is not exported; tools missing).

- [ ] **Step 3: Write the handlers and register the tools**

Append to `mcp/handlers.js` (add the imports to the import block at the top):

```js
import { listGroups, setQuestionTags } from '../server/services/quizGroups.js';
import { loadGroup } from '../server/services/quizLoader.js';
```

```js
// Linked quizzes (spec 2026-10-12). Combining and linking stay in Prism's UI in v1.
export function listQuizGroupsTool(db, { course }) {
  return listGroups(db, { courseId: resolveCourseRef(db, course) });
}

export async function loadQuizResultsTool(db, { group_id }, deps = { loadGroup }) {
  try {
    return { summary: await deps.loadGroup(db, { groupId: group_id }) };
  } catch (err) {
    return { error: `${err.code || 'ERROR'}: ${err.message}` };
  }
}

export function setQuestionTagsTool(db, { group_id, tags }) {
  return setQuestionTags(db, { groupId: group_id, tags });
}
```

`resolveCourseRef` (existing, `mcp/handlers.js`) returns the local course id for a local id or a course name or code fragment, and throws on an unknown or ambiguous ref.

In `mcp/server.js`, add `listQuizGroupsTool, loadQuizResultsTool, setQuestionTagsTool` to the `./handlers.js` import, append to `INSTRUCTIONS`:

```js
  ' Also linked quizzes: per-question results of Schoology tests that Prism combined, and tags per question.';
```

(join it to the existing string with `+`), and register after `write_assessment_analysis`:

```js
  server.registerTool(
    'list_quiz_groups',
    {
      description: 'List the quiz groups in a course: each is one or more Schoology tests Prism treats as one quiz, with its member tests, the linked result task (if any), parity status and when results were last loaded.',
      inputSchema: { course: z.union([z.number(), z.string()]).describe('Local course id, or a course name or code fragment') },
    },
    async ({ course }) => ({ content: [{ type: 'text', text: JSON.stringify(listQuizGroupsTool(getDb(), { course })) }] })
  );

  server.registerTool(
    'load_quiz_results',
    {
      description: 'Read every attempt of a quiz group from Schoology through the saved browser session (read-only; about a minute for a class). Returns counts: attempts, not taken, failed students, unknown students, copy mismatches, students with several attempts.',
      inputSchema: { group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups') },
    },
    async ({ group_id }) => ({ content: [{ type: 'text', text: JSON.stringify(await loadQuizResultsTool(getDb(), { group_id })) }] })
  );

  server.registerTool(
    'set_question_tags',
    {
      description: 'Set free-text tags on a quiz group\'s questions by question number, for example College Board codes from the test\'s Codes.csv: { "1": ["CRD-2.G"], "2": ["AAP-1.A", "AAP-1.B"] }. Replaces each listed question\'s tags.',
      inputSchema: {
        group_id: z.union([z.number(), z.string()]),
        tags: z.record(z.string(), z.array(z.string())).describe('{ question number: [tag, ...] }'),
      },
    },
    async ({ group_id, tags }) => ({ content: [{ type: 'text', text: JSON.stringify(setQuestionTagsTool(getDb(), { group_id, tags })) }] })
  );
```

Update the tool list in `docs/prismcp-install-and-verify.md` ("Surface: tools ...") with the three names.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run mcp/`
Expected: PASS (including `mcp/copy.test.js`: no em dashes).

- [ ] **Step 5: Commit**

```bash
git add mcp/handlers.js mcp/server.js mcp/handlers.test.js mcp/server.test.js docs/prismcp-install-and-verify.md
git commit -m "feat(mcp): list_quiz_groups, load_quiz_results, set_question_tags"
```

---

### Task 12: Attempt link on the three feedback surfaces

**Files:**
- Create: `client/src/components/quiz/AttemptLink.jsx`
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (load links; pass to `StudentRubricCard`; render beside the status pill)
- Modify: `client/src/pages/CoursePage.jsx` (`RubricModal`: fetch and render)
- Modify: `client/src/pages/StudentPage.jsx` (`StudentPage` loads links by student; `CourseSection` renders them)
- Test: `client/src/components/quiz/AttemptLink.test.jsx`; extend `client/src/pages/AssessmentSummaryPage.test.jsx`

**Interfaces:**
- Consumes: `getAttemptLinks` (Task 10), `SchoologyLink`, `formatDateTime`.
- Produces: `<AttemptLink link={{url, completedAt}} name="Student Name" />` (renders nothing when `link` is null).

- [ ] **Step 1: Write the failing tests**

```jsx
// client/src/components/quiz/AttemptLink.test.jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AttemptLink from './AttemptLink.jsx';

describe('AttemptLink', () => {
  it('links to the attempt, labelled "Attempt", with the completion time in the tooltip', () => {
    render(<AttemptLink link={{ url: 'https://schoology.hkis.edu.hk/assignment/9/assessment_results/student_stats/1/2', completedAt: '2026-10-09 09:31' }} name="Ada Lovelace" />);
    const a = screen.getByRole('link', { name: "Attempt: open Ada Lovelace's test attempt in Schoology" });
    expect(a.getAttribute('href')).toContain('/student_stats/1/2');
    expect(a.getAttribute('title')).toMatch(/09\/10\/2026/);
  });
  it('renders nothing without a link', () => {
    const { container } = render(<AttemptLink link={null} name="Ada" />);
    expect(container.innerHTML).toBe('');
  });
});
```

In `client/src/pages/AssessmentSummaryPage.test.jsx`, add `getAttemptLinks: vi.fn().mockResolvedValue({ links: {} })` and `getQuizGroupFor: vi.fn().mockResolvedValue({ group: null })` to the `vi.mock('../services/api.js', ...)` object, import `getAttemptLinks`, and add this test beside the existing page-level tests (reuse that file's existing render helper and mastery fixture for one student, here called `renderPage()` and student id `1`; match the names used in the file):

```jsx
  it('shows an Attempt link beside the status pill when the student has a test attempt', async () => {
    getAttemptLinks.mockResolvedValueOnce({ links: { 1: { url: 'https://schoology.hkis.edu.hk/assignment/9/assessment_results/student_stats/u/2', completedAt: '2026-10-09 09:31' } } });
    renderPage();
    expect(await screen.findByRole('link', { name: /^Attempt: open .* test attempt in Schoology$/ })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && npx vitest run src/components/quiz/AttemptLink.test.jsx src/pages/AssessmentSummaryPage.test.jsx`
Expected: FAIL (module not found; link missing).

- [ ] **Step 3: Write the component and wire it in**

```jsx
// client/src/components/quiz/AttemptLink.jsx
// The student's attempt on a Schoology test, beside the submission-status pill
// (the #120 "Open" pattern): one outbound link, short label, detail on hover.
// Used on the assessment page cards, the gradebook modal and the student page.
import SchoologyLink from '../SchoologyLink.jsx';
import { formatDateTime } from '../../lib/formatDate.js';

export default function AttemptLink({ link, name }) {
  if (!link?.url) return null;
  const when = link.completedAt ? `: completed ${formatDateTime(link.completedAt.replace(' ', 'T'))}` : '';
  return (
    <SchoologyLink
      url={link.url}
      label="Attempt"
      ariaLabel={`Attempt: open ${name}'s test attempt in Schoology`}
      title={`Open ${name}'s test attempt in Schoology${when}`}
      style={{ fontSize: '0.78rem', fontWeight: 600 }}
    />
  );
}
```

`AssessmentSummaryPage.jsx`:
1. Import `getAttemptLinks` from `../services/api.js` and `AttemptLink from '../components/quiz/AttemptLink.jsx'`.
2. In `AssessmentSummaryPage`, beside the `workLinks` state:

```jsx
  // Each student's attempt on a linked or combined Schoology test (linked quizzes, phase 1).
  const [attemptLinks, setAttemptLinks] = useState({});
  useEffect(() => {
    let active = true;
    getAttemptLinks({ assignmentId }).then(r => { if (active) setAttemptLinks(r.links || {}); }).catch(() => {});
    return () => { active = false; };
  }, [assignmentId, dataVersion]);
```

3. Pass `attemptLink={attemptLinks[student.id] || null}` to `<StudentRubricCard ... />`, add `attemptLink = null` to the `StudentRubricCard` props, and render after the OneDrive `SchoologyLink` block (beside `<SubmissionStatusPill ... />`):

```jsx
        <AttemptLink link={attemptLink} name={displayName(student)} />
```

`CoursePage.jsx`, in `RubricModal`: import `getAttemptLinks` and `AttemptLink`; add

```jsx
  const [attemptLink, setAttemptLink] = useState(null);
  useEffect(() => {
    let active = true;
    getAttemptLinks({ assignmentId: assignment.schoology_assignment_id })
      .then(r => { if (active) setAttemptLink(r.links?.[student.id] || null); })
      .catch(() => {});
    return () => { active = false; };
  }, [assignment.schoology_assignment_id, student.id]);
```

include `|| !!attemptLink` in `hasBadges`, and render `<AttemptLink link={attemptLink} name={fullName} />` right after the `{workLink && (...)}` block.

`StudentPage.jsx`: in `StudentPage`, load `getAttemptLinks({ studentId: id })` into `attemptLinks` state (same effect pattern, keyed on `id`), pass `attemptLinks` to each `<CourseSection ... />`; in `CourseSection`, add the `attemptLinks = {}` prop and render `<AttemptLink link={attemptLinks[g.schoology_assignment_id] || null} name={studentName} />` inside `infoCell`, after the status badges, where `studentName` is the name already shown at the top of the page (pass it down as a prop if `CourseSection` does not have it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && npx vitest run src/components/quiz/AttemptLink.test.jsx src/pages/AssessmentSummaryPage.test.jsx src/pages/CoursePage.rubricModal.test.jsx src/pages/StudentPage.test.jsx`
Expected: PASS. If `CoursePage.rubricModal.test.jsx` or `StudentPage.test.jsx` mock `../services/api.js` with a closed object, add `getAttemptLinks: vi.fn().mockResolvedValue({ links: {} })` to those mocks.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/quiz/AttemptLink.jsx client/src/components/quiz/AttemptLink.test.jsx client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx client/src/pages/CoursePage.jsx client/src/pages/StudentPage.jsx client/src/pages/CoursePage.rubricModal.test.jsx client/src/pages/StudentPage.test.jsx
git commit -m "feat(quizzes): link each student's test attempt from the three feedback views"
```

---

### Task 13: Quiz setup modal

**Files:**
- Create: `client/src/components/quiz/QuizSetupModal.jsx`
- Test: `client/src/components/quiz/QuizSetupModal.test.jsx`

**Interfaces:**
- Consumes: `getQuizCandidates`, `checkQuizParity`, `createQuizGroup`, `linkQuizResult`, `deleteQuizGroup` (Task 10).
- Produces: `<QuizSetupModal open courseId currentAssignment={{schoology_assignment_id, title}} group={group|null} onClose onChanged={(group|null) => void} />`.

Behavior:
- **No group yet:** a checklist of candidate tests (the current test ticked and its `suggestedWith` tests ticked by default), a title field (default: the current test's title), **Check questions** (calls `checkQuizParity`), the result ("Same questions" or a list per test of missing and extra stems), and **Combine** (enabled only after a passing check of the ticked set). A single ticked test needs no check.
- **Group exists:** its members, a **Link result task** select listing `summatives` (plus the linked one), **Unlink**, and **Remove quiz group** (confirmation step in the modal: "Remove the quiz group? Loaded results are removed; Schoology is not changed.").

- [ ] **Step 1: Write the failing test**

```jsx
// client/src/components/quiz/QuizSetupModal.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import QuizSetupModal from './QuizSetupModal.jsx';
import { getQuizCandidates, checkQuizParity, createQuizGroup, linkQuizResult } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getQuizCandidates: vi.fn(), checkQuizParity: vi.fn(), createQuizGroup: vi.fn(), linkQuizResult: vi.fn(), deleteQuizGroup: vi.fn(),
}));

const CANDIDATES = {
  tests: [
    { id: 1, schoology_assignment_id: '900', title: 'Ep 1 Theory Test', suggestedWith: ['901'] },
    { id: 2, schoology_assignment_id: '901', title: 'Ep 1 Theory Test *', suggestedWith: ['900'] },
  ],
  summatives: [{ id: 3, schoology_assignment_id: '950', title: 'Ep 1 Theory Test - Result (S)' }],
};

beforeEach(() => { vi.clearAllMocks(); getQuizCandidates.mockResolvedValue(CANDIDATES); });

describe('QuizSetupModal', () => {
  it('ticks the suggested copy, checks parity, then combines', async () => {
    checkQuizParity.mockResolvedValue({ ok: true, differences: [] });
    createQuizGroup.mockResolvedValue({ group: { id: 7 } });
    const onChanged = vi.fn();
    render(<QuizSetupModal open courseId={5} currentAssignment={{ schoology_assignment_id: '900', title: 'Ep 1 Theory Test' }} group={null} onClose={() => {}} onChanged={onChanged} />);
    expect(await screen.findByRole('checkbox', { name: 'Ep 1 Theory Test *' })).toBeChecked();
    const combine = screen.getByRole('button', { name: 'Combine' });
    expect(combine).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check questions' }));
    expect(await screen.findByText('Same questions')).toBeInTheDocument();
    fireEvent.click(combine);
    await waitFor(() => expect(createQuizGroup).toHaveBeenCalledWith({ courseId: 5, assignmentIds: ['900', '901'], title: 'Ep 1 Theory Test' }));
    expect(onChanged).toHaveBeenCalledWith({ id: 7 });
  });

  it('a mismatch lists the differing questions and keeps Combine disabled', async () => {
    checkQuizParity.mockResolvedValue({ ok: false, differences: [{ assignmentId: 2, title: 'Ep 1 Theory Test *', missing: ['Which is true?'], extra: ['Which is false?'] }] });
    render(<QuizSetupModal open courseId={5} currentAssignment={{ schoology_assignment_id: '900', title: 'Ep 1 Theory Test' }} group={null} onClose={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check questions' }));
    expect(await screen.findByText(/Which is false\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Combine' })).toBeDisabled();
  });

  it('links a result task for an existing group', async () => {
    linkQuizResult.mockResolvedValue({ group: { id: 7, result: { schoology_assignment_id: '950' } } });
    const group = { id: 7, title: 'Ep 1 Theory Test', result: null, members: [{ id: 1, schoology_assignment_id: '900', title: 'Ep 1 Theory Test' }] };
    render(<QuizSetupModal open courseId={5} currentAssignment={{ schoology_assignment_id: '900', title: 'Ep 1 Theory Test' }} group={group} onClose={() => {}} onChanged={() => {}} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Result task' }), { target: { value: '950' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(linkQuizResult).toHaveBeenCalledWith(7, '950'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/components/quiz/QuizSetupModal.test.jsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the component**

```jsx
// client/src/components/quiz/QuizSetupModal.jsx
// Combine tests into a quiz group and link it to an aligned result task
// (docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md §8). Prism
// suggests tests with similar titles; the teacher confirms every combine, and a
// parity check of the ticked tests must pass first.
import { useEffect, useState } from 'react';
import { getQuizCandidates, checkQuizParity, createQuizGroup, linkQuizResult, deleteQuizGroup } from '../../services/api.js';

export default function QuizSetupModal({ open, courseId, currentAssignment, group, onClose, onChanged }) {
  const [candidates, setCandidates] = useState(null);
  const [ticked, setTicked] = useState([]);
  const [title, setTitle] = useState(currentAssignment?.title || '');
  const [parity, setParity] = useState(null); // { ok, differences, forKey }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [resultId, setResultId] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null); setParity(null); setConfirmRemove(false);
    getQuizCandidates(courseId).then((c) => {
      setCandidates(c);
      const me = c.tests.find(t => t.schoology_assignment_id === currentAssignment?.schoology_assignment_id);
      setTicked(me ? [me.schoology_assignment_id, ...me.suggestedWith] : []);
    }).catch((e) => setError(e.message));
  }, [open, courseId, currentAssignment?.schoology_assignment_id]);

  if (!open) return null;
  const key = [...ticked].sort().join(',');
  const canCombine = ticked.length === 1 || (parity?.ok && parity.forKey === key);

  async function run(fn) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const toggle = (sid) => setTicked(t => (t.includes(sid) ? t.filter(x => x !== sid) : [...t, sid]));

  return (
    <div role="dialog" aria-label="Quiz setup" className="modal-backdrop" onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, width: '100%', maxHeight: '85vh', overflow: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Quiz setup</h3>
        {error && <div className="alert alert-warning">{error}</div>}

        {!group && candidates && (
          <>
            <p className="text-sm text-muted">Tick the tests to treat as one quiz, for example a standard and an extra-time copy.</p>
            {candidates.tests.map(t => (
              <label key={t.schoology_assignment_id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.2rem 0' }}>
                <input type="checkbox" checked={ticked.includes(t.schoology_assignment_id)} onChange={() => toggle(t.schoology_assignment_id)} aria-label={t.title} />
                {t.title}
              </label>
            ))}
            <label className="text-sm" style={{ display: 'block', marginTop: '0.75rem' }}>
              Quiz name <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%' }} />
            </label>
            {ticked.length > 1 && (
              <button className="secondary" disabled={busy} style={{ marginTop: '0.75rem' }}
                onClick={() => run(async () => setParity({ ...(await checkQuizParity(ticked)), forKey: key }))}>
                Check questions
              </button>
            )}
            {parity && parity.forKey === key && (parity.ok
              ? <div className="alert alert-success" style={{ marginTop: '0.5rem' }}>Same questions</div>
              : (
                <div className="alert alert-warning" style={{ marginTop: '0.5rem' }}>
                  These tests have different questions, so they cannot be combined.
                  {parity.differences.map(d => (
                    <div key={d.assignmentId} style={{ marginTop: '0.4rem' }}>
                      <strong>{d.title}</strong>
                      {d.missing.map((m, i) => <div key={`m${i}`}>Missing: {m}</div>)}
                      {d.extra.map((x, i) => <div key={`x${i}`}>Extra: {x}</div>)}
                    </div>
                  ))}
                </div>
              ))}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="primary" disabled={busy || !canCombine || !ticked.length}
                onClick={() => run(async () => { const r = await createQuizGroup({ courseId, assignmentIds: ticked, title }); onChanged(r.group); })}>
                Combine
              </button>
              <button className="ghost" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {group && (
          <>
            <p className="text-sm"><strong>{group.title}</strong>: {group.members.map(m => m.title).join(', ')}</p>
            <label className="text-sm" style={{ display: 'block' }}>
              Result task{' '}
              <select aria-label="Result task" value={resultId || group.result?.schoology_assignment_id || ''} onChange={(e) => setResultId(e.target.value)}>
                <option value="">Not linked</option>
                {group.result && <option value={group.result.schoology_assignment_id}>{group.result.title}</option>}
                {(candidates?.summatives || []).map(s => <option key={s.schoology_assignment_id} value={s.schoology_assignment_id}>{s.title}</option>)}
              </select>
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
              <button className="primary" disabled={busy || !resultId}
                onClick={() => run(async () => onChanged((await linkQuizResult(group.id, resultId)).group))}>Link</button>
              {group.result && (
                <button className="secondary" disabled={busy}
                  onClick={() => run(async () => onChanged((await linkQuizResult(group.id, null)).group))}>Unlink</button>
              )}
              {!confirmRemove
                ? <button className="ghost danger" onClick={() => setConfirmRemove(true)}>Remove quiz group</button>
                : (
                  <span className="text-sm">
                    Remove the quiz group? Loaded results are removed; Schoology is not changed.{' '}
                    <button className="ghost danger" disabled={busy}
                      onClick={() => run(async () => { await deleteQuizGroup(group.id); onChanged(null); })}>Remove</button>
                  </span>
                )}
              <button className="ghost" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/components/quiz/QuizSetupModal.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/quiz/QuizSetupModal.jsx client/src/components/quiz/QuizSetupModal.test.jsx
git commit -m "feat(quizzes): quiz setup modal (combine with parity check, link result task)"
```

---

### Task 14: Questions tab

**Files:**
- Create: `client/src/components/quiz/QuestionsTab.jsx`
- Test: `client/src/components/quiz/QuestionsTab.test.jsx`

**Interfaces:**
- Consumes: `getQuizStats`, `setQuizTags` (Task 10); stats shape (Task 9).
- Produces: `<QuestionsTab groupId reloadKey />` (refetches when `reloadKey` changes).

Layout (classes and tokens only; no hex): a summary line (takers, split by member; MCQ median), a "By tag" table (lowest first), a "By type" table, then the question list. Each question row: `Q{n}`, kind, tag chips (click **Edit tags** to edit a comma-separated field, saved with `setQuizTags`), the plain stem (first 120 characters), a facility bar (`var(--accent)` fill on `var(--bg-subtle)`), percent and band, option counts with the key marked `✓`, and flags. Rows expand (button `aria-expanded`) to show the stem and options as HTML (`dangerouslySetInnerHTML`; the HTML is Schoology's own question text). A "Lowest first" toggle (`.filter-btn`) sorts MCQs by facility.

- [ ] **Step 1: Write the failing test**

```jsx
// client/src/components/quiz/QuestionsTab.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import QuestionsTab from './QuestionsTab.jsx';
import { getQuizStats, setQuizTags } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({ getQuizStats: vi.fn(), setQuizTags: vi.fn() }));

const STATS = {
  takers: 18, classSize: 19,
  byMember: [{ schoology_assignment_id: '900', title: 'Ep 1', takers: 16 }, { schoology_assignment_id: '901', title: 'Ep 1 *', takers: 2 }],
  mcq: { count: 20, median_percent: 80 },
  frq: { count: 1, levels: [{ name: 'Exhibiting', count: 8 }, { name: 'Developing', count: 5 }] },
  byTag: [{ tag: 'CRD-2.G', positions: [4], correct: 10, total: 18, percent: 56 }],
  questions: [
    { position: 1, kind: 'mcq', stem_html: '<p>Easy one</p>', tags: [], total: 18, correct: 18, facility: 1, band: 'Strong', blank: 0,
      options: [{ letter: 'A', html: 'a', count: 18, is_key: true }, { letter: 'B', html: 'b', count: 0, is_key: false }], flags: [{ level: 'note', text: 'Nobody missed it.' }] },
    { position: 4, kind: 'mcq', stem_html: '<p>Hard one</p>', tags: ['CRD-2.G'], total: 18, correct: 10, facility: 0.556, band: 'Divided', blank: 0,
      options: [{ letter: 'A', html: 'a', count: 2, is_key: false }, { letter: 'B', html: 'b', count: 10, is_key: true }, { letter: 'C', html: 'c', count: 6, is_key: false }], flags: [] },
    { position: 21, kind: 'frq', stem_html: '<p>Explain</p>', tags: [], total: 18, correct: null, facility: null, band: null, blank: 0, options: [], flags: [] },
  ],
};

beforeEach(() => { vi.clearAllMocks(); getQuizStats.mockResolvedValue(STATS); });

describe('QuestionsTab', () => {
  it('shows takers, the MCQ median, the tag rollup and FRQ levels', async () => {
    render(<QuestionsTab groupId={7} />);
    expect(await screen.findByText(/Takers 18 of 19/)).toBeInTheDocument();
    expect(screen.getByText(/MCQ median 80%/)).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'By tag' })).getByText('56%')).toBeInTheDocument();
    expect(screen.getByText(/Exhibiting 8, Developing 5/)).toBeInTheDocument();
  });

  it('lists questions by number; "Lowest first" sorts MCQs by facility', async () => {
    render(<QuestionsTab groupId={7} />);
    const rows = await screen.findAllByTestId('question-row');
    expect(rows.map(r => r.dataset.position)).toEqual(['1', '4', '21']);
    fireEvent.click(screen.getByRole('button', { name: 'Lowest first' }));
    expect(screen.getAllByTestId('question-row').map(r => r.dataset.position)).toEqual(['4', '1', '21']);
  });

  it('shows option counts with the key marked, and flags', async () => {
    render(<QuestionsTab groupId={7} />);
    const row = (await screen.findAllByTestId('question-row'))[1];
    expect(within(row).getByText('B 10 ✓')).toBeInTheDocument();
    expect(within(row).getByText('Divided')).toBeInTheDocument();
    expect(within((await screen.findAllByTestId('question-row'))[0]).getByText('Nobody missed it.')).toBeInTheDocument();
  });

  it('edits tags', async () => {
    setQuizTags.mockResolvedValue({ updated: 1, unknownPositions: [] });
    render(<QuestionsTab groupId={7} />);
    const row = (await screen.findAllByTestId('question-row'))[0];
    fireEvent.click(within(row).getByRole('button', { name: 'Edit tags' }));
    fireEvent.change(within(row).getByRole('textbox', { name: 'Tags for question 1' }), { target: { value: 'AAP-1.A, AAP-1.B' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save tags' }));
    await waitFor(() => expect(setQuizTags).toHaveBeenCalledWith(7, { 1: ['AAP-1.A', 'AAP-1.B'] }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/components/quiz/QuestionsTab.test.jsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the component**

```jsx
// client/src/components/quiz/QuestionsTab.jsx
// Per-question statistics for a quiz group (spec §8). Counts, percentages, bands
// and distractor flags only; no discrimination statistics.
import { useEffect, useState } from 'react';
import { getQuizStats, setQuizTags } from '../../services/api.js';

const plain = (html) => {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
};
const FLAG_CLASS = { critical: 'badge badge-red', warning: 'badge badge-amber', note: 'badge' };

function QuestionRow({ q, groupId, onTagsSaved }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(q.tags.join(', '));
  const pct = q.facility == null ? null : Math.round(q.facility * 100);
  async function saveTags() {
    const tags = draft.split(',').map(t => t.trim()).filter(Boolean);
    await setQuizTags(groupId, { [q.position]: tags });
    setEditing(false);
    onTagsSaved();
  }
  return (
    <div data-testid="question-row" data-position={q.position} style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="ghost" aria-expanded={open} onClick={() => setOpen(o => !o)} style={{ fontWeight: 700 }}>Q{q.position}</button>
        <span className="text-sm text-muted">{q.kind === 'mcq' ? 'MCQ' : q.kind === 'frq' ? 'FRQ' : 'Other'}</span>
        {q.tags.map(t => <span key={t} className="badge">{t}</span>)}
        {!editing && <button className="ghost" onClick={() => setEditing(true)} style={{ fontSize: '0.75rem' }}>Edit tags</button>}
        {editing && (
          <>
            <input aria-label={`Tags for question ${q.position}`} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button className="secondary" onClick={saveTags}>Save tags</button>
          </>
        )}
        <span className="text-sm" style={{ flex: 1, minWidth: 160 }}>{plain(q.stem_html).slice(0, 120)}</span>
        {pct != null && (
          <>
            <span aria-hidden="true" style={{ width: 90, height: 8, borderRadius: 4, background: 'var(--bg-subtle)', overflow: 'hidden', display: 'inline-block' }}>
              <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: 'var(--accent)' }} />
            </span>
            <span className="text-sm">{pct}%</span>
            <span className="badge">{q.band}</span>
          </>
        )}
      </div>
      {q.options.length > 0 && (
        <div className="text-sm" style={{ display: 'flex', gap: '0.9rem', marginTop: '0.3rem', marginLeft: '2.5rem' }}>
          {q.options.map(o => <span key={o.letter} style={o.is_key ? { fontWeight: 700 } : undefined}>{`${o.letter} ${o.count}${o.is_key ? ' ✓' : ''}`}</span>)}
        </div>
      )}
      {q.flags.length > 0 && (
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.3rem', marginLeft: '2.5rem' }}>
          {q.flags.map(f => <span key={f.text} className={FLAG_CLASS[f.level]}>{f.text}</span>)}
        </div>
      )}
      {open && (
        <div style={{ marginTop: '0.5rem', marginLeft: '2.5rem' }}>
          <div className="s-rte" dangerouslySetInnerHTML={{ __html: q.stem_html }} />
          {q.options.map(o => (
            <div key={o.letter} style={{ display: 'flex', gap: '0.5rem' }}>
              <strong>{o.letter}</strong><span dangerouslySetInnerHTML={{ __html: o.html }} /><span className="text-muted">{o.count}{o.is_key ? ' ✓' : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function QuestionsTab({ groupId, reloadKey }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [lowestFirst, setLowestFirst] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    getQuizStats(groupId).then(s => { if (active) setStats(s); }).catch(e => setError(e.message));
    return () => { active = false; };
  }, [groupId, reloadKey, version]);

  if (error) return <div className="alert alert-warning">{error}</div>;
  if (!stats) return <div className="loading">Loading...</div>;
  if (!stats.takers) return <div className="card"><p className="text-muted">No results loaded yet. Use Load results above.</p></div>;

  const questions = [...stats.questions];
  if (lowestFirst) {
    questions.sort((a, b) => (a.facility ?? 2) - (b.facility ?? 2) || a.position - b.position);
  }
  const split = stats.byMember.length > 1 ? ` (${stats.byMember.map(m => `${m.title} ${m.takers}`).join(', ')})` : '';

  return (
    <div className="fade-in">
      <div className="card">
        <p style={{ margin: 0 }}>
          Takers {stats.takers} of {stats.classSize}{split}
          {stats.mcq.median_percent != null && <span>, MCQ median {stats.mcq.median_percent}%</span>}
        </p>
        <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
          {stats.byTag.length > 0 && (
            <table aria-label="By tag" className="text-sm">
              <thead><tr><th>Tag</th><th>Questions</th><th>Correct</th><th>%</th></tr></thead>
              <tbody>{stats.byTag.map(t => (
                <tr key={t.tag}><td>{t.tag}</td><td>{t.positions.map(p => `Q${p}`).join(' ')}</td><td>{t.correct}/{t.total}</td><td>{t.percent}%</td></tr>
              ))}</tbody>
            </table>
          )}
          <table aria-label="By type" className="text-sm">
            <thead><tr><th>Type</th><th>Result</th></tr></thead>
            <tbody>
              {stats.mcq.count > 0 && <tr><td>MCQ ({stats.mcq.count})</td><td>median {stats.mcq.median_percent}%</td></tr>}
              {stats.frq.count > 0 && <tr><td>FRQ ({stats.frq.count})</td><td>{stats.frq.levels.map(l => `${l.name} ${l.count}`).join(', ')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)' }}>
          <button className={`filter-btn${lowestFirst ? ' active' : ''}`} onClick={() => setLowestFirst(v => !v)}>Lowest first</button>
        </div>
        {questions.map(q => <QuestionRow key={q.position} q={q} groupId={groupId} onTagsSaved={() => setVersion(v => v + 1)} />)}
      </div>
    </div>
  );
}
```

`badge-red` and `badge-amber` are existing classes in `client/src/app.css` (backed by the `--badge-red-*` / `--badge-amber-*` tokens).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/components/quiz/QuestionsTab.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/quiz/QuestionsTab.jsx client/src/components/quiz/QuestionsTab.test.jsx
git commit -m "feat(quizzes): Questions tab with tags, bands and distractor counts"
```

---

### Task 15: Assessment page and course list wiring

**Files:**
- Create: `client/src/hooks/useQuizGroup.js`, `client/src/components/quiz/QuizChip.jsx`
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (header chip, Load results, Quiz setup, tabs, redirect)
- Modify: `client/src/pages/CoursePage.jsx` (`AssessmentsView`: chip and folding)
- Test: `client/src/pages/AssessmentSummaryPage.quiz.test.jsx`, `client/src/pages/CoursePage.quiz.test.jsx`

**Interfaces:**
- Consumes: `getQuizGroupFor`, `getQuizGroups`, `loadQuizResults` (Task 10); `QuizSetupModal` (Task 13); `QuestionsTab` (Task 14); `useStickyTab`.
- Produces: `useQuizGroup(assignmentId) → { group, setGroup, enabled }` (`enabled` false when `/api/features` reports `quizzes` off); `<QuizChip group courseId />`.

Page behavior:
- **Header** (only when `enabled` and the assignment is a test or has a group): **Quiz setup…** button (opens the modal). With a group: the chip (members and result task), **Load results** with "loaded {formatDateTime}" or "not loaded", and a load result line ("18 attempts loaded, 1 failed").
- **Redirect:** when `group` exists and `group.canonical_schoology_id !== assignmentId`, render `<Navigate replace to={`/course/${courseId}/assessment/${group.canonical_schoology_id}${location.search}`} />`.
- **Tabs:** when a group exists, `.tab-btn` buttons **Grading** and **Questions** under the header; state through `useStickyTab('assessment-quiz', 'grading', { param: 'tab' })`. **Questions** renders `<QuestionsTab groupId={group.id} reloadKey={group.loaded_at} />` in place of the student cards.
- **Course list:** `AssessmentsView` fetches `getQuizGroups(courseId)`; member tests that are not the canonical assignment are hidden from the list; the canonical row shows `<QuizChip>` after its title.

- [ ] **Step 1: Write the failing tests**

```jsx
// client/src/pages/AssessmentSummaryPage.quiz.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AssessmentSummaryPage from './AssessmentSummaryPage.jsx';
import { getQuizGroupFor, loadQuizResults, getMasteryForAssignment } from '../services/api.js';

vi.mock('../lib/assessmentDraftSaver.js', () => ({ makeDraftSaver: () => ({ save: vi.fn(), remove: vi.fn(), flush: vi.fn(), dispose: vi.fn() }) }));
vi.mock('../components/quiz/QuestionsTab.jsx', () => ({ default: ({ groupId }) => <div>Questions for group {groupId}</div> }));
vi.mock('../services/api.js', () => ({
  getMasteryForAssignment: vi.fn(),
  getSubmissionLinks: vi.fn().mockResolvedValue({ status: 'not_lti', links: {} }),
  setSuggestionState: vi.fn(), getFeedbackForAssignment: vi.fn().mockResolvedValue({}), getAssessmentAnalysis: vi.fn().mockResolvedValue(null),
  getDraftsForAssignment: vi.fn().mockResolvedValue({}), syncMasteryForAssignment: vi.fn(), writeMasteryScores: vi.fn(), writeMasteryComment: vi.fn(),
  sendAllGrades: vi.fn(), createFlag: vi.fn(), deleteFlag: vi.fn(), getSettings: vi.fn().mockResolvedValue({}),
  getRubricForAssignment: vi.fn().mockResolvedValue(null), getRubricConfig: vi.fn().mockResolvedValue({ reportingCategoryColors: {} }),
  getProficiencyScale: vi.fn().mockResolvedValue({ levels: [] }), getFeatures: vi.fn().mockResolvedValue({ quizzes: true }),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }), getQuizGroupFor: vi.fn(), loadQuizResults: vi.fn(),
  getQuizCandidates: vi.fn().mockResolvedValue({ tests: [], summatives: [] }),
}));

const GROUP = { id: 7, title: 'Ep 1', result: { schoology_assignment_id: '950', title: 'Ep 1 - Result (S)' }, members: [{ id: 1, schoology_assignment_id: '900', title: 'Ep 1' }], loaded_at: null, canonical_schoology_id: '950' };

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} /></Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getMasteryForAssignment.mockResolvedValue({ assignment: { title: 'Ep 1 - Result (S)', is_test: 0 }, topics: [], students: [], course: { course_name: 'AP CSP' } });
});

describe('AssessmentSummaryPage with a quiz group', () => {
  it('shows the chip, Load results and the Questions tab', async () => {
    getQuizGroupFor.mockResolvedValue({ group: GROUP });
    loadQuizResults.mockResolvedValue({ summary: { attempts: 18, failed: [] }, group: { ...GROUP, loaded_at: '2026-10-12 14:02:00' } });
    renderAt('/course/5/assessment/950');
    expect(await screen.findByText(/Linked: Ep 1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load results' }));
    expect(await screen.findByText('18 attempts loaded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Questions' }));
    expect(await screen.findByText('Questions for group 7')).toBeInTheDocument();
  });

  it('a member test redirects to the result task', async () => {
    getQuizGroupFor.mockResolvedValue({ group: GROUP });
    renderAt('/course/5/assessment/900');
    await waitFor(() => expect(getMasteryForAssignment).toHaveBeenCalledWith('5', '950'));
  });
});
```

Before writing this test, read the first lines of `AssessmentSummaryPage.test.jsx` and copy its full `vi.mock('../services/api.js', ...)` object instead of the shortened one above, so every function the page imports is mocked; then add the quiz functions. The page calls `getMasteryForAssignment(courseId, assignmentId)` with the route params as strings.

```jsx
// client/src/pages/CoursePage.quiz.test.jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AssessmentsView } from './CoursePage.jsx';
import { getQuizGroups } from '../services/api.js';

vi.mock('../services/api.js', async (orig) => ({ ...(await orig()), getQuizGroups: vi.fn() }));

it('folds member tests under the canonical row and shows the chip', async () => {
  getQuizGroups.mockResolvedValue({ groups: [{ id: 7, title: 'Ep 1', result: { schoology_assignment_id: '950', title: 'Ep 1 - Result (S)' },
    members: [{ id: 1, schoology_assignment_id: '900', title: 'Ep 1' }, { id: 2, schoology_assignment_id: '901', title: 'Ep 1 *' }], canonical_schoology_id: '950' }] });
  const data = { folders: [], assignments: [
    { id: 1, schoology_assignment_id: '900', title: 'Ep 1', aligned: 0, is_test: 1 },
    { id: 2, schoology_assignment_id: '901', title: 'Ep 1 *', aligned: 0, is_test: 1 },
    { id: 3, schoology_assignment_id: '950', title: 'Ep 1 - Result (S)', aligned: 1, is_test: 0 },
  ] };
  render(<MemoryRouter><AssessmentsView data={data} courseId={5} /></MemoryRouter>);
  expect(await screen.findByText(/Linked: Ep 1, Ep 1 \*/)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Ep 1 *' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Ep 1 - Result (S)' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.quiz.test.jsx src/pages/CoursePage.quiz.test.jsx`
Expected: FAIL.

- [ ] **Step 3: Write the hook, chip and wiring**

```js
// client/src/hooks/useQuizGroup.js
// The quiz group an assessment belongs to (as a member test or as the linked
// result task), or null. Off when the `quizzes` feature flag is off.
import { useEffect, useState } from 'react';
import { getFeatures, getQuizGroupFor } from '../services/api.js';

export function useQuizGroup(assignmentId) {
  const [group, setGroup] = useState(null);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    setGroup(null);
    // Promise.resolve().then: a test's api mock without getFeatures must not crash the page.
    Promise.resolve().then(() => getFeatures())
      .then(f => {
        if (!active || !f?.quizzes) return;
        setEnabled(true);
        return getQuizGroupFor(assignmentId).then(r => { if (active) setGroup(r.group); });
      })
      .catch(() => {});
    return () => { active = false; };
  }, [assignmentId]);
  return { group, setGroup, enabled };
}
```

```jsx
// client/src/components/quiz/QuizChip.jsx
// Shows that tests are combined (and linked to a result task) wherever the
// canonical assignment is listed.
export default function QuizChip({ group }) {
  if (!group) return null;
  const tests = group.members.map(m => m.title).join(', ');
  return (
    <span className="badge" title={group.result ? `Result task: ${group.result.title}` : 'Combined tests, not linked to a result task'}
      style={{ fontSize: '0.68rem' }}>
      {group.result ? `Linked: ${tests}` : `Combined: ${tests}`}
    </span>
  );
}
```

`AssessmentSummaryPage.jsx`:
1. Imports: `Navigate, useLocation` from `react-router-dom`; `loadQuizResults` from `../services/api.js`; `useQuizGroup` from `../hooks/useQuizGroup.js`; `QuizChip`, `QuizSetupModal`, `QuestionsTab` from `../components/quiz/...`.
2. State in `AssessmentSummaryPage`:

```jsx
  const location = useLocation();
  const { group: quizGroup, setGroup: setQuizGroup, enabled: quizzesEnabled } = useQuizGroup(assignmentId);
  const [quizTab, setQuizTab] = useStickyTab('assessment-quiz', 'grading', { param: 'tab' });
  const [quizSetupOpen, setQuizSetupOpen] = useState(false);
  const [quizLoad, setQuizLoad] = useState({ busy: false, message: null });
  async function handleLoadQuiz() {
    setQuizLoad({ busy: true, message: null });
    try {
      const r = await loadQuizResults(quizGroup.id);
      setQuizGroup(r.group);
      const failed = r.summary.failed?.length ? `, ${r.summary.failed.length} failed` : '';
      setQuizLoad({ busy: false, message: `${r.summary.attempts} attempts loaded${failed}` });
    } catch (e) {
      setQuizLoad({ busy: false, message: e.message });
    }
  }
```

3. Directly after the `if (!data) return null;` line:

```jsx
  if (quizGroup && quizGroup.canonical_schoology_id && quizGroup.canonical_schoology_id !== String(assignmentId)) {
    return <Navigate replace to={`/course/${courseId}/assessment/${quizGroup.canonical_schoology_id}${location.search}`} />;
  }
```

4. In the header controls row (after **Manage rubrics…**):

```jsx
          {quizzesEnabled && (assignment.is_test === 1 || quizGroup) && (
            <>
              <button className="secondary" style={{ fontSize: '0.78rem' }} onClick={() => setQuizSetupOpen(true)}>Quiz setup…</button>
              {quizGroup && (
                <>
                  <QuizChip group={quizGroup} />
                  <button className="secondary" style={{ fontSize: '0.78rem' }} disabled={quizLoad.busy} onClick={handleLoadQuiz}>
                    {quizLoad.busy ? 'Loading results…' : 'Load results'}
                  </button>
                  <span className="text-sm text-muted" style={{ fontSize: '0.75rem' }}>
                    {quizLoad.message || (quizGroup.loaded_at ? `loaded ${formatDateTime(quizGroup.loaded_at.replace(' ', 'T'))}` : 'not loaded')}
                  </span>
                </>
              )}
            </>
          )}
```

5. After `<AssessmentFilterBar ... />`, still inside the sticky header:

```jsx
        {quizGroup && (
          <div role="tablist" aria-label="Quiz views" style={{ display: 'flex', gap: '0.25rem', marginTop: '0.4rem' }}>
            <button role="tab" aria-selected={quizTab === 'grading'} className={`tab-btn${quizTab === 'grading' ? ' active' : ''}`} onClick={() => setQuizTab('grading')}>Grading</button>
            <button role="tab" aria-selected={quizTab === 'questions'} className={`tab-btn${quizTab === 'questions' ? ' active' : ''}`} onClick={() => setQuizTab('questions')}>Questions</button>
          </div>
        )}
```

6. Wrap the existing `{students.length === 0 ? ( ... ) : ( <> ... </> )}` block as:

```jsx
      {quizGroup && quizTab === 'questions'
        ? <QuestionsTab groupId={quizGroup.id} reloadKey={quizGroup.loaded_at} />
        : (students.length === 0 ? ( /* existing empty card, unchanged */ ) : ( /* existing fragment, unchanged */ ))}
```

7. Before `<RubricManagerModal`:

```jsx
      <QuizSetupModal
        open={quizSetupOpen}
        courseId={courseId}
        currentAssignment={{ schoology_assignment_id: String(assignmentId), title: assignment.title }}
        group={quizGroup}
        onClose={() => setQuizSetupOpen(false)}
        onChanged={(g) => { setQuizGroup(g); setQuizSetupOpen(false); }}
      />
```

Hooks must stay above the early returns: put the new `useQuizGroup`, `useStickyTab`, `useState` and `useLocation` calls with the other hooks at the top of the component.

`assignment.is_test` is already in the `getMasteryForAssignment` response: the route (`server/routes/mastery.js`, `GET /:courseId/assignment/:assignmentId`) selects `SELECT * FROM assignments`.

`CoursePage.jsx`, in `AssessmentsView`: import `getQuizGroups` and `QuizChip`; add

```jsx
  const [quizGroups, setQuizGroups] = useState([]);
  useEffect(() => {
    let active = true;
    getQuizGroups(courseId).then(r => { if (active) setQuizGroups(r.groups || []); }).catch(() => {});
    return () => { active = false; };
  }, [courseId]);
  const groupByCanonical = new Map(quizGroups.map(g => [String(g.canonical_schoology_id), g]));
  const foldedIds = new Set(quizGroups.flatMap(g => g.members.map(m => String(m.schoology_assignment_id)))
    .filter(sid => !groupByCanonical.has(sid)));
```

filter `visible` with `.filter(a => !foldedIds.has(String(a.schoology_assignment_id)))`, and after the title's `<SchoologyLink ... />` in each row add `<QuizChip group={groupByCanonical.get(String(a.schoology_assignment_id))} />`. Keep `summativeCount` / `formativeCount` computed from the unfolded list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && npx vitest run src/pages/ src/components/quiz/`
Expected: PASS (existing page tests included). Page tests that mock `../services/api.js` with a closed object need the new functions: add `getFeatures: vi.fn().mockResolvedValue({})` and `getQuizGroupFor: vi.fn().mockResolvedValue({ group: null })` to `AssessmentSummaryPage.test.jsx`, and `getQuizGroups: vi.fn().mockResolvedValue({ groups: [] })` to each `CoursePage*.test.jsx` mock that lacks it.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useQuizGroup.js client/src/components/quiz/QuizChip.jsx client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.quiz.test.jsx client/src/pages/CoursePage.jsx client/src/pages/CoursePage.quiz.test.jsx
git commit -m "feat(quizzes): quiz tabs, Load results and setup on the assessment page; fold combined tests in the course list"
```

---

### Task 16: Live parity probe, docs, and verification on real data

**Files:**
- Create: `scripts/parity-quiz-results.js`
- Modify: `docs/design-language.md` (append a section), `.claude/schoology-api-reference.md` (a "Consumed by Prism" note under the 2026-10-12 section), `.claude/build-progress.md` (an entry)

**Interfaces:**
- Consumes: the dev clone's DB after a real load; csp-tools' `<title> - item_analysis.csv` for the same test (written by `build_theory_test_review.py`).

- [ ] **Step 1: Write the parity probe**

```js
// scripts/parity-quiz-results.js
// Live parity check (AGENTS.md: a parity probe is the verification of choice for
// API-shape work). Compares Prism's per-question MCQ counts for a loaded quiz group
// with csp-tools' item_analysis.csv for the same test, built from the CSV exports.
// Usage: DB_PATH=<abs path> node scripts/parity-quiz-results.js <groupId> "<path to item_analysis.csv>"
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { getDb } from '../server/db/index.js';
import { groupStats } from '../server/services/quizStats.js';

const [groupId, csvPath] = process.argv.slice(2);
if (!groupId || !csvPath) { console.error('Usage: node scripts/parity-quiz-results.js <groupId> <item_analysis.csv>'); process.exit(1); }
const stats = groupStats(getDb(), { groupId: Number(groupId) });
const rows = parse(readFileSync(csvPath, 'utf8'), { columns: true, bom: true });
console.log('CSV columns:', Object.keys(rows[0] || {}).join(', '));
let mismatches = 0;
for (const q of stats.questions.filter(x => x.kind === 'mcq')) {
  const row = rows.find(r => Number(r.question ?? r.Question ?? r.n) === q.position);
  if (!row) { console.log(`Q${q.position}: not in the CSV`); mismatches++; continue; }
  const csvCorrect = Number(row.correct ?? row.Correct);
  const csvTotal = Number(row.total ?? row.Total);
  const same = csvCorrect === q.correct && csvTotal === q.total;
  if (!same) mismatches++;
  console.log(`Q${q.position}: Prism ${q.correct}/${q.total}, CSV ${csvCorrect}/${csvTotal}${same ? '' : '  <-- differs'}`);
}
console.log(mismatches ? `${mismatches} question(s) differ` : 'All MCQ counts match');
process.exit(mismatches ? 1 : 0);
```

The CSV's column names are printed first: if they differ from `question` / `correct` / `total`, adjust the three lookups to the printed names before trusting the result.

- [ ] **Step 2: Run the full test suites**

Run: `npx vitest run` then `cd client && npx vitest run`
Expected: both PASS.

- [ ] **Step 3: Verify on real data (dev clone, laptop)**

1. Check you are not on the mini: `hostname` must not be `macmini.local`.
2. Start the dev server: `npm run dev` (it refuses to start if the API port is held by something outside this clone; then use `PORT=3002 npm run dev`).
3. Copy the saved session for the dev clone: `PRISM_SESSION_DIR=/Users/gnolan/repos/prism/.playwright-session` in the environment of the dev server.
4. Open the Ep 1 test (`8544307969`, BK 6) in the dev UI, **Quiz setup…**, confirm the extra-time copy `8603667595` is ticked, **Check questions**, **Combine**, link `8544307980` (the Result task), **Load results**.
5. Check: the Questions tab shows 21 questions (20 MCQ and 1 FRQ), takers match Schoology's results pages, every card on the Grading tab shows **Attempt** for the students who sat it, and each link opens that student's attempt.
6. Run the parity probe against the Ep 1 `item_analysis.csv` (find it under `Courses/AP CS Principles/<year> AP CSP/<unit> Theory Test Results/` in OneDrive): `DB_PATH=<abs dev db> node scripts/parity-quiz-results.js <groupId> "<csv path>"`. Expected: "All MCQ counts match", or each difference explained (for example a student the CSV export truncated or a copy only one side included).

Record what happened, including any difference, in the build-progress entry.

- [ ] **Step 4: Write the docs**

Append to `docs/design-language.md`:

```markdown
## Linked quizzes: tabs, chip, attempt link (October 2026, phase 1)

- **One page per quiz group.** Every member test and the linked result task open the same
  assessment page; other URLs redirect to it, keeping `?tab=`. The canonical page is the
  result task when linked, otherwise the first member test.
- **Tabs, not a second page.** `.tab-btn` Grading and Questions sit under the header. Grading
  is the page's existing content, so nothing a teacher used before moves.
- **Chip in lists.** The course's Assessments list hides the member tests and shows one row
  with a chip ("Linked: ..." or "Combined: ..."), so the link is visible where the work is listed.
  The gradebook keeps a column per test, because each still carries a score.
- **"Attempt" beside the status pill.** The #120 pattern: a short label, the completion time
  in the tooltip, `SchoologyLink` for the outbound glyph. The same link appears on the
  assessment cards, the gradebook modal and the student page.
- **Statistics stay counts.** Facility bars, bands (Strong, Mixed, Divided), option counts
  with the key marked, and flags. No discrimination statistics, on purpose.
```

Under the 2026-10-12 section of `.claude/schoology-api-reference.md`, add:

```markdown
**Consumed by Prism (phase 1, linked quizzes):** `server/services/quizLoader.js` reads the
question list (on combine), the results page, each taker's `student_stats` page, the latest
attempt page, and for each essay with a rubric the two rubric GETs, one request at a time, GET
only (URLs with `unsubmit` or `delete` are refused). Parsers: `server/lib/parseQuizQuestions.js`,
`parseQuizResults.js`, `parseQuizAttempt.js`, `parseQuizRubric.js`.
```

Add a dated entry to `.claude/build-progress.md` naming phase 1 as shipped, the verification result from Step 3, and phases 2 to 4 as next.

- [ ] **Step 5: Commit**

```bash
git add scripts/parity-quiz-results.js docs/design-language.md .claude/schoology-api-reference.md .claude/build-progress.md
git commit -m "docs(quizzes): phase 1 design notes, API usage, parity probe and progress"
```

---

## After phase 1

- **Phase 2 plan (FRQ marking):** `frq_marks` table, the Free response tab (view by question and by student), `get_frq_responses`, `write_frq_suggestions`, the agent write-back tools, and the `grade-theory-test` skill change. Written after phase 1 ships and has been used on one real test.
- **Phase 3 plan (overall):** `get_quiz_results`, `write_quiz_overall_suggestions`, the comment template.
- **Phase 4 plan (Prism write-back):** starts with the teacher-approved write probe.
