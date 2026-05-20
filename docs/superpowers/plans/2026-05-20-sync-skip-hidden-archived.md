# Sync Skip Hidden/Archived + Excluded Flag — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default Prism's full sync to skip `hidden`/`archived` courses (with opt-in toggles in the SyncConfig modal), and permanently exclude template-pattern courses like the `MASTER Art, Design & Technology` section so they're never fetched again.

**Architecture:** A new `courses.excluded` column separates template sections (auto-detected by absent course/section codes) from user-hidden courses. The full-sync section loop reads `hidden`, `archived`, and `excluded` from the courses row and skips per the rules: excluded always; hidden/archived unless the matching toggle is on. Two new opt-in checkboxes in `SyncConfig.jsx` flow through `api.js → routes/schoology.js → syncOrchestrator → fullSync`. A one-time backfill at server boot flips existing template rows to `excluded=1` so the perf win lands without waiting for a sync.

**Tech Stack:** Node 20+, Express, better-sqlite3, React 18 + Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-20-sync-skip-hidden-archived-design.md`
**Issue:** [#56](https://github.com/ganolan/games/prism/issues/56)

---

## File Map

| File | Change | Responsibility |
|---|---|---|
| `server/db/index.js` | Modify | Add `excluded` column migration; add `backfillExcludedCourses()` purge helper called from `migrate()` |
| `server/services/sync.js` | Modify | New `markExcludedCourses(db)` helper; remove old auto-hide pass; `fullSync` accepts `{ includeHidden, includeArchived }`; section loop SELECTs and respects the three flags; `metrics.sections_skipped` counter |
| `server/services/sync.test.js` | Modify | Append four tests covering the skip matrix |
| `server/services/syncOrchestrator.js` | Modify | Thread `{ includeHidden, includeArchived }` from caller into `fullSync` |
| `server/routes/schoology.js` | Modify | Read flags from `req.body`, pass into `runUnifiedSync` |
| `client/src/services/api.js` | Modify | Extend `runSync` to send the two new flags in the request body |
| `client/src/components/SyncConfig.jsx` | Modify | Render the two checkboxes under Step 1; compute counts; exclude `excluded` rows from mastery picker `GROUPS`; pass flags to `onStart` |
| `client/src/components/SyncDialog.jsx` | Modify | `startSync` accepts and forwards the two flags into `runSync` |
| `client/src/app.css` | Modify | New `.sync-step-toggles` class for spacing (CSS vars only) |

---

## Task 1: Add `excluded` column migration + one-time backfill helper

**Files:**
- Modify: `server/db/index.js`

- [ ] **Step 1: Append the migration**

In `server/db/index.js`, append one line to the `MIGRATIONS` array (after the `num_assignees` line at ~line 44, before the indexes at ~line 46):

```js
  // Issue #56: courses we never want to sync (e.g., template sections like
  // "MASTER Art, Design & Technology" that carry assignments but zero real
  // enrolments). Auto-detected by the absence of course_code AND
  // section_school_code. Distinct from `hidden` — the user-facing toggle to
  // 'Include hidden courses' must NEVER re-include excluded rows.
  `ALTER TABLE courses ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0`,
```

- [ ] **Step 2: Add the backfill helper**

In `server/db/index.js`, add this function next to `purgeLegacyAutoFlags` and `purgeStudentScopedFlags` (around line 60):

```js
// Issue #56: flip existing template-pattern courses (no course_code AND no
// section_school_code) to excluded=1 so the next sync skips them without
// requiring user action. Idempotent — the predicate filters to rows that
// haven't been flagged yet, so re-running is a no-op.
export function backfillExcludedCourses(database) {
  database.exec(`
    UPDATE courses SET excluded = 1
    WHERE excluded = 0
      AND (course_code IS NULL OR course_code = '')
      AND (section_school_code IS NULL OR section_school_code = '')
  `);
}
```

- [ ] **Step 3: Wire backfill into `migrate()`**

In `migrate()`, add the backfill call alongside the other purges (~line 86):

```js
  // Data purges — independent of each other; order does not matter.
  purgeLegacyAutoFlags(database);
  purgeStudentScopedFlags(database);
  backfillExcludedCourses(database);
```

- [ ] **Step 4: Smoke test the migration locally**

Run the existing test suite to confirm the migration applies cleanly to in-memory DBs:

```bash
npm test -- server/db
```

Expected: all existing `index.test.js` tests pass. No new tests added in this task.

- [ ] **Step 5: Commit**

```bash
git add server/db/index.js
git commit -m "$(cat <<'EOF'
feat(#56): add courses.excluded column + boot-time backfill

New column separates template-pattern sections (no course/section codes,
e.g. MASTER) from user-hidden courses. Backfill flips existing template
rows on boot so subsequent syncs skip them. Schema-only change — no
behavior change until sync.js consumes the column in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Failing test — sync skips hidden/archived/excluded by default

**Files:**
- Modify: `server/services/sync.test.js`

This task ONLY writes the test and confirms it fails. Implementation lands in Task 3.

- [ ] **Step 1: Add the new `describe` block at the bottom of `sync.test.js`**

Append this to `server/services/sync.test.js`. The existing file already imports `migrate`, `vi.mock`s `./schoology.js`, and exposes `fullSync` indirectly — but `fullSync` is not currently imported. Add it to the existing import line `import { syncSectionData, retrySubmissions } from './sync.js';` so it becomes:

```js
import { syncSectionData, retrySubmissions, fullSync } from './sync.js';
```

Then at the END of the file, append:

```js
describe('fullSync — course skip matrix (#56)', () => {
  let db;

  // Seeds four courses representing each (hidden, archived, excluded) combo
  // the section loop must distinguish. Returns the schoology_section_id list
  // in stable order so assertions read naturally.
  function seedCourses() {
    const stmt = db.prepare(`
      INSERT INTO courses
        (schoology_section_id, course_name, course_code, section_school_code, hidden, archived, excluded)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run('sec-visible',  'Visible Course',  'CSE101', 'S1', 0, 0, 0);
    stmt.run('sec-hidden',   'Hidden Course',   'CSE102', 'S2', 1, 0, 0);
    stmt.run('sec-archived', 'Archived Course', 'CSE103', 'S3', 0, 1, 0);
    stmt.run('sec-excluded', 'MASTER Template', null,     null, 0, 0, 1);
    return ['sec-visible', 'sec-hidden', 'sec-archived', 'sec-excluded'];
  }

  // Schoology mocks that just satisfy fullSync's outer shape — every
  // section-level lookup returns an empty array so per-section side effects
  // don't matter; we only care which sections reach syncSectionData (proxied
  // here via getSectionEnrollments, the first API call inside syncSectionData).
  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    // Tell sync.js to use this DB. The real getDb() singleton is module-level;
    // we monkey-patch it by setting DB_PATH or by using the in-memory hook the
    // existing tests already rely on. The existing tests pass `db` directly
    // into syncSectionData, but fullSync calls getDb() internally. Workaround:
    // override the module's db handle.
    const dbModule = await import('../db/index.js');
    // eslint-disable-next-line no-import-assign
    dbModule.__setTestDb?.(db);

    const { getMyUserId, getMySections, getSectionGradingPeriods,
            getSectionEnrollments, getSectionAssignments, getSectionGrades,
            getSectionFolders, getSectionGradingCategories,
            getSectionGradingScales } = await import('./schoology.js');

    getMyUserId.mockResolvedValue('user-1');
    getSectionGradingPeriods.mockResolvedValue([]);
    getSectionEnrollments.mockResolvedValue([]);
    getSectionAssignments.mockResolvedValue([]);
    getSectionGrades.mockResolvedValue([]);
    getSectionFolders.mockResolvedValue([]);
    getSectionGradingCategories.mockResolvedValue([]);
    getSectionGradingScales.mockResolvedValue([]);

    // getMySections returns sections matching the seeded course IDs. Order
    // matches seedCourses(). course_title is what fullSync logs but is
    // otherwise unused.
    getMySections.mockResolvedValue([
      { id: 'sec-visible',  course_title: 'Visible Course',   section_title: 'A' },
      { id: 'sec-hidden',   course_title: 'Hidden Course',    section_title: 'A' },
      { id: 'sec-archived', course_title: 'Archived Course',  section_title: 'A' },
      { id: 'sec-excluded', course_title: 'MASTER Template',  section_title: 'A' },
    ]);
  });

  test('default sync skips hidden, archived, and excluded courses', async () => {
    seedCourses();
    const { getSectionEnrollments } = await import('./schoology.js');

    await fullSync(() => {});

    const visited = getSectionEnrollments.mock.calls.map(c => c[0]);
    expect(visited).toEqual(['sec-visible']);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm test -- sync.test.js -t "default sync skips"
```

Expected: FAIL. Likely failure mode: `fullSync` either calls `getSectionEnrollments` for all four sections (today's behavior), or throws because the test scaffolding's `__setTestDb` hook doesn't exist yet. Both are acceptable failure signals — we'll fix the test scaffolding and the production behavior together in Task 3.

- [ ] **Step 3: Commit (RED)**

```bash
git add server/services/sync.test.js
git commit -m "$(cat <<'EOF'
test(#56): failing test for default-skip course matrix in fullSync

Seeds four courses (visible, hidden, archived, excluded), mocks the
Schoology API surface, and asserts only the visible section reaches
getSectionEnrollments. Fails today — fullSync visits every section.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Make the test pass — add skip logic + test-DB hook

**Files:**
- Modify: `server/db/index.js` (add `__setTestDb`)
- Modify: `server/services/sync.js` (add `markExcludedCourses`, remove old auto-hide pass, extend `fullSync` signature, gate the section loop)

- [ ] **Step 1: Add `__setTestDb` hook to `server/db/index.js`**

Add this at the bottom of the file:

```js
// Test-only: let in-memory test DBs replace the module-level singleton so
// callers of getDb() see the test fixture. Never call from production code.
export function __setTestDb(testDb) {
  db = testDb;
}
```

- [ ] **Step 2: Add `markExcludedCourses` helper to `server/services/sync.js`**

Near the top of `server/services/sync.js` (after the imports), add:

```js
// Issue #56: flip newly-discovered template sections to excluded=1. Same
// predicate as the boot-time backfill in db/index.js but called every sync
// so new template sections appearing in subsequent syncs also get caught.
// Idempotent.
function markExcludedCourses(db) {
  db.exec(`
    UPDATE courses SET excluded = 1
    WHERE excluded = 0
      AND (course_code IS NULL OR course_code = '')
      AND (section_school_code IS NULL OR section_school_code = '')
  `);
}
```

- [ ] **Step 3: Replace the old auto-hide block in `fullSync`**

In `server/services/sync.js`, locate the block at lines ~441-449:

```js
    // Hide courses without course_code or section_school_code by default (only on first sync)
    db.prepare(`
      UPDATE courses
      SET hidden = 1
      WHERE (course_code IS NULL OR course_code = '')
        AND (section_school_code IS NULL OR section_school_code = '')
        AND hidden = 0
        AND synced_at = ?
    `).run(now);
```

Replace it with:

```js
    // Issue #56: mark template sections (no codes) as permanently excluded.
    // Subsumes the previous auto-hide pass — the section loop below skips
    // excluded courses unconditionally, so they never reach the expensive
    // per-section API calls.
    markExcludedCourses(db);
```

- [ ] **Step 4: Extend `fullSync` signature with the toggle options**

Locate `export async function fullSync(onProgress) {` at ~line 378. Change to:

```js
export async function fullSync(onProgress, { includeHidden = false, includeArchived = false } = {}) {
```

- [ ] **Step 5: Add `sections_skipped` to the metrics initialiser**

In the `metrics = { ... }` block at ~line 394, add the new field:

```js
    const metrics = {
      submission_calls: 0,
      rate_limit_hits: 0,
      transient_failures: 0,
      retries_attempted: 0,
      retries_succeeded: 0,
      retries_failed: 0,
      abandoned: 0,
      sections_skipped: 0,
      failed_assignment_ids: [],
    };
```

- [ ] **Step 6: Gate the section loop**

In the section loop at ~lines 478-481, change:

```js
    for (const sec of sections) {
      const sectionId = String(sec.id);
      const courseRow = db.prepare('SELECT id FROM courses WHERE schoology_section_id = ?').get(sectionId);
      if (!courseRow) continue;
```

to:

```js
    const selectCourseFlags = db.prepare(
      'SELECT id, hidden, archived, excluded FROM courses WHERE schoology_section_id = ?'
    );
    for (const sec of sections) {
      const sectionId = String(sec.id);
      const courseRow = selectCourseFlags.get(sectionId);
      if (!courseRow) continue;
      if (courseRow.excluded) { metrics.sections_skipped++; continue; }
      if (courseRow.hidden && !includeHidden) { metrics.sections_skipped++; continue; }
      if (courseRow.archived && !includeArchived) { metrics.sections_skipped++; continue; }
```

- [ ] **Step 7: Run the test again**

```bash
npm test -- sync.test.js -t "default sync skips"
```

Expected: PASS.

- [ ] **Step 8: Run the full sync test file to check for regressions**

```bash
npm test -- sync.test.js
```

Expected: every test in `sync.test.js` passes, including the pre-existing `#54` assignee-mapping tests.

- [ ] **Step 9: Commit (GREEN)**

```bash
git add server/db/index.js server/services/sync.js
git commit -m "$(cat <<'EOF'
feat(#56): skip excluded/hidden/archived courses in full sync

- markExcludedCourses() runs each sync to catch new template sections;
  replaces the previous auto-hide pass (which is now absorbed by the
  excluded flag).
- fullSync accepts { includeHidden, includeArchived }; section loop
  reads hidden/archived/excluded from the courses row and skips per
  rules. Excluded always skipped; hidden/archived gated on the flags.
- metrics.sections_skipped counter for telemetry.
- __setTestDb test hook in db/index.js lets in-memory test DBs
  replace the module-level singleton.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add the remaining three skip-matrix tests

**Files:**
- Modify: `server/services/sync.test.js`

- [ ] **Step 1: Append three more tests to the `describe('fullSync — course skip matrix (#56)')` block**

Add inside the existing `describe`, after the first test:

```js
  test('includeHidden=true visits visible + hidden, not archived, not excluded', async () => {
    seedCourses();
    const { getSectionEnrollments } = await import('./schoology.js');

    await fullSync(() => {}, { includeHidden: true });

    const visited = getSectionEnrollments.mock.calls.map(c => c[0]).sort();
    expect(visited).toEqual(['sec-hidden', 'sec-visible']);
  });

  test('includeArchived=true visits visible + archived, not hidden, not excluded', async () => {
    seedCourses();
    const { getSectionEnrollments } = await import('./schoology.js');

    await fullSync(() => {}, { includeArchived: true });

    const visited = getSectionEnrollments.mock.calls.map(c => c[0]).sort();
    expect(visited).toEqual(['sec-archived', 'sec-visible']);
  });

  test('excluded never reached even with both toggles on', async () => {
    seedCourses();
    const { getSectionEnrollments } = await import('./schoology.js');

    await fullSync(() => {}, { includeHidden: true, includeArchived: true });

    const visited = getSectionEnrollments.mock.calls.map(c => c[0]).sort();
    expect(visited).toEqual(['sec-archived', 'sec-hidden', 'sec-visible']);
    expect(visited).not.toContain('sec-excluded');
  });
```

- [ ] **Step 2: Run the new tests to confirm they pass**

```bash
npm test -- sync.test.js -t "course skip matrix"
```

Expected: all four tests in the new `describe` block pass.

- [ ] **Step 3: Commit**

```bash
git add server/services/sync.test.js
git commit -m "$(cat <<'EOF'
test(#56): cover full toggle matrix for fullSync skip logic

Three additional tests pin down includeHidden, includeArchived, and
both-on behavior — verifying excluded is never reached regardless of
toggle state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Thread the toggles through orchestrator and route

**Files:**
- Modify: `server/services/syncOrchestrator.js`
- Modify: `server/routes/schoology.js`

- [ ] **Step 1: Extend `runUnifiedSync` signature**

In `server/services/syncOrchestrator.js`, change the function signature at line 22:

```js
export async function runUnifiedSync({ masteryCourseIds = [], skipSchoology = false }, onEvent) {
```

to:

```js
export async function runUnifiedSync(
  { masteryCourseIds = [], skipSchoology = false, includeHidden = false, includeArchived = false },
  onEvent
) {
```

- [ ] **Step 2: Pass the flags into `fullSync`**

In the same file at line 31, change:

```js
      const result = await fullSync((progress) => emit({ type: 'log', message: progress.message }));
```

to:

```js
      const result = await fullSync(
        (progress) => emit({ type: 'log', message: progress.message }),
        { includeHidden, includeArchived }
      );
```

- [ ] **Step 3: Update the route handler**

In `server/routes/schoology.js`, change the body destructure at line 19:

```js
  const { masteryCourseIds = [], skipSchoology = false } = req.body || {};
```

to:

```js
  const {
    masteryCourseIds = [],
    skipSchoology = false,
    includeHidden = false,
    includeArchived = false,
  } = req.body || {};
```

And update the `runUnifiedSync` call at line 24:

```js
    await runUnifiedSync({ masteryCourseIds, skipSchoology }, write);
```

to:

```js
    await runUnifiedSync({ masteryCourseIds, skipSchoology, includeHidden, includeArchived }, write);
```

- [ ] **Step 4: Update the JSDoc comment on the route**

In `server/routes/schoology.js`, find the comment at line 10:

```js
// delimited JSON. Body: { masteryCourseIds?: number[], skipSchoology?: boolean }.
```

Replace with:

```js
// delimited JSON. Body: {
//   masteryCourseIds?: number[],
//   skipSchoology?: boolean,
//   includeHidden?: boolean,    // #56: opt in to syncing hidden courses
//   includeArchived?: boolean,  // #56: opt in to syncing archived courses
// }.
```

- [ ] **Step 5: Run existing orchestrator tests for regressions**

```bash
npm test -- syncOrchestrator.test.js
```

Expected: all existing tests pass. (The new flags have safe defaults, so existing callers behave identically.)

- [ ] **Step 6: Commit**

```bash
git add server/services/syncOrchestrator.js server/routes/schoology.js
git commit -m "$(cat <<'EOF'
feat(#56): thread includeHidden/includeArchived through route + orchestrator

Both flags default to false so existing callers (no body change) get
the new skip-by-default behavior automatically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire client `runSync` to send the new flags

**Files:**
- Modify: `client/src/services/api.js`

- [ ] **Step 1: Extend `runSync` signature and body**

In `client/src/services/api.js`, locate `runSync` at line 62. Replace the function with:

```js
export async function runSync(
  { masteryCourseIds = [], skipSchoology = false, includeHidden = false, includeArchived = false },
  onEvent
) {
  const res = await fetch(`${BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masteryCourseIds, skipSchoology, includeHidden, includeArchived }),
  });
  if (res.status === 409) throw new Error('A sync is already running.');
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Sync failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (final) => {
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
    if (final && buffer.trim()) onEvent(JSON.parse(buffer.trim()));
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flush(false);
  }
  flush(true);
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/services/api.js
git commit -m "$(cat <<'EOF'
feat(#56): runSync sends includeHidden/includeArchived in request body

Defaults preserve existing behavior for callers that don't pass the
new flags.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add the SyncConfig toggle UI

**Files:**
- Modify: `client/src/components/SyncConfig.jsx`
- Modify: `client/src/app.css`

- [ ] **Step 1: Update `SyncConfig.jsx` — state, counts, and excluded filter**

In `client/src/components/SyncConfig.jsx`, replace the `GROUPS` constant at the top of the file:

```js
const GROUPS = [
  { key: 'visible', label: 'Visible courses', match: (c) => !c.hidden && !c.archived },
  { key: 'hidden', label: 'Hidden courses', match: (c) => c.hidden && !c.archived },
  { key: 'archived', label: 'Archived courses', match: (c) => c.archived },
];
```

with (note the added `!c.excluded` in every match):

```js
const GROUPS = [
  { key: 'visible',  label: 'Visible courses',  match: (c) => !c.hidden && !c.archived && !c.excluded },
  { key: 'hidden',   label: 'Hidden courses',   match: (c) => c.hidden && !c.archived && !c.excluded },
  { key: 'archived', label: 'Archived courses', match: (c) =>  c.archived && !c.excluded },
];
```

- [ ] **Step 2: Add toggle state and count computations inside the component**

Inside `SyncConfig`, after the existing `const [collapsed, setCollapsed] = ...` line (around line 34), add:

```js
  const [includeHidden, setIncludeHidden] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);

  const hiddenCount = useMemo(
    () => courses.filter((c) => c.hidden && !c.archived && !c.excluded).length,
    [courses]
  );
  const archivedCount = useMemo(
    () => courses.filter((c) => c.archived && !c.excluded).length,
    [courses]
  );
```

- [ ] **Step 3: Render the two checkboxes under Step 1**

In the same file, locate the Step 1 block (around lines 54-62):

```jsx
      <div className="sync-step">
        <div className="sync-step-title">
          <span>Step 1 · Schoology data</span>
          <span className="sync-badge sync-badge-run">Always runs</span>
        </div>
        <p className="sync-step-desc">
          Courses, students, assignments, grades &amp; submission status — all sections in one pass.
        </p>
      </div>
```

Replace with:

```jsx
      <div className="sync-step">
        <div className="sync-step-title">
          <span>Step 1 · Schoology data</span>
          <span className="sync-badge sync-badge-run">Always runs</span>
        </div>
        <p className="sync-step-desc">
          Courses, students, assignments, grades &amp; submission status — all sections in one pass.
        </p>
        <div className="sync-step-toggles">
          <label>
            <input
              type="checkbox"
              checked={includeHidden}
              onChange={(e) => setIncludeHidden(e.target.checked)}
            />
            <span>Include hidden courses{hiddenCount > 0 ? ` (${hiddenCount})` : ''}</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            <span>Include archived courses{archivedCount > 0 ? ` (${archivedCount})` : ''}</span>
          </label>
        </div>
      </div>
```

- [ ] **Step 4: Pass the flags through `onStart`**

Locate the Start sync button (around line 143):

```jsx
          <button
            type="button"
            className="primary"
            onClick={() => onStart([...selected])}
            disabled={busy}
          >
            Start sync
          </button>
```

Replace with:

```jsx
          <button
            type="button"
            className="primary"
            onClick={() => onStart([...selected], { includeHidden, includeArchived })}
            disabled={busy}
          >
            Start sync
          </button>
```

- [ ] **Step 5: Add CSS for the toggle row**

In `client/src/app.css`, search for existing `.sync-step` styling and append a new rule near it (exact location doesn't matter — pick any spot near the sync-related rules):

```css
.sync-step-toggles {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.5rem;
  padding-left: 0.25rem;
}

.sync-step-toggles label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text);
  cursor: pointer;
  font-size: 0.95em;
}

.sync-step-toggles input[type="checkbox"] {
  cursor: pointer;
}
```

- [ ] **Step 6: Build the client to catch syntax errors**

```bash
cd client && npm run build && cd ..
```

Expected: clean build, no errors. The build output goes to `client/dist/` (already in .gitignore).

- [ ] **Step 7: Commit**

```bash
git add client/src/components/SyncConfig.jsx client/src/app.css
git commit -m "$(cat <<'EOF'
feat(#56): SyncConfig toggles for Include hidden / Include archived

Two opt-in checkboxes under Step 1 (Schoology data), default OFF every
time the dialog opens. Counts show parenthetical only when > 0.
GROUPS filters in the mastery picker now exclude `excluded` rows so
template sections (MASTER) stop appearing in the hidden bucket.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Forward the toggles through SyncDialog

**Files:**
- Modify: `client/src/components/SyncDialog.jsx`

- [ ] **Step 1: Extend `startSync` signature and `runSync` call**

In `client/src/components/SyncDialog.jsx`, find `startSync` (around line 35):

```js
  async function startSync(masteryCourseIds, { skipSchoology = false } = {}) {
    // ...
      await runSync({ masteryCourseIds, skipSchoology }, (evt) => {
```

Change the signature and the `runSync` body to:

```js
  async function startSync(masteryCourseIds, { skipSchoology = false, includeHidden = false, includeArchived = false } = {}) {
    // ...
      await runSync({ masteryCourseIds, skipSchoology, includeHidden, includeArchived }, (evt) => {
```

(Leave the rest of the function body unchanged.)

- [ ] **Step 2: Update the `onStart` callback wiring**

Find the SyncConfig render (around line 82):

```jsx
            onStart={(ids) => startSync(ids)}
```

Change to:

```jsx
            onStart={(ids, opts) => startSync(ids, opts)}
```

This preserves the existing `{ skipSchoology: true }` callsite at line 69 (`startSync(courseIds, { skipSchoology: true })`) since that callsite passes its own opts object directly.

- [ ] **Step 3: Build the client**

```bash
cd client && npm run build && cd ..
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/SyncDialog.jsx
git commit -m "$(cat <<'EOF'
feat(#56): SyncDialog forwards includeHidden/includeArchived to runSync

Wires the new SyncConfig opts object end-to-end. skipSchoology callsite
unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Full verification + close out

**Files:** (no code changes)

- [ ] **Step 1: Run the entire test suite**

```bash
npm test
```

Expected: every test passes, including the four new `#56` tests and all pre-existing tests.

- [ ] **Step 2: Run the Schoology API smoke test**

```bash
npm run test:api
```

Expected: smoke test passes (no behavior change in the API client itself).

- [ ] **Step 3: Kill any stale dev server processes, then start the dev server**

```bash
lsof -ti:3001 | xargs kill -9 2>/dev/null; lsof -ti:5173 | xargs kill -9 2>/dev/null; npm run dev
```

Let it boot. The server logs should show the boot-time backfill running silently (no log entry needed — the SQL is a quiet UPDATE).

- [ ] **Step 4: Manually verify the backfill flipped MASTER to excluded=1**

In a separate terminal:

```bash
sqlite3 server/db/students.db "SELECT id, course_name, hidden, archived, excluded FROM courses WHERE course_name LIKE '%MASTER%';"
```

Expected: MASTER row shows `excluded=1`.

- [ ] **Step 5: Open the app, open the Sync dialog, verify the UI**

Open `http://localhost:5173/` in a browser. Click the sync button. In the dialog:
- Confirm both new toggles render under Step 1, both unchecked.
- Confirm hidden/archived counts match the DB state (the counts should reflect courses where `hidden=1 AND excluded=0` and `archived=1 AND excluded=0` respectively).
- Confirm MASTER no longer appears in the mastery picker's "Hidden courses" bucket (it's filtered out by the new `!c.excluded` predicate).

- [ ] **Step 6: Run a full sync and check the metrics**

Click "Start sync" with both toggles OFF. Wait for completion.

```bash
curl -s http://localhost:3001/api/sync/metrics | jq .
```

Expected:
- `sections_skipped > 0` (at minimum MASTER + whatever else is hidden/archived).
- Total wall-time noticeably under the current 399s baseline (target ~245s with MASTER skipped).

- [ ] **Step 7: Sanity check — toggle ON and confirm hidden courses sync**

Re-open the dialog, tick "Include hidden courses", click Start. Watch the progress log — hidden courses should now appear in the "Syncing ..." messages. Excluded courses (MASTER) should still NOT appear.

- [ ] **Step 8: Close the GitHub issue**

```bash
gh issue close 56 -c "Shipped on main. Default sync now skips hidden/archived/excluded courses; two opt-in toggles in SyncConfig let users re-include hidden/archived. Template sections (no course/section codes) get auto-flagged as excluded and are never re-included. Wall-time drop matches the predicted ~38% (verified via /api/sync/metrics)."
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Default sync skips hidden + archived | Task 3 (sync.js gating) + Task 4 (tests prove it) |
| Two opt-in toggles in SyncConfig | Task 7 |
| New `excluded` flag separate from hidden | Task 1 (schema) + Task 3 (sync logic) |
| Auto-pass marks template sections | Task 1 (boot backfill) + Task 3 (`markExcludedCourses` per sync) |
| Old auto-hide pass removed | Task 3 step 3 |
| Client → server plumbing for flags | Tasks 5, 6, 8 |
| GROUPS filter excludes `excluded` from mastery picker | Task 7 step 1 |
| One-time backfill at boot | Task 1 step 2-3 |
| Four server tests covering the matrix | Tasks 2, 4 |
| `metrics.sections_skipped` for telemetry | Task 3 step 5 |
| `.sync-step-toggles` CSS class | Task 7 step 5 |
| Verify perf win via /api/sync/metrics | Task 9 step 6 |

All spec requirements covered.

**Placeholder scan:** No "TBD", no "implement later", no "add appropriate error handling". Every code step shows actual code.

**Type consistency:** `includeHidden` / `includeArchived` named identically across api.js, route, orchestrator, fullSync, SyncConfig, SyncDialog. `excluded` column name consistent in migration, backfill, helper, section loop SELECT, and GROUPS filter. `sections_skipped` consistent in metrics init and in three skip branches. `markExcludedCourses` is the sync.js helper; `backfillExcludedCourses` is the db/index.js boot helper — different names because they live in different files and run in different contexts (per-sync vs per-boot), avoiding ambiguity.
