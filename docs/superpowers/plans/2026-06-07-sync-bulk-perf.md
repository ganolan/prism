# Sync Bulk-Perf Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three per-item sync loops with their verified bulk equivalents, collapsing two O(N×M) walks and one O(N) walk into O(M)/O(chunks) calls, with **no behavioural change** (parity-exact).

**Architecture:** Three independent, low-conflict changes on one branch `feat/sync-bulk-perf` off `main`:
1. **#55** — native-dropbox submissions: per-(assignment × student) `GET /submissions/{aid}/{uid}` walk → ONE `GET /submissions/{aid}` per assignment, grouped by uid. GHD wiring is preserved exactly; only the *source* of each cell's `revision` object changes (per-cell call → grouped bulk fetch).
2. **#104** — mastery observations: per-topic `GET material-observations/search` loop → ONE `POST material-observations/search` with `objective_ids` csv, regrouped by `objective_id`.
3. **#105** — student profiles: per-student `GET /users/{uid}` loop → `POST /v1/multiget` chunked at 50.

Each win pairs unit TDD (pure helpers + fetchers) with a **live parity probe** (`scripts/parity-*.js`) that diffs old-vs-new against real Schoology data before we rely on it — the #62 e2e approach that caught a real concurrency bug.

**Tech Stack:** ESM, Node, Express, better-sqlite3, vitest, oauth-1.0a (PLAINTEXT), Playwright (mastery internal API).

**Key invariants to preserve:**
- `getSubmissionStatus(...)` output shape `{ ...latestRevision, latestRevisionAt }` (resubmit timing, #49 `isResubmitted`).
- The four `writeSubmissions` branches in `syncSectionData` (GHD-submitted / GHD-not-submitted / uncovered+revision / cleared) and the `submission_type` semantics.
- `enrichStudentProfiles` reconcile-on-success / preserve-on-failure (safeguarding: a removed guardian must not linger, but a failed fetch must not wipe).
- `observationsByTopic` shape feeding the persist step in `syncMasteryForCourse` (`obs.student_uid`, `obs.gradeable_material.material_id`, `obs.points`).

---

## File Structure

**New files:**
- `server/lib/submissionRevisions.js` — pure: `summarizeRevisions(revisions)`, `groupRevisionsByUid(revisions)`.
- `server/lib/submissionRevisions.test.js` — unit tests for the above.
- `server/lib/masteryObservations.js` — pure: `groupObservationsByTopic(observations, topicIds)`.
- `server/lib/masteryObservations.test.js` — unit tests.
- `scripts/parity-bulk-submissions.js` — live parity probe (#55).
- `scripts/parity-mastery-batch.js` — live parity probe (#104).
- `scripts/parity-multiget-profiles.js` — live parity probe (#105).

**Modified:**
- `server/services/schoology.js` — add `getAssignmentSubmissions`, `apiPost`, `getUserProfilesBatch`; refactor `getSubmissionStatus` to delegate to `summarizeRevisions`.
- `server/services/schoology.test.js` — add tests for the three new fetchers.
- `server/services/sync.js` — rewire native-dropbox path + `retrySubmissions` to bulk; rewire `enrichStudentProfiles` to batch.
- `server/services/sync.test.js` — update native-submission + profile tests for the bulk fetchers.
- `server/services/masterySync.js` — replace per-topic loop with batched POST.
- `.claude/schoology-api-reference.md` — flip the three "verified spike" rows to "shipped".
- `.claude/build-progress.md` — log the three wins.

---

## Task 0: Branch

- [ ] **Step 1: Create the branch off main**

Run:
```bash
cd /Users/gnolan/Documents/code/prism
git checkout main && git pull --ff-only 2>/dev/null; git checkout -b feat/sync-bulk-perf
```
Expected: `Switched to a new branch 'feat/sync-bulk-perf'`.

- [ ] **Step 2: Confirm the test runner is green before changes**

Run: `npm run test:server`
Expected: all suites PASS (this is the baseline).

---

# WIN 1 — #55 Native-dropbox bulk submissions

## Task 1.1: Pure revision helpers

**Files:**
- Create: `server/lib/submissionRevisions.js`
- Test: `server/lib/submissionRevisions.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/lib/submissionRevisions.test.js
import { describe, test, expect } from 'vitest';
import { summarizeRevisions, groupRevisionsByUid } from './submissionRevisions.js';

describe('summarizeRevisions', () => {
  test('empty / non-array → null', () => {
    expect(summarizeRevisions([])).toBeNull();
    expect(summarizeRevisions(null)).toBeNull();
    expect(summarizeRevisions(undefined)).toBeNull();
  });

  test('picks the latest revision by revision_id and spreads it', () => {
    const r = summarizeRevisions([
      { revision_id: 1, uid: '701', created: 1000, late: 0, draft: 0 },
      { revision_id: 3, uid: '701', created: 3000, late: 1, draft: 0 },
      { revision_id: 2, uid: '701', created: 2000, late: 0, draft: 0 },
    ]);
    expect(r.revision_id).toBe(3);
    expect(r.late).toBe(1);
    expect(r.latestRevisionAt).toBe(3000);
  });

  test('latestRevisionAt ignores draft revisions', () => {
    // Latest by id is a draft; latestRevisionAt must be the newest NON-draft created.
    const r = summarizeRevisions([
      { revision_id: 1, uid: '701', created: 1000, late: 0, draft: 0 },
      { revision_id: 2, uid: '701', created: 5000, late: 0, draft: 1 },
    ]);
    expect(r.revision_id).toBe(2);   // latest object is still the draft
    expect(r.draft).toBe(1);
    expect(r.latestRevisionAt).toBe(1000); // newest non-draft created
  });

  test('all-draft → latestRevisionAt is 0', () => {
    const r = summarizeRevisions([{ revision_id: 1, uid: '701', created: 1000, draft: 1 }]);
    expect(r.latestRevisionAt).toBe(0);
  });
});

describe('groupRevisionsByUid', () => {
  test('groups by string uid and summarizes each group', () => {
    const m = groupRevisionsByUid([
      { revision_id: 1, uid: 701, created: 1000, late: 0, draft: 0 },
      { revision_id: 2, uid: 701, created: 2000, late: 1, draft: 0 },
      { revision_id: 1, uid: '702', created: 500, late: 0, draft: 1 },
    ]);
    expect([...m.keys()].sort()).toEqual(['701', '702']);
    expect(m.get('701').latestRevisionAt).toBe(2000);
    expect(m.get('701').late).toBe(1);
    expect(m.get('702').draft).toBe(1);
    expect(m.get('702').latestRevisionAt).toBe(0);
  });

  test('empty / nullish → empty map', () => {
    expect(groupRevisionsByUid([]).size).toBe(0);
    expect(groupRevisionsByUid(null).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run server/lib/submissionRevisions.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// server/lib/submissionRevisions.js
// Pure helpers for Schoology submission revisions. Shared by the per-student
// getSubmissionStatus and the bulk #55 native-dropbox path so both derive the
// exact same per-student summary.

// Reduce a student's revision array to { ...latestRevision, latestRevisionAt }.
// latest = highest revision_id; latestRevisionAt = newest NON-draft `created`
// (0 if none). A draft revision is "in progress", not a submission, so it must
// not seed the resubmit baseline (#49). Returns null for an empty list.
export function summarizeRevisions(revisions) {
  if (!Array.isArray(revisions) || revisions.length === 0) return null;
  const latest = revisions.reduce((m, r) =>
    (Number(r.revision_id) > Number(m.revision_id) ? r : m));
  const latestRevisionAt = revisions
    .filter(r => Number(r.draft) !== 1)
    .reduce((m, r) => Math.max(m, Number(r.created) || 0), 0);
  return { ...latest, latestRevisionAt };
}

// Group a flat revision array (the bulk GET /submissions/{aid} response) by uid,
// summarizing each student's revisions. Returns Map<string uid, summary>.
export function groupRevisionsByUid(revisions) {
  const byUid = new Map();
  for (const r of (revisions || [])) {
    const uid = String(r.uid);
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(r);
  }
  const out = new Map();
  for (const [uid, revs] of byUid) out.set(uid, summarizeRevisions(revs));
  return out;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run server/lib/submissionRevisions.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/submissionRevisions.js server/lib/submissionRevisions.test.js
git commit -m "feat(#55): pure summarizeRevisions + groupRevisionsByUid helpers"
```

## Task 1.2: Bulk fetcher + getSubmissionStatus delegation

**Files:**
- Modify: `server/services/schoology.js`
- Test: `server/services/schoology.test.js`

- [ ] **Step 1: Write the failing test** (append to `schoology.test.js`)

```js
describe('getAssignmentSubmissions (bulk #55)', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('returns the flat revision[] for one assignment in one call', async () => {
    const { getAssignmentSubmissions } = await import('./schoology.js');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      revision: [
        { revision_id: 1, uid: '701', created: 1000, late: 0, draft: 0 },
        { revision_id: 1, uid: '702', created: 2000, late: 1, draft: 0 },
      ],
      total: 2,
    })));
    const revs = await getAssignmentSubmissions('sec-1', 'A1');
    expect(revs).toHaveLength(2);
    expect(revs.map(r => r.uid).sort()).toEqual(['701', '702']);
  });

  test('follows links.next pagination and concatenates every page', async () => {
    const { getAssignmentSubmissions } = await import('./schoology.js');
    const page1 = {
      revision: Array.from({ length: 20 }, (_, i) => ({ revision_id: 1, uid: String(i), created: 1, late: 0, draft: 0 })),
      links: { next: 'https://api.schoology.com/v1/sections/sec-1/submissions/A1?start=20&limit=20' },
    };
    const page2 = {
      revision: [{ revision_id: 1, uid: '99', created: 1, late: 0, draft: 0 }],
    };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(url);
      return jsonResponse(url.includes('start=20') ? page2 : page1);
    }));
    const revs = await getAssignmentSubmissions('sec-1', 'A1');
    expect(revs).toHaveLength(21);
    expect(calls.some(u => u.includes('start=20'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run server/services/schoology.test.js`
Expected: FAIL (`getAssignmentSubmissions` is not a function).

- [ ] **Step 3: Implement in `schoology.js`**

Add the import at the top (after the `OAuth` import):
```js
import { summarizeRevisions } from '../lib/submissionRevisions.js';
```

Replace the existing `getSubmissionStatus` (lines ~133-152) with a delegating version and add the bulk fetcher directly above it:
```js
// Bulk submission fetch (#55): ALL students' revisions for one assignment in a
// single call — `{ revision: [{ revision_id, uid, created, num_items, late,
// draft }], total, links }`. Follows links.next (Schoology pages this at ~20).
// Native dropbox only — the public revisions API is blind to post-submit LTI
// (those use the #62 document endpoints). Group the result with
// groupRevisionsByUid to recover the per-student summary.
export async function getAssignmentSubmissions(sectionId, assignmentId) {
  let url = `/sections/${sectionId}/submissions/${assignmentId}?limit=100`;
  const all = [];
  // Safety cap: Schoology rosters are ~20; this guards a malformed links.next.
  for (let page = 0; url && page < 100; page++) {
    const data = await apiGet(url);
    const revs = data?.revision || [];
    all.push(...revs);
    url = data?.links?.next || null;
  }
  return all;
}

// Returns the per-student revision summary { ...latestRevision, latestRevisionAt }
// or null. latestRevisionAt is the newest non-draft `created` (the #49 resubmit
// baseline). Shares summarizeRevisions with the bulk #55 path.
export async function getSubmissionStatus(sectionId, assignmentId, userId) {
  const data = await apiGet(`/sections/${sectionId}/submissions/${assignmentId}/${userId}`);
  return summarizeRevisions(data?.revision || []);
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run server/services/schoology.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/schoology.js server/services/schoology.test.js
git commit -m "feat(#55): bulk getAssignmentSubmissions + getSubmissionStatus shares summarizeRevisions"
```

## Task 1.3: Rewire the native-dropbox path in syncSectionData

**Files:**
- Modify: `server/services/sync.js`
- Test: `server/services/sync.test.js`

**Design:** Keep the GHD wiring and all four `writeSubmissions` branches **unchanged**. Only swap the per-cell `getSubmissionStatus` call for a single per-assignment bulk fetch grouped by uid. Per-assignment atomicity, `submissionAbandonAfter`, `failedAssignmentIds`, and the GHD pre-filter (`submissionSkipped`) are preserved. `runWithLimits` is no longer used in the native loop.

- [ ] **Step 1: Update the schoology mock** in `sync.test.js` (lines 5-18) to add the bulk fetcher:

```js
vi.mock('./schoology.js', () => ({
  getMyUserId: vi.fn(),
  getMySections: vi.fn(),
  getSectionEnrollments: vi.fn(),
  getSectionAssignments: vi.fn(),
  getSectionGrades: vi.fn(),
  getSectionGradingPeriods: vi.fn(),
  getSectionFolders: vi.fn(),
  getSectionGradingCategories: vi.fn(),
  getSectionGradingScales: vi.fn(),
  getUserProfile: vi.fn(),
  getUserProfilesBatch: vi.fn(),
  getSubmissionStatus: vi.fn(),
  getAssignmentSubmissions: vi.fn(),
  getSection: vi.fn(),
}));
```
And add to the import list (lines 33-41): `getAssignmentSubmissions,` and `getUserProfilesBatch,`.

> Note: `getUserProfilesBatch` is added now so the mock is complete; it is consumed in Win 3. Until then `enrichStudentProfiles` still calls `getUserProfile`, so leave its default unset here.

- [ ] **Step 2: Rewrite the native-submission tests to drive the bulk fetcher.**

Replace the bodies that previously set `getSubmissionStatus.mockResolvedValue/mockImplementation` for **native dropbox** assignments with `getAssignmentSubmissions` equivalents. The bulk mock returns a flat `revision[]`; the grouping reproduces the per-student summary. Concretely:

**`describe('syncSectionData — per-assignment atomicity (#55)')`** — replace both tests:
```js
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-A', 'Atomicity')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getAssignmentSubmissions.mockReset();
    getSectionGrades.mockResolvedValue([]);
  });

  test('one 429 on assignment A leaves all of A unwritten; B fully written', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
      { id: '802', uid: '702', name_first: 'Bob', name_last: 'M', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'A1', title: 'A', published: 1, allow_dropbox: '1' },
      { id: 'A2', title: 'B', published: 1, allow_dropbox: '1' },
    ]);
    getAssignmentSubmissions.mockImplementation(async (sid, aid) => {
      if (aid === 'A1') { const e = new Error('429'); e.rateLimited = true; e.transient = true; throw e; }
      return [
        { revision_id: 1, uid: '701', created: 1000, late: 0, draft: 0 },
        { revision_id: 1, uid: '702', created: 1000, late: 0, draft: 0 },
      ];
    });

    const result = await syncSectionData(db, 'sec-A', courseId, new Date().toISOString());
    expect(result.failedAssignmentIds).toEqual(['A1']);

    const a1 = db.prepare(`SELECT g.* FROM grades g JOIN assignments a ON a.id=g.assignment_id WHERE a.schoology_assignment_id='A1'`).all();
    expect(a1.length).toBe(0);
    const a2 = db.prepare(`SELECT g.* FROM grades g JOIN assignments a ON a.id=g.assignment_id WHERE a.schoology_assignment_id='A2'`).all();
    expect(a2.length).toBe(2);
  });

  test('abandonAfter threshold short-circuits remaining bulk fetches', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ id: `T${i}`, title: `T${i}`, published: 1, allow_dropbox: '1' }))
    );
    let callCount = 0;
    getAssignmentSubmissions.mockImplementation(async () => {
      callCount++; const e = new Error('429'); e.rateLimited = true; e.transient = true; throw e;
    });

    const result = await syncSectionData(
      db, 'sec-A', courseId, new Date().toISOString(),
      { submissionAbandonAfter: 3 }
    );
    expect(result.failedAssignmentIds.length).toBe(3);
    expect(result.submissionAbandoned).toBe(true);
    expect(callCount).toBeLessThanOrEqual(3);
  });
```

**`describe('syncSectionData — internal-gradebook submission state (#62/#55)')`** — in `beforeEach` add `getAssignmentSubmissions.mockReset()` and leave `getAssignmentSubmissions` returning `[]` by default (`getAssignmentSubmissions.mockResolvedValue([])`). Rewrite the native-only test "GHD-uncovered cell falls back to the public API…":
```js
  test('GHD-uncovered native cell uses the bulk revision and leaves submission_type null', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'N1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    getAssignmentSubmissions.mockResolvedValue([
      { revision_id: 1, uid: '701', created: 2000, late: 1, draft: 0 },
    ]);

    const result = await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchSubmissionLookup: async () => fakeLookup({}), // uncovered
    });

    expect(getAssignmentSubmissions).toHaveBeenCalledWith('sec-G', 'N1');
    const row = getGradeRow('701', 'N1');
    expect(row.late).toBe(1);
    expect(row.submission_type).toBeNull();
    expect(result.submissionSkipped).toBe(0);
  });
```
The three **lti** tests in this block keep their assertions but also assert the native bulk fetcher was not used for lti work — add `expect(getAssignmentSubmissions).not.toHaveBeenCalled();` alongside the existing `expect(getSubmissionStatus).not.toHaveBeenCalled();` in the two "lti excluded from per-cell walk" tests and the "#62: lti assignment writes lti_submission_state" test.

**`describe('syncSectionData — skipSubmissions opt (#72)')`** — in `beforeEach` replace the `getSubmissionStatus.mockResolvedValue({…})` line with `getAssignmentSubmissions.mockReset(); getAssignmentSubmissions.mockResolvedValue([{ revision_id: 1, uid: '701', created: 2000, late: 1, draft: 0 }]);`. Rewrite the two tests' assertions:
```js
  test('skipSubmissions:true does not fetch submissions and reports zero', async () => {
    const result = await syncSectionData(db, 'sec-S', courseId, new Date().toISOString(), { skipSubmissions: true });
    expect(getAssignmentSubmissions).not.toHaveBeenCalled();
    expect(result.submissionCount).toBe(0);
    expect(result.submissionAttempts).toBe(0);
    expect(result.submissionSkipped).toBe(0);
    expect(result.failedAssignmentIds).toEqual([]);
  });

  test('without skipSubmissions the same setup DOES bulk-fetch submissions (opt defaults off)', async () => {
    await syncSectionData(db, 'sec-S', courseId, new Date().toISOString());
    expect(getAssignmentSubmissions).toHaveBeenCalledWith('sec-S', 'D1');
  });
```

**`describe('syncSectionData — recent-only submission window (#55)')`** — in `beforeEach` replace `getSubmissionStatus` setup with `getAssignmentSubmissions.mockReset(); getAssignmentSubmissions.mockResolvedValue([]);`. Rewrite call-count assertions (one bulk call per *assignment*, not per cell):
```js
  test('recentOnly skips old + undated dropbox assignments', async () => {
    const result = await syncSectionData(db, 'sec-w', courseId, NOW, { recentOnly: true, recentDays: 30 });
    expect(getAssignmentSubmissions).toHaveBeenCalledTimes(1); // only the 1 recent assignment
    expect(result.windowSkipped).toBe(2);
  });

  test('recentOnly off checks every dropbox assignment (unchanged)', async () => {
    const result = await syncSectionData(db, 'sec-w', courseId, NOW, { recentOnly: false });
    expect(getAssignmentSubmissions).toHaveBeenCalledTimes(3); // 3 assignments
    expect(result.windowSkipped).toBe(0);
  });
```

**Archived blocks** (`finalizeArchivedCourse`, `detectArchivedTransitions`, `backfillUnfinalizedArchived`) — in each `beforeEach`/test that asserts `getSubmissionStatus` not called, also reset and assert the bulk fetcher: add `sch.getAssignmentSubmissions.mockReset(); sch.getAssignmentSubmissions.mockResolvedValue([]);` to the `beforeEach`, and change the three `expect(sch.getSubmissionStatus).not.toHaveBeenCalled();` assertions to `expect(sch.getAssignmentSubmissions).not.toHaveBeenCalled();`. (These exercise the `skipSubmissions` path, which sets `nativeDropboxAssignments=[]` → no bulk fetch.)

- [ ] **Step 3: Run the tests, verify the native-submission tests now FAIL** (implementation not yet changed)

Run: `npx vitest run server/services/sync.test.js`
Expected: the rewritten native tests FAIL (`getAssignmentSubmissions` never called — sync.js still calls `getSubmissionStatus` per cell). This confirms the tests drive the change.

- [ ] **Step 4: Implement the bulk native path in `sync.js`**

(a) Update imports: from `./schoology.js` add `getAssignmentSubmissions,` and remove `getSubmissionStatus` from the import **only if** it is no longer referenced after Task 1.4 — for now keep it (still used by the not-yet-converted `retrySubmissions`). Add near the other lib imports:
```js
import { groupRevisionsByUid } from '../lib/submissionRevisions.js';
```
Remove the now-unused `import { runWithLimits } from './rateLimitedRunner.js';` (the native loop no longer uses it; confirm no other reference remains in this file).

(b) Replace the per-cell native loop (current lines ~283-336, the `for (const a of nativeDropboxAssignments) { … runWithLimits(...) … }` block) with:
```js
  for (const a of nativeDropboxAssignments) {
    if (failedAssignmentIds.length >= submissionAbandonAfter) {
      submissionAbandoned = true;
      break;
    }
    const assignRow = selectAssignmentByExt.get(String(a.id));
    if (!assignRow) continue;

    // #55: ONE bulk fetch per assignment (was O(students) per-cell calls).
    // Per-assignment atomicity: a transient error discards this assignment and
    // continues; non-transient aborts the sync (unchanged contract).
    let revisions;
    try {
      revisions = await getAssignmentSubmissions(sectionId, String(a.id));
      submissionAttempts++;
    } catch (err) {
      if (err && err.transient) {
        if (err.rateLimited) rateLimitHits++; else transientFailures++;
        failedAssignmentIds.push(String(a.id));
        continue;
      }
      throw err;
    }
    const byUid = groupRevisionsByUid(revisions);

    const cells = studentEnrollments
      .map((e) => ({ e, studentRow: selectStudentByUid.get(String(e.uid)) }))
      .filter((c) => c.studentRow);

    for (const { e, studentRow } of cells) {
      const ghd = submissionLookup ? submissionLookup.get(String(e.uid), String(a.id)) : undefined;
      // #55 pre-filter parity: GHD definitively says "not submitted" → record a
      // cleared cell exactly as before (do not consult the bulk revision).
      if (ghd && !ghd.submitted) {
        submissionSkipped++;
        acceptedResults.push({
          studentId: studentRow.id,
          assignmentId: assignRow.id,
          enrolmentId: String(e.id),
          maxPoints: assignRow.max_points ?? null,
          revision: null,
          ghd: { resolved: true, submitted: false, type: null },
        });
        continue;
      }
      acceptedResults.push({
        studentId: studentRow.id,
        assignmentId: assignRow.id,
        enrolmentId: String(e.id),
        maxPoints: assignRow.max_points ?? null,
        revision: byUid.get(String(e.uid)) || null,
        ghd: ghd ? { resolved: true, submitted: true, type: ghd.submissionType } : { resolved: false },
      });
    }
  }
```

> The `writeSubmissions` transaction (current lines ~338-370) and the four branches are **unchanged**. The `acceptedResults` shape is identical to before (`{ studentId, assignmentId, enrolmentId, maxPoints, revision, ghd }`), so the writer needs no edit.

(c) The destructured opts `submissionConcurrency` and `submissionRatePerSec` (lines ~59-60) are no longer read. Leave them in the destructure for config compatibility but add a one-line comment: `// submissionConcurrency/submissionRatePerSec retained for config compat; the #55 bulk path no longer rate-limits per cell.` (Removing them from `getSyncConfig` is out of scope.)

- [ ] **Step 5: Run tests, verify green**

Run: `npx vitest run server/services/sync.test.js`
Expected: PASS. If a leftover test still references `getSubmissionStatus` for a native assignment, fix it to use `getAssignmentSubmissions`.

- [ ] **Step 6: Commit**

```bash
git add server/services/sync.js server/services/sync.test.js
git commit -m "feat(#55): native-dropbox submissions via one bulk fetch per assignment"
```

## Task 1.4: Convert retrySubmissions to bulk

**Files:**
- Modify: `server/services/sync.js` (`retrySubmissions`)
- Test: `server/services/sync.test.js` (`describe('retrySubmissions (#55)')`)

- [ ] **Step 1: Rewrite the retry tests to drive the bulk fetcher**

```js
describe('retrySubmissions (#55)', () => {
  let db; let courseId;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-R', 'R')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'RA1', 'A', 1)`).run(courseId);
    db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'Ada', 'L')`).run();
    getSectionEnrollments.mockReset();
    getAssignmentSubmissions.mockReset();
  });

  test('retry succeeds → row written, retries_succeeded incremented', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getAssignmentSubmissions.mockResolvedValue([
      { revision_id: 1, uid: '701', created: 1234, late: 0, draft: 0 },
    ]);
    const metrics = { submission_calls: 0, rate_limit_hits: 0, transient_failures: 0, retries_succeeded: 0, retries_failed: 0 };
    const stillFailing = await retrySubmissions(db, [{ sectionId: 'sec-R', courseId, assignmentExtId: 'RA1' }], new Date().toISOString(), metrics);
    expect(stillFailing).toEqual([]);
    expect(metrics.retries_succeeded).toBe(1);
    const rows = db.prepare(`SELECT g.* FROM grades g JOIN assignments a ON a.id=g.assignment_id WHERE a.schoology_assignment_id='RA1'`).all();
    expect(rows.length).toBe(1);
  });

  test('retry 429s again → no row written, returned in stillFailing, retries_failed=1', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getAssignmentSubmissions.mockImplementation(async () => { const e = new Error('429'); e.rateLimited = true; e.transient = true; throw e; });
    const metrics = { submission_calls: 0, rate_limit_hits: 0, transient_failures: 0, retries_succeeded: 0, retries_failed: 0 };
    const entry = { sectionId: 'sec-R', courseId, assignmentExtId: 'RA1' };
    const stillFailing = await retrySubmissions(db, [entry], new Date().toISOString(), metrics);
    expect(stillFailing).toEqual([entry]);
    expect(metrics.rate_limit_hits).toBe(1);
    expect(metrics.retries_failed).toBe(1);
    const rows = db.prepare(`SELECT g.* FROM grades g JOIN assignments a ON a.id=g.assignment_id WHERE a.schoology_assignment_id='RA1'`).all();
    expect(rows.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run server/services/sync.test.js -t retrySubmissions`
Expected: FAIL (retry still calls per-cell `getSubmissionStatus`).

- [ ] **Step 3: Rewrite `retrySubmissions`'s per-cell loop to one bulk fetch per failed assignment**

Replace the inner per-student loop (current lines ~455-483) with:
```js
      let revisions;
      try {
        metrics.submission_calls++;
        revisions = await getAssignmentSubmissions(sid, assignmentExtId);
      } catch (err) {
        if (err && err.transient) {
          if (err.rateLimited) metrics.rate_limit_hits++; else metrics.transient_failures++;
          stillFailing.push(entry);
          continue;
        }
        throw err;
      }
      const byUid = groupRevisionsByUid(revisions);
      const cellResults = [];
      for (const e of studentEnrollments) {
        const studentRow = selectStudentByUid.get(String(e.uid));
        if (!studentRow) continue;
        cellResults.push({
          studentId: studentRow.id,
          assignmentId: assignRow.id,
          enrolmentId: String(e.id),
          maxPoints: assignRow.max_points ?? null,
          revision: byUid.get(String(e.uid)) || null,
        });
      }
```
The subsequent `if (cellResults.length > 0) { writeRetry(...) }` and `metrics.retries_succeeded++` stay. Remove the now-dead `assignmentFailed` flag and its `if (assignmentFailed) { … continue; }` block. After Task 1.4, if `getSubmissionStatus` has no remaining references in `sync.js`, remove it from the import; otherwise leave it.

- [ ] **Step 4: Run, verify green**

Run: `npx vitest run server/services/sync.test.js`
Expected: PASS (full file).

- [ ] **Step 5: Commit**

```bash
git add server/services/sync.js server/services/sync.test.js
git commit -m "feat(#55): retrySubmissions retries via bulk fetch per assignment"
```

## Task 1.5: LIVE parity probe (#55)

**Files:**
- Create: `scripts/parity-bulk-submissions.js`

- [ ] **Step 1: Write the probe** — compares per-student `getSubmissionStatus` vs grouped `getAssignmentSubmissions` for a real native-dropbox assignment, and flags multi-revision students (the case the issue says to confirm).

```js
// scripts/parity-bulk-submissions.js
// Live parity check (#55): for a native-dropbox assignment, the bulk
// GET /sections/{sid}/submissions/{aid} grouped by uid must equal the per-student
// GET /sections/{sid}/submissions/{aid}/{uid} on { late, draft, latestRevisionAt }.
// Usage: node scripts/parity-bulk-submissions.js <sectionId> <assignmentId>
import 'dotenv/config';
import { getSectionEnrollments, getSubmissionStatus, getAssignmentSubmissions } from '../server/services/schoology.js';
import { groupRevisionsByUid } from '../server/lib/submissionRevisions.js';

const sectionId = process.argv[2];
const assignmentId = process.argv[3];
if (!sectionId || !assignmentId) { console.error('usage: node scripts/parity-bulk-submissions.js <sectionId> <assignmentId>'); process.exit(1); }

const enr = (await getSectionEnrollments(sectionId)).filter(e => e.admin !== '1' && e.admin !== 1);
const bulk = groupRevisionsByUid(await getAssignmentSubmissions(sectionId, assignmentId));

let mismatches = 0, multi = 0;
for (const e of enr) {
  const uid = String(e.uid);
  const single = await getSubmissionStatus(sectionId, assignmentId, uid); // null or summary
  const fromBulk = bulk.get(uid) || null;
  const norm = (s) => s ? { late: s.late ? 1 : 0, draft: s.draft ? 1 : 0, at: s.latestRevisionAt || 0 } : null;
  const a = JSON.stringify(norm(single)), b = JSON.stringify(norm(fromBulk));
  if (a !== b) { mismatches++; console.log(`  MISMATCH uid=${uid}\n    per-student=${a}\n    bulk=       ${b}`); }
}
// Multi-revision coverage: confirm the bulk form returns ALL revisions per student.
const raw = await getAssignmentSubmissions(sectionId, assignmentId);
const counts = {};
for (const r of raw) counts[r.uid] = (counts[r.uid] || 0) + 1;
for (const [uid, n] of Object.entries(counts)) if (n > 1) { multi++; }

console.log(`\n=== PARITY #55 (section ${sectionId} / assignment ${assignmentId}) ===`);
console.log(`students checked: ${enr.length} | mismatches: ${mismatches} | multi-revision students seen in bulk: ${multi}`);
console.log(mismatches === 0 ? '✅ PARITY OK' : '❌ PARITY FAILED');
process.exit(mismatches === 0 ? 0 : 1);
```

- [ ] **Step 2: Find a real native-dropbox assignment and run**

Native dropbox = `allow_dropbox=1` AND `assignment_type != 'lti_submission'`. The api-ref records native-dropbox assignment `8207125849` on Robotics section `7899907720`. Discover others if needed:
```bash
node -e "import('dotenv/config').then(async()=>{const {getSectionAssignments}=await import('./server/services/schoology.js');const a=await getSectionAssignments('7899907720');console.log(a.filter(x=>(x.allow_dropbox==='1'||x.allow_dropbox===1)&&x.assignment_type!=='lti_submission').map(x=>({id:x.id,title:x.title})))})"
```
Then:
```bash
node scripts/parity-bulk-submissions.js 7899907720 8207125849
```
Expected: `✅ PARITY OK`. If `multi-revision students seen in bulk` is 0 across the assignments you try, find a resubmitted assignment (Schoology's reminders showed ~29 resubmissions) so the multi-revision case is actually exercised — the issue requires confirming the bulk form returns *all* revisions per student.

- [ ] **Step 3: Commit the probe** (probes are kept, per the scripts/ convention)

```bash
git add scripts/parity-bulk-submissions.js
git commit -m "test(#55): live parity probe — bulk vs per-student submissions"
```

---

# WIN 2 — #104 Batched mastery observations

## Task 2.1: Pure observation grouping

**Files:**
- Create: `server/lib/masteryObservations.js`
- Test: `server/lib/masteryObservations.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/lib/masteryObservations.test.js
import { describe, test, expect } from 'vitest';
import { groupObservationsByTopic } from './masteryObservations.js';

describe('groupObservationsByTopic', () => {
  const topicIds = ['t-aaa', 't-bbb', 't-ccc'];

  test('regroups a flat batched response by objective_id', () => {
    const obs = [
      { objective_id: 't-aaa', student_uid: 1, points: 100 },
      { objective_id: 't-bbb', student_uid: 1, points: 75 },
      { objective_id: 't-aaa', student_uid: 2, points: 50 },
    ];
    const g = groupObservationsByTopic(obs, topicIds);
    expect(g['t-aaa']).toHaveLength(2);
    expect(g['t-bbb']).toHaveLength(1);
    expect(g['t-ccc']).toEqual([]); // topic with no observations → empty array, not undefined
  });

  test('falls back through alternate objective-id field names', () => {
    const obs = [
      { objective: { id: 't-aaa' }, student_uid: 1, points: 100 },
      { objectiveId: 't-bbb', student_uid: 2, points: 75 },
    ];
    const g = groupObservationsByTopic(obs, topicIds);
    expect(g['t-aaa']).toHaveLength(1);
    expect(g['t-bbb']).toHaveLength(1);
  });

  test('coerces ids to strings and ignores rows with no objective id', () => {
    const g = groupObservationsByTopic(
      [{ objective_id: 123, points: 1 }, { points: 2 }],
      [123]
    );
    expect(g['123']).toHaveLength(1);
  });

  test('nullish observations → all topics empty', () => {
    const g = groupObservationsByTopic(null, topicIds);
    expect(g).toEqual({ 't-aaa': [], 't-bbb': [], 't-ccc': [] });
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run server/lib/masteryObservations.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// server/lib/masteryObservations.js
// Pure: regroup the batched material-observations/search POST response
// (#104) back into the per-topic shape the mastery persist step expects.
// The batched POST returns every topic's observations in one array, each row
// tagged with its objective id. Mirrors the field-name fallbacks the spike
// probe used (probe-mastery-batch.js).

const objectiveOf = (o) =>
  o?.objective_id ?? o?.objective?.id ?? o?.measurement_topic_id ?? o?.objectiveId ?? null;

// @param observations flat array from the batched POST `.data`
// @param topicIds     the topic UUIDs we asked for (seeds empty buckets)
// @returns { [topicId]: observation[] }  — every requested topic present
export function groupObservationsByTopic(observations, topicIds) {
  const byTopic = {};
  for (const id of (topicIds || [])) byTopic[String(id)] = [];
  for (const obs of (observations || [])) {
    const oid = objectiveOf(obs);
    if (oid == null) continue;
    const key = String(oid);
    if (!byTopic[key]) byTopic[key] = [];
    byTopic[key].push(obs);
  }
  return byTopic;
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run server/lib/masteryObservations.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/masteryObservations.js server/lib/masteryObservations.test.js
git commit -m "feat(#104): pure groupObservationsByTopic helper"
```

## Task 2.2: Batched POST in syncMasteryForCourse

**Files:**
- Modify: `server/services/masterySync.js`

> No unit test: `syncMasteryForCourse` is Playwright-driven. The grouping logic is covered by Task 2.1; the wire-up is verified by the live parity probe (Task 2.3).

- [ ] **Step 1: Add the import** near the top of `masterySync.js` (after the `getSectionGrades` import):
```js
import { groupObservationsByTopic } from '../lib/masteryObservations.js';
```

- [ ] **Step 2: Replace the per-topic observations loop** (current lines ~322-339, the `── Step 4: Fetch observations per topic ──` block) with the batched POST:
```js
    // ── Step 4: Fetch observations for ALL topics in ONE POST (#104) ────────
    // The per-topic GET loop (one call/topic) was the ~20–40s/course mastery
    // floor. The POST form of material-observations/search batches across
    // objective_ids (verified 2026-06-07); regroup by objective_id to rebuild
    // observationsByTopic exactly as the per-topic loop did.
    log(`Fetching observations for ${allTopics.length} measurement topics (batched POST)...`);
    let observationsByTopic = {};
    if (allTopics.length) {
      const obsUrl = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search`;
      const obsResp = await postInternal(page, obsUrl, {
        building_id: Number(buildingId),
        section_id: Number(sectionId),
        objective_ids: allTopics.map(t => t.id).join(','),
      });
      const allObs = obsResp.data || [];
      observationsByTopic = groupObservationsByTopic(allObs, allTopics.map(t => t.id));
      for (const obs of allObs) {
        const mid = obs.gradeable_material?.material_id;
        if (mid) allMaterialIds.add(String(mid));
      }
      for (const topic of allTopics) {
        const n = (observationsByTopic[topic.id] || []).length;
        log(`  ${topic.external_id || topic.externalId || topic.id} ${topic.title}: ${n} observations`);
      }
    }
```

> Note: the original declared `const observationsByTopic = {}`; the replacement declares it with `let` so it can be reassigned from the grouping. Confirm there is no second declaration later in the function (there isn't — it is only read afterwards by Step 5/5.5/6).

- [ ] **Step 3: Sanity-check the server boots and the file parses**

Run: `node --check server/services/masterySync.js`
Expected: no output (syntax OK).

- [ ] **Step 4: Run the full server suite** (ensures nothing importing masterySync broke)

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/masterySync.js
git commit -m "feat(#104): batch mastery observations via one POST material-observations/search"
```

## Task 2.3: LIVE parity probe (#104)

**Files:**
- Create: `scripts/parity-mastery-batch.js`

- [ ] **Step 1: Write the probe** — per-topic GET vs batched POST, compared on the full set of `(student_uid, material_id, objective_id) → points` triples.

```js
// scripts/parity-mastery-batch.js
// Live parity (#104): per-topic GET material-observations/search vs the batched
// POST must yield the identical set of (student_uid, material_id, objective_id,
// points) observations. Usage: node scripts/parity-mastery-batch.js [sectionId]
import 'dotenv/config';
import { chromium } from 'playwright';
import { join } from 'path';
import { existsSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';
import { groupObservationsByTopic } from '../server/lib/masteryObservations.js';

const sectionId = process.argv[2] || '7899896098'; // ACSS
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');
if (!existsSync(STATE_FILE)) { console.error('No session — run npm run mastery:login'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();

const getJson = (u) => page.evaluate(async (url) => { const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { return null; } }, u);
const postJson = (u, body) => page.evaluate(async ({ url, body }) => { const c = { token: window.Drupal?.settings?.s_common?.csrf_token, key: window.Drupal?.settings?.s_common?.csrf_key }; const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': c.token, 'X-CSRF-Key': c.key }, body: JSON.stringify(body) }); const t = await r.text(); try { return JSON.parse(t); } catch { return null; } }, { url, body });
const key = (o) => `${o.student_uid}|${o.gradeable_material?.material_id}|${o.objective_id ?? o.objective?.id ?? o.objectiveId}|${o.points}`;

try {
  let buildingId = null;
  page.on('request', (req) => { const m = req.url().match(/building_id=(\d+)/); if (m) buildingId = m[1]; });
  await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`, { waitUntil: 'load', timeout: 30000 });
  if (!isLoggedInUrl(page.url())) throw new Error('SESSION DEAD');
  await page.waitForTimeout(3500);
  if (!buildingId) throw new Error('no building_id captured');

  const objs = await getJson(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/aligned-objectives?building_id=${buildingId}&section_id=${sectionId}`);
  const cats = objs?.data || objs || [];
  const topicIds = [];
  for (const c of cats) for (const t of (c.child_objectives || c.objectives || c.measurementTopics || c.measurement_topics || c.children || [])) topicIds.push(String(t.id));

  // OLD: per-topic GET
  const oldSet = new Set();
  for (const id of topicIds) {
    const r = await getJson(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search?building_id=${buildingId}&objective_id=${id}&section_id=${sectionId}`);
    for (const o of (r?.data || [])) oldSet.add(key({ ...o, objective_id: o.objective_id ?? id }));
  }

  // NEW: batched POST → regroup
  const resp = await postJson(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search`, { building_id: Number(buildingId), section_id: Number(sectionId), objective_ids: topicIds.join(',') });
  const grouped = groupObservationsByTopic(resp?.data || [], topicIds);
  const newSet = new Set();
  for (const id of topicIds) for (const o of (grouped[id] || [])) newSet.add(key({ ...o, objective_id: id }));

  const onlyOld = [...oldSet].filter(k => !newSet.has(k));
  const onlyNew = [...newSet].filter(k => !oldSet.has(k));
  console.log(`\n=== PARITY #104 (section ${sectionId}) ===`);
  console.log(`topics: ${topicIds.length} | per-topic observations: ${oldSet.size} | batched: ${newSet.size}`);
  console.log(`only-in-per-topic: ${onlyOld.length} | only-in-batched: ${onlyNew.length}`);
  if (onlyOld.length) console.log('  e.g. missing from batch:', onlyOld.slice(0, 3));
  if (onlyNew.length) console.log('  e.g. extra in batch:', onlyNew.slice(0, 3));
  console.log(onlyOld.length === 0 && onlyNew.length === 0 ? '✅ PARITY OK' : '❌ PARITY FAILED');
} catch (e) {
  console.error('PROBE ERROR:', e.message);
} finally {
  await browser.close();
}
```

- [ ] **Step 2: Run it**

Run: `node scripts/parity-mastery-batch.js 7899896098`
Expected: `✅ PARITY OK` (ACSS — the spike saw 212 observations across 8 objectives). If the session is dead, run `npm run mastery:login` first (interactive — ask the user to run it). Re-run on a second SBG section (e.g. AIML `7899907727`) for extra confidence.

- [ ] **Step 3: Commit the probe**

```bash
git add scripts/parity-mastery-batch.js
git commit -m "test(#104): live parity probe — per-topic vs batched observations"
```

---

# WIN 3 — #105 Batched student profiles via POST /multiget

## Task 3.1: apiPost + getUserProfilesBatch

**Files:**
- Modify: `server/services/schoology.js`
- Test: `server/services/schoology.test.js`

- [ ] **Step 1: Write the failing test** (append to `schoology.test.js`)

```js
describe('getUserProfilesBatch (POST /multiget #105)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function multigetResponse(uids) {
    return {
      ok: true, status: 207, headers: { get: () => null },
      json: async () => ({
        response: uids.map(u => ({
          location: `/v1/users/${u}`,
          response_code: 200,
          body: { uid: String(u), primary_email: `u${u}@x.com`, parents: { parent: [] } },
        })),
      }),
      text: async () => JSON.stringify({
        response: uids.map(u => ({
          location: `/v1/users/${u}`, response_code: 200,
          body: { uid: String(u), primary_email: `u${u}@x.com`, parents: { parent: [] } },
        })),
      }),
    };
  }

  test('bundles uids into a /multiget POST and maps results by uid', async () => {
    const { getUserProfilesBatch } = await import('./schoology.js');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return multigetResponse(['701', '702']);
    }));
    const map = await getUserProfilesBatch(['701', '702']);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/v1\/multiget$/);
    expect(calls[0].body).toEqual({ request: ['/v1/users/701', '/v1/users/702'] });
    expect(map.get('701').primary_email).toBe('u701@x.com');
    expect(map.get('702')).toBeTruthy();
  });

  test('chunks at 50 requests per call', async () => {
    const { getUserProfilesBatch } = await import('./schoology.js');
    const uids = Array.from({ length: 120 }, (_, i) => String(i));
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      posts++;
      const chunk = JSON.parse(opts.body).request.map(p => p.split('/').pop());
      return multigetResponse(chunk);
    }));
    const map = await getUserProfilesBatch(uids);
    expect(posts).toBe(3);        // ceil(120/50)
    expect(map.size).toBe(120);
  });

  test('skips per-entry non-200 response_codes', async () => {
    const { getUserProfilesBatch } = await import('./schoology.js');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 207, headers: { get: () => null },
      text: async () => JSON.stringify({ response: [
        { location: '/v1/users/701', response_code: 200, body: { uid: '701', primary_email: 'a@x.com' } },
        { location: '/v1/users/702', response_code: 404, body: null },
      ] }),
    })));
    const map = await getUserProfilesBatch(['701', '702']);
    expect(map.has('701')).toBe(true);
    expect(map.has('702')).toBe(false);
  });

  test('a failed chunk POST does not throw — those uids are simply absent', async () => {
    const { getUserProfilesBatch } = await import('./schoology.js');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    const map = await getUserProfilesBatch(['701']);
    expect(map.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run server/services/schoology.test.js`
Expected: FAIL (`getUserProfilesBatch` not a function).

- [ ] **Step 3: Implement in `schoology.js`** — add `apiPost` next to `apiPut`, and `getUserProfilesBatch` near `getUserProfile`:

```js
async function apiPost(path, body) {
  const url = `${API}${path}`;
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
```

```js
// Batched profile fetch (#105): POST /v1/multiget bundles up to ~50 per-user
// reads into one HTTP call. Each bundled `body` is the COMPLETE /users/{uid}
// object (primary_email + parents.parent[]). Paths MUST carry the /v1 prefix.
// Best-effort: a failed chunk (network/429) yields no entries for that chunk —
// those students are absent from the map and the caller preserves them.
// Returns Map<string uid, profile>.
const MULTIGET_CHUNK = 50;
export async function getUserProfilesBatch(uids) {
  const out = new Map();
  for (let i = 0; i < uids.length; i += MULTIGET_CHUNK) {
    const chunk = uids.slice(i, i + MULTIGET_CHUNK);
    let data;
    try {
      ({ data } = await apiPost('/multiget', { request: chunk.map(u => `/v1/users/${u}`) }));
    } catch {
      continue; // network error — preserve these students (caller skips them)
    }
    for (const entry of (data?.response || [])) {
      const code = Number(entry.response_code);
      if (code && code !== 200) continue;
      const body = entry.body;
      if (!body) continue;
      const uid = String(body.uid || body.id || '');
      if (uid) out.set(uid, body);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run server/services/schoology.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/schoology.js server/services/schoology.test.js
git commit -m "feat(#105): apiPost + getUserProfilesBatch via POST /v1/multiget"
```

## Task 3.2: Rewire enrichStudentProfiles to the batch

**Files:**
- Modify: `server/services/sync.js`
- Test: `server/services/sync.test.js` (`describe('enrichStudentProfiles — reconcile guardians (#70)')`)

- [ ] **Step 1: Update the import** in `sync.js` — change the `getUserProfile` import to `getUserProfilesBatch` (keep `getUserProfile` removed from sync's imports; it stays exported for `peopleSearch`):
```js
  getUserProfilesBatch,
```
(Replace the `getUserProfile,` line in the import block at the top of `sync.js`.)

- [ ] **Step 2: Rewrite the `enrichStudentProfiles` loop** (current lines ~552-578) to source profiles from the batch:
```js
  let profileCount = 0;
  // #105: one POST /multiget per ≤50 students instead of N GET /users/{uid}.
  // A student missing from the map = its fetch did not succeed → preserve its
  // data + contacts (reconcile nothing), matching the old per-student catch.
  const profiles = await getUserProfilesBatch(students.map(s => String(s.schoology_uid)));
  for (const s of students) {
    const profile = profiles.get(String(s.schoology_uid));
    if (!profile) continue;
    const email = profile.primary_email || null;
    const prefName = (profile.name_first_preferred && profile.use_preferred_first_name === '1')
      ? profile.name_first_preferred : null;
    const gradYear = profile.grad_year ? parseInt(profile.grad_year, 10) : null;
    updateStudent.run(email, prefName, gradYear, now, s.id);

    // Schoology may return a lone guardian as an object rather than a 1-element
    // array — normalise so a single-guardian student isn't reconciled away.
    const rawParents = profile.parents?.parent ?? [];
    const parents = Array.isArray(rawParents) ? rawParents : [rawParents];
    const keepUids = [];
    for (const p of parents) {
      upsertParent.run(s.id, String(p.id), p.name_first || '', p.name_last || '', p.primary_email || null, null);
      keepUids.push(String(p.id));
    }
    reconcileParents(s.id, keepUids);
    profileCount++;
  }
  return profileCount;
```

> Behaviour note: the old code wrapped each student in try/catch and preserved on error. The batch moves the failure boundary from per-student to per-chunk, but the outcome is identical — a student whose profile wasn't fetched is skipped (preserved), never wiped. The `parents.parent` object-vs-array normalisation is unchanged.

- [ ] **Step 3: Update the enrich tests** to mock the batch. In the `beforeEach`, replace `getUserProfile.mockReset()` with `getUserProfilesBatch.mockReset()`. Rewrite each test's mock to return a `Map`:

```js
  test('deletes a guardian Schoology no longer returns and updates email', async () => {
    getUserProfilesBatch.mockResolvedValue(new Map([['u-1', {
      primary_email: 'new@x.com',
      parents: { parent: [{ id: 'p-1', name_first: 'Mara', name_last: 'Lovelace', primary_email: 'mara@x.com' }] },
    }]]));
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());
    const uids = db.prepare('SELECT schoology_uid FROM parents WHERE student_id = ? ORDER BY schoology_uid').all(studentId).map(r => r.schoology_uid);
    expect(uids).toEqual(['p-1']);
    expect(db.prepare('SELECT email FROM students WHERE id = ?').get(studentId).email).toBe('new@x.com');
  });

  test('an unfetched profile (absent from the batch) preserves existing guardians and the student', async () => {
    getUserProfilesBatch.mockResolvedValue(new Map()); // u-1 not fetched
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());
    expect(db.prepare('SELECT COUNT(*) n FROM parents WHERE student_id = ?').get(studentId).n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) n FROM students WHERE id = ?').get(studentId).n).toBe(1);
  });

  test('a student with no guardians in the profile has all guardians removed', async () => {
    getUserProfilesBatch.mockResolvedValue(new Map([['u-1', { primary_email: null, parents: { parent: [] } }]]));
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());
    expect(db.prepare('SELECT COUNT(*) n FROM parents WHERE student_id = ?').get(studentId).n).toBe(0);
  });

  test('normalises a single guardian returned as an object (not array)', async () => {
    getUserProfilesBatch.mockResolvedValue(new Map([['u-1', {
      primary_email: 'new@x.com',
      parents: { parent: { id: 'p-9', name_first: 'Solo', name_last: 'Guardian', primary_email: 'solo@x.com' } },
    }]]));
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());
    const uids = db.prepare('SELECT schoology_uid FROM parents WHERE student_id = ? ORDER BY schoology_uid').all(studentId).map(r => r.schoology_uid);
    expect(uids).toEqual(['p-9']);
  });
```

> The `fullSync — course skip matrix (#56)` block calls `fullSync`, which calls `enrichStudentProfiles` → `getUserProfilesBatch`. Add a default `getUserProfilesBatch.mockResolvedValue(new Map());` in that block's `beforeEach` (alongside the other section mocks) so it doesn't hit an undefined return.

- [ ] **Step 4: Run, verify PASS**

Run: `npm run test:server`
Expected: PASS (whole suite).

- [ ] **Step 5: Commit**

```bash
git add server/services/sync.js server/services/sync.test.js
git commit -m "feat(#105): enrichStudentProfiles sources profiles from POST /multiget batch"
```

## Task 3.3: LIVE parity probe (#105)

**Files:**
- Create: `scripts/parity-multiget-profiles.js`

- [ ] **Step 1: Write the probe** — per-student `getUserProfile` vs `getUserProfilesBatch` on email + parents.

```js
// scripts/parity-multiget-profiles.js
// Live parity (#105): POST /multiget must return the same primary_email and
// guardian set as per-student GET /users/{uid}. Usage:
//   node scripts/parity-multiget-profiles.js [limit]
import 'dotenv/config';
import { getUserProfile, getUserProfilesBatch } from '../server/services/schoology.js';
import { getDb } from '../server/db/index.js';

const limit = Number(process.argv[2] || 60);
const db = getDb();
const uids = db.prepare('SELECT schoology_uid FROM students WHERE schoology_uid IS NOT NULL LIMIT ?').all(limit).map(r => String(r.schoology_uid));
if (!uids.length) { console.error('No students in DB — run a sync first'); process.exit(1); }

const parentKey = (p) => {
  const arr = Array.isArray(p?.parent) ? p.parent : (p?.parent ? [p.parent] : []);
  return arr.map(x => `${x.id}:${x.primary_email || ''}`).sort().join(',');
};

const batch = await getUserProfilesBatch(uids);
let mismatches = 0, missing = 0;
for (const uid of uids) {
  const single = await getUserProfile(uid).catch(() => null);
  const b = batch.get(uid);
  if (!b) { missing++; console.log(`  MISSING from batch: ${uid}`); continue; }
  const eA = single?.primary_email || '', eB = b.primary_email || '';
  const pA = parentKey(single?.parents), pB = parentKey(b.parents);
  if (eA !== eB || pA !== pB) {
    mismatches++;
    console.log(`  MISMATCH ${uid}\n    email: ${JSON.stringify([eA, eB])}\n    parents: ${JSON.stringify([pA, pB])}`);
  }
}
console.log(`\n=== PARITY #105 ===`);
console.log(`uids: ${uids.length} | missing-from-batch: ${missing} | mismatches: ${mismatches}`);
console.log(mismatches === 0 && missing === 0 ? '✅ PARITY OK' : '❌ PARITY FAILED');
process.exit(mismatches === 0 && missing === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it**

Run: `node scripts/parity-multiget-profiles.js 60`
Expected: `✅ PARITY OK`. (Uses the local DB's student uids — the DB is present. If the count is small, raise the limit.)

- [ ] **Step 3: Commit the probe**

```bash
git add scripts/parity-multiget-profiles.js
git commit -m "test(#105): live parity probe — per-student vs multiget profiles"
```

---

## Task 4: End-to-end live sync sanity + docs

- [ ] **Step 1: Full server suite green**

Run: `npm run test:server`
Expected: PASS (all suites).

- [ ] **Step 2: Real full sync, before/after DB diff (the #62 e2e approach)**

The three unit + parity probes already prove per-call parity. As a belt-and-braces e2e, run a real full sync and confirm it completes without error and the metrics show the reduced call count:
```bash
# Snapshot the grades + students + mastery_scores row counts and a checksum
node -e "import('./server/db/index.js').then(({getDb})=>{const db=getDb();const q=(s)=>db.prepare(s).get();console.log(JSON.stringify({grades:q('SELECT COUNT(*) n, SUM(COALESCE(late,0)) late, SUM(COALESCE(draft,0)) draft FROM grades'),students:q('SELECT COUNT(*) n FROM students'),mastery:q('SELECT COUNT(*) n FROM mastery_scores')}))})" > /tmp/prism-before.json
cat /tmp/prism-before.json
```
Then trigger a sync via the running app (ask the user to click Sync, or run the sync entrypoint) and re-snapshot to `/tmp/prism-after.json`. Diff:
```bash
diff <(cat /tmp/prism-before.json) <(cat /tmp/prism-after.json) && echo "IDENTICAL" || echo "CHANGED — investigate"
```
Expected: identical row counts / late / draft / mastery totals (a benign change is only newly-submitted work since the last sync). Investigate any structural drop.

> If a live full sync needs an interactive mastery re-login, ask the user to run `npm run mastery:login`. The submission (#55) and profile (#105) wins are pure OAuth and need no session.

- [ ] **Step 3: Update `.claude/schoology-api-reference.md`** — flip the three spike rows to shipped:
  - `POST /v1/multiget` row: append `**SHIPPED (#105):** consumed by getUserProfilesBatch + enrichStudentProfiles.`
  - bulk `GET /sections/{id}/submissions/{aid}` row: append `**SHIPPED (#55):** getAssignmentSubmissions + native-dropbox path retired the per-cell walk.`
  - `POST material-observations/search (BATCHED)` row: append `**SHIPPED (#104):** syncMasteryForCourse uses the batched POST.`

- [ ] **Step 4: Update `.claude/build-progress.md`** — add a dated entry noting the three bulk wins landed on `feat/sync-bulk-perf` (native submissions O(N×M)→O(M), mastery observations N→1/course, profiles N→ceil(N/50)).

- [ ] **Step 5: Commit docs**

```bash
git add .claude/schoology-api-reference.md .claude/build-progress.md
git commit -m "docs(#55,#104,#105): mark bulk-perf spikes shipped"
```

- [ ] **Step 6: Finish the branch** — invoke `superpowers:finishing-a-development-branch` to choose merge/PR/cleanup. Reference issues #55 (native-dropbox route), #104, #105 in the PR body; note the parity probes and that behaviour is unchanged.

---

## Self-Review checklist (run after writing, before executing)

- **Spec coverage:** #55 native bulk ✓ (Tasks 1.1–1.5), #104 mastery batch ✓ (2.1–2.3), #105 multiget ✓ (3.1–3.3). PowerSchool #106 is a separate stretch — NOT in this plan/branch (see the companion stretch note); do it last on its own branch only after these land.
- **Parity:** each win has a live probe diffing old vs new against real data; the native path keeps all four write branches + GHD wiring byte-for-byte (only the revision source changes).
- **No silent caps:** `getAssignmentSubmissions` follows `links.next` to the last page (page-cap 100 is a malformed-link guard, well above any HKIS roster). `getUserProfilesBatch` chunks at 50 and processes every chunk.
- **Types/signatures consistent:** `summarizeRevisions`/`groupRevisionsByUid` used identically in `schoology.js` and `sync.js`; `getUserProfilesBatch` returns `Map<string,profile>` consumed as such in `enrichStudentProfiles` and both probes.
- **Mocks:** `sync.test.js` schoology mock gains `getAssignmentSubmissions` + `getUserProfilesBatch`; every describe block that triggers the native or profile path resets/seeds them.
