# On-demand Submission and Score Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pages that show triage, a course or an assessment re-read the submissions and scores of the tasks they show from Schoology after they load, so a student who has submitted, or been scored, stops being listed without a sync.

**Architecture:** Extract the full sync's per-task submission read and grade write from `syncSectionData` into shared functions; a new `taskRefresh.js` service reads a list of tasks with them (2-minute freshness, shared in-flight reads, one session reader per batch) and adds the aligned tasks' mastery read (`refreshAssignmentMastery`). Three routes expose it; the client calls them through the existing `useMasteryRefresh` hook and shows a generalised `MasteryFreshness` line.

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest; React 18, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-19-on-demand-submissions-design.md`

## Global Constraints

- **Freshness:** `FRESH_MS` = 2 minutes, imported from `server/services/masteryRefresh.js` (one constant).
- **Stamp:** `assignments.submissions_read_at` (ISO text), added to `server/db/schema.sql` **and** the `MIGRATIONS` array in `server/db/index.js`. Set only when a task's read finished in full (native bulk read answered, LTI document read `'ok'`, test covered by the attempt read).
- **Failure rule:** a read started by a page leaves `lti_fetch_status` and `test_fetch_status` as they were on failure (`keepStatusOnFailure: true`); the full sync keeps writing `'failed'`.
- **A submission is cleared only by a read that finished in full.**
- **One task's grades:** `GET /sections/{id}/grades?assignment_id={aid}` (verified 19 Oct 2026, `.claude/schoology-api-reference.md`).
- **Archived courses are never refreshed** (their data no longer changes).
- **UI copy:** no em dashes (guard test); dates through `client/src/lib/formatDate.js` / `freshnessTime`.
- **Writes:** none to Schoology. Every new route is `POST` (origin guard applies).

## Review Focus

1. **No saved session:** native tasks and grades are still read; LTI/test tasks keep their state and the answer carries `signIn: true`. Test in Task 3.
2. **One task fails mid-batch (transient 5xx):** the other tasks are still read and stamped; the failed one keeps its old rows and no stamp. Test in Task 3.
3. **Two pages ask for the same task at once:** one Schoology read. Test in Task 3.
4. **A task on the triage list belongs to a course now archived or a task since removed** (`removed_at` set): skipped, never an error. Test in Task 3.
5. **The dashboard's refresh answers after the user changed the formative toggle:** the lists reload with the current toggle (TriageSection's `load` is the current callback). Test in Task 5.

---

### Task 1: Shared per-task submission read

**Files:**
- Create: `server/services/taskSubmissions.js`
- Modify: `server/services/sync.js` (the submission section of `syncSectionData`, lines ~262-472, and `syncTestAttempts` moves to the new file), `server/db/schema.sql` (assignments table), `server/db/index.js` (`MIGRATIONS`)
- Test: `server/services/taskSubmissions.test.js`; `server/services/sync.test.js` must pass unchanged

**Interfaces:**
- Produces:
  `readTaskSubmissions(db, { sectionId, now, students, native, lti, tests, fetchDocuments, fetchTestAttempts, keepStatusOnFailure = false, backoffMs = 750, abandonAfter = 5 })`
  - `students`: `[{ id: <schoology enrolment id string>, uid: <schoology uid string> }]`
  - `native`, `lti`, `tests`: arrays of Schoology assignment id strings.
  - Returns `{ submissionCount, failedAssignmentIds, submissionAbandoned, submissionAttempts, rateLimitHits, transientFailures, revisionsRead: Set<local assignment id>, readInFull: Set<local assignment id> }`.
  - Non-transient native errors still throw (the sync's contract). Writes `assignments.submissions_read_at = now` for every id in `readInFull`.

- [ ] **Step 1: Write the failing tests** in `taskSubmissions.test.js` (in-memory db via the existing test helpers in `sync.test.js`; mock `getAssignmentSubmissions` as `sync.test.js` does):
  - `stamps submissions_read_at only for tasks read in full`: native ok, one lti task whose `fetchDocuments` returns null twice → `readInFull` holds only the native task; only its `submissions_read_at` is set.
  - `keepStatusOnFailure leaves lti_fetch_status and test_fetch_status as they were`: preset both to `'ok'`, failing fetchers → both still `'ok'`; same call with `keepStatusOnFailure: false` → both `'failed'`.
  - `a transient native error leaves that task's grades rows unchanged`: preset a submitted row, `getAssignmentSubmissions` rejects `{ transient: true }` → row identical, id in `failedAssignmentIds`.
- [ ] **Step 2: Run** `npx vitest run server/services/taskSubmissions.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** by moving the native loop + `writeSubmissions`, the LTI pass and `syncTestAttempts` out of `syncSectionData` unchanged in behaviour; `syncSectionData` builds `students` from `studentEnrollments` and the three id lists from its windowed `dropboxAssignments`/`testAssignments`, then calls `readTaskSubmissions`. Add `submissions_read_at TEXT` to `assignments` in `schema.sql` and `ALTER TABLE assignments ADD COLUMN submissions_read_at TEXT` to `MIGRATIONS`.
- [ ] **Step 4: Run** `npx vitest run server/services/taskSubmissions.test.js server/services/sync.test.js` → all PASS, `sync.test.js` with no edits.
- [ ] **Step 5: Commit** `refactor(sync): one per-task submission read shared with on-demand refresh (#108)`.

### Task 2: Shared grade write and one task's grades

**Files:**
- Modify: `server/services/schoology.js` (add the read), `server/services/sync.js` (grades step, lines ~208-249)
- Create: `server/services/taskGrades.js`
- Test: `server/services/taskGrades.test.js`

**Interfaces:**
- Produces:
  - `getAssignmentGrades(sectionId, assignmentId)` in `schoology.js` → `apiGet('/sections/{sectionId}/grades?assignment_id={assignmentId}')?.grades?.grade || []`.
  - `writeGrades(db, { courseId, grades, now, enrollIdToUid = {} })` in `taskGrades.js` → count written. Same upsert and student resolution as today's `writeGrades` in `syncSectionData`; `syncSectionData` calls it.

- [ ] **Step 1: Write the failing tests:**
  - `writeGrades upserts score, comment, comment_status, exception and submitted_at, never late or draft`: preset `late = 1` → still 1 after.
  - `writeGrades resolves a student by stored enrolment, then by uid`.
  - `getAssignmentGrades asks for one task` (mock `apiGet`; assert the path is `/sections/S/grades?assignment_id=A`).
- [ ] **Step 2: Run** `npx vitest run server/services/taskGrades.test.js` → FAIL.
- [ ] **Step 3: Implement**, moving the existing statement and loop; no behaviour change.
- [ ] **Step 4: Run** `npx vitest run server/services/taskGrades.test.js server/services/sync.test.js` → PASS.
- [ ] **Step 5: Commit** `refactor(sync): shared grade write; one task's grades read (#108)`.

### Task 3: The refresh service

**Files:**
- Create: `server/services/taskRefresh.js`
- Test: `server/services/taskRefresh.test.js`

**Interfaces:**
- Consumes: Task 1's `readTaskSubmissions`, Task 2's `getAssignmentGrades` and `writeGrades`, `refreshAssignmentMastery` and `FRESH_MS` from `masteryRefresh.js`, `createSubmissionFetcher` from `graderSubmissions.js`, `captureFeedbackSnapshots`, `settleResubmissions`.
- Produces:
  `refreshTasks(assignmentIds, { db = getDb(), force = false, mastery = true, now = Date.now, openReader = createSubmissionFetcher, deps = {} } = {})`
  → `Promise<{ refreshed: number, readAt: string|null, failed: number[], error?: string, signIn?: boolean }>`
  - `assignmentIds`: local `assignments.id` numbers. Skips unknown, removed (`removed_at`), and archived-course tasks, and (unless `force`) tasks whose `submissions_read_at` is under `FRESH_MS` old.
  - Groups by course; one reader for the batch (null reader → native and grades only, `signIn: true` when any LTI/test task was skipped for it); courses read with concurrency 4; each course: students from `enrolments` (`dropped_at IS NULL`) joined to `students`, then `readTaskSubmissions(..., { keepStatusOnFailure: true })`, then `getAssignmentGrades` + `writeGrades` per task, then (when `mastery`) `refreshAssignmentMastery(courseId, schoologyAssignmentId)` per aligned task (`ALIGNED_SQL` from `triageCommon.js`), then `captureFeedbackSnapshots(db, { revisionsRead, readSince })` and `settleResubmissions(db, { courseId })`.
  - A course whose read throws adds its task ids to `failed` and the others carry on.
  - Shared in-flight: a module-level `Map<taskId, Promise>`; a task already being read is awaited, not read again.
  - `readAt`: the oldest `submissions_read_at` among the requested, known tasks after the read.
  - `deps` injects `getAssignmentSubmissions`, `getAssignmentGrades`, `refreshAssignmentMastery` for tests.

- [ ] **Step 1: Write the failing tests** (in-memory db, injected deps):
  - `skips tasks read under 2 minutes ago unless force`.
  - `no session: reads native tasks and grades, keeps lti state, answers signIn` (`openReader` resolves null).
  - `one course failing does not stop the others` (Review Focus 2).
  - `two calls for the same task share one read` (Review Focus 3): two concurrent calls → injected `getAssignmentSubmissions` called once.
  - `skips archived-course and removed tasks without error` (Review Focus 4).
  - `reads mastery only for aligned tasks, and not when mastery is false`.
  - `readAt is the oldest stamp among the tasks`.
- [ ] **Step 2: Run** `npx vitest run server/services/taskRefresh.test.js` → FAIL.
- [ ] **Step 3: Implement** `refreshTasks` as specified; close the reader in `finally`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(refresh): read listed tasks' submissions and scores on demand (#108)`.

### Task 4: Targets and routes

**Files:**
- Modify: `server/services/triage.js`, `server/routes/triage.js`, `server/routes/courses.js`, `server/routes/mastery.js`
- Test: `server/services/triage.test.js`, `server/routes/triage.test.js`, `server/routes/courses.test.js`, `server/routes/mastery.test.js`

**Interfaces:**
- Consumes: Task 3's `refreshTasks`.
- Produces:
  - `triageRefreshTargets(db, { courseId = null, includeFormative } = {})` in `triage.js` → local task ids: every `assignmentId` in `getTriage`'s `lateWork`, `makeUps`, `resubmissions`, `feedbackOwed`, plus past-due tests (`pastDueTests`) of current courses with `test_fetch_status != 'ok'` and `makeup_ignored = 0`. Deduplicated.
  - `courseRefreshTargets(db, courseId, now = new Date())` in `triage.js` → `triageRefreshTargets(db, { courseId, includeFormative: true })` plus the course's published, non-removed tasks with `accepts_submissions = 1 OR is_test = 1` and `due_date` within the last 30 days or later, plus tasks with an open resubmission request.
  - `POST /api/triage/refresh` body `{ courseId?, includeFormative? }` → `refreshTasks(triageRefreshTargets(...))`'s answer.
  - `POST /api/courses/:id/refresh` → `refreshTasks(courseRefreshTargets(...))`'s answer; 404 for an unknown course; `{ refreshed: 0, readAt: null }` for an archived one.
  - `POST /api/mastery/:courseId/assignment/:assignmentId/refresh` and `/sync`: also `refreshTasks([localId], { force: <same as the mastery call>, mastery: false })`; the answer's `refreshed` is true when either read ran; the `/sync` answer keeps its counts and adds `submissions: <refreshTasks answer>`.

- [ ] **Step 1: Write the failing tests:**
  - `triageRefreshTargets includes unchecked past-due tests and excludes ignored ones`.
  - `courseRefreshTargets includes a 10-day-old task and an open resubmission request's 90-day-old task, excludes a 60-day-old task with neither`.
  - Route tests (mock `taskRefresh.js`): each route passes the right ids and returns the answer; the assessment refresh route calls both reads with `mastery: false`.
- [ ] **Step 2: Run** the four test files → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(refresh): triage, course and assessment routes read their tasks (#108)`.

### Task 5: Client

**Files:**
- Modify: `client/src/services/api.js`, `client/src/components/MasteryFreshness.jsx`, `client/src/components/triage/TriageSection.jsx`, `client/src/pages/Dashboard.jsx` (only if a prop is needed), `client/src/pages/CoursePage.jsx`, `client/src/hooks/useMasteryRefresh.js` (comment only: it serves any Schoology refresh)
- Test: `client/src/components/MasteryFreshness.test.jsx`, `client/src/components/triage/TriageSection.test.jsx` (create if missing), `client/src/pages/CoursePage.test.jsx`

**Interfaces:**
- Consumes: Task 4's routes.
- Produces:
  - `refreshTriage({ courseId, includeFormative })` and `refreshCourse(courseId)` in `api.js` (`POST`).
  - `MasteryFreshness` prop `subject = { label: 'Mastery levels', short: 'levels' }`; the four sentences use `subject.label` / `subject.short`. Triage passes `{ label: 'Submissions and scores', short: 'submissions' }`. Existing callers unchanged.
  - `TriageSection` prop `refresh = true`: after its first successful load, `useMasteryRefresh(key, () => refreshTriage(...), load)` with `key = data ? \`${courseId}:${includeFormative}\` : null`; renders the freshness line above the panels. `CoursePage` passes `refresh={false}` and runs its own `useMasteryRefresh(course && !course.archived ? course.id : null, () => refreshCourse(id), reload)` where `reload` re-fetches the gradebook and bumps TriageSection's `version`; its line sits under the existing mastery line.

- [ ] **Step 1: Write the failing tests:**
  - `MasteryFreshness: subject changes the label` → "Submissions and scores read from Schoology at 14:05 today."
  - `TriageSection refreshes after its first load and reloads the lists when refreshed` (mock api; `getTriage` called twice).
  - `TriageSection reloads with the current formative toggle after a refresh` (Review Focus 5).
  - `TriageSection with refresh={false} never calls refreshTriage`.
  - `CoursePage calls refreshCourse once and not for an archived course`.
- [ ] **Step 2: Run** `cd client && npx vitest run src/components src/pages/CoursePage.test.jsx` → FAIL.
- [ ] **Step 3: Implement.** Append the decision (one freshness line per refresh, subject label) to `docs/design-language.md`.
- [ ] **Step 4: Run** `cd client && npx vitest run` → PASS; `npm run build` → succeeds.
- [ ] **Step 5: Commit** `feat(ui): dashboard, course and assessment pages read their tasks from Schoology after loading (#108)`.

### Task 6: Parity on database copies

**Files:**
- Create: `scripts/parity-task-refresh.js`

- [ ] **Step 1: Write the script.** Arguments: two database paths (copies). On copy A: `refreshTasks(triageRefreshTargets(dbA), { db: dbA, force: true })`. On copy B: for each course touched, `syncSectionData` with a reader (the full sync's path, `recentOnly: false`). Compare the target tasks' `grades` rows (every column except `synced_at`) between A and B; print counts of rows compared and every differing row's ids and column names only (no names, no comments). Print the refresh's wall time.
- [ ] **Step 2: Run it** on two copies made with `sqlite3 ~/prism/data/students.db ".backup <scratchpad>/a.db"` (and `b.db`), run with `DB_PATH=<a.db>` so the mastery read (which opens `getDb()`) writes to copy A, never to prod. Expected: 0 differing rows. A difference that is a real change between the two reads (a student submitting in between) is re-run once to confirm.
- [ ] **Step 3: Delete both copies.** Commit the script: `test(parity): on-demand task refresh against the full sync's read (#108)`.

### Task 7: Docs, ship, verify

- [ ] **Step 1: Docs.** `.claude/build-progress.md` (what shipped, timings); `docs/deploy.md` (the Scheduled sync / session sections: pages now also read submissions and scores); `AGENTS.md` only if a convention changed; mark the spec's "Left to the builder" choices as made. Grep for "Refresh from Schoology" and "mastery refresh" wording that now understates the read.
- [ ] **Step 2: Every suite.** `npx vitest run` at the root, `cd client && npx vitest run`, `npm run build` → all pass.
- [ ] **Step 3: Ship.** Fast-forward `main`, push, confirm CI green on the commit, `curl -s 127.0.0.1:3001/api/version` serves it.
- [ ] **Step 4: Prod timing.** `POST /api/triage/refresh` with `force` absent on prod after deploy (`curl` localhost); record its wall time and `refreshed` count.
- [ ] **Step 5: Issues and memory.** Comment on #108 (baseline from run 20, the refresh timing, commits) and close it if its goal is met; comment on #58 (what it can now use); update the project memory handoff.
