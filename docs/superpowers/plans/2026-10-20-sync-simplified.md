# Sync, simplified (#171) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-click Sync Courses, a nightly-data freshness line, a help "?" beside every Synced time, and a first run that shows courses as they sync and then imports past courses in the background.

**Architecture:** Everything rides the existing sync queue (`server/services/syncQueue.js`) and orchestrator (`server/services/syncOrchestrator.js`). Two small settings-row stamps (nightly data, past-import state) and one courses column pair (first sync state) carry the new facts; `GET /api/sync/status` exposes them; the dashboard and `SyncStatus` render them. Past courses import one queue run at a time (a new run kind `import`), chained, so page syncs interleave.

**Tech Stack:** Node ESM, Express, better-sqlite3, React (Vite), Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-20-sync-simplified-design.md` (read it first; its "How it works" and "What its first sync has finished means" sections are the requirement).

## Global Constraints

- Read `AGENTS.md`. Colours only through CSS custom properties; phone rules only in the `PHONE LAYOUT` block at the end of `client/src/app.css`; no em dashes in UI copy (a guard test enforces it); dates through `client/src/lib/formatDate.js` (`freshnessTime`).
- A new column goes in `server/db/schema.sql` **and** the `MIGRATIONS` array in `server/db/index.js`.
- No teacher-facing freshness line or help text names PowerSchool or Schoology's systems except the help's last line ("…in Schoology just now"). The progress dialog and provenance labels keep "PowerSchool".
- Exact copy (American spelling, no em dashes):
  - Help, line 1: `Prism keeps this up to date for you.`
  - Help, bullet 1: **`Courses, students, grades and submissions:`** `refreshed when you open a page, if older than 10 minutes.`
  - Help, bullet 2 (nightly on): **`Blocks, calendar and alerts:`** `refreshed every night.`
  - Help, bullet 2 (nightly off), dashboard: **`Blocks, calendar and alerts:`** `refreshed when you press Sync Courses.`; other pages: `refreshed when you press Sync Courses on the dashboard.`
  - Help, last line: `Press <button> only if you changed something in Schoology just now.` where `<button>` is `Sync Courses` / `Sync Course` / `Sync Assignment` (student page: `Sync Courses`).
  - Nightly line: `Blocks, calendar and alerts: <freshnessTime>`; never read: `Blocks, calendar and alerts: not read yet`; amber (stamp missing or over 26 hours old): `Blocks, calendar and alerts: <N> days old. Press Sync Courses to refresh them.` (N = whole days, at least 1; "1 day old" singular). Missing stamp amber text is the "not read yet" line plus ` Press Sync Courses to refresh them.`
  - First run: `Getting your courses: <finished> of <total>`; Archived tab: `Importing past courses: <done> of <total>`; card badge: `Sync failed`.
- Nightly is "on" only when the scheduler is armed (`getSyncScheduler()?.status().active`), Settings `enabled` and Settings `syncBlocks` are all true.

## Review Focus

1. **Nightly run off, or a dev clone (scheduler never armed):** the help's second bullet must not promise a night; the line is amber with the action. Test in Task 3.
2. **First run with no Schoology session:** the run is held; the dashboard shows the existing "Log in to Schoology" chip and an empty state that does not tell the teacher to use a sidebar button that no longer exists. Test in Task 6.
3. **One section fails during the first run while others succeed:** the run continues, the failed course shows with "Sync failed", the rest appear. Test in Task 4.
4. **Server restart in the middle of the past-course import:** it resumes with only the sections still missing; nothing imported twice. Test in Task 5.
5. **Prod's existing database:** no course is hidden (existing rows have no first-sync mark) and no past import ever starts (no first run happened). Tests in Tasks 4 and 5.

---

### Task 1: Nightly-data stamp and status

**Files:**
- Create: `server/services/nightlyData.js`, `server/services/nightlyData.test.js`
- Modify: `server/services/syncOrchestrator.js` (after the alerts phase), `server/services/syncOrchestrator.test.js`
- Modify: `server/routes/schoology.js` (`GET /api/sync/status`), its test

**Interfaces:**
- Produces: `NIGHTLY_DATA_KEY = 'sync.nightlyDataReadAt'`; `recordNightlyDataRead(db, at: string): void`; `nightlyDataStatus(db, { schedulerActive: boolean }) → { readAt: string|null, nightly: boolean }`.
- Produces: `GET /api/sync/status` adds `nightlyData: { readAt, nightly }` (existing fields unchanged).

- [ ] **Step 1: Failing tests.** `nightlyData.test.js`: `recordNightlyDataRead` then `nightlyDataStatus` returns that `readAt`; `nightly` is true only when `schedulerActive` and Settings `enabled` and `syncBlocks` are true (three cases false). `syncOrchestrator.test.js` (mock `syncPsAttendance`/`syncPsAlerts` as the file already does): stamped when blocks done and alerts done; stamped when blocks done with `notReady > 0`; stamped when blocks done and the `powerschool_alerts` feature is off; **not** stamped when blocks errors; **not** stamped when alerts errors; not stamped when `syncBlocks` is false. Route test: status carries `nightlyData`.
- [ ] **Step 2: Run** `npx vitest run server/services/nightlyData.test.js server/services/syncOrchestrator.test.js server/routes/schoology.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Store as a `settings` row (JSON string value, `INSERT … ON CONFLICT(key) DO UPDATE`, as `syncScheduler.js` `LAST_KEY` does). In `runUnifiedSync`, after the alerts block: when `syncBlocks` and `summary.blocks` has no `error` and (alerts ran without `error`, or the feature is off), call `recordNightlyDataRead(db, new Date().toISOString())`. The route reads `getSyncScheduler()?.status().active ?? false`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sync): stamp the last full read of blocks, calendar and alerts (#171)`.

### Task 2: One-click Sync Courses; remove the course list and the sidebar button

**Files:**
- Modify: `server/routes/schoology.js` (`POST /api/sync`), its test
- Modify: `client/src/components/SyncDialog.jsx`, `SyncDialog.test.jsx`
- Delete: `client/src/components/SyncConfig.jsx`, `SyncConfig.test.jsx`
- Modify: `client/src/App.jsx` (sidebar button, Shell's dialog), `client/src/App.test.jsx`, `client/src/pages/phoneLayout.test.jsx` if it references the sidebar button, `.sync-btn` rules in `client/src/app.css`
- Modify: `client/src/pages/Dashboard.jsx`, `Dashboard.test.jsx`; `client/src/components/SyncStatus.jsx`, `SyncStatus.test.jsx`
- Modify: `client/src/pages/SettingsPage.jsx` (the "Run a sync with "Sync from PowerSchool" ticked" sentence → `Press Sync Courses on the dashboard to load it.`)

**Interfaces:**
- Produces: `POST /api/sync` accepts `{ everything: true }` → enqueues `{ ...scheduledSyncOptions(db, getSyncScheduleSettings(db)), syncBlocks: true, trigger: 'button', force: true }`. Other body shapes unchanged.
- Produces: `SyncDialog` props `{ onClose, onSyncComplete, onRun, request?, presetCourse?, followRunId? }`. `request` (a `POST /api/sync` body) starts that run on mount. No `group`, no config mode.
- Produces: `SyncStatus` renders no Sync button when `label` is null.

- [ ] **Step 1: Failing tests.** Route: `{ everything: true }` queues `kind: 'all'`, `syncBlocks: true`, `refreshQuizzes: true`, `includeHidden` from Settings, `trigger: 'button'`. `SyncDialog.test.jsx`: with `request={{ everything: true }}` it calls `startSync` with that body on mount and shows progress (replace the config-mode tests; keep follow, held, stalled, retry tests). `Dashboard.test.jsx`: Current tab's Sync Courses opens the dialog that posts `{ everything: true }`; Archived tab shows no Sync Courses button and still shows its Synced time. `App.test.jsx`: the sidebar has no Sync Courses button. `SyncStatus.test.jsx`: `label={null}` renders no button.
- [ ] **Step 2: Run** `npx vitest run server/routes/schoology.test.js` and `cd client && npx vitest run src/components/SyncDialog.test.jsx src/pages/Dashboard.test.jsx src/App.test.jsx src/components/SyncStatus.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Drop the config path from `SyncDialog` and every import only it used (`SyncConfig`, `getCourses`, `getMasteryLoginStatus`, `getTriageCalendar`, `useSchoologyConnection`, `busy`, `loggedIn`, `calendar`, the `'loading'`→`'config'` branch); `presetCourse` becomes the same path as `request` (`{ courseIds: [id], syncBlocks: false }`). Update the header comments of `SyncDialog`, `Dashboard` ("Sync Courses opens the course list") and the empty-state copy that names the sidebar (Task 6 rewrites the empty state; here make it `No courses yet. Press Sync Courses to get your courses.`). Grep `client/src` for `SyncConfig`, `sync-btn`, `group=` and fix every hit.
- [ ] **Step 4: Run** the same commands, then the whole client suite `cd client && npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sync): one-click Sync Courses; remove the course list and the sidebar button (#171)`.

### Task 3: Help "?" beside every Synced time, and the nightly-data line

**Files:**
- Modify: `client/src/components/HelpDot.jsx` (optional `children`), its test if one exists
- Create: `client/src/components/SyncHelp.jsx`, `SyncHelp.test.jsx`
- Create: `client/src/hooks/useSyncFacts.js`
- Modify: `client/src/components/SyncStatus.jsx`, `SyncStatus.test.jsx`
- Modify: `client/src/pages/Dashboard.jsx`, `CoursePage.jsx`, `StudentPage.jsx`, `AssessmentSummaryPage.jsx` (pass `help` / `nightlyData`)
- Modify: `client/src/app.css` (`.sync-status__nightly`, its `--stale` amber via existing tokens; phone rule in PHONE LAYOUT)
- Modify: `docs/design-language.md` (new entry: the freshness lines name data, not systems; Graham 20/10/2026)

**Interfaces:**
- Consumes: Task 1's `GET /api/sync/status` `nightlyData`.
- Produces: `HelpDot({ text, children })`: `text` stays the aria-label; `children`, when given, is the popover content.
- Produces: `SyncHelp({ button: string, nightly: boolean, onDashboard?: boolean })` → a `HelpDot` with the Global Constraints copy, bullets as a `<ul>`, labels in `<strong>`.
- Produces: `useSyncFacts() → { nightlyData: { readAt, nightly } | null, pastImport: object | null, reload(): Promise }` (one `getSyncStatus()` fetch; Task 6 reads `pastImport`).
- Produces: `SyncStatus` new props `help?: ReactNode` (rendered after the time) and `nightlyData?: { readAt, nightly }` (renders the second line when given); exported `nightlyLine(nightlyData, now) → { text: string, stale: boolean }`.

- [ ] **Step 1: Failing tests.** `SyncHelp.test.jsx`: exact copy for nightly on/off, dashboard and other page, and each button name. `SyncStatus.test.jsx` on `nightlyLine`: read 2 hours ago → `Blocks, calendar and alerts: 03:01 today`, not stale; 27 hours ago → stale, `… 1 day old. Press Sync Courses to refresh them.`; 50 hours → `2 days old`; null `readAt` → stale `Blocks, calendar and alerts: not read yet. Press Sync Courses to refresh them.`; with `nightly: false` and a 27-hour-old read, still stale (the night is not promised). Rendering: the "?" is beside the time on all four pages (one test per page file that already renders `SyncStatus`, checking the aria-label contains the page's button name).
- [ ] **Step 2: Run** `cd client && npx vitest run src/components/SyncHelp.test.jsx src/components/SyncStatus.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** The dashboard passes `nightlyData` only on the Current tab. The aria-label is the help text joined into one string.
- [ ] **Step 4: Run** the whole client suite. Expected: PASS (the em-dash guard included).
- [ ] **Step 5: Commit** `feat(sync): help beside every Synced time and a line for blocks, calendar and alerts (#171)`.

### Task 4: A course's first sync (server)

**Files:**
- Modify: `server/db/schema.sql` (`courses`: `first_sync TEXT` — `'pending'` | `'failed'` | NULL — and `first_sync_error TEXT`), `server/db/index.js` (`MIGRATIONS`)
- Modify: `server/services/sync.js` (`fullSync`), `server/services/sync.test.js`
- Modify: `server/services/syncOrchestrator.js` (mastery list after discovery; `currentCourseIds`), `syncOrchestrator.test.js`
- Modify: `server/services/syncQueue.js` (`unifiedOptions`, `coveredCourseIds` uses `currentCourseIds`), `syncQueue.test.js`

**Interfaces:**
- Produces: `courses.first_sync`, `courses.first_sync_error` (returned by `GET /api/courses` through its `SELECT *`).
- Produces: `currentCourseIds(db, { includeHidden }) → number[]` exported from `syncOrchestrator.js` (the query now in `coveredCourseIds`).
- Produces: `runUnifiedSync` accepts `masteryCourseIds: null`, meaning "the current courses after the section phase".

- [ ] **Step 1: Failing tests.** `sync.test.js` (with the file's existing Schoology mocks): a section new to the database is inserted with `first_sync = 'pending'` and cleared to NULL after its `syncSectionData` succeeds; a new section whose `syncSectionData` throws ends `first_sync = 'failed'` with the message, a warning log line `Could not sync "<course title>": <message>`, and the run continues to the next section and returns normally; an existing row (no mark) whose section throws still fails the run as today; when `fullSync` throws after inserting (e.g. a later existing section fails), every row still `'pending'` becomes `'failed'` with `first_sync_error = 'The sync stopped before this course.'`; existing rows never get a mark. `syncOrchestrator.test.js`: with `masteryCourseIds: null` the mastery phase runs for the current courses present after `fullSync` (insert one in the `fullSync` mock). `syncQueue.test.js`: a `kind: 'all'` request passes `masteryCourseIds: null` to `runUnifiedSync`; a `kind: 'courses'` request still passes its list.
- [ ] **Step 2: Run** `npx vitest run server/services/sync.test.js server/services/syncOrchestrator.test.js server/services/syncQueue.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `fullSync`, insert new rows with `first_sync = 'pending'` (the `ON CONFLICT … DO UPDATE` leaves the column alone); wrap `syncSectionData` in try/catch only for rows whose `first_sync` is not NULL; the catch path rethrows for unmarked rows. The "stopped before" sweep goes in `fullSync`'s catch before the rethrow.
- [ ] **Step 4: Run** the same command, then `npx vitest run` at the root. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sync): mark a course until its first sync finishes; mastery for courses a run discovers (#171)`.

### Task 5: Past-course import queue

**Files:**
- Create: `server/services/archivedImport.js` (`importArchivedCourse`, moved out of `server/routes/courses.js` `POST /import`), `archivedImport.test.js`
- Modify: `server/routes/courses.js` (`POST /import` calls it; same responses), `courses.test.js` stays green
- Create: `server/lib/schoolYear.js`, `schoolYear.test.js`
- Create: `server/services/pastImport.js`, `pastImport.test.js`
- Create: `server/services/archivedImportRun.js` (the queue's runner for `{ kind: 'import' }`, modelled on `quizLoadRun.js`)
- Modify: `server/services/syncQueue.js` (`import` kind; `onRunFinished`), `syncQueue.test.js`; `server/services/syncRuns.js` (`isSmallRun` includes `'import'`); `client/src/lib/syncRunLog.js` (label `Past course import`) and its test
- Modify: `server/index.js` (call `startPastImport({ db })` after `markInterruptedRuns`); `server/routes/schoology.js` (`GET /api/sync/status` adds `pastImport`)

**Interfaces:**
- Produces: `importArchivedCourse(db, sectionId: string) → { course, studentsCount, assignmentsCount, gradesCount }` (throws as the route's errors do today).
- Produces: `academicYearStart(gradingPeriod: string|null) → number|null` (same rules as `parseAcademicYear` in `client/src/lib/courseDisplay.js`; a comment names that twin).
- Produces: `PAST_IMPORT_KEY = 'firstRun.pastImport'`; state JSON `{ state: 'waiting'|'importing'|'done', total, sectionIds: string[], failed: string[], retried: boolean }`.
- Produces: `markPastImportDue(db)` (sets `waiting` only when no state exists); `pastImportStatus(db) → { state: 'none'|'waiting'|'importing'|'done', done: number, total: number }` (done = total minus sections still missing from `courses`); `continuePastImport({ db, discover = getArchivedSections, enqueue })` (async); `startPastImport({ db })` registers the queue listener and calls `continuePastImport` once when the state is `importing`.
- Produces: queue request `{ kind: 'import', sectionId: string, trigger: 'page' }`; `onRunFinished(listener: (request, status) => void): () => void` exported from `syncQueue.js`, called after every finished (not held) run.

- [ ] **Step 1: Failing tests.** `schoolYear.test.js`: `'2024-2025: …'` → 2024; `'22-23 YR'` → 2022; `'Semester 1: 08/14/2025 - 01/11/2026'` → 2025; null → null. `pastImport.test.js` (in-memory db as other service tests build it; `discover` and `enqueue` injected): no state → `continuePastImport` does nothing (prod); `waiting` + discover null (no session) → stays `waiting`, nothing queued; `waiting` + discover list → `importing`, sections already in `courses` and ones with no course code dropped, ordered newest `academicYearStart` first (unknown last, page order kept within a year), exactly one `import` request queued for the first; after an import run, the next missing one is queued; a section still missing after its run goes to `failed` and the next is queued; when none remain, the failed ones are queued once more (`retried: true`), then `done`; resume: state `importing` with two of five already in `courses` queues the third, never the first two. `syncQueue.test.js`: an `import` request covers nothing and joins only an `import` for the same `sectionId`; it records no attempt stamp; `onRunFinished` fires once per finished run with its request and status, not for a held run. `archivedImport.test.js`: the moved behaviour (upsert archived row, finalize, enrich, block resolve best-effort) with the existing mocks moved from `courses.test.js` where they belong.
- [ ] **Step 2: Run** `npx vitest run server/lib/schoolYear.test.js server/services/pastImport.test.js server/services/syncQueue.test.js server/services/archivedImport.test.js server/routes/courses.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** The listener continues the import after an `import` run, and after a `kind: 'all'` run while the state is `waiting`. `pastImport.js` imports `enqueue`/`onRunFinished` from `syncQueue.js`; `syncQueue.js` imports only `archivedImportRun.js` (no cycle). Add `runPastImport` to `queueDeps`.
- [ ] **Step 4: Run** the same command, then `npx vitest run` at the root and `cd client && npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sync): import past courses in the background after a first run (#171)`.

### Task 6: First run trigger and the dashboard's progress

**Files:**
- Modify: `server/services/syncQueue.js` (`ensure`), `syncQueue.test.js`
- Modify: `client/src/pages/Dashboard.jsx`, `Dashboard.test.jsx`; `client/src/app.css` if a class is needed

**Interfaces:**
- Consumes: Task 4's `first_sync`; Task 5's `markPastImportDue`, `pastImportStatus` (via `useSyncFacts().pastImport`).
- Produces: `ensure({ kind: 'all' })` on a database with no `courses` row → `markPastImportDue(db)` and enqueues `{ kind: 'all', trigger: 'page' }` (so `syncBlocks` defaults on); returns its state and runId.
- Produces: in `ensure`, an active `kind: 'all'` entry (not `skipSchoology`) covers the courses `coveredCourseIds(entry.request)` returns **now**, not its enqueue-time list (a first run's list was empty).

- [ ] **Step 1: Failing tests.** `syncQueue.test.js`: empty `courses` → `ensure` queues a `kind: 'all'` run and the past-import state becomes `waiting`; a database with any course row (archived included) → today's behaviour, no past-import state; while that first run is running and has inserted courses, `ensure({ kind: 'all' })` and `ensure({ kind: 'courses', courseIds: [<a new course>] })` follow it and queue nothing. `Dashboard.test.jsx`: Current tab hides courses with `first_sync: 'pending'`; while any is pending shows `Getting your courses: 4 of 12` (12 = non-excluded current courses, 4 = those not pending); a `first_sync: 'failed'` course shows with a `Sync failed` badge and links to its page; while pending courses exist the dashboard re-fetches courses every 3 seconds (fake timers) and stops when none are pending; no courses and a held run → the empty state reads `Your courses appear here once you log in to Schoology.` beside the existing chip; no courses and a running run → `Getting your courses…`; no courses, nothing running → `No courses yet. Press Sync Courses to get your courses.`; Archived tab with `pastImport.state === 'importing'` shows `Importing past courses: 7 of 30`, polls the status every 5 seconds and reloads the archived courses when `done` changes; with `state` `done` or `none`, no line.
- [ ] **Step 2: Run** `npx vitest run server/services/syncQueue.test.js` and `cd client && npx vitest run src/pages/Dashboard.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** `oldestSynced` ignores pending courses. The Synced line may read "Not synced yet" during a first run; that is correct.
- [ ] **Step 4: Run** both whole suites. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sync): first run shows courses as they sync (#171)`.

### Task 7: Docs, live checks and close-out

**Files:** `.claude/build-progress.md`, `docs/design-language.md` (first-run lines), `CONTEXT.md` (first run, past-course import), `docs/deploy.md` if it describes Sync Courses, `AGENTS.md` if it names the dialog; any doc that a grep for `SyncConfig`, `course list`, `Sync from PowerSchool`, `sidebar` + `Sync Courses` finds.

- [ ] **Step 1:** Grep code, client, tests and docs for the old wording above; fix every hit.
- [ ] **Step 2:** `npx vitest run` (root), `cd client && npx vitest run`, `npm run build`. Expected: all pass.
- [ ] **Step 3: Live first run.** `DB_PATH=<scratchpad>/first-run.db PORT=3002 npm run dev` (preflight must pass), open the dashboard: courses appear one by one with `Getting your courses: N of M`, then the Archived tab shows `Importing past courses`. Then `npm run check:mobile http://127.0.0.1:<vite port>`. Stop with `npm run dev:stop`; delete the scratch database trio and any screenshots.
- [ ] **Step 4:** Commit docs; merge to `main` (fast-forward), push; CI green on that commit; `curl -s 127.0.0.1:3001/api/version` on the mini shows it; on prod the nightly line shows the last 03:00 read.
- [ ] **Step 5:** Comment on #171 with commits and evidence, close it; open issues for any follow-up.
