# Simplify Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three sync controls (Sync Courses, Sync Course, Sync Assignment), each syncing everything in its scope, with a prominent "Synced …" label and a "Checked for new work at …" line.

**Architecture:** `fullSync` and the orchestrator take a `courseIds` list (null keeps today's behaviour); the Sync dialog sends the ticked courses as that list, and the course page's Sync Course opens the same dialog preset to one course. Sync Assignment extends the existing assignment sync route with the task's metadata and comment threads. Two new stamps (`courses.course_synced_at`, `assignments.task_synced_at`) feed a shared `SyncStatus` component.

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest; React 18, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-20-simplify-sync-design.md`

## Global Constraints

- **Stamps:** `courses.course_synced_at TEXT` and `assignments.task_synced_at TEXT`, each in `server/db/schema.sql` **and** `MIGRATIONS` (`server/db/index.js`). ISO strings.
- **`courseIds: null` is today's behaviour** everywhere (the nightly sync passes nothing).
- **Labels (exact):** sidebar and dialog "Sync Courses"; course page "Sync Course"; assessment page "Sync Assignment"; label "Synced {time}" / "Not synced yet"; check line "Checked for new work at {time}." / "Checking Schoology for new work…" / "Could not check Schoology for new work." (+ **Log in to Schoology** on a sign-in failure). `{time}` from `freshnessTime` (`MasteryFreshness.jsx`).
- **Stale:** the label takes the amber tone when the stamp is older than 24 hours or missing.
- **UI copy:** no em dashes (guard test); colours only from `app.css` variables; buttons `.primary`.
- **No Schoology writes.** `GET /sections/{sid}/assignments/{aid}` is verified (API reference, 404 when deleted).

## Review Focus

1. **A course Prism has never read** (new term) with a list that omits it: it is still read. Test in Task 1.
2. **A ticked archived course:** read once through `finalizeArchivedCourse`, its mastery not read a second time by the orchestrator. Test in Tasks 1 and 2.
3. **Sync Course while another sync runs that does not cover the course:** it waits, then runs its own. Test in Task 4.
4. **Sync Assignment on a task deleted in Schoology (404):** the task is marked removed and the page says so; no other read runs. Test in Task 3.
5. **Sync Courses with the mastery session expired:** Schoology data still syncs for the ticked courses; the dialog states mastery will be skipped. Test in Task 4.

---

### Task 1: `fullSync` with a course list, and the stamps

**Files:** Modify `server/services/sync.js`, `server/db/schema.sql`, `server/db/index.js`. Test `server/services/sync.test.js`.

**Interfaces:**
- Produces: `fullSync(onProgress, { includeHidden, recentOnly, recentDays, courseIds = null })`. With a list (array of local course ids): reads sections whose course id is listed **or** whose `course_synced_at` is null (never read); ignores `includeHidden`; after the section loop, each listed **archived** course is read with `finalizeArchivedCourse(db, { courseId, sectionId, now, runMastery: true })`; the profile step reads only students enrolled (not dropped) in the courses read. Every course read gets `course_synced_at = now`. Returns, besides today's fields, `archivedRead: number[]` (course ids read through finalize).
- Produces: `syncSectionData` stamps `assignments.task_synced_at = now` for each task it wrote except dropbox/test tasks outside the recent window and tasks in `failedAssignmentIds`.

- [ ] **Step 1: Write the failing tests** in `sync.test.js` (existing fullSync mocks):
  - `fullSync with courseIds reads only the listed sections and stamps course_synced_at` (two sections, list holds one; `getSectionEnrollments` called once with that section; only that course stamped).
  - `fullSync with courseIds still reads a course never read` (second course has `course_synced_at` null → read).
  - `fullSync with courseIds reads a listed archived course through finalize` (archived course in list → `finalizeArchivedCourse` path runs: `getSectionEnrollments` called with its section; `archivedRead` holds it).
  - `fullSync with courseIds refreshes only those courses' students` (`getUserProfilesBatch` called with the listed course's uids only).
  - `fullSync without courseIds behaves as before` (hidden skipped unless includeHidden; all students' profiles).
  - `syncSectionData stamps task_synced_at except windowed-out and failed tasks` (recentOnly: an old dropbox task keeps null; a transiently failed task keeps null; a paper task is stamped).
- [ ] **Step 2: Run** `npx vitest run server/services/sync.test.js` → the new tests FAIL.
- [ ] **Step 3: Implement**; columns in schema + MIGRATIONS.
- [ ] **Step 4: Run** `npx vitest run server/services/sync.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(sync): fullSync reads a list of courses; course and task sync stamps (#58)`.

### Task 2: The run takes the list

**Files:** Modify `server/services/syncOrchestrator.js`, `server/services/syncRunner.js`, `server/routes/schoology.js`, `server/services/psAlertsSync.js`, `server/services/submissionComments.js`. Tests: `syncOrchestrator.test.js`, `server/routes/schoology.test.js`, `psAlertsSync.test.js`, `submissionComments.test.js`.

**Interfaces:**
- Consumes: Task 1's `fullSync` `courseIds` and `archivedRead`.
- Produces:
  - `runUnifiedSync({ …, courseIds = null })`: passes `courseIds` to `fullSync`, to `syncPsAttendance({ courseIds })` and `syncPsAlerts({ courseIds })`, and to `refreshRecentComments(db, { courseIds })`; skips the mastery phase for courses in `archivedRead`.
  - `syncPsAlerts({ courseIds })` and `refreshRecentComments(db, { courseIds })`: restrict to those courses when given.
  - `POST /api/sync` body accepts `courseIds` (array of integers, or absent/null). `currentSync()` → `{ running, runId, courseIds }` (the running run's list, null for a full run); `GET /api/sync/current` returns it.

- [ ] **Step 1: Failing tests:** orchestrator passes `courseIds` to each phase and skips mastery for `archivedRead`; route forwards `courseIds` and `GET /sync/current` returns it while a run is going; `syncPsAlerts` reads only listed courses; `refreshRecentComments` only listed courses' tasks.
- [ ] **Step 2: Run** the four files → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): a sync run for a list of courses (#58)`.

### Task 3: Sync Assignment on the server

**Files:** Create `server/services/taskAssignments.js`, `server/services/assignmentSync.js`. Modify `server/services/sync.js` (assignment upsert moves out), `server/services/schoology.js`, `server/routes/mastery.js`. Tests: `taskAssignments.test.js`, `assignmentSync.test.js`, `server/routes/mastery.test.js`, `sync.test.js` unchanged.

**Interfaces:**
- Produces:
  - `writeAssignments(db, { courseId, assignments, now, enrolmentIdToUid, complete })` in `taskAssignments.js`: today's upsert + assignees + (only when `complete`) the soft-removal of missing tasks; `isTest(a)` exported from the same file. `syncSectionData` calls it with `complete: true`.
  - `getSectionAssignment(sectionId, assignmentId)` in `schoology.js` → `apiGet('/sections/{sid}/assignments/{aid}')`.
  - `syncAssignment(courseId, schoologyAssignmentId, { db = getDb(), deps = {} })` in `assignmentSync.js` → `{ removed: true }` on a 404 (sets `removed_at`), else `{ removed: false, submissions: <refreshTasks answer>, comments: { queued }, taskSyncedAt }`: reads the task, `writeAssignments(..., complete: false)` with the enrolment map from stored enrolments, `refreshTasks([id], { force: true, mastery: false })`, awaits `refreshAssignment(db, id)`'s job (forced), and sets `task_synced_at = now` when the submissions read had no failure.
  - `POST /api/mastery/:courseId/assignment/:id/sync`: runs `syncAssignment` first; on `removed` answers `{ removed: true }` (200); then the existing mastery read; answer `{ ...masteryResult, syncedAt, submissions, taskSyncedAt }` (500 with the same extras when mastery fails, as now).

- [ ] **Step 1: Failing tests:** `writeAssignments` with `complete: false` never marks other tasks removed; `syncAssignment` updates a changed due date, marks a 404 task removed and reads nothing else, stamps `task_synced_at` only after a clean submissions read; the route answers `removed` and carries `taskSyncedAt`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (check `refreshAssignment`'s signature for forcing; use its existing option, or add `maxAgeSec: 0`).
- [ ] **Step 4: Run** the files plus `sync.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(sync): Sync Assignment reads the task's details, submissions, grades, mastery and comments (#58)`.

### Task 4: The Sync Courses dialog, and the course preset

**Files:** Modify `client/src/components/SyncConfig.jsx`, `client/src/components/SyncDialog.jsx`, `client/src/App.jsx`, `client/src/services/api.js`, `client/src/app.css` (only if needed). Tests: `SyncConfig.test.jsx`, `SyncDialog.test.jsx` (create where missing).

**Interfaces:**
- Consumes: Task 2's `courseIds` and `GET /api/sync/current` `courseIds`.
- Produces:
  - `runSync({ courseIds, masteryCourseIds, … })` sends `courseIds`.
  - `SyncConfig`: groups Current / Hidden / Archived (archived = `c.archived && !c.excluded`), defaults current ticked; no "Include hidden" box; the course list shows with or without a mastery session; without one, a notice: "Mastery will be skipped: log in to Schoology to sync it too." with the login button. `onStart(ids, { recentOnly, recentDays, syncBlocks })`; the dialog sends `courseIds = masteryCourseIds = ids` (mastery ids empty without a session).
  - `SyncDialog` prop `presetCourse = { id, name }`: skips the config and starts at once with `courseIds: [id]`, `masteryCourseIds: [id]`, `syncBlocks: false`. On a 409: reads `getCurrentSync()`; joins when its `courseIds` is null or holds `id`; otherwise shows "Waiting for the running sync…", follows that run to its end, then starts its own.
  - Sidebar button and dialog title "Sync Courses".

- [ ] **Step 1: Failing tests:** three groups with the right defaults; start sends the ticked ids as both lists; no session → list shown, mastery list empty, notice shown (Review Focus 5); preset starts at once with one course; 409 by a run covering the course → joined; 409 by a run of other courses → waits, then starts its own (Review Focus 3).
- [ ] **Step 2: Run** `cd client && npx vitest run src/components/Sync*` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(ui): Sync Courses: one course list, everything for each ticked course (#58)`.

### Task 5: `SyncStatus`, Sync Course and Sync Assignment on the pages

**Files:** Create `client/src/components/SyncStatus.jsx` (+ test). Modify `client/src/pages/CoursePage.jsx`, `client/src/pages/AssessmentSummaryPage.jsx`, `client/src/pages/Dashboard.jsx` (empty-state text), `client/src/app.css` (`.sync-status*` in the main sheet and, if needed, the PHONE LAYOUT block), `docs/design-language.md`. Tests: `SyncStatus.test.jsx`, `CoursePage.masteryRefresh.test.jsx`, `AssessmentSummaryPage.masteryRefresh.test.jsx`.

**Interfaces:**
- Consumes: Task 4's `SyncDialog presetCourse`; Task 3's route answer; `useMasteryRefresh` states.
- Produces: `SyncStatus({ label, syncedAt, syncing, onSync, checks = [], now })`: the prominent "Synced {time}" (amber over 24 h or missing), the `.primary` button (`label`, disabled and "Syncing…" while `syncing`), and one check line combining `checks` (refresh-hook states): refreshing if any is; else an error if any failed (sign-in button if any `signIn`); else "Checked for new work at {latest time}."
  - Course page: `SyncStatus label="Sync Course" syncedAt={course.course_synced_at} checks={[masteryFreshness, submissionsFreshness]}`; the button opens `SyncDialog presetCourse`; on completion the page reloads (course, gradebook, mastery, triage). The two `MasteryFreshness` lines, `handleMasterySync` and its result UI go. Archived course: label only, button shown (a re-read).
  - Assessment page: `SyncStatus label="Sync Assignment" syncedAt={taskSyncedAt} checks={[masteryFreshness]}`; the button runs today's `handleRefresh` (now Sync Assignment); a `removed` answer shows "This task was deleted in Schoology." (`.alert.alert-warning`). Its `MasteryFreshness` line goes. The page's data must carry `task_synced_at` (add it to the assignment GET if absent).
  - Texts: Dashboard "Click **Sync Courses** in the sidebar…"; course page "Click **Sync Course** above…".

- [ ] **Step 1: Failing tests:** `SyncStatus` (fresh, 2 days old → amber, never, refreshing, check error with sign-in, syncing); course page shows "Synced …" from `course_synced_at` and "Sync Course" opens the dialog preset; assessment page shows "Synced …" from `task_synced_at`, "Sync Assignment" calls the sync route, and a `removed` answer shows the alert.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; append the decisions to `docs/design-language.md`.
- [ ] **Step 4: Run** `cd client && npx vitest run` → PASS; `npm run build` → succeeds.
- [ ] **Step 5: Commit** `feat(ui): Sync Course and Sync Assignment with a prominent synced label (#58)`.

### Task 6: Live check, docs, ship

- [ ] **Step 1: Live.** Copy prod's database with `sqlite3 ~/prism/data/students.db ".backup <scratchpad>/dev.db"` and the session directory to the scratchpad; `DB_PATH=… PRISM_SESSION_DIR=… PORT=3002 npm run dev` (never `PRISM_SCHEDULED_SYNC`); in a browser (Playwright): Sync Course on one course and Sync Assignment on one task; record each wall time and the labels shown. Stop the server with `npm run dev:stop`; delete the copies and screenshots.
- [ ] **Step 2: Docs.** `.claude/build-progress.md`; `docs/deploy.md` (button names); `AGENTS.md` if a convention changed; grep for "Sync Mastery", "Refresh from Schoology", "Sync Schoology", "Include hidden courses" and fix each hit outside old plans/specs.
- [ ] **Step 3: Every suite.** Root `npx vitest run`, `cd client && npx vitest run`, `npm run build`.
- [ ] **Step 4: Final whole-branch review** (executing-plans), fix pass.
- [ ] **Step 5: Ship.** Fast-forward `main`, push; CI green; prod serves the commit.
- [ ] **Step 6: Issues and memory.** Comment on #58 with evidence and close it; update the handoff memory.
