# Background Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every sync is full and goes through one server queue; pages sync their scope in the background when it is over 10 minutes old; each page shows one "Synced" time and a chip that opens the progress dialog; a dead session holds syncs until sign-in.

**Architecture:** `syncRunner.js` becomes a queue of `sync_runs` rows (`queued` → `running` → finished, or `held`), with a cover check for joining, button priority and a session preflight. Requests are unified runs (a course list or all) or task runs (Sync Assignment). Stamps move to the orchestrator so they are written only for complete syncs. The client follows runs by polling (the stream goes); a `useBackgroundSync` hook drives each page's `SyncStatus` chip.

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest; React 18, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-20-background-sync-design.md`

## Global Constraints

- **Window:** `SYNC_FRESH_MS = 10 * 60 * 1000`, one constant in `server/services/syncQueue.js`.
- **New columns** (schema.sql **and** MIGRATIONS): `courses.sync_attempted_at TEXT`, `assignments.task_sync_attempted_at TEXT`.
- **Run statuses:** add `queued` and `held` to the existing `running | completed | completed_with_errors | failed | interrupted`. `markInterruptedRuns` also marks `queued` and `held` rows `interrupted` at boot.
- **`sync_runs.options_json`** carries `{ kind: 'all' | 'courses' | 'task', courseIds?, courseId?, assignmentId?, trigger: 'page' | 'button' | 'scheduled', force }`.
- **Session states:** `expired` and `none` hold; `connected` and `unknown` run. Scheduled runs never hold.
- **Copy (exact):** chip "Syncing…", "Waiting to sync…", "Sync failed", "Log in to Schoology"; label "Synced {time}" / "Not synced yet"; amber over 24 h or missing, never for an archived course.
- **No partial options:** `recentOnly`, `recentDays`, `mastery` leave the schedule settings, the dialog and `syncPrefs`. `fullSync` keeps `recentOnly` only as an internal default `false` (no caller sets it).
- **UI copy:** no em dashes; colours from `app.css` variables; `freshnessTime` for times.

## Review Focus

1. **Two page requests for the same course while one runs:** one run; both pages follow it. Test in Task 3.
2. **A button press while a covering run is already running:** a new run is queued ahead of queued page runs. Test in Task 3.
3. **Server restart with queued or held runs:** they become `interrupted`; the next page visit queues again. Test in Task 3.
4. **A course whose mastery keeps failing:** not re-synced on every visit (attempt stamp), chip "Sync failed". Test in Tasks 2 and 4.
5. **Session lapses mid-run (mastery login error):** the run ends `held`, and runs again after sign-in. Test in Task 3.

---

### Task 1: Remove the partial options

**Files:** `server/services/settings.js`, `server/services/syncScheduler.js`, `client/src/pages/SettingsPage.jsx`, `client/src/components/SyncConfig.jsx`, `client/src/components/SyncDialog.jsx`, `client/src/lib/syncPrefs.js`; tests beside each (`settings.test.js`, `syncScheduler.test.js`, `SettingsPage.test.jsx`, `SyncConfig.test.jsx`).

**Interfaces:** Produces `scheduledSyncOptions(db, s)` → `{ kind: 'all', includeHidden: s.includeHidden, syncBlocks: s.syncBlocks, refreshQuizzes: true, trigger: 'scheduled' }` (mastery for every course read; no recent window). Schedule settings keep `enabled`, `time`, `includeHidden`, `syncBlocks`.

- [ ] Failing tests: the schedule settings no longer accept or return `mastery`, `recentOnly`, `recentDays`; `scheduledSyncOptions` has no recent window and kind `all`; Settings shows neither control; `SyncConfig` has no recent-only box and `onStart(ids, { syncBlocks })`.
- [ ] Run → FAIL. Implement. Run → PASS.
- [ ] Commit `feat(sync): every sync reads everything; recent-only and mastery-none removed`.

### Task 2: Stamps only for complete syncs, and attempt stamps

**Files:** `server/services/sync.js`, `server/services/syncOrchestrator.js`, `server/services/submissionComments.js`, `server/db/schema.sql`, `server/db/index.js`; tests `sync.test.js`, `syncOrchestrator.test.js`.

**Interfaces:**
- `fullSync` stops writing `course_synced_at` and `task_synced_at`; returns `complete: { courseIds: number[], taskIdsByCourse: Record<courseId, number[]> }` (courses whose Schoology data and every submission read finished; tasks read in full) and `readCourseIds: number[]` (every course read, complete or not).
- `syncSectionData` returns `readInFullTaskIds` instead of stamping.
- `refreshRecentComments(db, …)` result gains `failedCourseIds: number[]`; it reads archived courses too when they are in `courseIds` (#169).
- `runUnifiedSync` after the mastery and comment phases: for each course in `complete.courseIds` whose mastery succeeded and is not in `failedCourseIds`, sets `course_synced_at = startedAtIso` and `task_synced_at` on its `taskIdsByCourse`; sets `sync_attempted_at` (and `task_sync_attempted_at` for the course's tasks) on every course in `readCourseIds`. A ticked archived course read through `finalizeArchivedCourse` reports its mastery failure (`finalizeArchivedCourse` returns `{ masteryError }`) and is stamped only without one (#169).
- `backfillUnfinalizedArchived` / `backfillArchivedSubmissions` skip courses in the list (#169).

- [ ] Failing tests: a course whose mastery fails keeps its old `course_synced_at` and gets `sync_attempted_at`; a comment-thread failure withholds the stamp; complete course and its tasks stamped; an archived listed course with a mastery error is not stamped and the run reports it; the backfills skip a listed course.
- [ ] Run → FAIL. Implement (columns in schema + MIGRATIONS). Run → PASS, plus every root test.
- [ ] Commit `feat(sync): a course or task is 'Synced' only when everything synced`.

### Task 3: The queue

**Files:** Create `server/services/syncQueue.js` (+ test). Modify `server/services/syncRunner.js` (becomes the queue's runner), `server/services/syncRuns.js`, `server/services/syncScheduler.js`, `server/routes/schoology.js`, `server/index.js` (boot), tests `syncRunner.test.js`, `syncRuns.test.js`, `syncScheduler.test.js`, `server/routes/schoology.test.js`.

**Interfaces:**
- `enqueue(request, { db, now })` → `{ runId, state: 'queued' | 'running' | 'held', joined: boolean }`. `request = { kind, courseIds?, courseId?, assignmentId?, trigger, force, includeHidden?, syncBlocks? }`. Joins a run when `covers(run, request)` and, for `force`, the run is still `queued`. Button (`trigger: 'button'`) requests are placed ahead of queued `page` requests. Creates the `sync_runs` row at once (`queued`).
- `coveredCourseIds(request, db)`: `all` → current non-excluded courses, hidden ones only with `includeHidden`; `courses` → the ids; `task` → `[]` (covers only the same task). A run covers a task request when its covered ids hold the task's course.
- The runner takes the head when idle: session preflight (`sessionStatus({ refresh: true })` unless `trigger === 'scheduled'`); `expired`/`none` → status `held`; else `running`, then `runUnifiedSync` (kind `all`/`courses`) or the task run (Task 4). A run whose summary shows a mastery `errorKind: 'login'` ends `held` instead of finished.
- `resumeHeld()` re-queues held runs (same rows → `queued`).
- `currentSync()` → `{ running: { runId, courseIds, kind } | null, queued: [{ runId, courseIds, kind }], held: [...] }`; keeps `running: boolean` and `runId` for old callers.
- Routes: `POST /api/sync` → `enqueue({ …body, trigger: 'button' })`, answers `{ runId, state, joined }` (no stream). `POST /api/sync/resume` → `resumeHeld()`. `GET /api/sync/current` → `currentSync()`. 400 for an empty course list stays.
- Scheduler: `enqueue(scheduledSyncOptions(...))`; a covering queued run is joined.
- Boot: `markInterruptedRuns` marks `running`, `queued`, `held`.

- [ ] Failing tests: Review Focus 1, 2, 3, 5; FIFO order; button priority; held on `expired`, run on `unknown`, scheduled never held; resume; prune keeps queued/held rows; route answers.
- [ ] Run → FAIL. Implement. Run → PASS, plus every root test.
- [ ] Commit `feat(sync): one queue for every sync, with a session preflight`.

### Task 4: Task runs and `ensure`

**Files:** Modify `server/services/assignmentSync.js`, `server/services/syncQueue.js`, `server/routes/schoology.js`, `server/routes/mastery.js`; tests beside.

**Interfaces:**
- Task run (kind `task`): `syncAssignment` then `refreshAssignmentMastery(..., { force: true })`; emits events (`phase: 'assignment'`, `phase: 'mastery'`); stamps `task_synced_at` only when both succeeded and the task was read; always `task_sync_attempted_at`. A 404 emits `{ type: 'log', message: 'Deleted in Schoology' }` and ends `completed`.
- `ensure(scope, { db, now, trigger: 'page' })` → `{ state: 'fresh' | 'queued' | 'running' | 'held', runId? }`. Fresh when, for every course in scope (archived courses excluded from `all`; an archived course or task scope is always fresh for `page`), `max(course_synced_at, sync_attempted_at)` (task: `max(task_synced_at, task_sync_attempted_at)`) is within `SYNC_FRESH_MS`. Otherwise `enqueue` with only the stale courses.
- `POST /api/sync/ensure { scope }` → `ensure` answer. `POST /api/mastery/:courseId/assignment/:id/sync` → `enqueue({ kind: 'task', …, trigger: 'button', force: true })` answer.

- [ ] Failing tests: Review Focus 4; fresh / stale / attempt within window; dashboard scope queues only stale courses; archived scope fresh for pages; task run stamps only on success; 404 path.
- [ ] Run → FAIL. Implement. Run → PASS, plus every root test.
- [ ] Commit `feat(sync): pages ask the queue to sync stale scopes; Sync Assignment is a queued run`.

### Task 5: Client: follow runs, the chip, the pages

**Files:** Create `client/src/hooks/useBackgroundSync.js` (+ test). Modify `client/src/services/api.js`, `client/src/components/SyncStatus.jsx`, `client/src/components/SyncDialog.jsx`, `client/src/pages/Dashboard.jsx`, `CoursePage.jsx`, `AssessmentSummaryPage.jsx`, `StudentPage.jsx`, `client/src/components/triage/TriageSection.jsx`, `client/src/app.css`, `docs/design-language.md`; tests beside.

**Interfaces:**
- `api.js`: `ensureSync(scope)`, `startSync(request)` (POST `/sync`, JSON answer), `resumeSync()`; `runSync` (stream) removed; `refreshTriage`, `refreshCourse` removed.
- `useBackgroundSync(scope | null, { onDone })` → `{ state: 'idle' | 'fresh' | 'queued' | 'running' | 'held' | 'failed', runId }`: calls `ensureSync` once per scope key; while `queued`/`running`, polls `getCurrentSync()` every 2 s; when the run ends, reads its status (`getSyncRun`), calls `onDone`, and sets `failed` for `failed`/`completed_with_errors`.
- `SyncStatus({ label, syncedAt, archived, sync, onSync, onOpen, onSignIn })`: label as before (no amber when `archived`); chip from `sync.state` ("Syncing…", "Waiting to sync…", "Sync failed", "Log in to Schoology"); clicking the chip calls `onOpen(runId)` (sign-in chip → `goToSignIn`). Check line removed.
- `SyncDialog`: `followRunId` prop opens on that run (join only); `presetCourse` and Sync Courses now `startSync` then follow; the stream code goes.
- Pages: Dashboard `scope { kind: 'all' }`, time = oldest current course; Course `{ kind: 'courses', courseIds: [id] }` (none when archived); Assessment `{ kind: 'task', courseId, assignmentId }`; Student `{ kind: 'courses', courseIds: current course ids }`, time = oldest. `useMasteryRefresh` uses and TriageSection's refresh removed; Sync Assignment button → `startSync({ kind: 'task', … })` and the hook follows it; the "deleted in Schoology" notice from `assignment.removed_at`.
- After sign-in (`RemoteSignIn` success) call `resumeSync()`.

- [ ] Failing tests: the hook's states and polling end; chip copy and click; the dialog's follow mode; each page asks for its scope and reloads on done; no check line; no `refreshTriage`/`refreshCourse` calls.
- [ ] Run → FAIL. Implement. Run `cd client && npx vitest run` → PASS; `npm run build`.
- [ ] Commit `feat(ui): pages sync in the background; one 'Synced' label with a chip that opens the progress`.

### Task 6: Retire the partial reads, live check, docs, ship

- [ ] Remove `POST /api/triage/refresh`, `POST /api/courses/:id/refresh` (+ tests), `triageRefreshTargets`/`courseRefreshTargets` if unused, `MasteryFreshness` if unused. Keep `refreshTasks` (Sync Assignment) and `masteryRefresh.js` (PrisMCP).
- [ ] Live on a dev server over a copy of prod (as in #58): course page starts a background sync, chip, then "Synced"; second visit within 10 minutes starts nothing; dashboard queues all stale courses and a course page opened meanwhile shows "Waiting to sync…"; a copy session with its cookies removed shows **Log in to Schoology** and runs nothing. Stop the server (`npm run dev:stop`); delete copies, snapshots, screenshots.
- [ ] Docs: build-progress, deploy.md (scheduled sync options; background sync), AGENTS.md if a convention changed; grep for `recentOnly`, "Checked for new work", `refreshTriage`, `refreshCourse`, "Include only recent submissions".
- [ ] Every suite, build, final whole-branch review and fix pass, ship to main, CI, prod; close #168 and #169 with evidence; memory.
