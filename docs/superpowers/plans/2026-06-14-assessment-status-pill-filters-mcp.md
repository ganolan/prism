# Assessment status pill, filters, and MCP exposure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a prominent per-student submission-status pill on the assessment summary page, add a grouped filter row (submission status, grading completeness, visibility, review flag, resubmit tag), and expose the same submission/grading/flag state through the Prism MCP.

**Architecture:** Status computation stays client-side and reuses `client/src/lib/gradeLabel.js` verbatim (byte-identical to the gradebook). One shared query (`getGradeMetaRows`) carries the raw status columns to both the assessment route and the MCP. The MCP returns a normalized readiness state (no colour logic). Pure filter/normalization logic lives in small testable modules (`client/src/lib/assessmentFilters.js`; server helpers in `assessmentContext.js`); presentational pieces are isolated components.

**Tech Stack:** Express + better-sqlite3 (server, ESM), React 18 + Vite (client), Vitest + React Testing Library (tests). MCP via `@modelcontextprotocol/sdk` in `mcp/`.

**Spec:** `docs/superpowers/specs/2026-06-14-assessment-status-pill-filters-mcp-design.md`

**Conventions to honor:** colours via CSS custom properties only (never hex in components); dates `en-GB`; new backend logic gets a `*.test.js` beside it, frontend gets a client test; commit per task.

---

## File Structure

**Server / MCP**
- Modify `server/services/assessmentContext.js` — extend `getGradeMetaRows` SELECT; add pure helpers `normalizeSubmissionStatus`, `gradingState`; add `getFlagsByStudent`; enrich the `getAssessmentContext` per-student object.
- Modify `server/routes/mastery.js` — add raw status fields to the assessment-page per-student payload.
- Modify `mcp/handlers.js` — add `submission_counts` + `grading_counts` to `listAssignments`.
- Tests: `server/services/assessmentContext.test.js`, `server/routes/mastery.test.js`, `mcp/handlers.test.js` (all exist — extend).

**Client**
- Create `client/src/lib/assessmentFilters.js` — pure: normalized submission state, grading state, pill→tone, group definitions, predicates, counts, `TONE_VARS`.
- Create `client/src/components/SubmissionStatusPill.jsx` — prominent per-card status pill.
- Create `client/src/components/AssessmentFilterBar.jsx` — grouped filter pills.
- Modify `client/src/pages/AssessmentSummaryPage.jsx` — render the pill in the card header; render the filter bar and filter the roster.
- Tests: create `client/src/lib/assessmentFilters.test.js`, `client/src/components/SubmissionStatusPill.test.jsx`, `client/src/components/AssessmentFilterBar.test.jsx`; extend `client/src/pages/AssessmentSummaryPage.test.jsx`.

**Docs**
- Modify `docs/design-language.md`.

**Canonical helper signatures (use exactly these names/shapes across tasks):**
- Server: `normalizeSubmissionStatus({ is_lti_submission, lti_submission_state, submission_type, submitted_at }) → 'submitted'|'in_progress'|'not_started'|'unknown'`
- Server: `gradingState({ scoredCount, topicsCount, hasComment, exception }) → 'ungraded'|'partial'|'complete'`
- Server: `getFlagsByStudent(db, assignmentLocalId) → { [student_id]: { review_needed: { reason } | null, resubmit_requested: boolean } }`
- Client: `normalizedSubmissionState(student, assignment)`, `gradingStateOf(student, topics)`, `studentMatchesPill(student, pillId, { assignment, topics })`, `passesFilters(student, activeSet, { assignment, topics })`, `countMatches(students, pillId, { assignment, topics })`, `filterGroups(assignment)`, `pillTone(pillId, assignment)`, `TONE_VARS`.

Run commands from the repo root. Server/MCP tests: `npx vitest run <path>`. Client tests: `cd client && npx vitest run <path>` (jsdom env is configured in `client/vite.config.js`).

---

## Task 1: Carry submission-status columns through `getGradeMetaRows`

**Files:**
- Modify: `server/services/assessmentContext.js:81-90`
- Test: `server/services/assessmentContext.test.js`

- [ ] **Step 1: Write the failing test**

Add to `server/services/assessmentContext.test.js` (it already imports `getDb`; add `getGradeMetaRows` to the import from `./assessmentContext.js`):

```js
describe('getGradeMetaRows', () => {
  test('selects the submission-status columns', () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-g', 'ROB')`).run().lastInsertRowid;
    const assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-g', 'Notebook')`).run(courseId).lastInsertRowid;
    const studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-g', 'Grace', 'Hopper')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-g')`).run(studentId, courseId);
    db.prepare(`INSERT INTO grades (student_id, assignment_id, lti_submission_state, submission_type, late, draft, submitted_at)
                VALUES (?, ?, 'in_progress', 'drop', 1, 0, 123)`).run(studentId, assignmentId);

    const rows = getGradeMetaRows(db, 'sa-g');
    expect(rows[0]).toMatchObject({
      schoology_uid: 'uid-g',
      lti_submission_state: 'in_progress',
      submission_type: 'drop',
      late: 1,
      draft: 0,
    });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run server/services/assessmentContext.test.js -t "selects the submission-status columns"`
Expected: FAIL — `lti_submission_state` is `undefined` (column not selected).

- [ ] **Step 3: Add the columns to the SELECT**

In `server/services/assessmentContext.js`, change `getGradeMetaRows`:

```js
export function getGradeMetaRows(db, assignmentSchoologyId) {
  return db.prepare(`
    SELECT s.schoology_uid, g.score, g.submitted_at, g.latest_revision_at,
           g.grade_comment, g.exception, g.comment_status,
           g.lti_submission_state, g.submission_type, g.late, g.draft
    FROM grades g
    JOIN students s ON s.id = g.student_id
    JOIN assignments a ON a.id = g.assignment_id
    WHERE a.schoology_assignment_id = ?
  `).all(assignmentSchoologyId);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run server/services/assessmentContext.test.js -t "selects the submission-status columns"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/assessmentContext.js server/services/assessmentContext.test.js
git commit -m "feat(assessment-context): carry submission-status columns in getGradeMetaRows"
```

---

## Task 2: Server normalization helpers (`normalizeSubmissionStatus`, `gradingState`)

**Files:**
- Modify: `server/services/assessmentContext.js` (add two exported functions near the top, after the imports)
- Test: `server/services/assessmentContext.test.js`

- [ ] **Step 1: Write the failing tests**

Add `normalizeSubmissionStatus, gradingState` to the import, then add:

```js
describe('normalizeSubmissionStatus', () => {
  test('LTI uses lti_submission_state', () => {
    expect(normalizeSubmissionStatus({ is_lti_submission: 1, lti_submission_state: 'in_progress' })).toBe('in_progress');
    expect(normalizeSubmissionStatus({ is_lti_submission: 1, lti_submission_state: 'submitted' })).toBe('submitted');
  });
  test('LTI with no state but a submission_type counts as submitted', () => {
    expect(normalizeSubmissionStatus({ is_lti_submission: 1, lti_submission_state: null, submission_type: 'drop' })).toBe('submitted');
  });
  test('LTI with nothing is unknown', () => {
    expect(normalizeSubmissionStatus({ is_lti_submission: 1, lti_submission_state: null, submission_type: null })).toBe('unknown');
  });
  test('non-LTI is submitted vs not_started only', () => {
    expect(normalizeSubmissionStatus({ is_lti_submission: 0, submission_type: 'drop' })).toBe('submitted');
    expect(normalizeSubmissionStatus({ is_lti_submission: 0, submitted_at: 5 })).toBe('submitted');
    expect(normalizeSubmissionStatus({ is_lti_submission: 0, submission_type: null, submitted_at: 0 })).toBe('not_started');
  });
});

describe('gradingState', () => {
  test('excepted is complete regardless of scores', () => {
    expect(gradingState({ scoredCount: 0, topicsCount: 3, hasComment: false, exception: 3 })).toBe('complete');
  });
  test('all topics scored + comment is complete', () => {
    expect(gradingState({ scoredCount: 3, topicsCount: 3, hasComment: true, exception: 0 })).toBe('complete');
  });
  test('nothing entered is ungraded', () => {
    expect(gradingState({ scoredCount: 0, topicsCount: 3, hasComment: false, exception: 0 })).toBe('ungraded');
  });
  test('some topics missing a level is partial', () => {
    expect(gradingState({ scoredCount: 2, topicsCount: 3, hasComment: true, exception: 0 })).toBe('partial');
  });
  test('all scored but no comment is partial', () => {
    expect(gradingState({ scoredCount: 3, topicsCount: 3, hasComment: false, exception: 0 })).toBe('partial');
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run server/services/assessmentContext.test.js -t "normalizeSubmissionStatus"`
Expected: FAIL — `normalizeSubmissionStatus is not a function`.

- [ ] **Step 3: Implement the helpers**

In `server/services/assessmentContext.js`, add after the imports (before `getAlignedTopics`):

```js
// Normalized submission readiness (no colour/due-date logic — that is the
// gradebook's client concern). LTI: the authoritative lti_submission_state, or
// 'submitted' when only a corroborating submission_type exists (mirrors
// gradeLabel.ltiBadges), else 'unknown'. Non-LTI: only submitted-or-not is
// knowable.
export function normalizeSubmissionStatus({ is_lti_submission, lti_submission_state, submission_type, submitted_at } = {}) {
  if (is_lti_submission) {
    const s = lti_submission_state || (submission_type ? 'submitted' : null);
    return s || 'unknown';
  }
  return (submission_type || Number(submitted_at) > 0) ? 'submitted' : 'not_started';
}

// Grading completeness on the published finals. Excepted students (rubric
// locked) count as handled → 'complete'. Complete = every aligned topic has a
// level AND a comment is present. Empty = nothing entered. Otherwise partial.
export function gradingState({ scoredCount, topicsCount, hasComment, exception } = {}) {
  if (exception) return 'complete';
  if (scoredCount === 0 && !hasComment) return 'ungraded';
  if (topicsCount > 0 && scoredCount === topicsCount && hasComment) return 'complete';
  return 'partial';
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run server/services/assessmentContext.test.js -t "normalizeSubmissionStatus"` then `-t "gradingState"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/assessmentContext.js server/services/assessmentContext.test.js
git commit -m "feat(assessment-context): add normalizeSubmissionStatus + gradingState helpers"
```

---

## Task 3: `getFlagsByStudent` helper

**Files:**
- Modify: `server/services/assessmentContext.js` (add exported function near the other readers)
- Test: `server/services/assessmentContext.test.js`

- [ ] **Step 1: Write the failing test**

Add `getFlagsByStudent` to the import, then:

```js
describe('getFlagsByStudent', () => {
  test('groups review and resubmit flags by student_id, only unresolved', () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-f', 'ROB')`).run().lastInsertRowid;
    const assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-f', 'NB')`).run(courseId).lastInsertRowid;
    const sId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-f', 'Ada', 'L')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason, resolved) VALUES (?, ?, 'review_needed', 'check sources', 0)`).run(sId, assignmentId);
    db.prepare(`INSERT INTO flags (student_id, assignment_id, flag_type, resolved) VALUES (?, ?, 'resubmit_requested', 0)`).run(sId, assignmentId);
    db.prepare(`INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason, resolved) VALUES (?, ?, 'review_needed', 'old', 1)`).run(sId, assignmentId);

    const byStudent = getFlagsByStudent(db, assignmentId);
    expect(byStudent[sId]).toEqual({
      review_needed: { reason: 'check sources' },
      resubmit_requested: true,
    });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run server/services/assessmentContext.test.js -t "getFlagsByStudent"`
Expected: FAIL — `getFlagsByStudent is not a function`.

- [ ] **Step 3: Implement the helper**

In `server/services/assessmentContext.js`, add (e.g. after `getGradeMetaRows`):

```js
// Unresolved Prism-local flags for an assignment (local id), grouped by
// student_id. review_needed carries its reason; resubmit_requested is a boolean.
export function getFlagsByStudent(db, assignmentLocalId) {
  const rows = db.prepare(`
    SELECT student_id, flag_type, flag_reason FROM flags
    WHERE assignment_id = ? AND resolved = 0
      AND flag_type IN ('review_needed', 'resubmit_requested')
  `).all(assignmentLocalId);
  const byStudent = {};
  for (const r of rows) {
    const entry = byStudent[r.student_id] || { review_needed: null, resubmit_requested: false };
    if (r.flag_type === 'review_needed') entry.review_needed = { reason: r.flag_reason || '' };
    if (r.flag_type === 'resubmit_requested') entry.resubmit_requested = true;
    byStudent[r.student_id] = entry;
  }
  return byStudent;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run server/services/assessmentContext.test.js -t "getFlagsByStudent"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/assessmentContext.js server/services/assessmentContext.test.js
git commit -m "feat(assessment-context): add getFlagsByStudent reader"
```

---

## Task 4: Enrich the MCP `get_assignment_context` per-student object

**Files:**
- Modify: `server/services/assessmentContext.js` (the `getAssessmentContext` function, `:149-228`)
- Test: `server/services/assessmentContext.test.js`

- [ ] **Step 1: Write the failing test**

The existing `seedContext` student is fully graded (one aligned topic scored `EX` + comment `Nice work`) and has `comment_status = 1`. Add:

```js
test('per-student includes submission_status, grading_state, is_lti, due_date, and flags', () => {
  const db = getDb();
  const { assignmentId, studentId } = seedContext(db);
  // Make the assignment LTI with a due date and a submitted state for the student.
  db.prepare(`UPDATE assignments SET is_lti_submission = 1, due_date = '2026-06-01' WHERE id = ?`).run(assignmentId);
  db.prepare(`UPDATE grades SET lti_submission_state = 'submitted' WHERE student_id = ? AND assignment_id = ?`).run(studentId, assignmentId);
  db.prepare(`INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason, resolved) VALUES (?, ?, 'review_needed', 'verify build', 0)`).run(studentId, assignmentId);

  const ctx = getAssessmentContext(db, { courseId: ctx_course(db), assignmentId: 'sa-1' });
  const s = ctx.students[0];
  expect(s.submission_status).toBe('submitted');
  expect(s.grading_state).toBe('complete'); // one aligned topic scored + comment present
  expect(s.is_lti).toBe(true);
  expect(s.due_date).toBe('2026-06-01');
  expect(s.flags).toEqual({ review_needed: { reason: 'verify build' }, resubmit_requested: false });
});

// helper: re-read the course id the seed created (seedContext returns it)
function ctx_course(db) {
  return db.prepare(`SELECT course_id FROM assignments WHERE schoology_assignment_id = 'sa-1'`).get().course_id;
}
```

(If a `courseId` is already in scope from `seedContext`, use that instead of `ctx_course`; `getAssessmentContext` only uses `assignmentId` to resolve, so `courseId` is informational.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run server/services/assessmentContext.test.js -t "submission_status, grading_state"`
Expected: FAIL — `s.submission_status` is `undefined`.

- [ ] **Step 3: Implement the enrichment**

In `getAssessmentContext`, (a) load flags once after `drafts`:

```js
  const flagsByStudent = getFlagsByStudent(db, assignmentRow.id);
```

(b) inside the `roster.map((st) => { ... })`, after `const draft = drafts[st.id];` compute:

```js
    const currentScores = Object.fromEntries(
      Object.entries(scoreMap[st.schoology_uid] || {}).map(([topicId, sc]) => [topicId, { level: sc.grade }])
    );
    const grading_state = gradingState({
      scoredCount: Object.keys(currentScores).length,
      topicsCount: topics.length,
      hasComment: (meta.grade_comment || '').trim().length > 0,
      exception: meta.exception ?? 0,
    });
```

(c) in the returned object, replace the inline `current_scores` with `currentScores` and add the new fields:

```js
      current_scores: currentScores,
      grade_comment: meta.grade_comment || '',
      display_to_student: (meta.comment_status ?? null) === 1,
      exception: meta.exception ?? 0,
      submission_status: normalizeSubmissionStatus({
        is_lti_submission: assignmentRow.is_lti_submission,
        lti_submission_state: meta.lti_submission_state,
        submission_type: meta.submission_type,
        submitted_at: meta.submitted_at,
      }),
      grading_state,
      is_lti: !!assignmentRow.is_lti_submission,
      due_date: assignmentRow.due_date ?? null,
      flags: flagsByStudent[st.id] || { review_needed: null, resubmit_requested: false },
```

(Leave `existing_suggestion` and `draft_feedback` as they are.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run server/services/assessmentContext.test.js -t "submission_status, grading_state"`
Expected: PASS. Also run the whole file to confirm the existing `composes …` test still passes (the `current_scores` value is unchanged): `npx vitest run server/services/assessmentContext.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/assessmentContext.js server/services/assessmentContext.test.js
git commit -m "feat(mcp): expose submission_status, grading_state, is_lti, due_date, flags per student"
```

---

## Task 5: `list_assignments` submission + grading counts

**Files:**
- Modify: `mcp/handlers.js:25-45`
- Test: `mcp/handlers.test.js`

- [ ] **Step 1: Write the failing test**

Add to the `describe('listAssignments', ...)` block in `mcp/handlers.test.js` (reuse `seedCourse`):

```js
test('returns submission_counts and grading_counts', () => {
  const db = getDb();
  const courseId = seedCourse(db);
  const aId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission, due_date) VALUES (?, 'sa-c', 'NB', 1, '2026-06-01')`).run(courseId).lastInsertRowid;
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', NULL, ?, 'T1', 'Topic')`).run(courseId);
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-c', 't1', ?)`).run(courseId);
  const mk = (uid, state) => {
    const sId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'F', 'L')`).run(uid).lastInsertRowid;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, lti_submission_state) VALUES (?, ?, ?)`).run(sId, aId, state);
    return sId;
  };
  mk('u1', 'submitted'); mk('u2', 'in_progress'); mk('u3', 'not_started');

  const rows = listAssignments(db, { course_id: courseId });
  const nb = rows.find(r => r.schoology_assignment_id === 'sa-c');
  expect(nb.submission_counts).toMatchObject({ submitted: 1, in_progress: 1, not_started: 1, total: 3 });
  expect(nb.grading_counts).toMatchObject({ ungraded: 3, partial: 0, complete: 0 });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run mcp/handlers.test.js -t "submission_counts and grading_counts"`
Expected: FAIL — `nb.submission_counts` is `undefined`.

- [ ] **Step 3: Implement the counts**

In `mcp/handlers.js`, add a small helper above `listAssignments` and call it per row. Counts are derived in JS from `grades` rows (keeps the SQL simple and reuses the same normalization shape as the per-student path):

```js
// Per-assignment readiness rollup. Submission: LTI uses lti_submission_state,
// non-LTI collapses to submitted/not_started. Grading: all aligned topics
// levelled + a comment ⇒ complete; nothing ⇒ ungraded; otherwise partial
// (excepted ⇒ complete). Computed in JS over the grade rows for clarity.
function assignmentCounts(db, assignmentRow) {
  const topicsCount = db.prepare(`
    SELECT COUNT(*) AS n FROM mastery_alignments WHERE assignment_schoology_id = ? AND course_id = ?
  `).get(assignmentRow.schoology_assignment_id, assignmentRow.course_id).n;
  const scoredByUid = {};
  for (const r of db.prepare(`SELECT student_uid, COUNT(*) AS n FROM mastery_scores WHERE assignment_schoology_id = ? GROUP BY student_uid`).all(assignmentRow.schoology_assignment_id)) {
    scoredByUid[r.student_uid] = r.n;
  }
  const rows = db.prepare(`
    SELECT s.schoology_uid, g.lti_submission_state, g.submission_type, g.submitted_at,
           g.grade_comment, g.exception
    FROM grades g JOIN students s ON s.id = g.student_id
    WHERE g.assignment_id = ?
  `).all(assignmentRow.id);
  const submission = { submitted: 0, in_progress: 0, not_started: 0, unknown: 0, total: rows.length };
  const grading = { ungraded: 0, partial: 0, complete: 0 };
  for (const r of rows) {
    const ss = normalizeSubmissionStatus({
      is_lti_submission: assignmentRow.is_lti_submission,
      lti_submission_state: r.lti_submission_state,
      submission_type: r.submission_type,
      submitted_at: r.submitted_at,
    });
    submission[ss] = (submission[ss] ?? 0) + 1;
    const gs = gradingState({
      scoredCount: scoredByUid[r.schoology_uid] || 0,
      topicsCount,
      hasComment: (r.grade_comment || '').trim().length > 0,
      exception: r.exception ?? 0,
    });
    grading[gs === 'complete' ? 'complete' : gs === 'partial' ? 'partial' : 'ungraded'] += 1;
  }
  return { submission_counts: submission, grading_counts: grading };
}
```

Import the helpers at the top of `mcp/handlers.js`:

```js
import { normalizeSubmissionStatus, gradingState } from '../server/services/assessmentContext.js';
```

Then change the `listAssignments` SELECT to also fetch `a.is_lti_submission`, and map the counts in. Replace the body with:

```js
export function listAssignments(db, { course_id }) {
  const rows = db.prepare(`
    SELECT a.id, a.schoology_assignment_id, a.title, a.due_date, a.assignment_type, a.is_lti_submission, a.course_id,
           EXISTS (
             SELECT 1 FROM mastery_alignments ma
             WHERE ma.assignment_schoology_id = a.schoology_assignment_id
               AND ma.course_id = a.course_id
           ) AS has_aligned_topics,
           (SELECT MAX(g.submitted_at) FROM grades g WHERE g.assignment_id = a.id) AS latest_submitted_at
    FROM assignments a
    WHERE a.course_id = ?
    ORDER BY a.due_date, a.id
  `).all(Number(course_id));
  return rows.map(({ latest_submitted_at, course_id: _c, is_lti_submission, ...r }) => ({
    ...r,
    has_aligned_topics: !!r.has_aligned_topics,
    latest_submission_at: latest_submitted_at > 0 ? new Date(latest_submitted_at * 1000).toISOString() : null,
    ...assignmentCounts(db, { id: r.id, schoology_assignment_id: r.schoology_assignment_id, course_id: _c, is_lti_submission }),
  }));
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run mcp/handlers.test.js -t "submission_counts and grading_counts"` then the whole file `npx vitest run mcp/handlers.test.js` (confirm the existing `has_aligned_topics` test still passes).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/handlers.js mcp/handlers.test.js
git commit -m "feat(mcp): add submission_counts + grading_counts to list_assignments"
```

---

## Task 6: Assessment route payload — raw status fields

**Files:**
- Modify: `server/routes/mastery.js:413-466`
- Test: `server/routes/mastery.test.js`

- [ ] **Step 1: Write the failing test**

Open `server/routes/mastery.test.js`, find the test that exercises `GET /:courseId/assignment/:assignmentId` (it seeds a course/assignment/student/grade and asserts the student payload). Add a focused test mirroring that file's existing setup helper. Concretely, add:

```js
test('per-student payload carries raw submission-status fields', async () => {
  // <follow this file's existing seed helper to create a course, an LTI
  //  assignment 'sa-1', and one student with a grades row>, then:
  db.prepare(`UPDATE assignments SET is_lti_submission = 1, due_date = '2026-06-01' WHERE schoology_assignment_id = 'sa-1'`).run();
  db.prepare(`UPDATE grades SET lti_submission_state = 'in_progress', submission_type = 'drop', late = 1, draft = 0 WHERE student_id = ?`).run(studentId);

  const res = await request(app).get('/api/mastery/' + courseId + '/assignment/sa-1');
  const s = res.body.students.find(x => x.schoology_uid === 'uid-1');
  expect(s).toMatchObject({ lti_submission_state: 'in_progress', submission_type: 'drop', late: 1, draft: 0 });
  expect(res.body.assignment).toMatchObject({ is_lti_submission: 1, due_date: '2026-06-01' });
});
```

(Match the variable names — `app`, `db`, `courseId`, `studentId`, `request` — to those already established at the top of `mastery.test.js`.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run server/routes/mastery.test.js -t "raw submission-status fields"`
Expected: FAIL — `s.lti_submission_state` is `undefined`.

- [ ] **Step 3: Add the fields to the payload**

In `server/routes/mastery.js`, extend the maps built from `gradeRows` (the `for (const c of gradeRows)` loop, `:419-425`) and the per-student object (`:456-466`). Add four maps:

```js
  const ltiStateMap = {};
  const submissionTypeMap = {};
  const lateMap = {};
  const draftMap = {};
  const submittedAtMap = {};
  for (const c of gradeRows) {
    commentMap[c.schoology_uid] = c.grade_comment || '';
    exceptionMap[c.schoology_uid] = c.exception ?? 0;
    commentStatusMap[c.schoology_uid] = c.comment_status ?? null;
    hasGradeRowMap[c.schoology_uid] = true;
    resubmittedMap[c.schoology_uid] = isResubmitted(c);
    ltiStateMap[c.schoology_uid] = c.lti_submission_state ?? null;
    submissionTypeMap[c.schoology_uid] = c.submission_type ?? null;
    lateMap[c.schoology_uid] = c.late ?? 0;
    draftMap[c.schoology_uid] = c.draft ?? 0;
    submittedAtMap[c.schoology_uid] = c.submitted_at ?? 0;
  }
```

Then in `students.map(s => ({ ... }))` add:

```js
      lti_submission_state: ltiStateMap[s.schoology_uid] ?? null,
      submission_type: submissionTypeMap[s.schoology_uid] ?? null,
      late: lateMap[s.schoology_uid] ?? 0,
      draft: draftMap[s.schoology_uid] ?? 0,
      submitted_at: submittedAtMap[s.schoology_uid] ?? 0,
```

(`assignment.is_lti_submission` and `assignment.due_date` are already returned because the route returns the full `assignmentRow`.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run server/routes/mastery.test.js -t "raw submission-status fields"` then the whole file.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/mastery.js server/routes/mastery.test.js
git commit -m "feat(mastery-route): carry raw submission-status fields in per-student payload"
```

---

## Task 7: Client pure filter library

**Files:**
- Create: `client/src/lib/assessmentFilters.js`
- Test: `client/src/lib/assessmentFilters.test.js`

- [ ] **Step 1: Write the failing tests**

Create `client/src/lib/assessmentFilters.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  normalizedSubmissionState, gradingStateOf, studentMatchesPill, passesFilters,
  countMatches, filterGroups, pillTone, TONE_VARS,
} from './assessmentFilters.js';

const LTI = { is_lti_submission: 1, due_date: '2026-06-01' };
const NON_LTI = { is_lti_submission: 0, due_date: '2026-06-01' };
const TOPICS = [{ id: 't1' }, { id: 't2' }];

const stu = (over = {}) => ({
  scores: {}, grade_comment: '', exception: 0, comment_status: 0,
  lti_submission_state: null, submission_type: null, submitted_at: 0,
  review_flag: null, resubmit_flag: null, ...over,
});

describe('normalizedSubmissionState', () => {
  it('LTI reads lti_submission_state', () => {
    expect(normalizedSubmissionState(stu({ lti_submission_state: 'in_progress' }), LTI)).toBe('in_progress');
  });
  it('LTI null is unknown', () => expect(normalizedSubmissionState(stu(), LTI)).toBe('unknown'));
  it('non-LTI is submitted vs not_started', () => {
    expect(normalizedSubmissionState(stu({ submission_type: 'drop' }), NON_LTI)).toBe('submitted');
    expect(normalizedSubmissionState(stu(), NON_LTI)).toBe('not_started');
  });
});

describe('gradingStateOf', () => {
  it('all topics + comment is complete', () =>
    expect(gradingStateOf(stu({ scores: { t1: { grade: 'EX' }, t2: { grade: 'D' } }, grade_comment: 'x' }), TOPICS)).toBe('complete'));
  it('nothing is ungraded', () => expect(gradingStateOf(stu(), TOPICS)).toBe('ungraded'));
  it('some missing is partial', () =>
    expect(gradingStateOf(stu({ scores: { t1: { grade: 'EX' } }, grade_comment: 'x' }), TOPICS)).toBe('partial'));
  it('excepted is complete', () => expect(gradingStateOf(stu({ exception: 3 }), TOPICS)).toBe('complete'));
});

describe('passesFilters (OR within group, AND across groups)', () => {
  const ctx = { assignment: LTI, topics: TOPICS };
  const submittedUngraded = stu({ lti_submission_state: 'submitted' });
  it('empty filter set shows everyone', () => {
    expect(passesFilters(submittedUngraded, new Set(), ctx)).toBe(true);
  });
  it('Submitted + Ungraded keeps a submitted-and-ungraded student', () => {
    expect(passesFilters(submittedUngraded, new Set(['submitted', 'ungraded']), ctx)).toBe(true);
  });
  it('Submitted + Graded drops a submitted-but-ungraded student (AND across groups)', () => {
    expect(passesFilters(submittedUngraded, new Set(['submitted', 'graded']), ctx)).toBe(false);
  });
  it('OR within the status group', () => {
    const inProgress = stu({ lti_submission_state: 'in_progress' });
    expect(passesFilters(inProgress, new Set(['submitted', 'in_progress']), ctx)).toBe(true);
  });
});

describe('filterGroups', () => {
  it('LTI assignment has three status pills', () =>
    expect(filterGroups(LTI)[0].pills.map(p => p.id)).toEqual(['submitted', 'in_progress', 'not_started']));
  it('non-LTI assignment has only the Submitted status pill', () =>
    expect(filterGroups(NON_LTI)[0].pills.map(p => p.id)).toEqual(['submitted']));
});

describe('countMatches', () => {
  it('counts students matching a single pill', () => {
    const students = [stu({ lti_submission_state: 'submitted' }), stu({ lti_submission_state: 'submitted' }), stu({ lti_submission_state: 'not_started' })];
    expect(countMatches(students, 'submitted', { assignment: LTI, topics: TOPICS })).toBe(2);
  });
});

describe('pillTone / TONE_VARS', () => {
  it('submitted is green; not_started overdue is red', () => {
    const overdue = { is_lti_submission: 1, due_date: '2000-01-01' };
    expect(pillTone('submitted', overdue)).toBe('green');
    expect(pillTone('not_started', overdue)).toBe('red');
  });
  it('every tone has CSS vars', () => {
    ['green', 'blue', 'amber', 'yellow', 'red', 'neutral', 'resubmit'].forEach(t => {
      expect(TONE_VARS[t]).toHaveProperty('bg');
      expect(TONE_VARS[t]).toHaveProperty('text');
    });
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd client && npx vitest run src/lib/assessmentFilters.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the library**

Create `client/src/lib/assessmentFilters.js`:

```js
// Pure filter + normalization logic for the assessment summary page. Mirrors the
// server's normalizeSubmissionStatus/gradingState (kept per-side, like the
// proficiency-scale derivation) and reuses gradeLabel for due-date-aware pill
// tones so the filter pills match the gradebook badges exactly.

import { submissionStatus } from './gradeLabel.js';

// Tone → CSS-var pairs. Mirrors BADGE_TONE_CLASS in CoursePage / SubmissionBadges
// (amber→pink, yellow→amber) so colours stay consistent, plus a resubmit tone.
export const TONE_VARS = {
  green:    { bg: 'var(--badge-green-bg)',    text: 'var(--badge-green-text)' },
  blue:     { bg: 'var(--badge-blue-bg)',     text: 'var(--badge-blue-text)' },
  amber:    { bg: 'var(--badge-pink-bg)',     text: 'var(--badge-pink-text)' },
  yellow:   { bg: 'var(--badge-amber-bg)',    text: 'var(--badge-amber-text)' },
  red:      { bg: 'var(--badge-red-bg)',      text: 'var(--badge-red-text)' },
  neutral:  { bg: 'var(--badge-gray-bg)',     text: 'var(--badge-gray-text)' },
  resubmit: { bg: 'var(--badge-resubmit-bg)', text: 'var(--badge-resubmit-text)' },
};

export function normalizedSubmissionState(student, assignment) {
  if (assignment.is_lti_submission) {
    const s = student.lti_submission_state || (student.submission_type ? 'submitted' : null);
    return s || 'unknown';
  }
  return (student.submission_type || Number(student.submitted_at) > 0) ? 'submitted' : 'not_started';
}

export function gradingStateOf(student, topics) {
  if (student.exception) return 'complete';
  const scores = student.scores || {};
  const scoredCount = topics.filter(t => scores[t.id] != null).length;
  const hasComment = (student.grade_comment || '').trim().length > 0;
  if (scoredCount === 0 && !hasComment) return 'ungraded';
  if (topics.length === 0) return 'complete'; // no rubric topics to score; a comment-bearing row is handled (matches server gradingState)
  if (scoredCount === topics.length && hasComment) return 'complete';
  return 'partial';
}

const STATUS_PILLS_LTI = [
  { id: 'submitted', label: 'Submitted' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'not_started', label: 'Not Started' },
];
const STATUS_PILLS_NONLTI = [{ id: 'submitted', label: 'Submitted' }];

export function filterGroups(assignment) {
  return [
    { key: 'status', pills: assignment.is_lti_submission ? STATUS_PILLS_LTI : STATUS_PILLS_NONLTI },
    { key: 'grading', pills: [
      { id: 'ungraded', label: 'Ungraded' },
      { id: 'partial', label: 'Partially graded' },
      { id: 'graded', label: 'Graded' },
    ] },
    { key: 'visibility', pills: [
      { id: 'visible', label: 'Visible' },
      { id: 'not_visible', label: 'Not visible' },
    ] },
    { key: 'flag', pills: [{ id: 'review', label: 'Flag for review' }] },
    { key: 'resubmit', pills: [{ id: 'resubmit', label: 'Ask to resubmit' }] },
  ];
}

const GRADING_PILL_STATE = { ungraded: 'ungraded', partial: 'partial', graded: 'complete' };

export function studentMatchesPill(student, pillId, { assignment, topics }) {
  switch (pillId) {
    case 'submitted':
    case 'in_progress':
    case 'not_started':
      return normalizedSubmissionState(student, assignment) === pillId;
    case 'ungraded':
    case 'partial':
    case 'graded':
      return gradingStateOf(student, topics) === GRADING_PILL_STATE[pillId];
    case 'visible':
      return student.comment_status === 1;
    case 'not_visible':
      return student.comment_status !== 1;
    case 'review':
      return student.review_flag != null;
    case 'resubmit':
      return student.resubmit_flag != null;
    default:
      return true;
  }
}

export function passesFilters(student, activeSet, ctx) {
  for (const group of filterGroups(ctx.assignment)) {
    const activePills = group.pills.filter(p => activeSet.has(p.id));
    if (activePills.length === 0) continue; // group imposes no constraint
    if (!activePills.some(p => studentMatchesPill(student, p.id, ctx))) return false;
  }
  return true;
}

export function countMatches(students, pillId, ctx) {
  return students.filter(s => studentMatchesPill(s, pillId, ctx)).length;
}

const NONSTATUS_TONE = {
  ungraded: 'neutral', partial: 'yellow', graded: 'green',
  visible: 'blue', not_visible: 'neutral',
  review: 'yellow', resubmit: 'resubmit',
};

// Status pills take the gradebook's due-date-aware tone for a hypothetical
// student in that state; non-status pills use a fixed tone.
export function pillTone(pillId, assignment) {
  if (pillId === 'submitted' || pillId === 'in_progress' || pillId === 'not_started') {
    const base = {
      score: null, exception: 0, late: 0, draft: 0, submitted_at: 0,
      is_lti_submission: !!assignment.is_lti_submission, due_date: assignment.due_date,
    };
    const synthetic = pillId === 'submitted'
      ? { ...base, lti_submission_state: 'submitted', submission_type: 'drop' }
      : { ...base, lti_submission_state: pillId };
    const badges = submissionStatus(synthetic);
    return badges[0]?.tone || (pillId === 'submitted' ? 'green' : pillId === 'in_progress' ? 'blue' : 'neutral');
  }
  return NONSTATUS_TONE[pillId] || 'neutral';
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd client && npx vitest run src/lib/assessmentFilters.test.js`
Expected: PASS (all groups).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/assessmentFilters.js client/src/lib/assessmentFilters.test.js
git commit -m "feat(assessment-filters): pure submission/grading/visibility filter logic"
```

---

## Task 8: `SubmissionStatusPill` component

**Files:**
- Create: `client/src/components/SubmissionStatusPill.jsx`
- Test: `client/src/components/SubmissionStatusPill.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `client/src/components/SubmissionStatusPill.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SubmissionStatusPill from './SubmissionStatusPill.jsx';

const LTI = { is_lti_submission: 1, due_date: '2026-06-01', lti_fetch_status: 'ok' };

const stu = (over = {}) => ({
  exception: 0, late: 0, draft: 0, submitted_at: 0,
  submission_type: null, lti_submission_state: null, ...over,
});

describe('SubmissionStatusPill', () => {
  it('shows "Submitted" for a submitted LTI student', () => {
    render(<SubmissionStatusPill student={stu({ lti_submission_state: 'submitted' })} assignment={LTI} />);
    expect(screen.getByText('Submitted')).toBeInTheDocument();
  });
  it('shows "In Progress"', () => {
    render(<SubmissionStatusPill student={stu({ lti_submission_state: 'in_progress' })} assignment={LTI} />);
    expect(screen.getByText('In Progress')).toBeInTheDocument();
  });
  it('renders nothing when status is unknown and fetch was ok', () => {
    const { container } = render(<SubmissionStatusPill student={stu()} assignment={LTI} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows an unavailable affordance when the LTI fetch failed', () => {
    render(<SubmissionStatusPill student={stu()} assignment={{ ...LTI, lti_fetch_status: 'failed' }} />);
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd client && npx vitest run src/components/SubmissionStatusPill.test.jsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `client/src/components/SubmissionStatusPill.jsx`:

```jsx
// Prominent per-student submission-status pill for the assessment summary page.
// Reuses gradeLabel.submissionStatus so the colours + due-date rules match the
// gradebook exactly. Always computes the submission badge (score: null) because
// here the pill and the grade coexist — the rubric grid shows the grade.

import { submissionStatus, ltiStatusUnavailable } from '../lib/gradeLabel.js';
import { TONE_VARS } from '../lib/assessmentFilters.js';

const PILL = {
  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
  height: '1.7rem', boxSizing: 'border-box', padding: '0 0.7rem',
  borderRadius: 999, fontSize: '0.78rem', fontWeight: 700, whiteSpace: 'nowrap',
};

export default function SubmissionStatusPill({ student, assignment }) {
  const badges = submissionStatus({
    score: null,
    exception: student.exception ?? 0,
    late: student.late,
    draft: student.draft,
    submitted_at: student.submitted_at,
    submission_type: student.submission_type,
    is_lti_submission: assignment.is_lti_submission,
    lti_submission_state: student.lti_submission_state,
    due_date: assignment.due_date,
  });

  if (badges.length === 0) {
    if (ltiStatusUnavailable({
      is_lti_submission: assignment.is_lti_submission,
      lti_fetch_status: assignment.lti_fetch_status,
      score: null,
      exception: student.exception ?? 0,
    })) {
      return (
        <span style={{ ...PILL, background: 'var(--warning-light)', color: 'var(--warning)', border: '2px solid var(--warning)' }}
          title="Prism couldn't read the submission status for this assignment at the last sync — re-sync to refresh.">
          ⚠ Status unavailable
        </span>
      );
    }
    return null;
  }

  return (
    <span style={{ display: 'inline-flex', gap: '0.35rem' }}>
      {badges.map(b => {
        const v = TONE_VARS[b.tone] || TONE_VARS.neutral;
        return (
          <span key={b.kind} style={{ ...PILL, background: v.bg, color: v.text, border: `1px solid ${v.text}` }}>
            {b.label}
          </span>
        );
      })}
    </span>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd client && npx vitest run src/components/SubmissionStatusPill.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SubmissionStatusPill.jsx client/src/components/SubmissionStatusPill.test.jsx
git commit -m "feat(assessment-page): prominent SubmissionStatusPill (reuses gradeLabel)"
```

---

## Task 9: `AssessmentFilterBar` component

**Files:**
- Create: `client/src/components/AssessmentFilterBar.jsx`
- Test: `client/src/components/AssessmentFilterBar.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `client/src/components/AssessmentFilterBar.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AssessmentFilterBar from './AssessmentFilterBar.jsx';

const LTI = { is_lti_submission: 1, due_date: '2026-06-01' };
const NON_LTI = { is_lti_submission: 0, due_date: '2026-06-01' };
const TOPICS = [{ id: 't1' }];
const students = [
  { scores: { t1: { grade: 'EX' } }, grade_comment: 'x', exception: 0, comment_status: 1, lti_submission_state: 'submitted', review_flag: null, resubmit_flag: null },
  { scores: {}, grade_comment: '', exception: 0, comment_status: 0, lti_submission_state: 'not_started', review_flag: null, resubmit_flag: null },
];

describe('AssessmentFilterBar', () => {
  it('renders three status pills for an LTI assignment', () => {
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set()} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: /Submitted/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /In Progress/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Not Started/ })).toBeInTheDocument();
  });
  it('renders only the Submitted status pill for a non-LTI assignment', () => {
    render(<AssessmentFilterBar students={students} assignment={NON_LTI} topics={TOPICS} active={new Set()} onToggle={() => {}} />);
    expect(screen.queryByRole('button', { name: /In Progress/ })).toBeNull();
  });
  it('shows a per-pill count', () => {
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set()} onToggle={() => {}} />);
    // one submitted student
    expect(screen.getByRole('button', { name: /Submitted/ })).toHaveTextContent('1');
  });
  it('calls onToggle with the pill id on click', () => {
    const onToggle = vi.fn();
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set()} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /Partially graded/ }));
    expect(onToggle).toHaveBeenCalledWith('partial');
  });
  it('marks an active pill via aria-pressed', () => {
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set(['submitted'])} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: /Submitted/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd client && npx vitest run src/components/AssessmentFilterBar.test.jsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `client/src/components/AssessmentFilterBar.jsx`:

```jsx
// Grouped filter toggle pills for the assessment summary page. Mirrors the
// Summative/Formative TypeFilterToggle pattern (themed pill, dot, label, count;
// muted when inactive). OR within a group, AND across groups is applied by the
// page via passesFilters — this component only renders + reports toggles.

import { filterGroups, pillTone, countMatches, TONE_VARS } from '../lib/assessmentFilters.js';

function FilterPill({ label, count, active, tone, onClick }) {
  const v = TONE_VARS[tone] || TONE_VARS.neutral;
  const colorStyle = active
    ? { background: v.bg, color: v.text, boxShadow: `inset 0 0 0 1px ${v.text}` }
    : { background: 'var(--bg-subtle)', color: 'var(--text-muted)', boxShadow: 'inset 0 0 0 1px var(--border)', opacity: 0.7 };
  return (
    <button onClick={onClick} aria-pressed={active}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
        padding: '0.3rem 0.7rem', borderRadius: 999, border: 'none',
        cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600,
        transition: 'opacity 0.12s, background 0.12s', ...colorStyle,
      }}>
      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'currentColor', opacity: active ? 1 : 0.5 }} />
      {label}
      <span style={{ fontWeight: 700, opacity: 0.75 }}>{count}</span>
    </button>
  );
}

export default function AssessmentFilterBar({ students, assignment, topics, active, onToggle }) {
  const groups = filterGroups(assignment);
  const ctx = { assignment, topics };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', paddingTop: '0.5rem' }}>
      <span className="text-sm text-muted" style={{ marginRight: '0.1rem' }}>Filter:</span>
      {groups.map((g, gi) => (
        <span key={g.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
          {gi > 0 && <span aria-hidden style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 0.2rem' }} />}
          {g.pills.map(p => (
            <FilterPill key={p.id} label={p.label} count={countMatches(students, p.id, ctx)}
              active={active.has(p.id)} tone={pillTone(p.id, assignment)} onClick={() => onToggle(p.id)} />
          ))}
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd client && npx vitest run src/components/AssessmentFilterBar.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/AssessmentFilterBar.jsx client/src/components/AssessmentFilterBar.test.jsx
git commit -m "feat(assessment-page): grouped AssessmentFilterBar toggle pills"
```

---

## Task 10: Render the status pill in the student card header

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (import + the `StudentRubricCard` header, after the name `<Link>` at `:682-684`)
- Test: `client/src/pages/AssessmentSummaryPage.test.jsx`

- [ ] **Step 1: Write the failing test**

In `client/src/pages/AssessmentSummaryPage.test.jsx`, add a test using the existing `renderCard` helper, passing an LTI `assignmentRow` and a submitted student:

```jsx
describe('StudentRubricCard submission-status pill', () => {
  it('shows the submission status pill in the header', () => {
    renderCard({
      student: { ...makeStudent(), lti_submission_state: 'submitted', submission_type: null, late: 0, draft: 0, submitted_at: 0 },
      assignmentRow: { id: 50, is_lti_submission: 1, due_date: '2026-06-01', lti_fetch_status: 'ok', mastery_grading_period_id: 1, mastery_grading_category_id: 2 },
    });
    expect(screen.getByText('Submitted')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "submission-status pill"`
Expected: FAIL — no "Submitted" text.

- [ ] **Step 3: Wire the pill in**

At the top of `client/src/pages/AssessmentSummaryPage.jsx`, add the import (next to the other component imports):

```jsx
import SubmissionStatusPill from '../components/SubmissionStatusPill.jsx';
```

In `StudentRubricCard`, immediately after the name `<Link>` (`:682-684`), insert:

```jsx
        <SubmissionStatusPill student={student} assignment={assignmentRow} />
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "submission-status pill"` then the whole file (confirm existing card tests still pass).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment-page): show submission-status pill in the student card header"
```

---

## Task 11: Wire the filter bar + roster filtering into the page

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (the page component: import, state, render the bar after the header button row at `:1626`, filter `students` at `:1635`, empty-result state)
- Test: `client/src/pages/AssessmentSummaryPage.test.jsx`

- [ ] **Step 1: Write the failing test**

The page component reads `useParams()` and calls `getMasteryForAssignment`. Add a render helper + test (mirror the mock pattern already in the file — `getMasteryForAssignment` is a `vi.fn()`):

```jsx
import { MemoryRouter as MR, Routes as Rs, Route as Rt } from 'react-router-dom';

function renderPage(mastery) {
  getMasteryForAssignment.mockResolvedValue(mastery);
  return render(
    <MR initialEntries={['/course/4/assessment/8']}>
      <Rs><Rt path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} /></Rs>
    </MR>
  );
}

describe('AssessmentSummaryPage filtering', () => {
  const mastery = {
    assignment: { title: 'Notebook 4', is_lti_submission: 1, due_date: '2026-06-01', lti_fetch_status: 'ok' },
    topics: [{ id: 't1', title: 'T1', category_title: 'C', external_id: 'X1' }],
    students: [
      { id: 1, schoology_uid: 'u1', first_name: 'Ada', last_name: 'L', scores: {}, grade_comment: '', exception: 0, comment_status: 0, lti_submission_state: 'submitted', submission_type: null, late: 0, draft: 0, submitted_at: 0, review_flag: null, resubmit_flag: null },
      { id: 2, schoology_uid: 'u2', first_name: 'Bob', last_name: 'M', scores: {}, grade_comment: '', exception: 0, comment_status: 0, lti_submission_state: 'not_started', submission_type: null, late: 0, draft: 0, submitted_at: 0, review_flag: null, resubmit_flag: null },
    ],
  };

  it('filters the roster to submitted students when the Submitted pill is active', async () => {
    renderPage(mastery);
    await waitFor(() => expect(screen.getByText('Ada L')).toBeInTheDocument());
    expect(screen.getByText('Bob M')).toBeInTheDocument();
    // The filter bar's Submitted pill (the count distinguishes it from the card pill)
    fireEvent.click(screen.getByRole('button', { name: /Submitted 1/ }));
    expect(screen.queryByText('Bob M')).toBeNull();
    expect(screen.getByText('Ada L')).toBeInTheDocument();
  });
});
```

(Note: the student name renders via `displayName(student)`; with `preferred_name`/`preferred_name_teacher` absent it is `"Ada L"`. Adjust the expected text if the helper formats differently — check `displayName` in the page file.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "filters the roster"`
Expected: FAIL — clicking finds no such button / Bob still present (no filter bar yet).

- [ ] **Step 3: Wire the bar + filtering**

Add the import near the top of `client/src/pages/AssessmentSummaryPage.jsx`:

```jsx
import AssessmentFilterBar from '../components/AssessmentFilterBar.jsx';
import { passesFilters } from '../lib/assessmentFilters.js';
```

In the page component, add filter state alongside the other `useState`s (e.g. near `viewMode`):

```jsx
  const [activeFilters, setActiveFilters] = useState(() => new Set());
  const toggleFilter = (id) => setActiveFilters(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
```

After the header button-row `</div>` (`:1626`) and before the header container's closing `</div>` (`:1627`), insert the bar:

```jsx
        <AssessmentFilterBar
          students={students}
          assignment={assignment}
          topics={alignedTopics}
          active={activeFilters}
          onToggle={toggleFilter}
        />
```

Compute the filtered roster just before the `students.length === 0` block (`:1629`):

```jsx
  const visibleStudents = students.filter(s => passesFilters(s, activeFilters, { assignment, topics: alignedTopics }));
```

Change the roster `.map` (`:1635`) to iterate `visibleStudents` instead of `students`, and add a "no matches" branch. Replace the `students.map((student) => ( ... ))` opening so the list renders from `visibleStudents`, and after the `</>`-closed list (or inside the existing `students.length === 0 ? ... : ( <> ... )` ternary) add, right after the `<>`:

```jsx
          {visibleStudents.length === 0 && (
            <div className="card"><p className="text-muted">No students match the current filters.</p></div>
          )}
```

(The outer `students.length === 0` guard at `:1629` stays — it covers a genuinely empty roster; the new line covers "filtered to zero".)

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "filters the roster"` then the whole file.
Expected: PASS.

- [ ] **Step 5: Run the full client + server + mcp suites**

Run: `cd client && npx vitest run` then from the repo root `npx vitest run server mcp`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment-page): filter roster via grouped filter bar (OR within / AND across)"
```

---

## Task 12: Documentation

**Files:**
- Modify: `docs/design-language.md`

- [ ] **Step 1: Append the design-language entry**

Add a dated entry to `docs/design-language.md` (match the file's existing entry format):

```markdown
### Assessment summary page — submission status + filters (2026-06-14)

- Each student card header shows a **prominent submission-status pill** computed
  from the same `gradeLabel.submissionStatus` rule (and colours/due-date
  proximity) as the gradebook grid, so the two never drift. A failed LTI fetch
  surfaces the same amber "status unavailable — re-sync" affordance.
- Below the header button row, a **grouped filter row** of themed toggle pills
  (mirroring the Summative/Formative `TypeFilterToggle`): submission status
  (3 pills for LTI / just *Submitted* for non-LTI), grading completeness
  (*Ungraded / Partially graded / Graded*), visibility (*Visible / Not visible*),
  *Flag for review*, *Ask to resubmit*. Semantics: **OR within a group, AND
  across groups**; selection is in-memory (resets each visit). Status-pill colour
  follows the assignment's due-date proximity.
- The same submission/grading/flag state is exposed to the MCP: per-student
  `submission_status` + `grading_state` + `flags` on `get_assignment_context`,
  and `submission_counts` + `grading_counts` on `list_assignments`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/design-language.md
git commit -m "docs(design-language): assessment-page status pill + filter row"
```

---

## Self-Review (completed during planning)

**Spec coverage:** Layer 1 → Task 1; Layer 2 (route payload) → Task 6; Layer 3 (card pill) → Tasks 8+10; Layer 4 (filter row, incl. grading-completeness + visibility groups, OR/AND, due-date pill colours, conditional status pills) → Tasks 7+9+11; Layer 5 (MCP per-student + list_assignments counts) → Tasks 2+3+4+5; testing → embedded per task; docs → Task 12. All covered.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Two tasks (6 and 11) reference *existing* in-file conventions (the `mastery.test.js` seed helper variable names; the page's `displayName` formatting) rather than restating them — flagged inline with what to match, not left vague.

**Type consistency:** Helper names are fixed in the "canonical signatures" list and used verbatim across tasks. `TONE_VARS` keys (green/blue/amber/yellow/red/neutral/resubmit) are produced by `pillTone`/`gradeLabel` tones and consumed by both `SubmissionStatusPill` and `AssessmentFilterBar`. Pill ids (`submitted`/`in_progress`/`not_started`/`ungraded`/`partial`/`graded`/`visible`/`not_visible`/`review`/`resubmit`) are defined once in `filterGroups` and matched in `studentMatchesPill`. Server `gradingState`/`normalizeSubmissionStatus` and client `gradingStateOf`/`normalizedSubmissionState` are intentional per-side twins (documented), tested identically.
