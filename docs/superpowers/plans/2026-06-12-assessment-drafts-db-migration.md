# Assessment Draft Feedback → DB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `/assessment/` draft teacher feedback (proficiency picks, comment, display toggle) from browser `localStorage` into the SQLite DB so the Prism MCP can read it, autosaved with no perceptible UI delay; and restore the draft proficiency cell to a pale tint of its level colour instead of grey.

**Architecture:** A new `assessment_drafts` table (one row per `(assignment_id, student_id)`, the draft stored verbatim as JSON) with an Express CRUD route. The MCP `get_assignment_context` reads it and surfaces a `draft_feedback` field per student. The client keeps React state as the instant UI source of truth and persists via a debounced/immediate-flush saver (with `sendBeacon`/`keepalive` on unload); drafts load once at page level and pass into each card as a prop so render stays synchronous. A separate one-line colour fix passes the per-level `draftFill` into `RubricDescriptorGrid`.

**Tech Stack:** better-sqlite3 (synchronous, WAL), Express (ESM Routers), React + Vite, Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-06-12-assessment-drafts-db-migration-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `server/db/schema.sql` | DB schema (auto-`exec`'d on boot) | Add `assessment_drafts` table + index |
| `server/routes/assessment-drafts.js` | CRUD route for drafts | Create |
| `server/routes/assessment-drafts.test.js` | Route tests (in-memory DB) | Create |
| `server/index.js` | Route registration | Add `app.use('/api/assessment-drafts', …)` |
| `server/services/assessmentContext.js` | Shared MCP/route context read | Add `getDrafts` + `draft_feedback` |
| `server/services/assessmentContext.test.js` | Context tests | Add draft coverage |
| `mcp/server.js` | MCP tool definitions | Update `get_assignment_context` description |
| `client/src/services/api.js` | Client API helpers | Add draft helpers |
| `client/src/lib/assessmentDraftSaver.js` | Debounced/immediate DB saver | Create |
| `client/src/lib/assessmentDraftSaver.test.js` | Saver tests (fake timers) | Create |
| `client/src/lib/assessmentDraft.js` | `draftBaseline` only (localStorage fns removed) | Trim |
| `client/src/lib/assessmentDraft.test.js` | `draftBaseline` tests only | Trim |
| `client/src/pages/AssessmentSummaryPage.jsx` | Page load + card autosave wiring | Modify |
| `client/src/pages/AssessmentSummaryPage.test.jsx` | Card load-from-prop test | Create |
| `client/src/components/RubricDescriptorGrid.jsx` | Draft cell background | Colour fix |
| `client/src/components/RubricDescriptorGrid.test.jsx` | Draft cell colour test | Create |
| `docs/design-language.md` | Visual-decision log | Append note |

---

## Task 1: Schema — `assessment_drafts` table

**Files:**
- Modify: `server/db/schema.sql` (append a new table; `migrate()` runs `schema.sql` via `database.exec()` on every boot, so a `CREATE TABLE IF NOT EXISTS` auto-creates it — no `MIGRATIONS` entry needed)

- [ ] **Step 1: Add the table to the schema**

Append to the end of `server/db/schema.sql`:

```sql

-- Draft teacher feedback for the /assessment/ page (unpublished proficiency
-- picks, comment text, display-to-student toggle). One row per (assignment,
-- student); the draft object is stored verbatim as JSON. Replaces the former
-- per-browser localStorage draft so the MCP can read in-progress grading. See
-- docs/superpowers/specs/2026-06-12-assessment-drafts-db-migration-design.md.
CREATE TABLE IF NOT EXISTS assessment_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  enrolment_id TEXT,
  draft_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_assessment_drafts_assignment ON assessment_drafts(assignment_id);
```

(`enrolment_id` is `TEXT` and British-spelled to match the DB convention — `grades.enrolment_id`, table `enrolments` — even though the roster/API boundary exposes it to the client as `enrollment_id`. `getRoster` aliases `schoology_enrolment_id AS enrollment_id`, a string like `'enr-1'`.)

- [ ] **Step 2: Verify the table is created on a fresh DB**

Run: `DB_PATH=:memory: node -e "import('./server/db/index.js').then(m => { const d = m.getDb(); console.log(d.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='assessment_drafts'\").get()); })"`
Expected: prints `{ name: 'assessment_drafts' }`

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(db): assessment_drafts table for DB-backed assessment drafts"
```

---

## Task 2: Express route `/api/assessment-drafts`

**Files:**
- Create: `server/routes/assessment-drafts.js`
- Create: `server/routes/assessment-drafts.test.js`
- Modify: `server/index.js` (import + register)

- [ ] **Step 1: Write the failing test**

Create `server/routes/assessment-drafts.test.js` (using the repo's `app.listen(0)` + `fetch` route-test convention, mirroring `server/routes/flags.test.js`):

```js
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './assessment-drafts.js';
import { getDb } from '../db/index.js';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/assessment-drafts', router);
  const server = app.listen(0);
  return { server, port: server.address().port };
}

async function call(method, path, payload) {
  const { server, port } = startServer();
  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

let assignmentId, studentId;

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM assessment_drafts; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AIML')`).run().lastInsertRowid;
  assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, max_points) VALUES (?, 'sa-1', 'Project', 100)`).run(courseId).lastInsertRowid;
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-1')`).run(studentId, courseId);
});

describe('assessment-drafts route', () => {
  test('POST upserts a draft and GET returns it keyed by student_id', async () => {
    const draft = { pending: { 'topic-1': 'ED' }, comment: 'wip', display: true, displayTouched: false, base: 'b1' };
    const post = await call('POST', '/api/assessment-drafts', { assignment_id: 'sa-1', student_id: studentId, enrollment_id: 'enr-1', draft });
    expect(post.status).toBe(200);
    const get = await call('GET', '/api/assessment-drafts?assignment_id=sa-1');
    expect(get.status).toBe(200);
    expect(get.body[String(studentId)]).toEqual(draft);
  });

  test('POST a second time replaces the existing draft (upsert, not duplicate)', async () => {
    await call('POST', '/api/assessment-drafts', { assignment_id: 'sa-1', student_id: studentId, enrollment_id: 'enr-1', draft: { pending: { 'topic-1': 'ED' }, comment: 'one' } });
    await call('POST', '/api/assessment-drafts', { assignment_id: 'sa-1', student_id: studentId, enrollment_id: 'enr-1', draft: { pending: {}, comment: 'two' } });
    const get = await call('GET', '/api/assessment-drafts?assignment_id=sa-1');
    expect(Object.keys(get.body)).toHaveLength(1);
    expect(get.body[String(studentId)].comment).toBe('two');
  });

  test('DELETE removes the draft', async () => {
    await call('POST', '/api/assessment-drafts', { assignment_id: 'sa-1', student_id: studentId, enrollment_id: 'enr-1', draft: { pending: {}, comment: 'x' } });
    const del = await call('DELETE', `/api/assessment-drafts?assignment_id=sa-1&student_id=${studentId}`);
    expect(del.status).toBe(200);
    const get = await call('GET', '/api/assessment-drafts?assignment_id=sa-1');
    expect(get.body).toEqual({});
  });

  test('GET returns {} for an unknown assignment', async () => {
    const get = await call('GET', '/api/assessment-drafts?assignment_id=no-such');
    expect(get.body).toEqual({});
  });

  test('POST 404s when the student cannot be resolved', async () => {
    const post = await call('POST', '/api/assessment-drafts', { assignment_id: 'sa-1', student_id: 999999, draft: { pending: {} } });
    expect(post.status).toBe(404);
  });

  test('POST 400s when assignment_id or draft is missing', async () => {
    const post = await call('POST', '/api/assessment-drafts', { student_id: studentId });
    expect(post.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/routes/assessment-drafts.test.js`
Expected: FAIL — cannot import `./assessment-drafts.js` (module does not exist).

- [ ] **Step 3: Implement the route**

Create `server/routes/assessment-drafts.js`:

```js
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { resolveAssignmentId, resolveStudentId } from '../services/idResolvers.js';

const router = Router();

// GET /api/assessment-drafts?assignment_id=<schoology|local>
// → { [student_id]: { pending, comment, display, displayTouched, base } }
router.get('/', (req, res) => {
  const db = getDb();
  const { assignment_id } = req.query;
  if (!assignment_id) return res.status(400).json({ error: 'assignment_id is required' });
  const localAssignmentId = resolveAssignmentId(db, assignment_id);
  if (!localAssignmentId) return res.json({});
  const rows = db.prepare('SELECT student_id, draft_json FROM assessment_drafts WHERE assignment_id = ?').all(localAssignmentId);
  const byStudent = {};
  for (const r of rows) {
    try { byStudent[r.student_id] = JSON.parse(r.draft_json); } catch { /* skip corrupt row */ }
  }
  res.json(byStudent);
});

// POST /api/assessment-drafts — upsert one draft. Body:
// { assignment_id, student_id, enrollment_id?, draft }. Also serves
// navigator.sendBeacon flushes (a Blob with type application/json — parsed by
// the express.json() body parser like any POST).
router.post('/', (req, res) => {
  const db = getDb();
  const { assignment_id, student_id, enrollment_id, draft } = req.body || {};
  if (!assignment_id || !student_id || !draft) return res.status(400).json({ error: 'assignment_id, student_id, and draft are required' });
  const localAssignmentId = resolveAssignmentId(db, assignment_id);
  if (!localAssignmentId) return res.status(404).json({ error: 'Assignment not found' });
  const localStudentId = resolveStudentId(db, student_id);
  if (!localStudentId) return res.status(404).json({ error: 'Student not found' });
  db.prepare(`
    INSERT INTO assessment_drafts (assignment_id, student_id, enrolment_id, draft_json, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(assignment_id, student_id) DO UPDATE SET
      draft_json = excluded.draft_json,
      enrolment_id = excluded.enrolment_id,
      updated_at = datetime('now')
  `).run(localAssignmentId, localStudentId, enrollment_id ?? null, JSON.stringify(draft));
  res.json({ ok: true });
});

// DELETE /api/assessment-drafts?assignment_id=&student_id=
router.delete('/', (req, res) => {
  const db = getDb();
  const { assignment_id, student_id } = req.query;
  if (!assignment_id || !student_id) return res.status(400).json({ error: 'assignment_id and student_id are required' });
  const localAssignmentId = resolveAssignmentId(db, assignment_id);
  if (!localAssignmentId) return res.json({ ok: true });
  const localStudentId = resolveStudentId(db, student_id);
  if (localStudentId) {
    db.prepare('DELETE FROM assessment_drafts WHERE assignment_id = ? AND student_id = ?').run(localAssignmentId, localStudentId);
  }
  res.json({ ok: true });
});

export default router;
```

- [ ] **Step 4: Register the route**

In `server/index.js`, add the import beside the other route imports (after line 19, the `rubricsRouter` import):

```js
import assessmentDraftsRouter from './routes/assessment-drafts.js';
```

And register it beside the others (after line 48, the `rubricsRouter` registration):

```js
app.use('/api/assessment-drafts', assessmentDraftsRouter);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run server/routes/assessment-drafts.test.js`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add server/routes/assessment-drafts.js server/routes/assessment-drafts.test.js server/index.js
git commit -m "feat(api): /api/assessment-drafts GET/POST/DELETE for DB-backed drafts"
```

---

## Task 3: MCP exposure — `draft_feedback` in `get_assignment_context`

**Files:**
- Modify: `server/services/assessmentContext.js` (add `getDrafts`, `buildDraftFeedback`, wire into the student map)
- Modify: `server/services/assessmentContext.test.js` (add draft coverage)
- Modify: `mcp/server.js` (update the `get_assignment_context` tool description)

- [ ] **Step 1: Write the failing test**

In `server/services/assessmentContext.test.js`, extend `seedContext` to also insert a draft, and add tests. First, add this line inside `seedContext` (just before `return`), and add `assessment_drafts` to the `beforeEach` `DELETE` list:

```js
  // Draft teacher feedback: one staged proficiency, one staged removal, a comment.
  db.prepare(`INSERT INTO assessment_drafts (assignment_id, student_id, enrollment_id, draft_json) VALUES (?, ?, 'enr-1', ?)`).run(
    assignmentId, studentId,
    JSON.stringify({ pending: { 'topic-1': 'D', 'topic-9': '__remove__' }, comment: 'draft note', display: true, displayTouched: true, base: 'b1' })
  );
```

Update the `beforeEach` first line to include the new table:

```js
  getDb().exec(
    'DELETE FROM assessment_drafts; DELETE FROM feedback; DELETE FROM mastery_alignments; DELETE FROM mastery_scores; ' +
    'DELETE FROM grades; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
    'DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
  );
```

Then add these tests inside the `describe('getAssessmentContext', …)` block:

```js
  test('surfaces the teacher draft as draft_feedback, splitting picks from removals', () => {
    const db = getDb();
    seedContext(db);
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-1' });
    expect(ctx.students[0].draft_feedback).toMatchObject({
      rubric_scores: { 'topic-1': 'D' },
      removed_topics: ['topic-9'],
      comment: 'draft note',
      display_to_student: true,
    });
  });

  test('draft_feedback is null when no draft row exists', () => {
    const db = getDb();
    seedContext(db);
    db.prepare('DELETE FROM assessment_drafts').run();
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-1' });
    expect(ctx.students[0].draft_feedback).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/services/assessmentContext.test.js`
Expected: FAIL — `draft_feedback` is `undefined` (property does not exist yet).

- [ ] **Step 3: Implement `getDrafts` + `buildDraftFeedback` and wire them in**

In `server/services/assessmentContext.js`, add these two helpers after `getExistingSuggestions` (after line 107):

```js
// Teacher draft feedback (unpublished proficiency picks + comment + display
// toggle) for an assignment (local id), keyed by student_id. The draft object
// is stored verbatim; updated_at is attached for recency display.
export function getDrafts(db, assignmentLocalId) {
  const rows = db.prepare(
    'SELECT student_id, draft_json, updated_at FROM assessment_drafts WHERE assignment_id = ?'
  ).all(assignmentLocalId);
  const byStudent = {};
  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(row.draft_json || '{}'); } catch { parsed = {}; }
    byStudent[row.student_id] = { ...parsed, updated_at: row.updated_at };
  }
  return byStudent;
}

// Project a stored draft into the agent-facing shape: separate real level picks
// (rubric_scores) from staged removals (the '__remove__' sentinel → removed_topics).
function buildDraftFeedback(draft) {
  const pending = draft.pending || {};
  const rubric_scores = {};
  const removed_topics = [];
  for (const [topicId, level] of Object.entries(pending)) {
    if (level === '__remove__') removed_topics.push(topicId);
    else rubric_scores[topicId] = level;
  }
  return {
    updated_at: draft.updated_at ?? null,
    rubric_scores,
    removed_topics,
    comment: draft.comment ?? '',
    display_to_student: Boolean(draft.display),
  };
}
```

Then, inside `getAssessmentContext`, read the drafts beside the suggestions (after line 124, `const suggestions = …`):

```js
  const drafts = getDrafts(db, assignmentRow.id);
```

And in the `roster.map` student object, add a `draft_feedback` field right after `existing_suggestion` (after line 155, inside the returned object). First capture the draft beside `const sug = suggestions[st.id];` (line 131):

```js
    const draft = drafts[st.id];
```

Then add to the returned object (after the `existing_suggestion` property):

```js
      draft_feedback: draft ? buildDraftFeedback(draft) : null,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/services/assessmentContext.test.js`
Expected: PASS (all prior tests + the 2 new ones)

- [ ] **Step 5: Update the MCP tool description**

In `mcp/server.js`, replace the `get_assignment_context` description string (line 56-57) with one that mentions the draft:

```js
      description:
        'Load an assignment\'s roster, aligned measurement topics (rubric skeleton), current finals/comments/display-status, any existing AI suggestions, and the teacher\'s in-progress unpublished draft (draft_feedback: their staged proficiency picks, removed topics, comment, and display-to-student toggle), to grade against. Address each student in feedback by their roster `preferred_first_name` (the teacher-honored display name); `first_name`/`last_name` are the legal name, for matching submissions.',
```

- [ ] **Step 6: Run the MCP server tests to confirm nothing regressed**

Run: `npx vitest run mcp/ server/services/assessmentContext.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/services/assessmentContext.js server/services/assessmentContext.test.js mcp/server.js
git commit -m "feat(mcp): surface teacher draft_feedback in get_assignment_context"
```

---

## Task 4: Client API helpers

**Files:**
- Modify: `client/src/services/api.js` (add draft helpers + beacon body builder)

- [ ] **Step 1: Add the helpers**

In `client/src/services/api.js`, after the Feedback block (after line 142, the `uploadFeedbackJson` definition), add:

```js
// Assessment drafts (DB-backed unpublished grading work). DRAFTS_PATH is the
// absolute path used by navigator.sendBeacon on unload (request() prepends /api).
export const DRAFTS_PATH = '/api/assessment-drafts';
export const getDraftsForAssignment = (assignmentId) => request(`/assessment-drafts?assignment_id=${assignmentId}`);
export const saveAssessmentDraft = (data, opts = {}) =>
  request('/assessment-drafts', { method: 'POST', body: JSON.stringify(data), ...opts });
export const deleteAssessmentDraft = ({ assignmentId, studentId }) =>
  request(`/assessment-drafts?assignment_id=${assignmentId}&student_id=${studentId}`, { method: 'DELETE' });
export const draftBeaconBody = (data) => new Blob([JSON.stringify(data)], { type: 'application/json' });
```

- [ ] **Step 2: Verify the client still builds/lints**

Run: `npx vitest run client/src/lib/masteryLevels.test.js`
Expected: PASS (sanity that the client test runner + module graph still resolve; this file imports nothing new but confirms the toolchain is green).

- [ ] **Step 3: Commit**

```bash
git add client/src/services/api.js
git commit -m "feat(client): api helpers for DB-backed assessment drafts"
```

---

## Task 5: Draft autosave module

**Files:**
- Create: `client/src/lib/assessmentDraftSaver.js`
- Create: `client/src/lib/assessmentDraftSaver.test.js`

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/assessmentDraftSaver.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../services/api.js', () => ({
  saveAssessmentDraft: vi.fn(() => Promise.resolve({ ok: true })),
  deleteAssessmentDraft: vi.fn(() => Promise.resolve({ ok: true })),
  draftBeaconBody: (d) => JSON.stringify(d),
  DRAFTS_PATH: '/api/assessment-drafts',
}));

import { saveAssessmentDraft, deleteAssessmentDraft } from '../services/api.js';
import { makeDraftSaver } from './assessmentDraftSaver.js';

const target = { assignmentId: 'sa-1', studentId: 7, enrollmentId: 'enr-1' };
// The route's snake_case wire contract that the saver maps the target into.
const wire = (draft) => ({ assignment_id: 'sa-1', student_id: 7, enrollment_id: 'enr-1', draft });

beforeEach(() => {
  vi.useFakeTimers();
  saveAssessmentDraft.mockClear();
  deleteAssessmentDraft.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe('makeDraftSaver', () => {
  it('debounces a save: one POST after the delay, not per call', () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.save({ comment: 'a' });
    s.save({ comment: 'ab' });
    s.save({ comment: 'abc' });
    expect(saveAssessmentDraft).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(saveAssessmentDraft).toHaveBeenCalledTimes(1);
    expect(saveAssessmentDraft).toHaveBeenCalledWith(wire({ comment: 'abc' }));
  });

  it('immediate save fires synchronously with no timer wait', () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.save({ pending: { t1: 'ED' } }, { immediate: true });
    expect(saveAssessmentDraft).toHaveBeenCalledTimes(1);
  });

  it('remove() debounces a DELETE', () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.remove();
    vi.advanceTimersByTime(500);
    expect(deleteAssessmentDraft).toHaveBeenCalledWith(target);
  });

  it('a newer save supersedes a queued delete', () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.remove();
    s.save({ comment: 'back' });
    vi.advanceTimersByTime(500);
    expect(deleteAssessmentDraft).not.toHaveBeenCalled();
    expect(saveAssessmentDraft).toHaveBeenCalledTimes(1);
  });

  it('flush() sends a pending save immediately via keepalive when no beacon', () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.save({ comment: 'x' });
    s.flush();
    expect(saveAssessmentDraft).toHaveBeenCalledWith(wire({ comment: 'x' }), { keepalive: true });
  });

  it('flush() is a no-op when nothing is pending', () => {
    const s = makeDraftSaver(target, { delay: 500 });
    s.flush();
    expect(saveAssessmentDraft).not.toHaveBeenCalled();
  });

  it('flush({ beacon: true }) uses navigator.sendBeacon when available', () => {
    const beacon = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const s = makeDraftSaver(target, { delay: 500 });
    s.save({ comment: 'x' });
    s.flush({ beacon: true });
    expect(beacon).toHaveBeenCalledWith('/api/assessment-drafts', JSON.stringify(wire({ comment: 'x' })));
    expect(saveAssessmentDraft).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run client/src/lib/assessmentDraftSaver.test.js`
Expected: FAIL — cannot import `./assessmentDraftSaver.js`.

- [ ] **Step 3: Implement the saver**

Create `client/src/lib/assessmentDraftSaver.js`:

```js
// A per-card draft saver: debounces typing into one trailing POST, flushes a
// discrete pick immediately, and flushes any pending save on page-hide/unmount
// via a keepalive transport. The React UI never awaits these — state is the
// instant source of truth; this only mirrors it to the DB. See
// docs/superpowers/specs/2026-06-12-assessment-drafts-db-migration-design.md.
import { saveAssessmentDraft, deleteAssessmentDraft, draftBeaconBody, DRAFTS_PATH } from '../services/api.js';

export function makeDraftSaver(target, { delay = 500 } = {}) {
  // target: { assignmentId, studentId, enrollmentId } (camelCase JS).
  let timer = null;
  let pendingDraft = null;   // latest draft object to POST, or null
  let pendingDelete = false; // latest intent is a delete

  // Map the camelCase target to the route's snake_case wire contract.
  function wireBody(draft) {
    return {
      assignment_id: target.assignmentId,
      student_id: target.studentId,
      enrollment_id: target.enrollmentId,
      draft,
    };
  }

  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }

  function send() {
    clearTimer();
    if (pendingDraft) {
      const body = wireBody(pendingDraft);
      pendingDraft = null;
      saveAssessmentDraft(body).catch(() => {});
    } else if (pendingDelete) {
      pendingDelete = false;
      deleteAssessmentDraft(target).catch(() => {});
    }
  }

  return {
    // Persist a draft. immediate: skip the debounce (proficiency / display click).
    save(draft, { immediate = false } = {}) {
      pendingDraft = draft;
      pendingDelete = false;
      clearTimer();
      if (immediate) send();
      else timer = setTimeout(send, delay);
    },
    // Schedule removal of the server row (card returned to no-pending-changes).
    remove({ immediate = false } = {}) {
      pendingDraft = null;
      pendingDelete = true;
      clearTimer();
      if (immediate) send();
      else timer = setTimeout(send, delay);
    },
    // Best-effort flush of a pending SAVE on unload/unmount. A no-pending-changes
    // card has nothing to lose, so queued deletes are not flushed.
    flush({ beacon = false } = {}) {
      clearTimer();
      if (!pendingDraft) return;
      const body = wireBody(pendingDraft);
      pendingDraft = null;
      if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon(DRAFTS_PATH, draftBeaconBody(body));
      } else {
        saveAssessmentDraft(body, { keepalive: true }).catch(() => {});
      }
    },
    dispose() { clearTimer(); pendingDraft = null; pendingDelete = false; },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run client/src/lib/assessmentDraftSaver.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/assessmentDraftSaver.js client/src/lib/assessmentDraftSaver.test.js
git commit -m "feat(client): debounced/immediate assessment draft saver"
```

---

## Task 6: Wire the page + card to DB autosave

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx`
- Create: `client/src/pages/AssessmentSummaryPage.test.jsx`

This task swaps the card's localStorage draft I/O for the DB saver, loads drafts at page level, and migrates any pre-existing localStorage draft into the DB. It leaves the old `localStorage` helper exports in `assessmentDraft.js` untouched (removed in Task 7) so every commit builds.

- [ ] **Step 1: Write the failing test (card restores pending from the `draftRow` prop)**

Create `client/src/pages/AssessmentSummaryPage.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// The card persists via the saver; stub it so the test asserts wiring, not I/O.
vi.mock('../lib/assessmentDraftSaver.js', () => ({
  makeDraftSaver: () => ({ save: vi.fn(), remove: vi.fn(), flush: vi.fn(), dispose: vi.fn() }),
}));
// A ready proficiency scale so the rubric renders.
vi.mock('../hooks/useProficiencyScale.js', () => ({
  useProficiencyScale: () => ({
    ready: true, schoologyScaleId: 'gs-1',
    levelToPoints: (c) => ({ ED: 100, EX: 75, D: 50, EM: 25, IE: 0 }[c] ?? null),
    levelLabel: (c) => c,
  }),
}));

import { StudentRubricCard } from './AssessmentSummaryPage.jsx';
import { draftBaseline } from '../lib/assessmentDraft.js';

const topics = [{ id: 'topic-1', external_id: 'ART.5.1', title: 'Generates media', category_title: 'Creating' }];
const student = {
  id: 7, schoology_uid: 'uid-1', enrollment_id: 'enr-1',
  first_name: 'Ada', last_name: 'Lovelace', preferred_name: 'Ada',
  grade_comment: '', comment_status: 0, exception: 0,
  scores: {},
};

beforeEach(() => { localStorage.clear(); });

describe('StudentRubricCard draft restore', () => {
  it('restores pending changes from the draftRow prop (matching baseline)', () => {
    const base = draftBaseline(student, topics);
    const draftRow = { pending: { 'topic-1': 'ED' }, comment: '', display: false, displayTouched: false, base };
    render(
      <StudentRubricCard
        student={student} topics={topics} courseId="4" assignmentId="sa-1"
        assignmentRow={{ id: 1 }} feedbackRow={null} draftRow={draftRow} viewMode="descriptors"
      />
    );
    // The pending-change badge reflects the restored draft.
    expect(screen.getByText(/pending change/i)).toBeInTheDocument();
  });

  it('ignores a stale draftRow whose base no longer matches', () => {
    const draftRow = { pending: { 'topic-1': 'ED' }, comment: '', display: false, displayTouched: false, base: 'STALE' };
    render(
      <StudentRubricCard
        student={student} topics={topics} courseId="4" assignmentId="sa-1"
        assignmentRow={{ id: 1 }} feedbackRow={null} draftRow={draftRow} viewMode="descriptors"
      />
    );
    expect(screen.queryByText(/pending change/i)).not.toBeInTheDocument();
  });
});
```

> Note: the badge text matcher (`/pending change/i`) must match the real badge copy in the card. Before implementing, grep the card for the pending-count label and adjust the matcher to the actual string if it differs.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run client/src/pages/AssessmentSummaryPage.test.jsx`
Expected: FAIL — `StudentRubricCard` does not yet accept `draftRow` (it reads localStorage), so the first test won't find restored pending reliably and the prop is ignored.

- [ ] **Step 3: Update imports in the page**

In `client/src/pages/AssessmentSummaryPage.jsx`:

Change the draft import (line 4) from:

```js
import { draftKey, readDraft, writeDraft, clearDraft, draftBaseline } from '../lib/assessmentDraft.js';
```

to:

```js
import { draftBaseline } from '../lib/assessmentDraft.js';
import { makeDraftSaver } from '../lib/assessmentDraftSaver.js';
```

Add `getDraftsForAssignment` to the api import (line 3) — append it to the existing destructured list:

```js
import { getMasteryForAssignment, getFeedbackForAssignment, getAssessmentAnalysis, syncMasteryForAssignment, writeMasteryScores, writeMasteryComment, sendAllGrades, createFlag, deleteFlag, getRubricForAssignment, getRubricConfig, getDraftsForAssignment } from '../services/api.js';
```

- [ ] **Step 4: Add `draftRow` to the card signature and create the saver**

Change the `StudentRubricCard` signature (line 107) to accept `draftRow`:

```js
export function StudentRubricCard({ student, topics, courseId, assignmentId, assignmentRow, feedbackRow, draftRow = null, rubric = null, viewMode = 'descriptors', rubricPalette = {}, onSaved, onPendingChange, onDisplayChange, registerCard, unregisterCard }) {
```

Replace the `storageKey` line (line 110):

```js
  // Per-card DB draft saver (replaces the former localStorage key). Created once.
  const saverRef = useRef(null);
  if (!saverRef.current) {
    saverRef.current = makeDraftSaver(
      { assignmentId, studentId: student.id, enrollmentId: student.enrollment_id },
      { delay: 500 }
    );
  }
  // Set true by discrete handlers (proficiency / display) so the next autosave
  // flushes immediately instead of debouncing.
  const flushNextRef = useRef(false);
```

(`useRef` is already imported at line 1.)

- [ ] **Step 5: Restore from the prop instead of localStorage**

Replace the `restoredDraft` `useState` block (lines 127-135) with:

```js
  const [restoredDraft] = useState(() => {
    if (!draftRow) return null;
    // Stale: Schoology changed underneath the draft (#47). Ignore it; the mount
    // effect below deletes the orphaned server row.
    if (draftRow.base !== currentBaseline) return null;
    return draftRow;
  });
  const draftWasStale = Boolean(draftRow && draftRow.base !== currentBaseline);
```

- [ ] **Step 6: Replace the persist effect with the autosave effect**

Replace the localStorage persist effect (lines 214-220) with:

```js
  // Track whether this card has ever held a draft, so an untouched card does NOT
  // fire a spurious DELETE on first mount (only a real draft→clear transition does).
  const didDraftRef = useRef(Boolean(restoredDraft));

  // Mirror unsaved work to the DB. React state stays the instant UI source of
  // truth; this autosave is fire-and-forget. Typing debounces (~500ms); a
  // discrete proficiency/display change flushes immediately (flushNextRef).
  useEffect(() => {
    const saver = saverRef.current;
    if (hasPendingChanges) {
      didDraftRef.current = true;
      saver.save(
        { pending, comment, display, displayTouched, base: currentBaseline },
        { immediate: flushNextRef.current }
      );
    } else if (didDraftRef.current) {
      saver.remove();
    }
    flushNextRef.current = false;
  }, [hasPendingChanges, pending, comment, display, displayTouched, currentBaseline]);

  // Flush a pending save on tab-hide (sendBeacon) and on SPA unmount (keepalive);
  // delete a stale server draft once on mount.
  useEffect(() => {
    const saver = saverRef.current;
    if (draftWasStale) saver.remove({ immediate: true });
    const onPageHide = () => saver.flush({ beacon: true });
    const onVisibility = () => { if (document.visibilityState === 'hidden') saver.flush({ beacon: true }); };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      saver.flush({ keepalive: true });
      saver.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-time migration of a pre-DB localStorage draft for this card. If the
  // browser still holds the old key and the server has no draft, seed React
  // state from it (the autosave effect then persists it) and clear localStorage.
  useEffect(() => {
    if (draftRow) return;
    const legacyKey = `prism:assessment-draft:${courseId}:${assignmentId}:${student.enrollment_id}`;
    let legacy = null;
    try { const raw = localStorage.getItem(legacyKey); legacy = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    if (!legacy) return;
    try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
    if (legacy.base === currentBaseline) {
      flushNextRef.current = true;
      setPending(legacy.pending ?? {});
      setComment(legacy.comment ?? (student.grade_comment || ''));
      setDisplay(legacy.display ?? loadedDisplay);
      setDisplayTouched(legacy.displayTouched ?? false);
      setAutoFlipArmed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 7: Flag discrete changes for immediate flush**

In `selectLevel` (line 270), set the immediate flag at the top of the function body (after the `isRubricLocked` guard, line 271):

```js
    flushNextRef.current = true;
```

In `applyDisplay` (line 323), add at the top:

```js
    flushNextRef.current = true;
```

- [ ] **Step 8: Replace the explicit `clearDraft` calls**

In `applySendResult` (line 401) replace `clearDraft(storageKey);` with:

```js
      saverRef.current.remove({ immediate: true });
```

In `handleSave` (line 437) replace `clearDraft(storageKey);` with:

```js
      saverRef.current.remove({ immediate: true });
```

- [ ] **Step 9: Load drafts at page level and pass to cards**

In the page component, add a drafts state next to `feedbackByStudent`. Find the `feedbackByStudent` state declaration (grep `setFeedbackByStudent`) and add beside it:

```js
  const [draftByStudent, setDraftByStudent] = useState({});
```

In `load()` (line 1264), add the drafts fetch to the `Promise.all` and destructure it:

```js
  function load() {
    setLoading(true);
    Promise.all([
      getMasteryForAssignment(courseId, assignmentId),
      getFeedbackForAssignment(assignmentId).catch(() => ({})),
      getAssessmentAnalysis(assignmentId).catch(() => null),
      getDraftsForAssignment(assignmentId).catch(() => ({})),
    ])
      .then(([mastery, feedback, analysisRow, drafts]) => {
        setData(mastery);
        setFeedbackByStudent(feedback || {});
        setAnalysis(analysisRow || null);
        setDraftByStudent(drafts || {});
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }
```

Pass the prop in the `<StudentRubricCard>` render (after line 1403, `feedbackRow={…}`):

```jsx
              draftRow={draftByStudent[student.id] || null}
```

- [ ] **Step 10: Run the card test to verify it passes**

Run: `npx vitest run client/src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS (2 tests). If the badge matcher fails, fix the matcher string to the card's real pending-count copy (per the Step 1 note) and re-run.

- [ ] **Step 11: Run the full client + server suites to confirm no regressions**

Run: `npx vitest run`
Expected: PASS across the suite. (`assessmentDraft.test.js` still passes — its functions are removed in Task 7.)

- [ ] **Step 12: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(client): DB-backed autosave for assessment drafts (load-from-prop + flush)"
```

---

## Task 7: Remove dead localStorage helpers

**Files:**
- Modify: `client/src/lib/assessmentDraft.js` (drop `draftKey`/`readDraft`/`writeDraft`/`clearDraft`; keep `draftBaseline`)
- Modify: `client/src/lib/assessmentDraft.test.js` (drop the localStorage tests; keep `draftBaseline`)

- [ ] **Step 1: Confirm nothing still imports the localStorage helpers**

Run: `grep -rn "draftKey\|readDraft\|writeDraft\|clearDraft" client/src`
Expected: no matches (Task 6 removed the last usages). If any remain, fix them before continuing.

- [ ] **Step 2: Trim `assessmentDraft.js` to `draftBaseline` only**

Replace the entire contents of `client/src/lib/assessmentDraft.js` with:

```js
// Stale-draft detection for the /assessment/ page (#47). Draft persistence
// itself now lives in the DB (assessmentDraftSaver.js + /api/assessment-drafts);
// this signature lets a card detect when synced Schoology values changed
// underneath a stored draft so the stale draft is discarded.

// A deterministic signature of the synced Schoology values a draft was diffed
// against. Comparing a draft's stored signature to a freshly-recomputed one
// detects when Schoology data changed underneath the draft (#47).
export function draftBaseline(student, topics) {
  // Build `scores` from topic ids sorted (as strings) so JSON.stringify emits
  // keys in a stable order regardless of the `topics` array order — equal
  // synced state must always produce an equal signature.
  const scores = {};
  const sortedIds = topics
    .map((t) => t.id)
    .sort((a, b) => String(a).localeCompare(String(b)));
  for (const id of sortedIds) {
    scores[id] = student.scores?.[id]?.grade ?? null;
  }
  return JSON.stringify({
    grade_comment: student.grade_comment ?? '',
    comment_status: student.comment_status ?? null,
    exception: student.exception ?? null,
    scores,
  });
}
```

- [ ] **Step 3: Trim the test to `draftBaseline` only**

Replace the entire contents of `client/src/lib/assessmentDraft.test.js` with:

```js
import { describe, it, expect } from 'vitest';
import { draftBaseline } from './assessmentDraft.js';

describe('draftBaseline', () => {
  const topics = [{ id: 't1' }, { id: 't2' }];

  it('produces the same signature for equal synced state', () => {
    const s = { grade_comment: 'hi', comment_status: 1, exception: null, scores: { t1: { grade: 'ED' } } };
    expect(draftBaseline(s, topics)).toBe(draftBaseline({ ...s }, topics));
  });

  it('changes when the synced comment changes', () => {
    const a = { grade_comment: 'hi', comment_status: 1, exception: null, scores: {} };
    const b = { ...a, grade_comment: 'bye' };
    expect(draftBaseline(a, topics)).not.toBe(draftBaseline(b, topics));
  });

  it('changes when a synced topic score changes', () => {
    const a = { grade_comment: '', comment_status: 0, exception: null, scores: { t1: { grade: 'ED' } } };
    const b = { grade_comment: '', comment_status: 0, exception: null, scores: { t1: { grade: 'D' } } };
    expect(draftBaseline(a, topics)).not.toBe(draftBaseline(b, topics));
  });

  it('produces the same signature regardless of topic array order', () => {
    const student = {
      grade_comment: '', comment_status: 0, exception: null,
      scores: { t1: { grade: 'ED' }, t2: { grade: 'D' } },
    };
    const forward = [{ id: 't1' }, { id: 't2' }];
    const reversed = [{ id: 't2' }, { id: 't1' }];
    expect(draftBaseline(student, forward)).toBe(draftBaseline(student, reversed));
  });

  it('handles empty topics and a student with no scores', () => {
    const a = draftBaseline({ grade_comment: 'x', comment_status: 1, exception: null }, []);
    const b = draftBaseline({ grade_comment: 'x', comment_status: 1, exception: null, scores: {} }, []);
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 4: Run the trimmed test**

Run: `npx vitest run client/src/lib/assessmentDraft.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/assessmentDraft.js client/src/lib/assessmentDraft.test.js
git commit -m "refactor(client): drop localStorage draft helpers, keep draftBaseline"
```

---

## Task 8: Colour fix — draft cell = level `draftFill`

**Files:**
- Modify: `client/src/components/RubricDescriptorGrid.jsx` (new `levelDraftColors` prop; draft background)
- Create: `client/src/components/RubricDescriptorGrid.test.jsx`
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (pass the new prop)
- Modify: `docs/design-language.md` (record the decision)

- [ ] **Step 1: Write the failing test**

Create `client/src/components/RubricDescriptorGrid.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import RubricDescriptorGrid from './RubricDescriptorGrid.jsx';

const rows = [{ topic: { id: 't1', title: 'Generates media', category_title: 'Creating', external_id: 'ART.5.1' }, criterion: null }];
const levels = ['ED', 'EX'];
const headerColors = { ED: '#bfdbfe', EX: '#bbf7d0' };
const borderColors = { ED: '#2563eb', EX: '#16a34a' };
const draftColors = { ED: '#eff6ff', EX: '#f0fdf4' };

function renderGrid(cellState) {
  return render(
    <RubricDescriptorGrid
      rows={rows} levels={levels} cellState={cellState} onSelect={() => {}}
      palette={{}} levelHeaderColors={headerColors} levelBorderColors={borderColors}
      levelDraftColors={draftColors}
    />
  );
}

describe('RubricDescriptorGrid draft cell', () => {
  it('fills a draft cell with the level draftFill, not grey', () => {
    const { container } = renderGrid((topicId, l) => (l === 'ED' ? { draft: true } : {}));
    // First body row, first level cell (ED).
    const cell = container.querySelectorAll('tbody td')[1];
    // jsdom normalises hex to rgb: #eff6ff → rgb(239, 246, 255).
    expect(cell.style.background).toContain('rgb(239, 246, 255)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run client/src/components/RubricDescriptorGrid.test.jsx`
Expected: FAIL — the draft cell background is `var(--bg-subtle)`, not the draftFill.

- [ ] **Step 3: Add the prop and use it**

In `client/src/components/RubricDescriptorGrid.jsx`, add `levelDraftColors` to the props (line 5-7):

```js
export default function RubricDescriptorGrid({
  rows, levels, cellState, onSelect, palette, levelHeaderColors, levelBorderColors, levelDraftColors,
}) {
```

Change the draft branch background (line 45-46) from `background: 'var(--bg-subtle)'` to the level draft fill:

```js
              else if (st.draft) Object.assign(base, {
                outline: `2px dashed ${levelBorderColors[l]}`, outlineOffset: '-1px', background: levelDraftColors[l] });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run client/src/components/RubricDescriptorGrid.test.jsx`
Expected: PASS

- [ ] **Step 5: Pass the prop from the page**

In `client/src/pages/AssessmentSummaryPage.jsx`, in the `<RubricDescriptorGrid>` render (line 739-747), add after the `levelBorderColors` prop (line 746):

```jsx
            levelDraftColors={Object.fromEntries(LEVELS.map(l => [l, LEVEL_COLORS[l].draftFill]))}
```

- [ ] **Step 6: Record the decision in the design-language log**

Append to `docs/design-language.md`:

```markdown

## Draft proficiency cell fill (assessment rubric)

Selected-but-unpublished (draft) proficiency cells fill with the level's own
`draftFill` (a pale tint of its final `headerFill`, e.g. ED `#eff6ff` under
`#bfdbfe`) plus a dashed `finalBorder` outline — never the neutral
`var(--bg-subtle)` grey, which reads as the AI-suggestion wash. The descriptor
grid (`RubricDescriptorGrid`) takes a `levelDraftColors` prop so it matches the
inline-table path. A draft is a tentative version of *this* score, so it should
look like a lighter shade of the final colour, not a separate neutral state.
```

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS across server + client.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/RubricDescriptorGrid.jsx client/src/components/RubricDescriptorGrid.test.jsx client/src/pages/AssessmentSummaryPage.jsx docs/design-language.md
git commit -m "fix(rubric): draft cell uses level draftFill tint, not grey"
```

---

## Final verification

- [ ] **Run the full test suite:** `npx vitest run` — expect green.
- [ ] **Manual smoke (real app):** `npm run dev`, open an assignment on `/course/:id/assessment/:assignmentId`:
  - Select a proficiency → the cell shows a pale tint of that level's colour (not grey).
  - Reload the page → the draft pick + any typed comment are still there (now loaded from the DB).
  - Confirm the DB row exists: `sqlite3 server/db/students.db "SELECT assignment_id, student_id, substr(draft_json,1,80) FROM assessment_drafts;"`
  - Publish/discard → the row disappears.
  - Via the MCP, call `get_assignment_context` and confirm `draft_feedback` reflects the unsaved pick/comment.

## Spec coverage check

- Spec §1 (table) → Task 1. §2 (routes) → Task 2. §3 (client instant UI + autosave + load-from-prop + migration) → Tasks 4-7. §4 (MCP `draft_feedback`) → Task 3. §5 (colour) → Task 8. §6 (tests) → tests embedded in each task. ✅
