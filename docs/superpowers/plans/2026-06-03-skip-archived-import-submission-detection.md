# Skip Per-Cell Submission Detection on Archived Imports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make archived-course finalisation skip the per-(assignment, student) submission-status loop entirely, eliminating the wall-time dominator for grade-heavy archived imports.

**Architecture:** Add a `skipSubmissions` opt to `syncSectionData` that short-circuits the dropbox-assignment list to `[]` (making the whole submission phase a no-op). `finalizeArchivedCourse` — the single chokepoint for import, transition, and backfill — passes `skipSubmissions: true` and logs a diagnostic line. The active recurring sync (`fullSync`) never passes the opt, so its behaviour is untouched.

**Tech Stack:** Node.js (ESM), Express, better-sqlite3, Vitest. All work is in `server/services/sync.js` and `server/services/sync.test.js`, plus a docs note.

**Spec:** `docs/superpowers/specs/2026-06-03-skip-archived-import-submission-detection-design.md`

---

## File Structure

- `server/services/sync.js` — Modify:
  - `syncSectionData` (~line 57 opts destructure; ~line 206 dropbox list) — add and apply `skipSubmissions`.
  - `finalizeArchivedCourse` (~line 533) — pass `skipSubmissions: true` + diagnostic log with course name.
- `server/services/sync.test.js` — Add tests: one direct `syncSectionData` skip-opt test, plus negative-assertion tests on the `finalizeArchivedCourse`, `detectArchivedTransitions`, and `backfillUnfinalizedArchived` describe blocks.
- `.claude/schoology-api-reference.md` — Modify: add the archived/inactive-section GHD-blindness note.

---

## Task 1: `syncSectionData` honours `skipSubmissions`

**Files:**
- Modify: `server/services/sync.js` (opts destructure ~57; dropbox list ~206)
- Test: `server/services/sync.test.js` (new describe block)

- [ ] **Step 1: Write the failing test**

Add this describe block to `server/services/sync.test.js`. It mirrors the existing
`internal-gradebook submission state (#62/#55)` block's mock setup (a real dropbox
assignment + one student; `getSubmissionStatus` mocked).

```js
describe('syncSectionData — skipSubmissions opt (#72)', () => {
  let db;
  let courseId;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-S', 'Archived')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getSubmissionStatus.mockReset();
    getSectionGrades.mockResolvedValue([]);
    getSubmissionStatus.mockResolvedValue({ revision_id: 1, late: 1, draft: 0, latestRevisionAt: 2000 });
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'D1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
  });

  test('skipSubmissions:true does not call the public submissions API and reports zero', async () => {
    const result = await syncSectionData(db, 'sec-S', courseId, new Date().toISOString(), {
      skipSubmissions: true,
    });

    expect(getSubmissionStatus).not.toHaveBeenCalled();
    expect(result.submissionCount).toBe(0);
    expect(result.submissionAttempts).toBe(0);
    expect(result.failedAssignmentIds).toEqual([]);
  });

  test('without skipSubmissions the same setup DOES call the public submissions API (opt defaults off)', async () => {
    await syncSectionData(db, 'sec-S', courseId, new Date().toISOString());

    expect(getSubmissionStatus).toHaveBeenCalledWith('sec-S', 'D1', '701');
  });
});
```

- [ ] **Step 2: Run the test to verify the first case fails**

Run: `npx vitest run server/services/sync.test.js -t "skipSubmissions"`
Expected: the `skipSubmissions:true ...` test FAILS — `getSubmissionStatus` is called (the opt isn't implemented yet), so `not.toHaveBeenCalled()` fails. The second ("defaults off") test passes already (proves the control).

- [ ] **Step 3: Implement the opt**

In `server/services/sync.js`, add `skipSubmissions = false` to the opts destructure (~line 57):

```js
  const {
    submissionConcurrency = 2,
    submissionRatePerSec = 4,
    submissionAbandonAfter = 5,
    skipSubmissions = false,
  } = opts;
```

Then change the dropbox-assignment list (~line 206) from:

```js
  const dropboxAssignments = assignments.filter(a => a.allow_dropbox === '1' || a.allow_dropbox === 1);
```

to:

```js
  // #72: archived finalisation freezes submission state — the per-cell loop is
  // the wall-time dominator and yields nothing useful for immutable archived
  // courses (GHD is blind for inactive sections). An empty list makes the
  // submission phase a clean no-op (lookup fetch is guarded by .length, the
  // loop doesn't iterate, writeSubmissions([]) is a no-op).
  const dropboxAssignments = skipSubmissions
    ? []
    : assignments.filter(a => a.allow_dropbox === '1' || a.allow_dropbox === 1);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/services/sync.test.js -t "skipSubmissions"`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/sync.js server/services/sync.test.js
git commit -m "feat(#72): add skipSubmissions opt to syncSectionData"
```

---

## Task 2: `finalizeArchivedCourse` skips submissions + logs

**Files:**
- Modify: `server/services/sync.js:533` (`finalizeArchivedCourse`)
- Test: `server/services/sync.test.js` (extend the `finalizeArchivedCourse (#70)` block)

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe('finalizeArchivedCourse (#70)', ...)` block.
The block's `beforeEach` mocks `getSubmissionStatus` to resolve `null` and seeds empty
assignments — override the assignments + enrollments inside the test so there *is* a
dropbox cell the old code would have called for.

```js
  test('skips the per-cell submission loop (#72) — no public submissions call', async () => {
    const sch = await import('./schoology.js');
    sch.getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    sch.getSectionAssignments.mockResolvedValue([
      { id: 'D1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    hasMasterySession.mockReturnValue(false);

    await finalizeArchivedCourse(db, { courseId, sectionId: 'sec-9', now: '2026-05-31T00:00:00Z' });

    expect(sch.getSubmissionStatus).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/services/sync.test.js -t "skips the per-cell submission loop"`
Expected: FAIL — `finalizeArchivedCourse` still calls `syncSectionData` with no opts, so `getSubmissionStatus` is called.

- [ ] **Step 3: Implement the skip + log**

In `server/services/sync.js`, change the first line of `finalizeArchivedCourse` (~533) from:

```js
export async function finalizeArchivedCourse(db, { courseId, sectionId, now, runMastery = true }) {
  const counts = await syncSectionData(db, String(sectionId), courseId, now);
```

to (the log line carries course name + year/semester via raw `grading_period` + section id):

```js
export async function finalizeArchivedCourse(db, { courseId, sectionId, now, runMastery = true }) {
  const c = db.prepare('SELECT course_name, grading_period FROM courses WHERE id = ?').get(courseId) || {};
  const period = c.grading_period ? ` — ${c.grading_period}` : '';
  console.log(`[archived] "${c.course_name || sectionId}"${period} (section ${sectionId}): skipped per-cell submission detection (frozen)`);
  const counts = await syncSectionData(db, String(sectionId), courseId, now, { skipSubmissions: true });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/services/sync.test.js -t "skips the per-cell submission loop"`
Expected: PASS. Also re-run the whole `finalizeArchivedCourse` block to confirm the existing mastery/finalized_at tests still pass:
`npx vitest run server/services/sync.test.js -t "finalizeArchivedCourse"`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/sync.js server/services/sync.test.js
git commit -m "feat(#72): finalizeArchivedCourse skips submission loop + logs course name"
```

---

## Task 3: Confirm the skip holds through transition and backfill

These paths route through `finalizeArchivedCourse`, so Task 2 already makes them skip.
These are guard tests so a future change to either entry point can't silently
reintroduce the per-cell loop.

**Files:**
- Test: `server/services/sync.test.js` (extend the `detectArchivedTransitions (#70)` and `backfillUnfinalizedArchived (#70)` blocks)

- [ ] **Step 1: Write the tests**

Add to the `describe('detectArchivedTransitions (#70)', ...)` block (its `beforeEach`
already mocks `getSection`, grading periods, and `hasMasterySession` → false):

```js
  test('finalising a transitioned course skips the submission loop (#72)', async () => {
    const sch = await import('./schoology.js');
    sch.getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    sch.getSectionAssignments.mockResolvedValue([
      { id: 'D1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    seed('sec-gone');
    getSection.mockResolvedValue({ id: 'sec-gone', active: 0, course_title: 'Gone' });

    await detectArchivedTransitions(db, new Set(['sec-active']), '2026-05-31T00:00:00Z');

    expect(sch.getSubmissionStatus).not.toHaveBeenCalled();
  });
```

Add to the `describe('backfillUnfinalizedArchived (#70)', ...)` block:

```js
  test('backfill finalisation skips the submission loop (#72)', async () => {
    const sch = await import('./schoology.js');
    sch.getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    sch.getSectionAssignments.mockResolvedValue([
      { id: 'D1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('a','A',1)`).run();

    await backfillUnfinalizedArchived(db, '2026-05-31T00:00:00Z');

    expect(sch.getSubmissionStatus).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npx vitest run server/services/sync.test.js -t "skips the submission loop"`
Expected: both new tests PASS (the skip is inherited from Task 2). If either fails,
check that the block's `beforeEach` reset `getSubmissionStatus` — add
`sch.getSubmissionStatus.mockReset()` inside the test if a prior test left call state.

- [ ] **Step 3: Commit**

```bash
git add server/services/sync.test.js
git commit -m "test(#72): guard transition + backfill paths skip the submission loop"
```

---

## Task 4: Document the archived-section GHD limitation

**Files:**
- Modify: `.claude/schoology-api-reference.md`

- [ ] **Step 1: Find the grader_header_data (GHD) section**

Run: `grep -n "grader_header_data\|GHD" .claude/schoology-api-reference.md`
Expected: locates the GHD note. Read the surrounding lines to match the doc's tone.

- [ ] **Step 2: Add the limitation note**

Append to the GHD section a note capturing the 2026-06-01 probe:

```markdown
**Limitation — archived/inactive sections:** `grader_header_data` is blind for
archived/inactive sections. Probe (2026-06-01) of archived AP CSP `7361043994`
(75 assignments / 57 published in the DB): HTTP 200 but only 1 grade_item, 0
submissions, 0 grades (the 19-student roster loads); the `?grading_period=` param
(`all` / a period id / `final` / `none`) had no effect. So the GHD submission
pre-filter cannot help archived-course imports — which is why archived finalisation
skips the per-cell submission loop entirely (#72) rather than pre-filtering it.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/schoology-api-reference.md
git commit -m "docs(#72): note grader_header_data is blind for archived sections"
```

---

## Task 5: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full server test suite**

Run: `npx vitest run server/`
Expected: all tests PASS — especially the existing `internal-gradebook submission
state (#62/#55)`, `fullSync — course skip matrix (#56)`, and `courses.test.js` import
tests (which mock `finalizeArchivedCourse` and so are unaffected). No active-sync
behaviour should have changed.

- [ ] **Step 2: Confirm no stray skip in the active path**

Run: `grep -n "skipSubmissions" server/services/sync.js`
Expected: exactly two hits — the opts destructure and the `dropboxAssignments`
ternary in `syncSectionData`, plus the `{ skipSubmissions: true }` literal in
`finalizeArchivedCourse`. `fullSync` must NOT appear (it never skips).

- [ ] **Step 3: Final commit (if any uncommitted changes remain)**

```bash
git status
# only if anything is unstaged from review fixes:
git add -A && git commit -m "chore(#72): finalise skip-archived-submissions work"
```

---

## Manual verification (user's call — not part of the automated suite)

Time a real archived import (e.g. AP CSP) before/after the change. This hits live
Schoology and mutates the DB, so it is run by the user. Expected: the submission-loop
wall time disappears from the import; mastery (~20–40s) remains the floor.
