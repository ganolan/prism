# Resubmission Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a teacher-set "Re-submit requested" flag and an auto-detected "Resubmitted" indicator to Prism, surfaced across the gradebook, the assessment page, and the student page.

**Architecture:** Part A reuses the submission-scoped `flags` table with a new `flag_type = 'resubmit_requested'` (a pure toggle — no schema change). Part B adds one `grades.latest_revision_at` column, populated by the existing submission-status sync, and derives a `resubmitted` boolean at read time by comparing it to the grade timestamp. The two phases ship independently; Phase 1 (Part A) has no dependency on Phase 2 (Part B).

**Tech Stack:** Express + better-sqlite3 (server, ESM), React + Vite (client), Vitest for both suites (`npm run test:server`, `cd client && npm test -- --run`).

**Spec:** `docs/superpowers/specs/2026-05-17-resubmission-tracking-design.md`

---

## File Structure

**Phase 0 — shared styling**
- Modify `client/src/app.css` — new blue tint/ring CSS tokens (3 theme blocks) + two `.badge-*` modifier classes.

**Phase 1 — Part A (manual flag)**
- Modify `server/routes/flags.js` — relax `POST` validation; delete dead `resolve`/`reopen` routes.
- Create `server/routes/flags.test.js` — coverage for the new validation rules.
- Modify `client/src/services/api.js` — remove `resolveFlag` / `reopenFlag`.
- Modify `server/routes/courses.js` — `/gradebook` cells gain `resubmit_requested`.
- Modify `server/routes/mastery.js` — assignment endpoint students gain `resubmit_flag`.
- Modify `server/routes/courses.test.js` (create if absent) and `server/routes/mastery.test.js` — endpoint coverage.
- Modify `client/src/pages/AssessmentSummaryPage.jsx` — `StudentRubricCard` re-submit toggle.
- Modify `client/src/pages/CoursePage.jsx` — `GradebookView` cell tint.
- Modify `client/src/pages/StudentPage.jsx` — `CourseSection` re-submit pill.
- Modify the matching `*.test.jsx` files.

**Phase 2 — Part B (auto-detect)**
- Create `scripts/probe-revision-timestamps.js` — one-off verification probe.
- Modify `server/db/index.js` — `latest_revision_at` migration.
- Modify `server/services/schoology.js` — `getSubmissionStatus` also returns `latestSubmittedAt`.
- Modify `server/services/sync.js` — store `latest_revision_at`.
- Create `server/lib/resubmission.js` — `isResubmitted(grade)` helper.
- Create `server/lib/resubmission.test.js` — helper coverage.
- Modify `server/routes/courses.js`, `server/routes/mastery.js`, `server/routes/students.js` — endpoints expose `resubmitted`.
- Modify `client/src/pages/CoursePage.jsx`, `AssessmentSummaryPage.jsx`, `StudentPage.jsx` — `resubmitted` visual treatment.

---

## Phase 0 — Shared styling

### Task 1: Blue tint / ring CSS tokens and badge classes

**Files:**
- Modify: `client/src/app.css`

The app's existing `badge-blue` is actually the theme accent (purple in the Prism
theme), so it cannot be reused for a true blue. This task adds dedicated tokens.

- [ ] **Step 1: Add tokens to all three theme blocks**

`app.css` has three theme blocks: `:root` (Prism, light), `[data-theme="midnight"]`
(dark), and `[data-theme="ocean"]` (light). Each block defines a run of
`--badge-*-bg` / `--badge-*-text` variables ending with `--badge-pink-text`.
Immediately **after the `--badge-pink-text:` line in each block**, add the three
tokens for that block:

In `:root` (Prism):
```css
  --badge-resubmit-bg: #e6effe;
  --badge-resubmit-text: #1d4ed8;
  --resubmit-ring: #1d4ed8;
```

In `[data-theme="midnight"]`:
```css
  --badge-resubmit-bg: rgba(59, 130, 246, 0.18);
  --badge-resubmit-text: #93c5fd;
  --resubmit-ring: #60a5fa;
```

In `[data-theme="ocean"]`:
```css
  --badge-resubmit-bg: #e0f2fe;
  --badge-resubmit-text: #0369a1;
  --resubmit-ring: #0284c7;
```

- [ ] **Step 2: Add the two badge modifier classes**

Find the existing `.badge-amber` rule. Immediately after it, add:
```css
.badge-resubmit {
  background: var(--badge-resubmit-bg);
  color: var(--badge-resubmit-text);
}
.badge-resubmitted {
  background: var(--card-bg);
  color: var(--resubmit-ring);
  box-shadow: inset 0 0 0 1.5px var(--resubmit-ring);
}
```

- [ ] **Step 3: Verify the build still compiles**

Run: `cd client && npx vite build`
Expected: build completes with no CSS errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/app.css
git commit -m "feat(#49): blue tint/ring CSS tokens for resubmission badges"
```

---

## Phase 1 — Part A: teacher-set "Re-submit requested" flag

### Task 2: Relax `POST /api/flags` validation; remove dead resolve/reopen routes

**Files:**
- Modify: `server/routes/flags.js`
- Create: `server/routes/flags.test.js`

`flag_reason` is currently mandatory for every flag. `resubmit_requested` is a
pure toggle with no reason, so `flag_reason` must be required only for
`review_needed`. The `PUT /:id/resolve` and `/:id/reopen` routes have been
unreachable since #20/#19 and are removed.

- [ ] **Step 1: Write the failing test**

Create `server/routes/flags.test.js`:
```js
import { describe, test, expect, beforeEach } from 'vitest';
import express from 'express';

process.env.DB_PATH = ':memory:';

import router from './flags.js';
import { getDb } from '../db/index.js';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/flags', router);
  const server = app.listen(0);
  return { server, port: server.address().port };
}

async function call(method, path, body) {
  const { server, port } = startServer();
  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
}

let studentId;
let assignmentId;

beforeEach(() => {
  const db = getDb();
  db.exec(
    'DELETE FROM flags; DELETE FROM enrolments; DELETE FROM assignments; ' +
    'DELETE FROM students; DELETE FROM courses;'
  );
  const courseId = db.prepare(
    `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'Course')`
  ).run().lastInsertRowid;
  studentId = db.prepare(
    `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`
  ).run().lastInsertRowid;
  assignmentId = db.prepare(
    `INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`
  ).run(courseId).lastInsertRowid;
});

describe('POST /api/flags validation', () => {
  test('resubmit_requested flag is created without a flag_reason', async () => {
    const { status, body } = await call('POST', '/api/flags', {
      student_id: studentId,
      assignment_id: assignmentId,
      flag_type: 'resubmit_requested',
    });
    expect(status).toBe(201);
    expect(body.flag_type).toBe('resubmit_requested');
    expect(body.flag_reason).toBeNull();
  });

  test('resubmit_requested flag requires an assignment_id', async () => {
    const { status } = await call('POST', '/api/flags', {
      student_id: studentId,
      flag_type: 'resubmit_requested',
    });
    expect(status).toBe(400);
  });

  test('review_needed flag still requires a flag_reason', async () => {
    const { status } = await call('POST', '/api/flags', {
      student_id: studentId,
      assignment_id: assignmentId,
      flag_type: 'review_needed',
    });
    expect(status).toBe(400);
  });

  test('a flag with no student_id is rejected', async () => {
    const { status } = await call('POST', '/api/flags', {
      assignment_id: assignmentId,
      flag_type: 'resubmit_requested',
    });
    expect(status).toBe(400);
  });
});

describe('removed flag lifecycle routes', () => {
  test('PUT /:id/resolve is gone', async () => {
    const { status } = await call('PUT', '/api/flags/1/resolve');
    expect(status).toBe(404);
  });

  test('PUT /:id/reopen is gone', async () => {
    const { status } = await call('PUT', '/api/flags/1/reopen');
    expect(status).toBe(404);
  });
});

describe('DELETE /api/flags/:id', () => {
  test('removes a resubmit_requested flag', async () => {
    const created = await call('POST', '/api/flags', {
      student_id: studentId,
      assignment_id: assignmentId,
      flag_type: 'resubmit_requested',
    });
    const { status } = await call('DELETE', `/api/flags/${created.body.id}`);
    expect(status).toBe(200);
    expect(getDb().prepare('SELECT COUNT(*) c FROM flags').get().c).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:server -- flags.test.js`
Expected: FAIL — `resubmit_requested` without a reason currently returns 400; the
`PUT` routes still return 200.

- [ ] **Step 3: Rewrite the `POST` handler and delete the lifecycle routes**

In `server/routes/flags.js`, replace the `POST /` handler (lines 26-39) with:
```js
// POST /api/flags — create a flag
router.post('/', (req, res) => {
  const db = getDb();
  const { student_id, assignment_id, flag_type, flag_reason } = req.body;
  const type = flag_type || 'custom';
  if (!student_id) {
    return res.status(400).json({ error: 'student_id is required' });
  }
  if (type === 'review_needed' && !flag_reason?.trim()) {
    return res.status(400).json({ error: 'flag_reason is required for review_needed flags' });
  }
  if (type === 'resubmit_requested' && !assignment_id) {
    return res.status(400).json({ error: 'assignment_id is required for resubmit_requested flags' });
  }
  const result = db.prepare(`
    INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
    VALUES (?, ?, ?, ?)
  `).run(student_id, assignment_id || null, type, flag_reason?.trim() || null);
  const flag = db.prepare('SELECT * FROM flags WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(flag);
});
```

Delete the entire `PUT /:id/resolve` handler (lines 41-49) and the entire
`PUT /:id/reopen` handler (lines 51-59). Leave the `GET /` and
`DELETE /:id` handlers untouched.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:server -- flags.test.js`
Expected: PASS — all flag tests green.

- [ ] **Step 5: Run the full server suite (regression check)**

Run: `npm run test:server`
Expected: PASS — no other suite regressed.

- [ ] **Step 6: Commit**

```bash
git add server/routes/flags.js server/routes/flags.test.js
git commit -m "feat(#49): resubmit_requested flag type; drop dead resolve/reopen routes"
```

---

### Task 3: Remove `resolveFlag` / `reopenFlag` from the client API module

**Files:**
- Modify: `client/src/services/api.js`

- [ ] **Step 1: Delete the dead client helpers**

In `client/src/services/api.js`, delete these two lines (103-104):
```js
export const resolveFlag = (id) => request(`/flags/${id}/resolve`, { method: 'PUT' });
export const reopenFlag = (id) => request(`/flags/${id}/reopen`, { method: 'PUT' });
```
Leave `createFlag` and `deleteFlag` (lines 102, 105) in place.

- [ ] **Step 2: Confirm nothing imports the removed helpers**

Run: `grep -rn "resolveFlag\|reopenFlag" client/src`
Expected: no matches (StudentAnalytics / FlagsCard were removed in #19).

- [ ] **Step 3: Run the client suite (regression check)**

Run: `cd client && npm test -- --run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/services/api.js
git commit -m "refactor(#49): drop unreachable resolveFlag/reopenFlag client helpers"
```

---

### Task 4: Expose `resubmit_requested` on the gradebook and assignment endpoints

**Files:**
- Modify: `server/routes/courses.js` (`GET /:id/gradebook`)
- Modify: `server/routes/mastery.js` (`GET /:courseId/assignment/:assignmentId`)
- Modify: `server/routes/mastery.test.js`
- Create: `server/routes/courses.test.js`

- [ ] **Step 1: Write the failing gradebook test**

Create `server/routes/courses.test.js`:
```js
import { describe, test, expect, beforeEach } from 'vitest';
import express from 'express';

process.env.DB_PATH = ':memory:';

import router from './courses.js';
import { getDb } from '../db/index.js';

function startServer() {
  const app = express();
  app.use('/api/courses', router);
  const server = app.listen(0);
  return { server, port: server.address().port };
}

async function get(path) {
  const { server, port } = startServer();
  try {
    const res = await fetch(`http://localhost:${port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

let courseId;
let studentId;
let assignmentId;

beforeEach(() => {
  const db = getDb();
  db.exec(
    'DELETE FROM flags; DELETE FROM grades; DELETE FROM enrolments; ' +
    'DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
  );
  courseId = db.prepare(
    `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'Course')`
  ).run().lastInsertRowid;
  studentId = db.prepare(
    `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`
  ).run().lastInsertRowid;
  db.prepare(
    `INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-1')`
  ).run(studentId, courseId);
  assignmentId = db.prepare(
    `INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'sa-1', 'Project', 1)`
  ).run(courseId).lastInsertRowid;
  db.prepare(
    `INSERT INTO grades (student_id, assignment_id, score, max_score) VALUES (?, ?, 75, 100)`
  ).run(studentId, assignmentId);
});

describe('GET /api/courses/:id/gradebook — resubmit_requested', () => {
  test('cell resubmit_requested is false with no flag', async () => {
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].resubmit_requested).toBe(false);
  });

  test('cell resubmit_requested is true when the flag exists', async () => {
    getDb().prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type) VALUES (?, ?, 'resubmit_requested')`
    ).run(studentId, assignmentId);
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].resubmit_requested).toBe(true);
  });

  test('a review_needed flag does not set resubmit_requested', async () => {
    getDb().prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
       VALUES (?, ?, 'review_needed', 'check it')`
    ).run(studentId, assignmentId);
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].resubmit_requested).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:server -- courses.test.js`
Expected: FAIL — `resubmit_requested` is `undefined`.

- [ ] **Step 3: Implement the gradebook change**

In `server/routes/courses.js`, inside `GET /:id/gradebook`, immediately after the
`const grades = db.prepare(...).all(req.params.id);` block and before the
`// Index grades by student_id` comment, add:
```js
  // Submission-scoped 'resubmit requested' flags (#49, Part A). Prism-local.
  const resubmitFlags = db.prepare(`
    SELECT f.student_id, f.assignment_id
    FROM flags f
    JOIN assignments a ON a.id = f.assignment_id
    WHERE a.course_id = ? AND f.flag_type = 'resubmit_requested'
  `).all(req.params.id);
  const resubmitSet = new Set(resubmitFlags.map(f => `${f.student_id}:${f.assignment_id}`));
```

Then in the existing index loop, set the flag on each grade row:
```js
  // Index grades by student_id -> assignment_id
  const gradeMap = {};
  for (const g of grades) {
    if (!gradeMap[g.student_id]) gradeMap[g.student_id] = {};
    g.resubmit_requested = resubmitSet.has(`${g.student_id}:${g.assignment_id}`);
    gradeMap[g.student_id][g.assignment_id] = g;
  }
```

- [ ] **Step 4: Run the gradebook test to verify it passes**

Run: `npm run test:server -- courses.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing assignment-endpoint test**

In `server/routes/mastery.test.js`, inside the existing
`describe('GET /api/mastery/:courseId/assignment/:assignmentId — review flags', ...)`
block, add these tests after the last existing `test(...)`:
```js
  test('resubmit_flag is null when the student has no resubmit flag', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmit_flag).toBeNull();
  });

  test('resubmit_flag carries the id for a resubmit_requested flag', async () => {
    const db = getDb();
    const flagId = db.prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type)
       VALUES (?, ?, 'resubmit_requested')`
    ).run(studentId, assignmentInternalId).lastInsertRowid;
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmit_flag).toEqual({ id: flagId });
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm run test:server -- mastery.test.js`
Expected: FAIL — `resubmit_flag` is `undefined`.

- [ ] **Step 7: Implement the assignment-endpoint change**

In `server/routes/mastery.js`, immediately after the `reviewFlagMap` block (the
loop ending `reviewFlagMap[r.student_id] = ...`), add:
```js
  // Submission-scoped 'resubmit requested' flags for this assignment (#49).
  const resubmitFlagRows = assignmentRow
    ? db.prepare(`
        SELECT id, student_id FROM flags
        WHERE assignment_id = ? AND flag_type = 'resubmit_requested'
      `).all(assignmentRow.id)
    : [];
  const resubmitFlagMap = {};
  for (const r of resubmitFlagRows) {
    resubmitFlagMap[r.student_id] = { id: r.id };
  }
```

Then in the `students.map(...)` object, add a line next to `review_flag`:
```js
      review_flag: reviewFlagMap[s.id] || null,
      resubmit_flag: resubmitFlagMap[s.id] || null,
```

- [ ] **Step 8: Run the full server suite**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/routes/courses.js server/routes/courses.test.js server/routes/mastery.js server/routes/mastery.test.js
git commit -m "feat(#49): expose resubmit_requested flag on gradebook + assignment endpoints"
```

---

### Task 5: `StudentRubricCard` — the re-submit toggle

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx`
- Modify: `client/src/pages/AssessmentSummaryPage.test.jsx`

The card header gains a pure-toggle control: a ghost button when unflagged, a
tinted badge with an `✕` clear action when flagged. It mirrors the review-flag
control but has **no reason input**.

- [ ] **Step 1: Write the failing test**

In `client/src/pages/AssessmentSummaryPage.test.jsx`, add a new `describe` block
at the end of the file:
```js
describe('StudentRubricCard — re-submit requested toggle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the ghost toggle when no resubmit flag is set', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /request re-submit/i })).toBeInTheDocument();
  });

  it('creates a resubmit_requested flag with no reason on click', async () => {
    createFlag.mockResolvedValueOnce({ id: 71, flag_type: 'resubmit_requested', flag_reason: null });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /request re-submit/i }));
    await waitFor(() => {
      expect(createFlag).toHaveBeenCalledWith({
        student_id: 1,
        assignment_id: 50,
        flag_type: 'resubmit_requested',
      });
    });
    expect(await screen.findByText(/re-submit requested/i)).toBeInTheDocument();
  });

  it('clears the flag via the ✕ control', async () => {
    renderCard({ student: { ...makeStudent(), resubmit_flag: { id: 71 } } });
    fireEvent.click(screen.getByRole('button', { name: /clear re-submit request/i }));
    await waitFor(() => expect(deleteFlag).toHaveBeenCalledWith(71));
  });

  it('the flag write does not trigger a Schoology write', async () => {
    createFlag.mockResolvedValueOnce({ id: 71 });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /request re-submit/i }));
    await waitFor(() => expect(createFlag).toHaveBeenCalled());
    expect(writeMasteryScores).not.toHaveBeenCalled();
    expect(writeMasteryComment).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npm test -- --run AssessmentSummaryPage`
Expected: FAIL — no "request re-submit" button exists.

- [ ] **Step 3: Add state and handlers**

In `client/src/pages/AssessmentSummaryPage.jsx`, after the review-flag state
declarations (after `const [flagControlHover, setFlagControlHover] = useState(false);`),
add:
```js
  // Re-submit requested flag (#49) — Prism-local, submission-scoped, pure toggle.
  const [resubmitFlag, setResubmitFlag] = useState(student.resubmit_flag || null);
  const [resubmitBusy, setResubmitBusy] = useState(false);
  const [resubmitHover, setResubmitHover] = useState(false);
```

After `handleClearReviewFlag` (after its closing brace), add:
```js
  async function handleRequestResubmit() {
    if (!assignmentRow?.id || resubmitBusy) return;
    setResubmitBusy(true);
    try {
      const flag = await createFlag({
        student_id: student.id,
        assignment_id: assignmentRow.id,
        flag_type: 'resubmit_requested',
      });
      setResubmitFlag({ id: flag.id });
    } catch (err) {
      setFlagError(`Re-submit request failed: ${err.message}`);
    } finally {
      setResubmitBusy(false);
    }
  }

  async function handleClearResubmit() {
    if (!resubmitFlag || resubmitBusy) return;
    setResubmitBusy(true);
    try {
      await deleteFlag(resubmitFlag.id);
      setResubmitFlag(null);
    } catch (err) {
      setFlagError(`Clear failed: ${err.message}`);
    } finally {
      setResubmitBusy(false);
    }
  }
```

- [ ] **Step 4: Render the control**

In the card header, immediately after the review-flag block closes (after the
`)}` that ends the `reviewFlag ? ... : showFlagInput ? ... : (...)` ternary, and
before `{flagError && (`), add:
```jsx
        {/* Re-submit requested (#49) — Prism-local pure toggle; never part of a
            Schoology save. */}
        {resubmitFlag ? (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
            onMouseEnter={() => setResubmitHover(true)}
            onMouseLeave={() => setResubmitHover(false)}
          >
            <span className="badge badge-resubmit" style={{ fontSize: '0.68rem' }}>
              ⟳ Re-submit requested
            </span>
            <button
              className="ghost danger"
              onClick={handleClearResubmit}
              onFocus={() => setResubmitHover(true)}
              onBlur={() => setResubmitHover(false)}
              disabled={resubmitBusy}
              aria-label="Clear re-submit request"
              title="Clear re-submit request"
              style={{
                fontSize: '0.9rem', fontWeight: 600, lineHeight: 1,
                padding: '0.1rem 0.35rem',
                opacity: resubmitHover ? 1 : 0,
                transition: 'opacity 0.12s',
              }}
            >
              ✕
            </button>
          </span>
        ) : (
          <button
            className="ghost accent"
            onClick={handleRequestResubmit}
            disabled={resubmitBusy}
            style={{ fontSize: '0.7rem' }}
          >
            ⟳ Request re-submit
          </button>
        )}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && npm test -- --run AssessmentSummaryPage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(#49): re-submit requested toggle on the assessment card"
```

---

### Task 6: `GradebookView` — tint cells with a re-submit request

**Files:**
- Modify: `client/src/pages/CoursePage.jsx`

- [ ] **Step 1: Apply the tint to graded cells**

In `client/src/pages/CoursePage.jsx`, inside `GradebookView`, find the
`const cellStyle = lbl.kind === 'mismatch' ? ... : { textAlign: 'center' };`
line. Replace it with:
```js
                const cellStyle = lbl.kind === 'mismatch'
                  ? { textAlign: 'center', color: 'var(--danger)' }
                  : { textAlign: 'center' };
                if (g.resubmit_requested) {
                  cellStyle.background = 'var(--badge-resubmit-bg)';
                }
```

- [ ] **Step 2: Add a tooltip cue**

In the same cell `<td>`, the `title` attribute currently reads
`title={lbl.kind === 'mismatch' ? '...' : (g.grade_comment || '')}`. Replace that
expression with a helper computed just above the `return (`:
```js
                const cellTitle = g.resubmit_requested
                  ? 'Re-submit requested'
                  : (lbl.kind === 'mismatch'
                      ? 'Score does not match any defined level on this grading scale — check Schoology'
                      : (g.grade_comment || ''));
```
and change the `<td>`'s `title={...}` to `title={cellTitle}`.

- [ ] **Step 3: Verify the build compiles**

Run: `cd client && npx vite build`
Expected: build succeeds.

- [ ] **Step 4: Run the client suite (regression check)**

Run: `cd client && npm test -- --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/CoursePage.jsx
git commit -m "feat(#49): tint gradebook cells with a re-submit request"
```

---

### Task 7: `CourseSection` — re-submit pill on the student page

**Files:**
- Modify: `client/src/pages/StudentPage.jsx`
- Modify: `client/src/pages/StudentPage.test.jsx`

- [ ] **Step 1: Write the failing test**

`StudentPage.test.jsx` already has a `renderCourseSection(flagsByAssignment)`
helper and a `describe('CourseSection review flag badge', ...)` block. Add a new
test inside that block:
```js
  it('renders a re-submit requested pill for a resubmit_requested flag', () => {
    renderCourseSection({
      10: [{ id: 7, flag_type: 'resubmit_requested', assignment_id: 10, resolved: 0 }],
    });
    const pill = screen.getByText(/⟳ Re-submit requested/);
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('badge', 'badge-resubmit');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npm test -- --run StudentPage`
Expected: FAIL — a `resubmit_requested` flag currently renders via the generic
`badge-red` branch as the text "resubmit requested" (one underscore replaced), so
the `⟳ Re-submit requested` text and `badge-resubmit` class are absent.

- [ ] **Step 3: Add the specific flag branch**

In `client/src/pages/StudentPage.jsx`, inside `CourseSection`'s
`assignmentFlags.map(flag => { ... })`, immediately after the
`if (flag.flag_type === 'review_needed') { ... }` block, add:
```js
                        if (flag.flag_type === 'resubmit_requested') {
                          return (
                            <span key={flag.id} className="badge badge-resubmit" style={{ fontSize: '0.68rem' }}>
                              ⟳ Re-submit requested
                            </span>
                          );
                        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npm test -- --run StudentPage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/StudentPage.jsx client/src/pages/StudentPage.test.jsx
git commit -m "feat(#49): re-submit requested pill on the student page"
```

---

### Phase 1 checkpoint

- [ ] Run `npm run test:server` — expect PASS.
- [ ] Run `cd client && npm test -- --run` — expect PASS.
- [ ] Manual smoke (optional): `npm run dev`, set a re-submit request on the
  assessment page, confirm the badge appears there, the gradebook cell tints,
  and the student-page row shows the pill.

Phase 1 (Part A) is complete and shippable on its own. Phase 2 follows.

---

## Phase 2 — Part B: auto-detect resubmissions

### Task 8: Verification probe — confirm the timestamp model holds

**Files:**
- Create: `scripts/probe-revision-timestamps.js`

Part B compares `grades.submitted_at` (populated from the Schoology grade
`timestamp`) against the latest submission revision's `created` time. This task
**empirically confirms** that `submitted_at` is the grade-modified time and that
both values are comparable Unix epochs. If the assumption fails, **stop** — the
spec's fallback (`graded_revision_id` baseline) requires a re-plan.

- [ ] **Step 1: Write the probe script**

Create `scripts/probe-revision-timestamps.js`:
```js
// One-off probe (#49 Part B). Usage: node scripts/probe-revision-timestamps.js <sectionId>
// Prints, for each graded dropbox assignment+student in the section: the stored
// grades.submitted_at, and the live Schoology revision[] created timestamps.
import { getDb } from '../server/db/index.js';
import { apiGet } from '../server/services/schoology.js';

const sectionId = process.argv[2];
if (!sectionId) { console.error('Usage: node scripts/probe-revision-timestamps.js <sectionId>'); process.exit(1); }

const db = getDb();
const course = db.prepare('SELECT id FROM courses WHERE schoology_section_id = ?').get(sectionId);
if (!course) { console.error('No course for section', sectionId); process.exit(1); }

const rows = db.prepare(`
  SELECT s.schoology_uid, a.schoology_assignment_id, g.submitted_at, g.score
  FROM grades g
  JOIN students s ON s.id = g.student_id
  JOIN assignments a ON a.id = g.assignment_id
  WHERE a.course_id = ? AND g.score IS NOT NULL
  LIMIT 10
`).all(course.id);

for (const r of rows) {
  try {
    const data = await apiGet(`/sections/${sectionId}/submissions/${r.schoology_assignment_id}/${r.schoology_uid}`);
    const revs = (data?.revision || []).map(x => ({ id: x.revision_id, created: x.created, draft: x.draft }));
    console.log(JSON.stringify({ uid: r.schoology_uid, aid: r.schoology_assignment_id, submitted_at: r.submitted_at, revisions: revs }));
  } catch (e) {
    console.log(JSON.stringify({ uid: r.schoology_uid, aid: r.schoology_assignment_id, error: e.message }));
  }
}
```
(If `apiGet` is not an exported member of `server/services/schoology.js`, export
it — it is used internally by every function in that file.)

- [ ] **Step 2: Run the probe against a real section**

Run: `node scripts/probe-revision-timestamps.js <a-real-sectionId>`
(Pick a section id from `SELECT schoology_section_id FROM courses` in the dev DB.)

- [ ] **Step 3: Verify the assumption and record the finding**

Confirm from the output:
1. `submitted_at` and revision `created` are both 10-digit Unix epoch seconds
   (same unit, directly comparable).
2. For a normally-graded row with no resubmission, `submitted_at` is **>= the
   latest non-draft revision's `created`** (the grade was entered after the
   submission). This confirms `submitted_at` tracks grade time, not submission time.

Append a short "Part B verification" note to
`docs/superpowers/specs/2026-05-17-resubmission-tracking-design.md` recording the
result.

**Decision gate:** if either check fails, STOP and re-plan Part B against the
`graded_revision_id` baseline approach. If both hold, continue.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-revision-timestamps.js docs/superpowers/specs/2026-05-17-resubmission-tracking-design.md
git commit -m "chore(#49): probe + confirm grade/revision timestamp model for Part B"
```

---

### Task 9: `latest_revision_at` migration and the `isResubmitted` helper

**Files:**
- Modify: `server/db/index.js`
- Create: `server/lib/resubmission.js`
- Create: `server/lib/resubmission.test.js`

- [ ] **Step 1: Add the migration**

In `server/db/index.js`, append one entry to the `MIGRATIONS` array, after the
`submitted_at` entry and before the `CREATE INDEX` entries:
```js
  // Issue #49: latest non-draft submission revision time, for resubmission
  // auto-detect. Compared against submitted_at (grade time) at read time.
  `ALTER TABLE grades ADD COLUMN latest_revision_at INTEGER DEFAULT 0`,
```

- [ ] **Step 2: Write the failing helper test**

Create `server/lib/resubmission.test.js`:
```js
import { describe, test, expect } from 'vitest';
import { isResubmitted } from './resubmission.js';

describe('isResubmitted', () => {
  test('true when latest revision is newer than the grade time', () => {
    expect(isResubmitted({ score: 80, submitted_at: 1000, latest_revision_at: 2000 })).toBe(true);
  });

  test('false when the latest revision predates the grade time', () => {
    expect(isResubmitted({ score: 80, submitted_at: 2000, latest_revision_at: 1000 })).toBe(false);
  });

  test('false when there is no grade (score null, no exception)', () => {
    expect(isResubmitted({ score: null, submitted_at: 1000, latest_revision_at: 2000 })).toBe(false);
  });

  test('true for an exception row that was resubmitted against', () => {
    expect(isResubmitted({ score: null, exception: 4, submitted_at: 1000, latest_revision_at: 2000 })).toBe(true);
  });

  test('false when submitted_at is 0 (grade time unknown)', () => {
    expect(isResubmitted({ score: 80, submitted_at: 0, latest_revision_at: 2000 })).toBe(false);
  });

  test('false when latest_revision_at is 0 (no revision data)', () => {
    expect(isResubmitted({ score: 80, submitted_at: 1000, latest_revision_at: 0 })).toBe(false);
  });

  test('false for null / undefined input', () => {
    expect(isResubmitted(null)).toBe(false);
    expect(isResubmitted(undefined)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test:server -- resubmission.test.js`
Expected: FAIL — `./resubmission.js` does not exist.

- [ ] **Step 4: Implement the helper**

Create `server/lib/resubmission.js`:
```js
// Resubmission detection (#49, Part B). A row counts as "resubmitted since last
// graded" when the latest non-draft submission revision is newer than the grade
// timestamp. Guards: a grade must exist, and the grade time must be known.
export function isResubmitted(grade) {
  if (!grade) return false;
  const submittedAt = Number(grade.submitted_at) || 0;
  const latestRevisionAt = Number(grade.latest_revision_at) || 0;
  if (submittedAt <= 0 || latestRevisionAt <= 0) return false;
  const hasGrade = grade.score != null || (Number(grade.exception) || 0) > 0;
  if (!hasGrade) return false;
  return latestRevisionAt > submittedAt;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:server -- resubmission.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/index.js server/lib/resubmission.js server/lib/resubmission.test.js
git commit -m "feat(#49): latest_revision_at migration + isResubmitted helper"
```

---

### Task 10: Sync — store `latest_revision_at`

**Files:**
- Modify: `server/services/schoology.js`
- Modify: `server/services/sync.js`

- [ ] **Step 1: Extend `getSubmissionStatus`**

In `server/services/schoology.js`, replace the body of `getSubmissionStatus`
with:
```js
export async function getSubmissionStatus(sectionId, assignmentId, userId) {
  const data = await apiGet(`/sections/${sectionId}/submissions/${assignmentId}/${userId}`);
  const revisions = data?.revision || [];
  if (!revisions.length) return null;
  const latest = revisions.reduce((m, r) => (r.revision_id > m.revision_id ? r : m));
  // Baseline for resubmission detection (#49): newest *non-draft* revision time.
  // A draft revision is not a submission and must not seed the baseline.
  const latestSubmittedAt = revisions
    .filter(r => Number(r.draft) !== 1)
    .reduce((m, r) => Math.max(m, Number(r.created) || 0), 0);
  return { ...latest, latestSubmittedAt };
}
```

- [ ] **Step 2: Add the column to `upsertSubmissionStatus`**

In `server/services/sync.js`, replace the `upsertSubmissionStatus` prepared
statement with:
```js
  const upsertSubmissionStatus = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, exception, late, draft, latest_revision_at, synced_at)
    VALUES (?, ?, ?, NULL, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      late = excluded.late,
      draft = excluded.draft,
      latest_revision_at = excluded.latest_revision_at,
      synced_at = excluded.synced_at
  `);
```

- [ ] **Step 3: Zero the column in `clearSubmissionStatus`**

Replace the `clearSubmissionStatus` statement with:
```js
  const clearSubmissionStatus = db.prepare(`
    UPDATE grades SET late = 0, draft = 0, latest_revision_at = 0, synced_at = ?
    WHERE student_id = ? AND assignment_id = ?
  `);
```

- [ ] **Step 4: Pass the new value in the `upsertSubmissionStatus.run` call**

Replace the `upsertSubmissionStatus.run(...)` call with:
```js
        upsertSubmissionStatus.run(
          studentRow.id, assignRow.id, String(e.id),
          assignRow.max_points ?? null,
          revision.late ? 1 : 0,
          revision.draft ? 1 : 0,
          revision.latestSubmittedAt || 0,
          now,
        );
```

- [ ] **Step 5: Run the full server suite (regression check)**

Run: `npm run test:server`
Expected: PASS — `syncOrchestrator.test.js` and others still green.

- [ ] **Step 6: Commit**

```bash
git add server/services/schoology.js server/services/sync.js
git commit -m "feat(#49): sync stores latest non-draft revision time on grades"
```

---

### Task 11: Endpoints expose the `resubmitted` indicator

**Files:**
- Modify: `server/routes/courses.js` + `server/routes/courses.test.js`
- Modify: `server/routes/mastery.js` + `server/routes/mastery.test.js`
- Modify: `server/routes/students.js`

- [ ] **Step 1: Write the failing gradebook test**

In `server/routes/courses.test.js`, add a new `describe` block:
```js
describe('GET /api/courses/:id/gradebook — resubmitted', () => {
  test('cell resubmitted is true when the latest revision is newer than the grade', async () => {
    const db = getDb();
    db.prepare('UPDATE grades SET submitted_at = 1000, latest_revision_at = 2000 WHERE student_id = ? AND assignment_id = ?')
      .run(studentId, assignmentId);
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].resubmitted).toBe(true);
  });

  test('cell resubmitted is false when the grade postdates the revision', async () => {
    const db = getDb();
    db.prepare('UPDATE grades SET submitted_at = 2000, latest_revision_at = 1000 WHERE student_id = ? AND assignment_id = ?')
      .run(studentId, assignmentId);
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].resubmitted).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:server -- courses.test.js`
Expected: FAIL — `resubmitted` is `undefined`.

- [ ] **Step 3: Implement the gradebook change**

In `server/routes/courses.js`, add the import at the top of the file:
```js
import { isResubmitted } from '../lib/resubmission.js';
```
The gradebook `grades` SELECT already returns `g.submitted_at`; add
`g.latest_revision_at` to its column list. Then in the index loop set the field:
```js
  for (const g of grades) {
    if (!gradeMap[g.student_id]) gradeMap[g.student_id] = {};
    g.resubmit_requested = resubmitSet.has(`${g.student_id}:${g.assignment_id}`);
    g.resubmitted = isResubmitted(g);
    gradeMap[g.student_id][g.assignment_id] = g;
  }
```

- [ ] **Step 4: Run the gradebook test to verify it passes**

Run: `npm run test:server -- courses.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing assignment-endpoint test**

In `server/routes/mastery.test.js`, inside the review-flags `describe` block,
add:
```js
  test('resubmitted is true when the latest revision postdates the grade', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, score, submitted_at, latest_revision_at)
       VALUES (?, ?, 80, 1000, 2000)`
    ).run(studentId, assignmentInternalId);
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmitted).toBe(true);
  });

  test('resubmitted is false with no newer revision', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmitted).toBe(false);
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm run test:server -- mastery.test.js`
Expected: FAIL — `resubmitted` is `undefined`.

- [ ] **Step 7: Implement the assignment-endpoint change**

In `server/routes/mastery.js`, add the import at the top:
```js
import { isResubmitted } from '../lib/resubmission.js';
```
Add `g.score, g.submitted_at, g.latest_revision_at` to the `gradeRows` SELECT
column list (`s.schoology_uid` is already selected by that query). After
the existing `commentMap` / `exceptionMap` loop, build a resubmission map:
```js
  const resubmittedMap = {};
  for (const c of gradeRows) {
    resubmittedMap[c.schoology_uid] = isResubmitted(c);
  }
```
Then in the `students.map(...)` object add:
```js
      resubmit_flag: resubmitFlagMap[s.id] || null,
      resubmitted: resubmittedMap[s.schoology_uid] === true,
```

- [ ] **Step 8: Implement the student-endpoint change**

In `server/routes/students.js`, add the import at the top:
```js
import { isResubmitted } from '../lib/resubmission.js';
```
The `grades` SELECT already returns `g.submitted_at`; add `g.latest_revision_at`
to its column list. In the existing `for (const g of grades) { ... }` loop
(around line 119), add:
```js
    g.resubmitted = isResubmitted(g);
```

- [ ] **Step 9: Run the full server suite**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/routes/courses.js server/routes/courses.test.js server/routes/mastery.js server/routes/mastery.test.js server/routes/students.js
git commit -m "feat(#49): expose resubmitted indicator on gradebook, assignment + student endpoints"
```

---

### Task 12: `GradebookView` — inset ring for resubmitted cells

**Files:**
- Modify: `client/src/pages/CoursePage.jsx`

- [ ] **Step 1: Apply the inset ring**

In `client/src/pages/CoursePage.jsx`, in `GradebookView`, extend the `cellStyle`
block added in Task 6 so it also handles `resubmitted`:
```js
                if (g.resubmit_requested) {
                  cellStyle.background = 'var(--badge-resubmit-bg)';
                }
                if (g.resubmitted) {
                  cellStyle.boxShadow = 'inset 0 0 0 2px var(--resubmit-ring)';
                }
```

- [ ] **Step 2: Extend the tooltip cue**

Update the `cellTitle` helper from Task 6 so resubmitted is named:
```js
                const signalTitle = [
                  g.resubmit_requested ? 'Re-submit requested' : null,
                  g.resubmitted ? 'Resubmitted since last graded' : null,
                ].filter(Boolean).join(' · ');
                const cellTitle = signalTitle
                  || (lbl.kind === 'mismatch'
                      ? 'Score does not match any defined level on this grading scale — check Schoology'
                      : (g.grade_comment || ''));
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd client && npx vite build`
Expected: build succeeds.

- [ ] **Step 4: Run the client suite (regression check)**

Run: `cd client && npm test -- --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/CoursePage.jsx
git commit -m "feat(#49): inset ring on resubmitted gradebook cells"
```

---

### Task 13: `StudentRubricCard` — resubmitted pill and combined emphasis

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx`
- Modify: `client/src/pages/AssessmentSummaryPage.test.jsx`

- [ ] **Step 1: Write the failing test**

In `client/src/pages/AssessmentSummaryPage.test.jsx`, add to the
re-submit `describe` block:
```js
  it('shows a read-only Resubmitted pill when student.resubmitted is true', () => {
    renderCard({ student: { ...makeStudent(), resubmitted: true } });
    const pill = screen.getByText(/resubmitted/i);
    expect(pill).toBeInTheDocument();
    expect(pill.tagName).not.toBe('BUTTON');
  });

  it('does not show the Resubmitted pill when student.resubmitted is false', () => {
    renderCard({ student: { ...makeStudent(), resubmitted: false } });
    expect(screen.queryByText(/^↩ Resubmitted$/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npm test -- --run AssessmentSummaryPage`
Expected: FAIL — no Resubmitted pill is rendered.

- [ ] **Step 3: Render the pill**

In `client/src/pages/AssessmentSummaryPage.jsx`, immediately after the
re-submit toggle block added in Task 5 (after its closing `)}`), add:
```jsx
        {student.resubmitted && (
          <span className="badge badge-resubmitted" style={{ fontSize: '0.68rem' }}
                title="The student has submitted new work since this was last graded">
            ↩ Resubmitted
          </span>
        )}
```

- [ ] **Step 4: Add the combined-signal card emphasis**

The card's outermost `<div>` (the `return (` root) has
`border: '1px solid var(--border)'`. Compute a flag just before `return (`:
```js
  const bothSignals = !!resubmitFlag && !!student.resubmitted;
```
Then change the outer `<div>` style so the border and a ring reflect it:
```jsx
    <div style={{
      border: bothSignals ? '1px solid var(--resubmit-ring)' : '1px solid var(--border)',
      boxShadow: bothSignals ? '0 0 0 2px var(--badge-resubmit-bg)' : undefined,
      borderRadius: 10,
      background: 'var(--card-bg)', overflow: 'hidden',
      marginBottom: '1rem',
    }}>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && npm test -- --run AssessmentSummaryPage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(#49): resubmitted pill + combined-signal emphasis on the assessment card"
```

---

### Task 14: `CourseSection` — resubmitted pill on the student page

**Files:**
- Modify: `client/src/pages/StudentPage.jsx`
- Modify: `client/src/pages/StudentPage.test.jsx`

`resubmitted` is a per-grade boolean (`g.resubmitted`), not a flag, so it renders
from the grade row rather than from `assignmentFlags`.

- [ ] **Step 1: Extend the test helper and write the failing test**

`resubmitted` lives on the grade row, but `StudentPage.test.jsx`'s
`renderCourseSection` helper hardcodes the grade. Extend the helper signature to
accept grade overrides — change `function renderCourseSection(flagsByAssignment) {`
to `function renderCourseSection(flagsByAssignment, gradeOverrides = {}) {` and
add `...gradeOverrides,` as the last property of the grade object literal (after
`mastery: null,`). Existing callers are unaffected (default `{}`).

Then add a test to the `CourseSection` `describe` block:
```js
  it('renders a Resubmitted pill when the grade row has resubmitted=true', () => {
    renderCourseSection({}, { resubmitted: true });
    const pill = screen.getByText(/↩ Resubmitted/);
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('badge', 'badge-resubmitted');
  });

  it('renders no Resubmitted pill when resubmitted is absent', () => {
    renderCourseSection({});
    expect(screen.queryByText(/↩ Resubmitted/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npm test -- --run StudentPage`
Expected: FAIL — no Resubmitted pill is rendered.

- [ ] **Step 3: Render the pill**

In `client/src/pages/StudentPage.jsx`, inside `CourseSection`, in the
"Due + flags row" `<div>`, immediately after the `assignmentFlags.map(...)`
block closes (after its `)}`), add:
```jsx
                      {g.resubmitted && (
                        <span className="badge badge-resubmitted" style={{ fontSize: '0.68rem' }}
                              title="The student has submitted new work since this was last graded">
                          ↩ Resubmitted
                        </span>
                      )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npm test -- --run StudentPage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/StudentPage.jsx client/src/pages/StudentPage.test.jsx
git commit -m "feat(#49): resubmitted pill on the student page"
```

---

### Phase 2 checkpoint

- [ ] Run `npm run test:server` — expect PASS.
- [ ] Run `cd client && npm test -- --run` — expect PASS.
- [ ] Manual smoke (optional): `npm run dev`, run a course sync, confirm a row
  whose latest revision postdates its grade shows the inset ring in the
  gradebook, the `↩ Resubmitted` pill on the assessment card and student page,
  and that a row with both signals shows the combined card emphasis.

---

## Final verification

- [ ] `npm run test:server` — full server suite green.
- [ ] `cd client && npm test -- --run` — full client suite green.
- [ ] `cd client && npx vite build` — production build succeeds.
- [ ] Confirm no hardcoded hex values were added to components — all colours go
  through the `--badge-resubmit-*` / `--resubmit-ring` tokens (per `CLAUDE.md`).
- [ ] Hand off via `superpowers:finishing-a-development-branch`.
