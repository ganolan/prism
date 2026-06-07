# True submission-state badges for `lti_submission` work (#62) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unverifiable "Not Started" badge on OneDrive/GDrive (`lti_submission`) work with the true 4-state (Graded / Submitted / In Progress / Not Started) read from Schoology's per-assignment grader endpoints.

**Architecture:** Two per-assignment internal endpoints (`/iapi2/assignments/{aid}/submitted-documents/` and `/in-progress-documents/`, browser-session auth) yield each student's real state; the `in-progress` list's boolean `revisionCreated` splits In Progress (`true`) from Not Started (`false`). Sync persists a per-cell `lti_submission_state`; the badge layer renders it with due-proximity-based tones. Native dropbox is untouched on the sync side and simplified to Submitted/Missing on the render side.

**Tech Stack:** Node ESM, better-sqlite3, Playwright (existing `.playwright-session`), Express, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-07-lti-submission-state-badges-design.md`. **Verified endpoint reference:** `.claude/schoology-api-reference.md` (2026-06-07 RESOLVED note).

**Branch:** create `feat/62-lti-submission-state` before Task 1 (we're on `main`).

---

## File structure

- `server/db/index.js` — +2 migrations (`assignments.is_lti_submission`, `grades.lti_submission_state`).
- `server/services/sync.js` — store the lti marker; add the lti documents branch in the submission phase; inject the documents fetcher in `fullSync`.
- `server/lib/parseGraderDocuments.js` *(new)* — pure parser: the two `{data:[…]}` payloads → `Map<uid, state>`. + `.test.js`.
- `server/services/graderDocuments.js` *(new)* — `fetchAssignmentSubmissionState(context, assignmentId)`: fetch both endpoints via a shared Playwright context, parse, return the map (or `null` on any failure).
- `server/services/graderSubmissions.js` — add a `fetchDocuments(assignmentId)` method to the existing single-browser fetcher (reuses the one session; no second browser).
- `server/routes/courses.js`, `server/routes/students.js` — expose `is_lti_submission` + `lti_submission_state` to the client.
- `client/src/lib/gradeLabel.js` — rewrite `submissionStatus` for the lti/non-lti matrix. + `.test.js`.
- `client/src/components/SubmissionBadges.jsx` — add `green` + `yellow` tone keys.
- `client/src/pages/CoursePage.jsx` — `SHORT_BADGE`, compact tone map, the 3 call sites (511, 858, 912).
- `client/src/pages/StudentPage.jsx` — the 1 call site (116).

**State vocabulary** (one source of truth): `lti_submission_state ∈ { 'submitted', 'in_progress', 'not_started' }`, stored on `grades`, `NULL` when non-lti or uncovered.

---

## Task 1: DB migrations for the two new columns

**Files:**
- Modify: `server/db/index.js:66` (append to `MIGRATIONS` after the `finalized_at` migration, before the index lines at :67-69)

- [ ] **Step 1: Add the two migrations**

In `server/db/index.js`, insert after the `finalized_at` migration line (currently line 66) and before the `CREATE INDEX` lines:

```js
  // #62: the real OneDrive/GDrive marker — Schoology's public assignment
  // `assignment_type` field === 'lti_submission'. Distinct from the overloaded
  // `assignment_type` COLUMN (which masterySync/analytics use for
  // formative/summative). Drives which submission-detection path sync takes and
  // how the badge layer reads state.
  `ALTER TABLE assignments ADD COLUMN is_lti_submission INTEGER DEFAULT 0`,
  // #62: per-(student, assignment) true submission state for lti work, read from
  // the grader's per-assignment in-progress/submitted document endpoints.
  // 'submitted' | 'in_progress' | 'not_started'; NULL = non-lti or not covered
  // (no browser session). Authoritative for lti badge display.
  `ALTER TABLE grades ADD COLUMN lti_submission_state TEXT`,
```

- [ ] **Step 2: Verify migrations apply cleanly**

Run: `node -e "import('./server/db/index.js').then(({getDb})=>{const db=getDb();const a=db.prepare('PRAGMA table_info(assignments)').all().some(c=>c.name==='is_lti_submission');const g=db.prepare('PRAGMA table_info(grades)').all().some(c=>c.name==='lti_submission_state');console.log('is_lti_submission:',a,'lti_submission_state:',g);})"`
Expected: `is_lti_submission: true lti_submission_state: true`

- [ ] **Step 3: Commit**

```bash
git add server/db/index.js
git commit -m "feat(#62): add is_lti_submission + lti_submission_state columns"
```

---

## Task 2: Persist the lti marker during sync

**Files:**
- Modify: `server/services/sync.js:97-132` (assignment upsert)

- [ ] **Step 1: Add the column to the INSERT + ON CONFLICT + run() args**

In `server/services/sync.js`, update the `upsertAssignment` prepared statement (currently lines 96-112) to include `is_lti_submission`:

```js
  const upsertAssignment = db.prepare(`
    INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, max_points, assignment_type, is_lti_submission, grading_category_id, grading_scale_id, folder_id, count_in_grade, published, display_weight, num_assignees, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(schoology_assignment_id) DO UPDATE SET
      title = excluded.title,
      due_date = excluded.due_date,
      max_points = excluded.max_points,
      assignment_type = excluded.assignment_type,
      is_lti_submission = excluded.is_lti_submission,
      grading_category_id = excluded.grading_category_id,
      grading_scale_id = excluded.grading_scale_id,
      folder_id = excluded.folder_id,
      count_in_grade = excluded.count_in_grade,
      published = excluded.published,
      display_weight = excluded.display_weight,
      num_assignees = excluded.num_assignees,
      synced_at = excluded.synced_at
  `);
```

- [ ] **Step 2: Pass the value in `upsertAssignment.run(...)`**

In the `writeAssignments` transaction (currently lines 119-132), add the `is_lti_submission` argument right after the `a.type || 'assignment'` line:

```js
      upsertAssignment.run(
        courseId, String(a.id), a.title, a.due || null, a.max_points ?? null,
        a.type || 'assignment',
        a.assignment_type === 'lti_submission' ? 1 : 0,
        a.grading_category ? String(a.grading_category) : null,
        a.grading_scale ? String(a.grading_scale) : null,
        a.folder_id ? String(a.folder_id) : null,
        a.count_in_grade ?? 1,
        a.published ?? 1,
        a.display_weight ?? 0,
        Number.isFinite(Number(a.num_assignees)) ? Number(a.num_assignees) : null,
        now
      );
```

- [ ] **Step 3: Verify against existing sync tests**

Run: `npx vitest run server/services/sync.test.js`
Expected: PASS (existing fixtures use `assignment_type: 'lti_submission'` on mock assignments; column add is additive — no behavior change yet).

- [ ] **Step 4: Commit**

```bash
git add server/services/sync.js
git commit -m "feat(#62): persist is_lti_submission from Schoology assignment_type field"
```

---

## Task 3: Pure parser for the document endpoints

**Files:**
- Create: `server/lib/parseGraderDocuments.js`
- Test: `server/lib/parseGraderDocuments.test.js`

Real payload shape (verified): each endpoint returns `{ data: [ { id (=schoology uid), enrollmentId, firstName, lastName, submissionTiming, submissionStatus, exception, grade, revisionCreated (boolean), submissionDate }, … ] }`.

- [ ] **Step 1: Write the failing test**

Create `server/lib/parseGraderDocuments.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildSubmissionStateMap } from './parseGraderDocuments.js';

const submitted = { data: [{ id: 11862763, revisionCreated: true }] };
const inProgress = { data: [
  { id: 132465441, revisionCreated: false }, // never opened → not_started
  { id: 117424434, revisionCreated: true },  // opened → in_progress
] };

describe('buildSubmissionStateMap', () => {
  it('maps submitted-documents entries to "submitted"', () => {
    const m = buildSubmissionStateMap(submitted, { data: [] });
    expect(m.get('11862763')).toBe('submitted');
  });

  it('splits in-progress by revisionCreated', () => {
    const m = buildSubmissionStateMap({ data: [] }, inProgress);
    expect(m.get('132465441')).toBe('not_started');
    expect(m.get('117424434')).toBe('in_progress');
  });

  it('submitted wins if a uid somehow appears in both lists', () => {
    const m = buildSubmissionStateMap({ data: [{ id: 5, revisionCreated: true }] }, { data: [{ id: 5, revisionCreated: false }] });
    expect(m.get('5')).toBe('submitted');
  });

  it('returns an empty map for empty/missing payloads', () => {
    expect(buildSubmissionStateMap(null, null).size).toBe(0);
    expect(buildSubmissionStateMap({}, {}).size).toBe(0);
  });

  it('keys are string uids', () => {
    const m = buildSubmissionStateMap({ data: [{ id: 42, revisionCreated: true }] }, { data: [] });
    expect([...m.keys()]).toEqual(['42']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/lib/parseGraderDocuments.test.js`
Expected: FAIL — "Failed to resolve import './parseGraderDocuments.js'".

- [ ] **Step 3: Write the parser**

Create `server/lib/parseGraderDocuments.js`:

```js
/**
 * parseGraderDocuments.js
 *
 * Pure parser for Schoology's per-assignment grader document lists
 * (`GET /iapi2/assignments/{aid}/submitted-documents/` and
 * `/in-progress-documents/`, browser-session auth). Each returns
 * `{ data: [ { id (=schoology uid), revisionCreated (bool), … } ] }`.
 *
 * Produces the true per-student submission state for lti_submission work — the
 * only surface that distinguishes "opened, in progress" (revisionCreated:true)
 * from "never opened" (revisionCreated:false). See schoology-api-reference.md
 * (2026-06-07 RESOLVED note) and issue #62.
 */

function rows(payload) {
  const data = payload?.data;
  return Array.isArray(data) ? data : [];
}

/**
 * @param {object|null} submittedPayload   submitted-documents response
 * @param {object|null} inProgressPayload  in-progress-documents response
 * @returns {Map<string, 'submitted'|'in_progress'|'not_started'>} keyed by string uid
 */
export function buildSubmissionStateMap(submittedPayload, inProgressPayload) {
  const map = new Map();
  for (const r of rows(inProgressPayload)) {
    if (r?.id == null) continue;
    map.set(String(r.id), r.revisionCreated ? 'in_progress' : 'not_started');
  }
  // submitted overrides in-progress for the same uid.
  for (const r of rows(submittedPayload)) {
    if (r?.id == null) continue;
    map.set(String(r.id), 'submitted');
  }
  return map;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/lib/parseGraderDocuments.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/lib/parseGraderDocuments.js server/lib/parseGraderDocuments.test.js
git commit -m "feat(#62): pure parser for grader in-progress/submitted document lists"
```

---

## Task 4: Browser-session fetch for the document endpoints

**Files:**
- Create: `server/services/graderDocuments.js`
- Modify: `server/services/graderSubmissions.js:61-90` (add `fetchDocuments` to the returned fetcher)

- [ ] **Step 1: Create the fetch helper**

Create `server/services/graderDocuments.js`:

```js
/**
 * graderDocuments.js
 *
 * Browser-session fetch for the grader's per-assignment document lists, which
 * carry the true lti_submission state (submitted / in_progress / not_started).
 * Reuses an existing Playwright BrowserContext (the same session as GHD/mastery)
 * — see graderSubmissions.createSubmissionFetcher. Best-effort: returns null on
 * any failure so the caller falls back cleanly. Never throws into the sync.
 */
import { buildSubmissionStateMap } from '../lib/parseGraderDocuments.js';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';

/**
 * @param {import('playwright').BrowserContext} context  logged-in context
 * @param {string} assignmentId
 * @returns {Promise<Map<string,string>|null>} uid → state, or null
 */
export async function fetchAssignmentSubmissionState(context, assignmentId) {
  const page = await context.newPage();
  try {
    await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!isLoggedInUrl(page.url())) return null;
    const get = (path) => page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include' });
      if (r.status !== 200) return null;
      try { return JSON.parse(await r.text()); } catch { return null; }
    }, `${SCHOOLOGY_BASE}/iapi2/assignments/${assignmentId}/${path}/`);
    const [submitted, inProgress] = await Promise.all([get('submitted-documents'), get('in-progress-documents')]);
    if (submitted == null && inProgress == null) return null;
    return buildSubmissionStateMap(submitted, inProgress);
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}
```

- [ ] **Step 2: Expose `context` + `fetchDocuments` from the existing fetcher**

In `server/services/graderSubmissions.js`, add the import at the top (after the existing imports):

```js
import { fetchAssignmentSubmissionState } from './graderDocuments.js';
```

Then in the object returned by `createSubmissionFetcher` (currently the `return { async fetch(sectionId){…}, async close(){…} }` block at lines 61-90), add a `fetchDocuments` method alongside `fetch`:

```js
    async fetchDocuments(assignmentId) {
      if (sessionDead) return null;
      return fetchAssignmentSubmissionState(context, assignmentId);
    },
```

(`context` and `sessionDead` are already in scope in `createSubmissionFetcher`.)

- [ ] **Step 3: Smoke-test against the live session (manual, requires `npm run mastery:login`)**

Run: `node -e "import('./server/services/graderSubmissions.js').then(async ({createSubmissionFetcher})=>{const f=await createSubmissionFetcher();if(!f){console.log('no session');return;}const m=await f.fetchDocuments('8348763574');console.log('states:',m?[...new Set(m.values())]:null,'count:',m?.size);await f.close();})"`
Expected (with a fresh session): `states: [ 'not_started', 'in_progress', 'submitted' ] count: 19` (or similar). Without a session: `no session`. Either is acceptable — it must not throw.

- [ ] **Step 4: Commit**

```bash
git add server/services/graderDocuments.js server/services/graderSubmissions.js
git commit -m "feat(#62): browser-session fetch for per-assignment submission state"
```

---

## Task 5: Sync — take the documents path for lti assignments

**Files:**
- Modify: `server/services/sync.js` — the submission phase (lines ~215-360) and `fullSync` injection (line ~736)

The current submission loop walks `dropboxAssignments` per-cell. We split it: lti assignments use the documents fetcher (2 calls, whole roster) and write `lti_submission_state`; non-lti keep the per-cell public path.

- [ ] **Step 1: Partition dropbox assignments into lti vs native**

In `server/services/sync.js`, just after `dropboxAssignments` is computed (currently the `filterRecentAssignments` block ending ~line 221), add:

```js
  // #62: lti_submission assignments use the per-assignment document endpoints
  // (true state, whole roster in 2 calls); native dropbox keeps the per-cell
  // public revisions walk below.
  const ltiAssignments = dropboxAssignments.filter(a => a.assignment_type === 'lti_submission');
  const nativeDropboxAssignments = dropboxAssignments.filter(a => a.assignment_type !== 'lti_submission');
```

- [ ] **Step 2: Restrict the existing per-cell loop to native dropbox**

Change the per-cell loop header (currently `for (const a of dropboxAssignments) {` at ~line 273) to:

```js
  for (const a of nativeDropboxAssignments) {
```

- [ ] **Step 3: Add the lti documents pass + state upsert**

Immediately after `writeSubmissions(acceptedResults);` (currently ~line 360), add:

```js
  // #62: lti_submission state pass. Two per-assignment reads (submitted +
  // in-progress documents) give every assigned student's true state. Writes
  // grades.lti_submission_state; inserts a row for un-graded cells so
  // not_started / in_progress reach the gradebook. No-op without a session.
  const upsertLtiState = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, lti_submission_state, synced_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      lti_submission_state = excluded.lti_submission_state,
      synced_at = excluded.synced_at
  `);
  if (typeof opts.fetchDocuments === 'function' && ltiAssignments.length) {
    for (const a of ltiAssignments) {
      const assignRow = selectAssignmentByExt.get(String(a.id));
      if (!assignRow) continue;
      let stateMap = null;
      try { stateMap = await opts.fetchDocuments(String(a.id)); } catch { stateMap = null; }
      if (!stateMap) continue; // no session / fetch failed → leave prior state
      const writeStates = db.transaction(() => {
        for (const { e, studentRow } of studentEnrollments
          .map((e) => ({ e, studentRow: selectStudentByUid.get(String(e.uid)) }))
          .filter((c) => c.studentRow)) {
          const state = stateMap.get(String(e.uid));
          if (!state) continue; // student not in either list → leave as-is
          upsertLtiState.run(studentRow.id, assignRow.id, String(e.id), assignRow.max_points ?? null, state, now);
        }
      });
      writeStates();
    }
  }
```

- [ ] **Step 4: Inject `fetchDocuments` in `fullSync`**

In `fullSync`, where `syncSectionData` is called with `fetchSubmissionLookup` (currently ~line 736), add the sibling injection:

```js
        fetchSubmissionLookup: submissionFetcher ? (sid) => submissionFetcher.fetch(sid) : undefined,
        fetchDocuments: submissionFetcher ? (aid) => submissionFetcher.fetchDocuments(aid) : undefined,
```

- [ ] **Step 5: Add a sync test for the lti branch**

In `server/services/sync.test.js`, add this test inside the same `describe` block as the existing `#62`/`#55` lti tests (it reuses the file's `getSectionEnrollments` / `getSectionAssignments` / `getSubmissionStatus` mocks and the `getGradeRow` helper):

```js
test('#62: lti assignment writes lti_submission_state via fetchDocuments and skips the per-cell walk', async () => {
  getSectionEnrollments.mockResolvedValue([
    { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    { id: '802', uid: '702', name_first: 'Bo', name_last: 'M', admin: '0' },
  ]);
  getSectionAssignments.mockResolvedValue([
    { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
  ]);

  const docCalls = [];
  await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
    fetchDocuments: async (aid) => { docCalls.push(aid); return new Map([['701', 'submitted'], ['702', 'not_started']]); },
  });

  // The per-assignment documents path is used; the per-cell public walk is NOT
  // used for lti work (L1 is excluded from nativeDropboxAssignments).
  expect(docCalls).toEqual(['L1']);
  expect(getSubmissionStatus).not.toHaveBeenCalled();
  expect(getGradeRow('701', 'L1').lti_submission_state).toBe('submitted');
  // A not_started cell inserts a row so the state reaches the gradebook.
  expect(getGradeRow('702', 'L1').lti_submission_state).toBe('not_started');
});
```

- [ ] **Step 6: Run the sync tests**

Run: `npx vitest run server/services/sync.test.js`
Expected: PASS (new test + existing unaffected).

- [ ] **Step 7: Commit**

```bash
git add server/services/sync.js server/services/sync.test.js
git commit -m "feat(#62): sync lti submission state via per-assignment document endpoints"
```

---

## Task 6: Expose the two fields to the client

**Files:**
- Modify: `server/routes/courses.js:148-149` (gradebook assignment SELECT) and `:212` (grades SELECT)
- Modify: `server/routes/students.js:46-48` (student grades+assignment SELECT)

- [ ] **Step 1: Gradebook assignment query — add `is_lti_submission`**

In `server/routes/courses.js`, the `/:id/gradebook` assignments query (line 148) — add `a.is_lti_submission` to the column list:

```js
    SELECT a.id, a.title, a.max_points, a.due_date, a.grading_category_id, a.grading_scale_id, a.folder_id,
           a.schoology_assignment_id, a.num_assignees, a.is_lti_submission,
```

- [ ] **Step 2: Gradebook grades query — add `g.lti_submission_state`**

In `server/routes/courses.js:212`, append `g.lti_submission_state` to the grades SELECT column list:

```js
    SELECT g.student_id, g.assignment_id, g.score, g.max_score, g.grade_comment, g.exception, g.late, g.draft, g.submitted_at, g.latest_revision_at, g.submission_type, g.lti_submission_state, g.comment_status
```

- [ ] **Step 3: Student page query — add both fields**

In `server/routes/students.js`, the grades query (lines 46-48): add `g.lti_submission_state` to the `g.` columns and `a.is_lti_submission` to the `a.` columns:

```js
      g.exception, g.late, g.draft, g.submitted_at, g.latest_revision_at, g.submission_type, g.lti_submission_state,
      a.title as assignment_title, a.due_date, a.is_lti_submission, a.max_points as assignment_max_points,
```

- [ ] **Step 4: Verify the API returns the fields**

Run (server must be running, or use a quick query):
`node -e "import('./server/db/index.js').then(({getDb})=>{const db=getDb();const cols=db.prepare('SELECT * FROM grades LIMIT 1').columns().map(c=>c.name);console.log('lti_submission_state in grades:', cols.includes('lti_submission_state'));})"`
Expected: `lti_submission_state in grades: true`

- [ ] **Step 5: Run route tests**

Run: `npx vitest run server/routes/courses.test.js`
Expected: PASS (additive columns; no shape break).

- [ ] **Step 6: Commit**

```bash
git add server/routes/courses.js server/routes/students.js
git commit -m "feat(#62): expose is_lti_submission + lti_submission_state to client"
```

---

## Task 7: Rewrite `submissionStatus` for the lti/non-lti matrix

**Files:**
- Modify: `client/src/lib/gradeLabel.js:20-93`
- Test: `client/src/lib/gradeLabel.test.js`

- [ ] **Step 1: Write the failing tests**

Replace the `describe('submissionStatus — submission_type (#62)', …)` block in `client/src/lib/gradeLabel.test.js` with the matrix tests below (keep the `gradeLabel` describe block and the `PAST`/`FUTURE`/`kinds` helpers):

```js
// due ~3 days out → 'soon'; >1 week out → 'early'
const SOON = new Date(Date.now() + 3 * 864e5).toISOString();
const EARLY = new Date(Date.now() + 30 * 864e5).toISOString();
const tone = (badges, kind) => badges.find(b => b.kind === kind)?.tone;

describe('submissionStatus — lti true state (#62)', () => {
  const lti = (state, due) => submissionStatus({ score: null, is_lti_submission: 1, lti_submission_state: state, due_date: due });

  it('submitted → green Submitted regardless of due date', () => {
    expect(lti('submitted', PAST)).toEqual([{ kind: 'submitted', label: 'Submitted', tone: 'green' }]);
  });
  it('in_progress → blue before due, yellow once overdue', () => {
    expect(tone(lti('in_progress', SOON), 'in-progress')).toBe('blue');
    expect(tone(lti('in_progress', PAST), 'in-progress')).toBe('yellow');
  });
  it('not_started → grey when early/none, red from a week out through overdue', () => {
    expect(tone(lti('not_started', EARLY), 'not-started')).toBe('neutral');
    expect(tone(lti('not_started', null), 'not-started')).toBe('neutral');
    expect(tone(lti('not_started', SOON), 'not-started')).toBe('red');
    expect(tone(lti('not_started', PAST), 'not-started')).toBe('red');
  });
  it('null state (no session): nothing before due, neutral Ungraded once overdue', () => {
    expect(lti(null, SOON)).toEqual([]);
    expect(tone(lti(null, PAST), 'ungraded')).toBe('neutral');
  });
  it('null state but GHD submission_type present → Submitted (green)', () => {
    const b = submissionStatus({ score: null, is_lti_submission: 1, lti_submission_state: null, submission_type: 'drop', due_date: PAST });
    expect(b).toEqual([{ kind: 'submitted', label: 'Submitted', tone: 'green' }]);
  });
  it('graded lti → no status badge', () => {
    expect(submissionStatus({ score: 14, is_lti_submission: 1, lti_submission_state: 'submitted', due_date: PAST })).toEqual([]);
  });
  it('a non-late exception still takes precedence', () => {
    expect(submissionStatus({ score: null, is_lti_submission: 1, exception: 1, due_date: PAST }))
      .toEqual([{ kind: 'exception', label: 'Excused', tone: 'blue' }]);
  });
});

describe('submissionStatus — non-lti consolidated (#62)', () => {
  const nl = (opts) => submissionStatus({ score: null, is_lti_submission: 0, ...opts });
  it('submitted → green Submitted', () => {
    expect(nl({ submission_type: 'drop', due_date: PAST })).toEqual([{ kind: 'submitted', label: 'Submitted', tone: 'green' }]);
  });
  it('not submitted + overdue → red Missing only (no Not Started)', () => {
    const b = nl({ submitted_at: 0, due_date: PAST });
    expect(kinds(b)).toEqual(['missing']);
    expect(tone(b, 'missing')).toBe('red');
  });
  it('not submitted + before due → no badge', () => {
    expect(nl({ submitted_at: 0, due_date: FUTURE })).toEqual([]);
  });
  it('graded → no status badge', () => {
    expect(submissionStatus({ score: 9, is_lti_submission: 0, due_date: PAST })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run client/src/lib/gradeLabel.test.js`
Expected: FAIL (current `submissionStatus` doesn't know `is_lti_submission`/`lti_submission_state`).

- [ ] **Step 3: Rewrite `submissionStatus`**

In `client/src/lib/gradeLabel.js`, replace the comment block + `submissionStatus` (lines 20-85) with:

```js
// Derive submission-state badges for an assignment row. Returns an array of
// { kind, label, tone } badges; tone ∈ 'red' | 'blue' | 'amber' | 'green' |
// 'yellow' | 'neutral'. Graded cells return [] (gradeLabel shows the score).
//
// lti_submission work (#62): state comes from `lti_submission_state`
// ('submitted' | 'in_progress' | 'not_started'), read from the grader's
// per-assignment document endpoints — the only reliable signal. The public
// `draft`/`submitted_at` are auto-provisioned noise for lti and are ignored.
// Tones escalate by due-proximity (see the spec's matrix).
//
// Non-lti work: only submitted-or-not is knowable, so it consolidates to
// green "Submitted" or red "Missing" (overdue only); nothing before due.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function dueProximity(due_date, today) {
  if (!due_date) return 'none';
  const d = new Date(due_date);
  if (isNaN(d)) return 'none';
  if (today > d) return 'overdue';
  if (today >= new Date(d.getTime() - WEEK_MS)) return 'soon';
  return 'early';
}

function ltiBadges(state, submission_type, due_date, today) {
  // GHD covered the cell but the document fetch didn't: trust "submitted".
  if (state == null && submission_type) state = 'submitted';
  const prox = dueProximity(due_date, today);
  if (state === 'submitted') return [{ kind: 'submitted', label: 'Submitted', tone: 'green' }];
  if (state === 'in_progress') {
    return [{ kind: 'in-progress', label: 'In Progress', tone: prox === 'overdue' ? 'yellow' : 'blue' }];
  }
  if (state === 'not_started') {
    const tone = (prox === 'soon' || prox === 'overdue') ? 'red' : 'neutral';
    return [{ kind: 'not-started', label: 'Not Started', tone }];
  }
  // null/unknown (no session): low-noise fallback — nothing before due.
  if (prox === 'overdue') return [{ kind: 'ungraded', label: 'Ungraded', tone: 'neutral' }];
  return [];
}

function nonLtiBadges({ submission_type, submitted_at, late, due_date, today }) {
  const badges = [];
  if (late) badges.push({ kind: 'late', label: 'Late', tone: 'red' });
  const submitted = !!submission_type || Number(submitted_at) > 0;
  if (submitted) {
    badges.push({ kind: 'submitted', label: 'Submitted', tone: 'green' });
  } else if (dueProximity(due_date, today) === 'overdue') {
    badges.push({ kind: 'missing', label: 'Missing', tone: 'red' });
  }
  return badges;
}

export function submissionStatus({ score, exception, late, draft, submitted_at, submission_type, is_lti_submission, lti_submission_state, due_date, today = new Date() }) {
  const exLabel = EXCEPTION_LABELS[exception];
  if (exception && exception !== 4 && exLabel) {
    const tone = exception === 1 ? 'blue' : 'red';
    return [{ kind: 'exception', label: exLabel, tone }];
  }
  if (score != null) return []; // graded — gradeLabel renders the score
  if (is_lti_submission) return ltiBadges(lti_submission_state, submission_type, due_date, today);
  return nonLtiBadges({ submission_type, submitted_at, late, due_date, today });
}
```

Leave `isPastDue` (now unused by this function) only if nothing else imports it — otherwise remove it. The `gradeLabel` export below is unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run client/src/lib/gradeLabel.test.js`
Expected: PASS (all lti + non-lti matrix tests + the untouched gradeLabel tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/gradeLabel.js client/src/lib/gradeLabel.test.js
git commit -m "feat(#62): submissionStatus renders true lti state + consolidated non-lti"
```

---

## Task 8: Add green + yellow tones to the full badge component

**Files:**
- Modify: `client/src/components/SubmissionBadges.jsx:15`

- [ ] **Step 1: Extend `TONE_CLASS`**

In `client/src/components/SubmissionBadges.jsx`, replace line 15:

```js
const TONE_CLASS = { red: 'badge-red', blue: 'badge-blue', amber: 'badge-pink', green: 'badge-green', yellow: 'badge-amber', neutral: 'badge-gray' };
```

(`badge-green` and `badge-amber` already exist in `app.css` as themed, variable-backed classes.)

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: build succeeds (no type/lint break). [No unit test — this is a one-line map extension; visual check happens in Task 10.]

- [ ] **Step 3: Commit**

```bash
git add client/src/components/SubmissionBadges.jsx
git commit -m "feat(#62): green Submitted + yellow overdue-in-progress badge tones"
```

---

## Task 9: Thread the new state through the page call sites

**Files:**
- Modify: `client/src/pages/CoursePage.jsx:15` (SHORT_BADGE), `:511`, `:858-867`, `:912-915`, `:963-967` (compact tone map)
- Modify: `client/src/pages/StudentPage.jsx:116-124`

- [ ] **Step 1: Extend `SHORT_BADGE` and add a compact tone map**

In `client/src/pages/CoursePage.jsx`, replace line 15:

```js
const SHORT_BADGE = { late: 'L', draft: 'D', missing: 'M', 'not-started': 'NS', submitted: 'S', 'in-progress': 'IP', ungraded: '·' };
const BADGE_TONE_CLASS = { red: 'badge-red', blue: 'badge-blue', amber: 'badge-pink', green: 'badge-green', yellow: 'badge-amber', neutral: 'badge-gray' };
```

- [ ] **Step 2: RubricModal call site (511) — pass the two fields**

In `client/src/pages/CoursePage.jsx`, update the `submissionStatus({…})` at line 511-514:

```js
  const status = submissionStatus({
    score: grade.score, exception: grade.exception, late: grade.late,
    draft: grade.draft, submitted_at: grade.submitted_at, submission_type: grade.submission_type,
    is_lti_submission: assignment.is_lti_submission, lti_submission_state: grade.lti_submission_state,
    due_date: assignment.due_date,
  });
```

- [ ] **Step 3: Empty-cell branch (858-868) — use the real state, drop hardcoded M/NS**

Replace the no-grade-row block (lines 855-868) with:

```js
                const g = grades[s.id]?.[a.id];
                if (!g) {
                  // No grade row — for lti this means the document pass found no
                  // state (no session / not covered); for native dropbox, past-due
                  // unsubmitted → Missing. Render via the shared badge logic.
                  const empty = submissionStatus({
                    score: null, exception: 0, late: 0, draft: 0, submitted_at: 0,
                    is_lti_submission: a.is_lti_submission, lti_submission_state: null,
                    due_date: a.due_date,
                  });
                  if (!empty.length) return <td key={a.id} style={{ textAlign: 'center' }}>—</td>;
                  return (
                    <td key={a.id} style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                      {empty.map(b => (
                        <span key={b.kind} className={`badge ${BADGE_TONE_CLASS[b.tone]}`} style={{ fontSize: '0.55rem', marginLeft: 3 }} title={b.label}>
                          {SHORT_BADGE[b.kind] || b.label[0]}
                        </span>
                      ))}
                    </td>
                  );
                }
```

- [ ] **Step 4: Graded-cell call site (912) — pass the two fields**

Update the `submissionStatus({…})` at lines 912-915:

```js
                const status = submissionStatus({
                  score: g.score, exception: g.exception, late: g.late, draft: g.draft,
                  submitted_at: g.submitted_at, submission_type: g.submission_type,
                  is_lti_submission: a.is_lti_submission, lti_submission_state: g.lti_submission_state,
                  due_date: a.due_date,
                });
```

- [ ] **Step 5: Compact badge render (963-967) — use the shared tone map**

Replace the inline badge map (lines 963-967) so it covers all tones:

```js
                    {inlineBadges.map(b => (
                      <span key={b.kind} className={`badge ${BADGE_TONE_CLASS[b.tone] || 'badge-gray'}`} style={{ fontSize: '0.55rem', marginLeft: 3 }} title={b.label}>
                        {SHORT_BADGE[b.kind] || b.label[0]}
                      </span>
                    ))}
```

- [ ] **Step 6: StudentPage call site (116) — pass the two fields**

In `client/src/pages/StudentPage.jsx`, update lines 116-124:

```js
                const statusBadges = submissionStatus({
                  score: g.score,
                  exception: g.exception,
                  late: g.late,
                  draft: g.draft,
                  submitted_at: g.submitted_at,
                  submission_type: g.submission_type,
                  is_lti_submission: g.is_lti_submission,
                  lti_submission_state: g.lti_submission_state,
                  due_date: g.due_date,
                });
```

- [ ] **Step 7: Build to verify compilation**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/CoursePage.jsx client/src/pages/StudentPage.jsx
git commit -m "feat(#62): render true lti submission state in gradebook + student page"
```

---

## Task 10: End-to-end verification + docs

**Files:**
- Modify: `.claude/build-progress.md` (note #62 shipped), `.claude/api-exploration-playbook.md` (frontier: mark in-progress/submitted-documents resolved)

- [ ] **Step 1: Full test sweep**

Run: `npx vitest run`
Expected: all suites PASS.

- [ ] **Step 2: Live sync + visual check (requires `npm run mastery:login`)**

Run a sync of the Robotics section, then open the gradebook for it (`npm run dev`, navigate to the ROBOTICS course). Confirm on Notebook 4: Brigid shows 🟢 Submitted; Maria shows Not Started (grey if >1wk out / red if within a week or overdue); the rest show In Progress (🔵, or 🟡 if overdue). Confirm a graded cell shows only the grade. Confirm no cell shows the old amber "Not Started" for a student who actually submitted.

- [ ] **Step 3: Update build-progress + playbook frontier**

Add a `build-progress.md` entry noting #62 shipped (true 4-state lti badges via `in-progress-documents`/`submitted-documents`, cheaper than the per-cell walk). In `api-exploration-playbook.md`, move the `/iapi2/assignments/.../{in-progress,submitted}-documents` from the open frontier to resolved (point at the schoology-api-reference note).

- [ ] **Step 4: Commit**

```bash
git add .claude/build-progress.md .claude/api-exploration-playbook.md
git commit -m "docs(#62): record true-state lti submission badges + resolved endpoints"
```

---

## Notes / non-goals

- **Archived sections:** untouched (frozen via #72; the iapi2 endpoints are likely GHD-blind there — not verified). Archived finalisation still skips the submission loop.
- **Late detection for lti:** `submissionTiming` (0/1) in the document payloads likely encodes on-time/late; left as a future enhancement — out of scope for #62.
- **Perf / Simplify Sync:** the lti path already removes per-cell calls; the broader rework stays in #55/#58.
- **Probe scripts** (`scripts/probe-*.js`) are retained as discovery tooling, consistent with the repo's existing `scripts/`.
