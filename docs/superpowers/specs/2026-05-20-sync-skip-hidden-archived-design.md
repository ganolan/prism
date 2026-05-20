# Sync UX: skip hidden/archived courses + permanent template exclusion

GitHub issue: [#56](https://github.com/ganolan/prism/issues/56)

## Problem

The full Schoology sync currently fetches every section the API returns, including a `MASTER Art, Design & Technology` template section that holds 778 assignments and 1 enrolment. That single section accounts for ~34% of submission API calls per sync (778 of 2288), with zero value — the course is hidden in the Prism UI and no view reads its data.

The existing auto-hide heuristic at `server/services/sync.js:441-449` correctly flags MASTER as `hidden=1` after first sync, but the section loop ignores the hidden flag and fetches submissions anyway.

## Goals

1. Default sync skips `hidden=1` AND `archived=1` courses — no API calls made for them.
2. Two opt-in toggles in `SyncConfig.jsx` re-enable inclusion when needed.
3. Template-pattern courses (no `course_code` AND no `section_school_code`) are permanently excluded from sync, independent of the hidden toggle — they have no real data and should never be re-included by accident.
4. Existing tests still pass; four new server-side tests cover the filter logic.

## Non-goals

- Dashboard UI for manually marking a course as `excluded`. The auto-detect predicate is sufficient for current needs; manual control is a future issue if/when needed.
- Changing how user-driven hide/archive toggles work (`toggleCourseVisibility`, `toggleArchiveCourse`).
- Live "what's currently hidden in Schoology" lookup — Prism's hidden/archived states are local bookkeeping, not Schoology concepts.

## Design

### Data model — separate "excluded" from "hidden"

There are two distinct kinds of "courses I don't want to sync":

- **Template sections like MASTER** — auto-detected (no codes). Genuinely have no student data. Useless forever.
- **User-hidden courses** — courses the teacher hid via `toggleCourseVisibility`. Might still have data; teacher might occasionally want to sync them.

Today both live under `hidden=1`. The design splits them.

**Schema change** — add one column to `courses`:

```sql
ALTER TABLE courses ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
```

Wrapped in a `PRAGMA table_info` check inside `getDb()` for idempotent startup, matching how other column adds work in that file.

**Auto-pass** in `fullSync` (replaces the existing auto-hide pass at `sync.js:441-449`):

```sql
UPDATE courses
SET excluded = 1
WHERE (course_code IS NULL OR course_code = '')
  AND (section_school_code IS NULL OR section_school_code = '')
  AND synced_at = ?;
```

The existing auto-hide pass is removed — its job is fully absorbed by `excluded`. Courses can still be user-hidden via `toggleCourseVisibility`; that codepath is untouched.

**One-time backfill** at server startup, in `getDb()`:

```sql
UPDATE courses SET excluded = 1
WHERE excluded = 0
  AND (course_code IS NULL OR course_code = '')
  AND (section_school_code IS NULL OR section_school_code = '');
```

This flips MASTER (and any other template rows in the current DB) to `excluded=1` immediately on deploy, so the perf win lands on the very first sync after upgrade without requiring a sync cycle first.

### Sync skip logic

In the section loop in `sync.js` (currently around line 478), extend the per-section SELECT to pull `hidden`, `archived`, `excluded`, then:

```js
if (course.excluded) {
  metrics.sections_skipped++;
  continue;  // always skip — toggles do not re-include
}
if (course.hidden && !includeHidden) {
  metrics.sections_skipped++;
  continue;
}
if (course.archived && !includeArchived) {
  metrics.sections_skipped++;
  continue;
}
```

`metrics.sections_skipped` is a new field in the `metrics` object initialized at `sync.js:394`, surfaced through the existing sync_log persistence path so `/api/sync/metrics` exposes it.

### Plumbing client → server

**`client/src/services/api.js`** — extend `runSync` to carry two new flags:

```js
export async function runSync(
  { masteryCourseIds = [], skipSchoology = false, includeHidden = false, includeArchived = false },
  onEvent
) {
  // ...
  body: JSON.stringify({ masteryCourseIds, skipSchoology, includeHidden, includeArchived })
  // ...
}
```

**`server/routes/schoology.js`** — read `includeHidden` and `includeArchived` from `req.body`, pass into `runUnifiedSync({ ..., includeHidden, includeArchived })`.

**`server/services/syncOrchestrator.js`** — accept and forward the two flags into `fullSync(onProgress, { includeHidden, includeArchived })`.

**`server/services/sync.js`** — change signature:

```js
export async function fullSync(
  onProgress,
  { includeHidden = false, includeArchived = false } = {}
) { ... }
```

Defaults are conservative — calling `fullSync(onProgress)` with no second argument continues to skip hidden and archived.

### UI — SyncConfig.jsx

Two checkboxes inline under "Step 1 · Schoology data", below the existing description paragraph:

```
Step 1 · Schoology data      [Always runs]
Courses, students, assignments, grades & submission status — all sections in one pass.
  [ ] Include hidden courses (3)
  [ ] Include archived courses (12)

Step 2 · Mastery (SBG) data   [Optional]
  ...
```

- Both toggles default OFF every time the dialog opens — no localStorage. The 99% case is the default; opting in is deliberate.
- Counts come from the existing `courses` prop (no new endpoint, no extra round-trip). Counts are computed from the last-synced state of the courses table, so they're advisory rather than contractual.
- Count parenthetical is dropped when the count is 0 (e.g., first-ever sync shows "Include hidden courses" with no count).
- Counts exclude `excluded` rows: `courses.filter(c => c.hidden && !c.archived && !c.excluded).length` for the hidden count, `courses.filter(c => c.archived && !c.excluded).length` for archived.
- New state in `SyncConfig`:
  ```js
  const [includeHidden, setIncludeHidden] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  ```
- `onStart` callback's payload extends to carry the flags. `SyncDialog` already owns this callback; it forwards into `runSync({ masteryCourseIds, includeHidden, includeArchived }, ...)`.
- New CSS class `.sync-step-toggles` in `app.css` for spacing, using existing CSS variables only.
- `GROUPS` filters in `SyncConfig.jsx:3-7` extend to also drop `c.excluded`, so MASTER stops appearing in the mastery picker's "Hidden courses" bucket.

### Tests

Append four tests to `server/services/sync.test.js`, using the existing `vi.mock('../api/schoology.js')` pattern in the file:

1. **`sync skips hidden/archived/excluded courses by default`** — seed four courses (visible, hidden, archived, excluded), mock `getMySections` and `syncSectionData`, assert `syncSectionData` is called once with the visible section only.
2. **`sync includes hidden courses when includeHidden=true`** — same fixture; assert called for visible + hidden, not archived, not excluded.
3. **`sync includes archived courses when includeArchived=true`** — assert called for visible + archived, not hidden, not excluded.
4. **`sync never fetches excluded courses even when both toggles are on`** — assert excluded never reached, with both flags `true`.

No client-side tests — `SyncConfig` rendering is mechanical and stable; the cost/benefit doesn't justify it for this change.

## Migration & rollout

1. Server start runs `ALTER TABLE` (idempotent) and the one-time backfill.
2. MASTER and any other template-pattern rows flip to `excluded=1`.
3. UI immediately stops showing them in the mastery picker.
4. Next sync skips them — perf win lands without further action.
5. No user-visible behavior change unless they open the SyncConfig dialog, where they'll see two new opt-in toggles.

## Expected impact

At current tuned settings (concurrency=6, rate=10): skipping MASTER removes 778 submission calls, leaving ~1510. At 10 req/sec that's ~151s of submission work + ~95s of overhead ≈ **~245s total wall-time, ~38% faster than the current 399s baseline**.

## Verification

Before claiming the issue complete:

- `npm test` — full suite, including the four new tests.
- `npm run test:api` — Schoology smoke (no behavior change expected here).
- Open the dialog locally → confirm:
  - Both toggles render, both OFF.
  - Counts match `courses` table state.
  - MASTER no longer appears in mastery picker.
- Run a sync → check `/api/sync/metrics` shows `sections_skipped > 0` and wall-time near the predicted ~245s.

## Risk

- **Backfill misclassifies a real course as excluded.** Mitigated by the predicate's strictness — both `course_code` AND `section_school_code` must be null/empty. Any real-enrolment course has at least one of those. If a false positive surfaces, the user can manually `UPDATE courses SET excluded = 0 WHERE id = ?` until a dashboard UI exists.
- **Pre-`excluded` deployments.** None — `excluded` is a brand-new column with a default of 0, so existing code paths see all rows as non-excluded.
- **Forgetting to include `excluded` in the per-section SELECT.** Caught by test 4.
