# Archived-Course Parity + Always-Fresh Student Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Prism capture an archived course's immutable snapshot (gradebook + mastery) automatically — on import, on current→archived transition, and as a one-time backfill — while keeping **student data** (email, preferred name, parent/guardian contacts) **fresh and reconciled every sync for every retained student**.

**Architecture:** Backend-only (plus removing two now-dead Sync-dialog controls). A new `finalizeArchivedCourse` (gradebook + mastery, session-permitting) is reused by the import route, a new `detectArchivedTransitions` step in `fullSync`, and a `backfillUnfinalizedArchived` step. Student enrichment is extracted into `enrichStudentProfiles` and upgraded to **reconcile** guardians (delete those Schoology no longer returns) — only on a successful profile fetch. A new `courses.finalized_at` column marks "mastery attempted with a session present".

**Tech Stack:** Node ESM, Express, `better-sqlite3`, Vitest. Schoology public OAuth (`apiGet`) + the existing Playwright-based mastery sync.

**Spec:** `docs/superpowers/specs/2026-05-31-archived-parity-and-student-freshness-design.md` · **Issue:** #70

**Conventions:** server tests `npx vitest run`; in-memory DB via `new Database(':memory:')` + `migrate(db)`; network mocked with `vi.mock('./schoology.js', …)`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Commit directly to `main`.

**Per-data-type immutability:** gradebook + mastery freeze at archive time; **student data never freezes**.

---

### Task 1: Migration — add `courses.finalized_at`

**Files:**
- Modify: `server/db/index.js` (the `MIGRATIONS` array)
- Test: `server/db/index.test.js`

- [ ] **Step 1: Write the failing test**

Add to `server/db/index.test.js` (it already imports `Database` from `better-sqlite3` and `migrate` from `./index.js`; if not, add `import Database from 'better-sqlite3'; import { migrate } from './index.js';` at the top):

```js
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './index.js';

describe('migration: courses.finalized_at (#70)', () => {
  test('adds a finalized_at column to courses', () => {
    const db = new Database(':memory:');
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(courses)').all().map((c) => c.name);
    expect(cols).toContain('finalized_at');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/db/index.test.js`
Expected: FAIL — `finalized_at` not in the column list.

- [ ] **Step 3: Add the migration**

In `server/db/index.js`, in the `MIGRATIONS` array, immediately after the line
`` `ALTER TABLE sync_metrics ADD COLUMN sections_skipped INTEGER DEFAULT 0`, `` and
before the `// Indexes for issue #13 columns` comment, add:

```js
  // #70: marks an archived course as finalised (mastery attempted with a browser
  // session present). Null = not yet captured → eligible for backfill.
  `ALTER TABLE courses ADD COLUMN finalized_at TEXT`,
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run server/db/index.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/index.js server/db/index.test.js
git commit -m "feat(#70): add courses.finalized_at migration"
```

---

### Task 2: Extract `enrichStudentProfiles` + reconcile guardians

**Files:**
- Modify: `server/services/sync.js` (add exported function; refactor `fullSync` lines ~648–701 to call it)
- Test: `server/services/sync.test.js`

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `server/services/sync.test.js` (the file already
`vi.mock('./schoology.js', …)` with `getUserProfile: vi.fn()` and imports `Database`/`migrate`). Add `enrichStudentProfiles` to the import from `./sync.js` and `getUserProfile` to the import from `./schoology.js`:

```js
import { syncSectionData, retrySubmissions, fullSync, enrichStudentProfiles } from './sync.js';
import { getUserProfile } from './schoology.js';

describe('enrichStudentProfiles — reconcile guardians (#70)', () => {
  let db;
  let studentId;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    studentId = db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name, email) VALUES ('u-1','Ada','Lovelace','old@x.com')`
    ).run().lastInsertRowid;
    // Two existing guardians: p-1 (kept) and p-2 (will be removed in Schoology).
    db.prepare(`INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email) VALUES (?, 'p-1','Mara','Lovelace','mara@x.com')`).run(studentId);
    db.prepare(`INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email) VALUES (?, 'p-2','Stale','Guardian','stale@x.com')`).run(studentId);
    getUserProfile.mockReset();
  });

  test('deletes a guardian Schoology no longer returns and updates email', async () => {
    getUserProfile.mockResolvedValue({
      primary_email: 'new@x.com',
      parents: { parent: [{ id: 'p-1', name_first: 'Mara', name_last: 'Lovelace', primary_email: 'mara@x.com' }] },
    });
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());

    const uids = db.prepare('SELECT schoology_uid FROM parents WHERE student_id = ? ORDER BY schoology_uid').all(studentId).map((r) => r.schoology_uid);
    expect(uids).toEqual(['p-1']); // p-2 reconciled away
    const email = db.prepare('SELECT email FROM students WHERE id = ?').get(studentId).email;
    expect(email).toBe('new@x.com');
  });

  test('a failed profile fetch preserves existing guardians and the student', async () => {
    getUserProfile.mockRejectedValue(new Error('403 inaccessible'));
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());

    const count = db.prepare('SELECT COUNT(*) n FROM parents WHERE student_id = ?').get(studentId).n;
    expect(count).toBe(2); // nothing deleted on failure
    expect(db.prepare('SELECT COUNT(*) n FROM students WHERE id = ?').get(studentId).n).toBe(1);
  });

  test('a student with no guardians in the profile has all guardians removed', async () => {
    getUserProfile.mockResolvedValue({ primary_email: null, parents: { parent: [] } });
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());
    expect(db.prepare('SELECT COUNT(*) n FROM parents WHERE student_id = ?').get(studentId).n).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/services/sync.test.js -t "reconcile guardians"`
Expected: FAIL — `enrichStudentProfiles` is not exported.

- [ ] **Step 3: Add `enrichStudentProfiles` to `server/services/sync.js`**

Add this exported function (e.g. directly above `fullSync`). It uses `getUserProfile`, already imported at the top of the file:

```js
// Refresh + RECONCILE one batch of students' profiles. For each student, fetch
// the Schoology profile and: update email/grad_year/preferred-name; upsert the
// guardians Schoology currently returns; and DELETE any stored guardian it no
// longer returns. Reconciliation runs ONLY on a successful fetch — a failed
// fetch leaves the student's data and contacts untouched (never wipe on error).
// Students are never deleted. Safeguarding: a removed/changed parent contact
// must not linger. `students` is a list of { id, schoology_uid }. Returns the
// number of profiles successfully fetched. (#70)
export async function enrichStudentProfiles(db, students, now) {
  const upsertParent = db.prepare(`
    INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email, relationship)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, schoology_uid) DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      email = excluded.email
  `);
  const updateStudent = db.prepare(`
    UPDATE students SET
      email = COALESCE(?, email),
      preferred_name = COALESCE(preferred_name, ?),
      grad_year = COALESCE(?, grad_year),
      updated_at = ?
    WHERE id = ?
  `);
  const deleteAllParents = db.prepare('DELETE FROM parents WHERE student_id = ?');
  const reconcileParents = (studentId, keepUids) => {
    if (keepUids.length === 0) { deleteAllParents.run(studentId); return; }
    const placeholders = keepUids.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM parents WHERE student_id = ? AND schoology_uid NOT IN (${placeholders})`
    ).run(studentId, ...keepUids);
  };

  let profileCount = 0;
  for (const s of students) {
    try {
      const profile = await getUserProfile(s.schoology_uid);
      const email = profile.primary_email || null;
      const prefName = (profile.name_first_preferred && profile.use_preferred_first_name === '1')
        ? profile.name_first_preferred : null;
      const gradYear = profile.grad_year ? parseInt(profile.grad_year) : null;
      updateStudent.run(email, prefName, gradYear, now, s.id);

      const parents = profile.parents?.parent || [];
      const keepUids = [];
      for (const p of parents) {
        upsertParent.run(s.id, String(p.id), p.name_first || '', p.name_last || '', p.primary_email || null, null);
        keepUids.push(String(p.id));
      }
      reconcileParents(s.id, keepUids);
      profileCount++;
    } catch {
      // Non-fatal: profile inaccessible (e.g. a graduated student). Preserve
      // last-known data + contacts; delete nothing.
    }
  }
  return profileCount;
}
```

- [ ] **Step 4: Refactor `fullSync` to use it**

In `server/services/sync.js`, replace the block from `// 3. Fetch full profiles + parent data for all students` through `totalRecords += profileCount;` (currently lines ~648–701) with:

```js
    // 3. Refresh + reconcile every retained student's profile + guardians.
    //    Runs for ALL students every sync (including those in no active course)
    //    so student data never goes stale. See enrichStudentProfiles (#70).
    const allStudents = db.prepare('SELECT id, schoology_uid FROM students WHERE schoology_uid IS NOT NULL').all();
    log(`Fetching profiles for ${allStudents.length} students...`);
    const profileCount = await enrichStudentProfiles(db, allStudents, now);
    log(`Fetched ${profileCount} profiles, reconciled parent contacts`);
    totalRecords += profileCount;
```

(This deletes the now-duplicated inline `upsertParent` statement and the per-student loop; `getUserProfile` stays imported.)

- [ ] **Step 5: Run to verify pass (new + existing fullSync tests)**

Run: `npx vitest run server/services/sync.test.js`
Expected: PASS — the three new tests pass and the existing `fullSync` tests still pass (no students seeded there → enrichment is a no-op).

- [ ] **Step 6: Commit**

```bash
git add server/services/sync.js server/services/sync.test.js
git commit -m "feat(#70): extract enrichStudentProfiles and reconcile guardians on sync"
```

---

### Task 3: `getSection` helper + `finalizeArchivedCourse`

**Files:**
- Modify: `server/services/schoology.js` (add `getSection`)
- Modify: `server/services/sync.js` (import mastery fns; add `finalizeArchivedCourse`)
- Test: `server/services/sync.test.js`

- [ ] **Step 1: Add the `getSection` helper**

In `server/services/schoology.js`, after `getMySections` (around line 82), add:

```js
export async function getSection(sectionId) {
  return apiGet(`/sections/${sectionId}`);
}
```

- [ ] **Step 2: Write the failing tests**

In `server/services/sync.test.js`, add a mock for `masterySync.js` near the top
(after the existing `vi.mock('./graderSubmissions.js', …)`):

```js
vi.mock('./masterySync.js', () => ({
  syncMasteryForCourse: vi.fn().mockResolvedValue({ scoresCount: 0 }),
  hasMasterySession: vi.fn(() => false),
}));
```

Import the mastery mocks and `finalizeArchivedCourse`:

```js
import { syncMasteryForCourse, hasMasterySession } from './masterySync.js';
import { /* …existing… */ finalizeArchivedCourse } from './sync.js';
```

Add the describe block:

```js
describe('finalizeArchivedCourse (#70)', () => {
  let db; let courseId;
  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('sec-9','Old Bio',1)`
    ).run().lastInsertRowid;
    const sch = await import('./schoology.js');
    sch.getSectionEnrollments.mockResolvedValue([]);
    sch.getSectionAssignments.mockResolvedValue([]);
    sch.getSectionGrades.mockResolvedValue([]);
    sch.getSubmissionStatus.mockResolvedValue(null);
    syncMasteryForCourse.mockClear();
    hasMasterySession.mockReset();
  });

  test('runs mastery and sets finalized_at when a session is present', async () => {
    hasMasterySession.mockReturnValue(true);
    await finalizeArchivedCourse(db, { courseId, sectionId: 'sec-9', now: '2026-05-31T00:00:00Z' });
    expect(syncMasteryForCourse).toHaveBeenCalledWith(courseId, expect.objectContaining({ allowInteractiveLogin: false }));
    expect(db.prepare('SELECT finalized_at FROM courses WHERE id = ?').get(courseId).finalized_at).toBe('2026-05-31T00:00:00Z');
  });

  test('skips mastery and leaves finalized_at null when no session', async () => {
    hasMasterySession.mockReturnValue(false);
    await finalizeArchivedCourse(db, { courseId, sectionId: 'sec-9', now: '2026-05-31T00:00:00Z' });
    expect(syncMasteryForCourse).not.toHaveBeenCalled();
    expect(db.prepare('SELECT finalized_at FROM courses WHERE id = ?').get(courseId).finalized_at).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run server/services/sync.test.js -t "finalizeArchivedCourse"`
Expected: FAIL — `finalizeArchivedCourse` is not exported.

- [ ] **Step 4: Add `finalizeArchivedCourse` to `server/services/sync.js`**

At the top of `server/services/sync.js`, add an import:

```js
import { syncMasteryForCourse, hasMasterySession } from './masterySync.js';
```

Add the function (e.g. above `fullSync`):

```js
// Capture an archived course's IMMUTABLE snapshot: gradebook (always, public
// OAuth via syncSectionData) + mastery (only when a browser session exists —
// mastery can't change after archiving). Sets courses.finalized_at = now when a
// session was present (mastery attempted, success or caught failure), so a
// session-less call leaves it null and a later session-enabled sync retries.
// Does NOT touch student data (that is enrichStudentProfiles' job). Returns the
// gradebook counts plus { finalized }. (#70)
export async function finalizeArchivedCourse(db, { courseId, sectionId, now, runMastery = true }) {
  const counts = await syncSectionData(db, String(sectionId), courseId, now);
  const sessionPresent = runMastery && hasMasterySession();
  if (sessionPresent) {
    try {
      await syncMasteryForCourse(courseId, { allowInteractiveLogin: false });
    } catch {
      // Best-effort: a mastery failure still counts as "attempted with a
      // session" so backfill doesn't retry forever; re-import is the escape hatch.
    }
    db.prepare('UPDATE courses SET finalized_at = ? WHERE id = ?').run(now, courseId);
  }
  return { ...counts, finalized: sessionPresent };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run server/services/sync.test.js`
Expected: PASS (new finalize tests + all existing — masterySync is mocked, `hasMasterySession` defaults to `false` so existing fullSync tests are unaffected).

- [ ] **Step 6: Commit**

```bash
git add server/services/schoology.js server/services/sync.js server/services/sync.test.js
git commit -m "feat(#70): add getSection + finalizeArchivedCourse (gradebook + mastery snapshot)"
```

---

### Task 4: Import route finalises + enriches

**Files:**
- Modify: `server/routes/courses.js` (import line 5; handler lines ~292–295)
- Test: `server/routes/courses.test.js`

- [ ] **Step 1: Write the failing test**

In `server/routes/courses.test.js`, add mocks at the top (after the existing
`vi.mock('../services/archivedCourses.js', …)`):

```js
vi.mock('../services/schoology.js', () => ({ apiGet: vi.fn() }));
vi.mock('../services/sync.js', () => ({
  finalizeArchivedCourse: vi.fn().mockResolvedValue({ studentsCount: 1, assignmentsCount: 2, gradesCount: 3 }),
  enrichStudentProfiles: vi.fn().mockResolvedValue(1),
}));
```

Import the mocks and add a `post` helper + test:

```js
import { apiGet } from '../services/schoology.js';
import { finalizeArchivedCourse, enrichStudentProfiles } from '../services/sync.js';

async function post(path, body) {
  const { server, port } = startServer();
  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

describe('POST /api/courses/import — finalise + enrich (#70)', () => {
  test('imports an archived course, finalising (mastery) and enriching its students', async () => {
    apiGet.mockReset();
    apiGet.mockImplementation((p) =>
      p.endsWith('/grading_periods')
        ? Promise.resolve({ grading_period: [{ title: 'Semester 1: 08/14/2024 - 01/11/2025' }] })
        : Promise.resolve({ id: 'sec-9', course_title: 'Old Bio', section_title: 'A', course_code: 'BIO', active: 0 }));
    finalizeArchivedCourse.mockClear();
    enrichStudentProfiles.mockClear();

    const res = await post('/api/courses/import', { sectionId: 'sec-9' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ studentsCount: 1, assignmentsCount: 2, gradesCount: 3 });
    expect(finalizeArchivedCourse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sectionId: 'sec-9', runMastery: true }),
    );
    expect(enrichStudentProfiles).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/routes/courses.test.js -t "finalise + enrich"`
Expected: FAIL — the route still calls `syncSectionData` (not `finalizeArchivedCourse`) and never calls `enrichStudentProfiles`.

- [ ] **Step 3: Update the import route**

In `server/routes/courses.js`, change the import on line 5:

```js
import { syncSectionData } from '../services/sync.js';
```

to:

```js
import { finalizeArchivedCourse, enrichStudentProfiles } from '../services/sync.js';
```

Replace the single line (currently ~293):

```js
    const { studentsCount, assignmentsCount, gradesCount } = await syncSectionData(db, String(sec.id), courseRow.id, now);
```

with:

```js
    const { studentsCount, assignmentsCount, gradesCount } =
      await finalizeArchivedCourse(db, { courseId: courseRow.id, sectionId: sec.id, now, runMastery: true });
    // Bring the imported section's students to full parity (email + guardians).
    const sectionStudents = db.prepare(`
      SELECT s.id, s.schoology_uid FROM students s
      JOIN enrolments e ON e.student_id = s.id
      WHERE e.course_id = ? AND s.schoology_uid IS NOT NULL
    `).all(courseRow.id);
    await enrichStudentProfiles(db, sectionStudents, now);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/routes/courses.test.js`
Expected: PASS (new test + existing GET-route tests — they don't touch the mocked modules).

- [ ] **Step 5: Commit**

```bash
git add server/routes/courses.js server/routes/courses.test.js
git commit -m "feat(#70): archived import finalises (gradebook+mastery) and enriches students"
```

---

### Task 5: Remove the `includeArchived` toggle + Step 2 archived group; always skip archived

**Files:**
- Modify: `server/services/sync.js` (`fullSync` signature + skip line)
- Modify: `server/services/syncOrchestrator.js` (lines 22–37)
- Modify: `server/routes/schoology.js` (lines 14, 24–29, 34)
- Modify: `client/src/services/api.js` (`runSync` only — NOT `getCourses`)
- Modify: `client/src/components/SyncConfig.jsx`
- Modify: `client/src/components/SyncDialog.jsx`
- Test: `server/services/sync.test.js` (skip matrix), `client/src/components/SyncConfig.test.jsx`

- [ ] **Step 1: Update the server skip-matrix tests (write the new expectations first)**

In `server/services/sync.test.js`, in the `describe('fullSync — course skip matrix (#56)', …)` block: **delete** the `test('includeArchived=true visits visible + archived…')` test entirely, and replace the `test('excluded never reached even with both toggles on', …)` with:

```js
  test('archived is always skipped; excluded never reached even with includeHidden', async () => {
    seedCourses();
    const { getSectionEnrollments } = await import('./schoology.js');

    await fullSync(() => {}, { includeHidden: true });

    const visited = getSectionEnrollments.mock.calls.map(c => c[0]).sort();
    expect(visited).toEqual(['sec-hidden', 'sec-visible']);
    expect(visited).not.toContain('sec-archived');
    expect(visited).not.toContain('sec-excluded');
  });
```

(The `default sync skips hidden, archived, and excluded` and `includeHidden=true…` tests are unchanged and still pass.)

- [ ] **Step 2: Run to verify the new skip test fails**

Run: `npx vitest run server/services/sync.test.js -t "course skip matrix"`
Expected: FAIL — `fullSync` still honours `includeArchived` (and the removed test referenced it).

- [ ] **Step 3: Always-skip archived + drop `includeArchived` in `fullSync`**

In `server/services/sync.js`, change the `fullSync` signature:

```js
export async function fullSync(onProgress, { includeHidden = false, includeArchived = false } = {}) {
```

to:

```js
export async function fullSync(onProgress, { includeHidden = false } = {}) {
```

Change the archived skip line (currently ~574):

```js
      if (courseRow.archived && !includeArchived) { metrics.sections_skipped++; continue; }
```

to (archived courses are immutable — never re-synced by the recurring sync):

```js
      if (courseRow.archived) { metrics.sections_skipped++; continue; }
```

- [ ] **Step 4: Drop `includeArchived` from the orchestrator + route + api client**

In `server/services/syncOrchestrator.js`: in the `runUnifiedSync` signature (line ~23) remove `includeArchived = false`, and in the `fullSync(...)` call (line ~37) change `{ includeHidden, includeArchived }` to `{ includeHidden }`.

In `server/routes/schoology.js`: remove the `//   includeArchived?: boolean,` comment line (~14); remove `includeArchived = false,` from the destructure (~28); and change the `runUnifiedSync({ masteryCourseIds, skipSchoology, includeHidden, includeArchived }, write)` call (~34) to `runUnifiedSync({ masteryCourseIds, skipSchoology, includeHidden }, write)`.

In `client/src/services/api.js`: in `runSync` (line ~63–70) remove `includeArchived = false` from the destructure and `includeArchived` from the `JSON.stringify({ … })` body. **Do not touch `getCourses` (line ~16) — its `includeArchived` is an unrelated list query param.**

- [ ] **Step 5: Remove the toggle + archived group from `SyncConfig.jsx`**

In `client/src/components/SyncConfig.jsx`:

Remove the `archived` entry from `GROUPS` (line 7), leaving:

```js
const GROUPS = [
  { key: 'visible',  label: 'Visible courses',  match: (c) => !c.hidden && !c.archived && !c.excluded },
  { key: 'hidden',   label: 'Hidden courses',   match: (c) => c.hidden && !c.archived && !c.excluded },
];
```

Remove the `includeArchived` state (line 38) and the `archivedCount` memo (lines 44–47). Change the `collapsed` initial state (line 35) to `useState({ visible: false, hidden: true })`.

Remove the "Include archived courses" `<label>` block (lines 84–91) — keep the "Include hidden courses" label above it.

Change the Start-sync `onClick` (line 179) from `onStart([...selected], { includeHidden, includeArchived })` to `onStart([...selected], { includeHidden })`.

- [ ] **Step 6: Drop `includeArchived` from `SyncDialog.jsx`**

In `client/src/components/SyncDialog.jsx`: in `startSync` (line ~41) remove `includeArchived = false` from the options destructure, and in the `runSync({ … })` call (~46) change `{ masteryCourseIds, skipSchoology, includeHidden, includeArchived }` to `{ masteryCourseIds, skipSchoology, includeHidden }`.

- [ ] **Step 7: Update `SyncConfig.test.jsx`**

In `client/src/components/SyncConfig.test.jsx`:
- The `renders the three course groups with counts` test asserts `getByText(/Archived courses/)` — **remove that assertion line** (the archived group is gone; keep the Visible/Hidden assertions).
- The onStart assertion (line 51) `expect(onStart).toHaveBeenCalledWith([1, 2], { includeHidden: false, includeArchived: false });` → change to `{ includeHidden: false }`.
- If any test references the "Include archived courses" toggle text, remove it.

- [ ] **Step 8: Run both suites**

Run: `npx vitest run server/services/sync.test.js server/services/syncOrchestrator.test.js server/routes/schoology.test.js` and `cd client && npx vitest run src/components/SyncConfig.test.jsx`
Expected: PASS. (If `syncOrchestrator.test.js` or `schoology.test.js` pass `includeArchived` anywhere, drop it — grep first: `grep -rn includeArchived server/services/syncOrchestrator.test.js server/routes/schoology.test.js`.)

- [ ] **Step 9: Commit**

```bash
git add server/services/sync.js server/services/syncOrchestrator.js server/routes/schoology.js client/src/services/api.js client/src/components/SyncConfig.jsx client/src/components/SyncDialog.jsx server/services/sync.test.js client/src/components/SyncConfig.test.jsx
git commit -m "feat(#70): always skip archived in sync; remove Include-archived toggle + archived mastery group"
```

---

### Task 6: Auto-archive on current→archived transition

**Files:**
- Modify: `server/services/sync.js` (add `detectArchivedTransitions`; call it in `fullSync`; import `getSection`)
- Test: `server/services/sync.test.js`

- [ ] **Step 1: Write the failing tests**

In `server/services/sync.test.js`, add `getSection` to the `vi.mock('./schoology.js', …)` exports list (`getSection: vi.fn(),`) and to the imports from `./schoology.js`. Add `detectArchivedTransitions` to the `./sync.js` import. Add:

```js
import { getSection, getSectionGradingPeriods } from './schoology.js';
// (detectArchivedTransitions added to the existing './sync.js' import)

describe('detectArchivedTransitions (#70)', () => {
  let db;
  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    const sch = await import('./schoology.js');
    sch.getSectionEnrollments.mockResolvedValue([]);
    sch.getSectionAssignments.mockResolvedValue([]);
    sch.getSectionGrades.mockResolvedValue([]);
    sch.getSubmissionStatus.mockResolvedValue(null);
    sch.getSectionGradingPeriods.mockResolvedValue([{ title: 'Semester 1: 08/14/2024 - 01/11/2025' }]);
    hasMasterySession.mockReturnValue(false); // gradebook-only finalise in this test
    getSection.mockReset();
  });

  function seed(sectionId, archived = 0) {
    return db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name, archived, excluded, synced_at) VALUES (?, ?, ?, 0, '2026-01-01T00:00:00Z')`
    ).run(sectionId, sectionId, archived).lastInsertRowid;
  }

  test('archives a dropped course that the section read confirms is inactive', async () => {
    const id = seed('sec-gone');
    getSection.mockResolvedValue({ id: 'sec-gone', active: 0, course_title: 'Gone' });
    await detectArchivedTransitions(db, new Set(['sec-active']), '2026-05-31T00:00:00Z');
    expect(db.prepare('SELECT archived FROM courses WHERE id = ?').get(id).archived).toBe(1);
  });

  test('leaves a dropped course that is still active (transient drop)', async () => {
    const id = seed('sec-blip');
    getSection.mockResolvedValue({ id: 'sec-blip', active: 1 });
    await detectArchivedTransitions(db, new Set(['sec-active']), '2026-05-31T00:00:00Z');
    expect(db.prepare('SELECT archived FROM courses WHERE id = ?').get(id).archived).toBe(0);
  });

  test('archives (no data refresh) when the section read 404s', async () => {
    const id = seed('sec-deleted');
    const err = new Error('Schoology API 404'); err.status = 404;
    getSection.mockRejectedValue(err);
    await detectArchivedTransitions(db, new Set([]), '2026-05-31T00:00:00Z');
    expect(db.prepare('SELECT archived FROM courses WHERE id = ?').get(id).archived).toBe(1);
  });

  test('ignores courses still in the active set', async () => {
    const id = seed('sec-active');
    await detectArchivedTransitions(db, new Set(['sec-active']), '2026-05-31T00:00:00Z');
    expect(getSection).not.toHaveBeenCalled();
    expect(db.prepare('SELECT archived FROM courses WHERE id = ?').get(id).archived).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/services/sync.test.js -t "detectArchivedTransitions"`
Expected: FAIL — `detectArchivedTransitions` is not exported.

- [ ] **Step 3: Add `detectArchivedTransitions` + import `getSection`**

In `server/services/sync.js`, add `getSection` to the import from `./schoology.js`. Add the function:

```js
// Auto-archive: a previously-synced active course (archived=0, has synced_at)
// that has dropped off the active-sections set has likely been archived on
// Schoology. Confirm via a section read before archiving: active:0 → finalise
// (gradebook + mastery if a session exists) + mark archived; still active:1 →
// leave (transient/ambiguous); 404 → mark archived but keep the last snapshot.
// `activeSectionIds` is a Set of the section ids returned by getMySections. (#70)
export async function detectArchivedTransitions(db, activeSectionIds, now) {
  const dropped = db.prepare(`
    SELECT id, schoology_section_id FROM courses
    WHERE archived = 0 AND excluded = 0 AND synced_at IS NOT NULL
  `).all().filter((c) => !activeSectionIds.has(String(c.schoology_section_id)));

  for (const c of dropped) {
    const sectionId = String(c.schoology_section_id);
    let sec;
    try {
      sec = await getSection(sectionId);
    } catch (err) {
      if (err?.status === 404) {
        db.prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(c.id);
      }
      continue; // transient/other error → leave for a later sync
    }
    if (Number(sec.active) === 0) {
      const periods = await getSectionGradingPeriods(sectionId).catch(() => []);
      const gradingPeriod = periods[0]?.title || null;
      await finalizeArchivedCourse(db, { courseId: c.id, sectionId, now });
      db.prepare('UPDATE courses SET archived = 1, grading_period = COALESCE(?, grading_period) WHERE id = ?')
        .run(gradingPeriod, c.id);
    }
  }
}
```

- [ ] **Step 4: Wire it into `fullSync`**

In `server/services/sync.js`, in `fullSync`, immediately after the retry-pass block (the `if (metrics.failed_assignment_ids.length > 0 …) { … }`, ~line 646) and before the `// 3. Fetch full profiles` comment, add:

```js
    // Auto-archive courses that have dropped off the active list this turn.
    await detectArchivedTransitions(db, new Set(sections.map((s) => String(s.id))), now);
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run server/services/sync.test.js`
Expected: PASS. The existing skip-matrix tests still pass: their seeded courses are all in the active set (`getMySections` returns them), so `detectArchivedTransitions` finds no dropped courses and `getSection` is never called.

- [ ] **Step 6: Commit**

```bash
git add server/services/sync.js server/services/sync.test.js
git commit -m "feat(#70): auto-archive courses on current->archived transition (confirm via section read)"
```

---

### Task 7: One-time backfill of unfinalised archived courses

**Files:**
- Modify: `server/services/sync.js` (add `backfillUnfinalizedArchived`; call it in `fullSync`)
- Test: `server/services/sync.test.js` (new tests + update `seedCourses` for the skip matrix)

- [ ] **Step 1: Write the failing tests + protect the skip matrix**

In `server/services/sync.test.js`:

(a) Update `seedCourses()` so its archived row is already finalised (otherwise the new backfill step in `fullSync` would finalise it and pull `sec-archived` into the visited list). Change the INSERT to include `finalized_at` and set it for the archived row only:

```js
  function seedCourses() {
    const stmt = db.prepare(`
      INSERT INTO courses
        (schoology_section_id, course_name, course_code, section_school_code, hidden, archived, excluded, finalized_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run('sec-visible',  'Visible Course',  'CSE101', 'S1', 0, 0, 0, null);
    stmt.run('sec-hidden',   'Hidden Course',   'CSE102', 'S2', 1, 0, 0, null);
    stmt.run('sec-archived', 'Archived Course', 'CSE103', 'S3', 0, 1, 0, '2026-01-01T00:00:00Z');
    stmt.run('sec-excluded', 'MASTER Template', null,     null, 0, 0, 1, null);
    return ['sec-visible', 'sec-hidden', 'sec-archived', 'sec-excluded'];
  }
```

(b) Add the backfill tests (`backfillUnfinalizedArchived` added to the `./sync.js` import):

```js
describe('backfillUnfinalizedArchived (#70)', () => {
  let db;
  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    const sch = await import('./schoology.js');
    sch.getSectionEnrollments.mockResolvedValue([]);
    sch.getSectionAssignments.mockResolvedValue([]);
    sch.getSectionGrades.mockResolvedValue([]);
    sch.getSubmissionStatus.mockResolvedValue(null);
    hasMasterySession.mockReturnValue(true);
    syncMasteryForCourse.mockClear();
  });

  test('finalises an unfinalised archived course once and skips finalised ones', async () => {
    const a = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('a',?,1)`).run('A').lastInsertRowid;
    const b = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived, finalized_at) VALUES ('b',?,1,'2026-01-01T00:00:00Z')`).run('B').lastInsertRowid;

    const n = await backfillUnfinalizedArchived(db, '2026-05-31T00:00:00Z');

    expect(n).toBe(1); // only A was eligible
    expect(syncMasteryForCourse).toHaveBeenCalledTimes(1);
    expect(syncMasteryForCourse).toHaveBeenCalledWith(a, expect.anything());
    expect(db.prepare('SELECT finalized_at FROM courses WHERE id = ?').get(a).finalized_at).toBe('2026-05-31T00:00:00Z');
    expect(db.prepare('SELECT finalized_at FROM courses WHERE id = ?').get(b).finalized_at).toBe('2026-01-01T00:00:00Z');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/services/sync.test.js -t "backfillUnfinalizedArchived"`
Expected: FAIL — `backfillUnfinalizedArchived` is not exported.

- [ ] **Step 3: Add `backfillUnfinalizedArchived`**

In `server/services/sync.js`:

```js
// One-time backfill: finalise archived courses that were never finalised
// (imported under the old flow). Captures mastery when a session is present;
// converges over session-enabled syncs and never re-runs once finalized_at is
// set. Returns the number of courses processed. (#70)
export async function backfillUnfinalizedArchived(db, now) {
  const courses = db.prepare(
    'SELECT id, schoology_section_id FROM courses WHERE archived = 1 AND excluded = 0 AND finalized_at IS NULL'
  ).all();
  for (const c of courses) {
    await finalizeArchivedCourse(db, { courseId: c.id, sectionId: c.schoology_section_id, now });
  }
  return courses.length;
}
```

- [ ] **Step 4: Wire it into `fullSync`**

In `server/services/sync.js`, in `fullSync`, immediately after the
`await detectArchivedTransitions(...)` line added in Task 6, add:

```js
    // One-time: finalise archived courses imported before #70 (capture mastery).
    await backfillUnfinalizedArchived(db, now);
```

- [ ] **Step 5: Run the full server suite**

Run: `npx vitest run server/services/sync.test.js`
Expected: PASS — backfill tests pass; the skip-matrix tests pass because `seedCourses`'s archived row is now pre-finalised (backfill skips it) and is still in the active set (no transition).

- [ ] **Step 6: Commit**

```bash
git add server/services/sync.js server/services/sync.test.js
git commit -m "feat(#70): backfill mastery for archived courses finalised before this change"
```

---

### Task 8: Full verification + build-progress + close #70

**Files:**
- Modify: `.claude/build-progress.md`

- [ ] **Step 1: Run both full suites**

Run: `npx vitest run` (server) and `cd client && npx vitest run` (client)
Expected: all green. Server gains the migration, enrich, finalize, transition, backfill tests; client `SyncConfig.test.jsx` updated. Investigate any failure before proceeding.

- [ ] **Step 2: Live verification**

With the dev server running, and a Schoology browser session present (`npm run mastery:login` only if dead — confirm first):
- Trigger a sync. Confirm an existing archived course (e.g. MOBILE GAMES DEVELOPMENT) gets `finalized_at` set (backfill): `sqlite3 server/db/students.db "SELECT course_name, archived, finalized_at FROM courses WHERE archived=1;"`.
- Confirm the Sync dialog no longer shows the "Include archived courses" toggle or a Step 2 "Archived courses" group.
- (If feasible) confirm a student's removed guardian disappears from the `parents` table after a sync, and a student in no active course still gets re-fetched. Mask any real values; do not commit PII.

- [ ] **Step 3: Append a build-progress entry**

Add a dated `## Archived-Course Parity + Always-Fresh Student Data (#70)` entry to
`.claude/build-progress.md` summarising: `enrichStudentProfiles` (reconcile guardians, only on success), `finalizeArchivedCourse` (gradebook + mastery, `finalized_at` marker), import finalises+enriches, `detectArchivedTransitions` (confirm-via-section-read), `backfillUnfinalizedArchived`, removed `includeArchived` toggle + archived mastery group + always-skip-archived, the `finalized_at` migration. Note the live-verified result and a "not yet explored" list (sync perf of enriching all retained students — #55; sub-project B / #71; PowerSchool safeguarding freshness — #66/#65).

- [ ] **Step 4: Commit**

```bash
git add .claude/build-progress.md
git commit -m "docs(#70): build-progress — archived parity + student freshness shipped"
```

- [ ] **Step 5: Close the issue (after live verification confirmed)**

```bash
gh issue close 70 --comment "Shipped: auto-archive on transition (confirm-via-section-read), finalizeArchivedCourse (gradebook+mastery, finalized_at marker) reused by import + transition + one-time backfill, enrichStudentProfiles with guardian reconciliation (every sync, all retained students), and removal of the Include-archived toggle + Step 2 archived mastery group. Server + client suites green; live-verified. Follow-on UX in #71."
```

---

## Self-Review

**Spec coverage:**
- Always-fresh student data + reconcile-on-success → Task 2 (`enrichStudentProfiles`) + `fullSync` refactor.
- Finalise = gradebook + mastery + `finalized_at` semantics → Task 3.
- Import finalises + enriches → Task 4.
- Auto-archive on transition, confirm-via-section-read (active:0 / active:1 / 404) → Task 6.
- Backfill once → Task 7.
- Remove Include-archived toggle (+ plumbing) and Step 2 archived mastery group; archived never re-synced → Task 5.
- Migration → Task 1. Out-of-scope (#66/#65, perf, sub-project B) → noted in Task 8's build-progress + the spec. ✓

**Placeholder scan:** every code step shows complete code; commands have expected outcomes; no TBD/TODO. The Task 5 Step 8 note to grep `syncOrchestrator.test.js`/`schoology.test.js` for stray `includeArchived` is a verification action, not a placeholder (the earlier scan found none in those files). ✓

**Type/name consistency:** `enrichStudentProfiles(db, students, now)`, `finalizeArchivedCourse(db, { courseId, sectionId, now, runMastery })` (returns `{ ...counts, finalized }`), `detectArchivedTransitions(db, activeSectionIds, now)`, `backfillUnfinalizedArchived(db, now)`, `getSection(sectionId)`, `hasMasterySession()`, `syncMasteryForCourse(courseId, { allowInteractiveLogin })`, `courses.finalized_at` — used identically across tasks. `finalizeArchivedCourse` is defined (Task 3) before its callers (Tasks 4, 6, 7). `getSection`/mastery mocks are added to `sync.test.js` in the task that first needs them (Task 3 mastery, Task 6 `getSection`). ✓
