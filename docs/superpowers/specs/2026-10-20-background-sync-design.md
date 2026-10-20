# Background sync: everything, or nothing

Date: 20 Oct 2026. Follows #58 (shipped `4aaebb8`); closes #168 and #169. Supersedes the partial page
reads of #52 and #108 on the dashboard, course, assessment and student pages.

## Intent

Graham, 20 Oct 2026: "Confidence comes from not having to second guess the data." A partial read
looks the same as a full one to a teacher, so Prism shows only the results of full syncs:

- **Always sync everything.** Mastery is part of every sync; when the Schoology session is down,
  ask for a sign-in, then sync.
- **One time per page.** "Synced 10:05 today" is the only freshness the teacher sees. The second
  line ("Checked for new work at …") goes.
- **Sync in the background,** with a visible indicator that opens the progress dialog.

## Decisions (Graham, 20 Oct 2026)

- **Window: 10 minutes.** Opening a page whose scope was last synced more than 10 minutes ago starts
  a background sync of that scope.
- **Dashboard:** a full sync of every current course on the same 10-minute rule (courses already
  synced in the window are left out). A course page opened meanwhile waits its turn.
- **Comment threads** in Sync Assignment stay started-not-awaited (kept from #58).
- **No partial options:** "Include only recent submissions" (Sync Courses dialog, nightly settings)
  and the nightly "mastery: none" setting are removed. Every sync reads everything.

## Scopes and costs (measured 19 to 20 Oct 2026)

| Page | Scope | Full sync |
|---|---|---|
| Dashboard | every current course | 138 s (prod, 9 courses) |
| Course | one course | about 37 s (copy of prod, AP CSP) |
| Assessment | one task | 4.2 s (copy of prod) |
| Student | the student's current courses | one course sync each |

## Goals

1. **One queue of syncs on the server.** Every sync (the nightly run, Sync Courses, Sync Course,
   Sync Assignment, and the pages' background syncs) is a queued request. One runs at a time. A
   request whose scope a queued or running request already covers joins it instead of queueing
   twice. Closing a dialog never cancels a queued request.
2. **Background syncs.** The dashboard, course, assessment and student pages ask the server to sync
   their scope after they load. The server does so only when the scope's oldest stamp is over 10
   minutes old (or missing); otherwise it answers "fresh".
3. **Everything or nothing.** Before a request that reads Schoology starts, the server checks the
   session (one cheap request, renewing it when possible). When the session is down, the request
   waits: it is held as "needs sign-in", and the pages show **Log in to Schoology**. After the
   sign-in, held requests run.
4. **Stamps only for complete syncs.** `course_synced_at` is set only when the course's Schoology
   data, every submission read, its comment threads and its mastery all succeeded.
   `task_synced_at` likewise for a task (its submissions, grades and mastery). A failure leaves the
   older time.
5. **One indicator per page.** `SyncStatus` shows "Synced 10:05 today" (amber when over a day old or
   never) and, while the page's scope is queued or syncing, a "Syncing…" or "Waiting to sync…" chip.
   Clicking the chip opens the progress dialog on that run. A failed sync shows "Sync failed" on the
   chip (the dialog has the reason); a held one shows **Log in to Schoology**. The Sync button stays
   (it forces a sync now, whatever the window).

## Calls made after the builder check (mine)

- **A failing scope waits too.** New columns `courses.sync_attempted_at` and
  `assignments.task_sync_attempted_at` (schema + MIGRATIONS), set when a sync of it ends either way.
  `ensure` compares the later of the success stamp and the attempt stamp with the window, so a
  course whose mastery keeps failing is tried at most every 10 minutes. The chip then shows "Sync
  failed"; the button forces a retry.
- **Buttons:** a button request never joins a running request (it may have read the course before
  the teacher's change); it may join a queued one, and goes ahead of queued page requests (behind
  the running one). Sync Assignment becomes a queued request too: the button shows the chip, the
  page reloads when it ends, and a removed task shows the "deleted in Schoology" notice from the
  reloaded data (`removed_at`).
- **Session states:** `expired` and `none` hold the request; `unknown` (Schoology not reached) runs
  it, and it fails visibly. A request whose mastery read fails with a sign-in error mid-run is held
  and re-queued after the sign-in.
- **Archived courses:** synced only by the button (their data is frozen); their label is never
  amber. The button still re-reads them in full.
- **Background syncs** are full (every task's submissions) with PowerSchool off.

## The design

### Server

- **The queue** (`syncRunner.js`): a FIFO of requests `{ scope, options, trigger, force }` plus the
  running one. `scope` is `{ kind: 'all' }` (every current course), `{ kind: 'courses', ids }` or
  `{ kind: 'task', courseId, assignmentId }`. A new request is joined to a queued or running one
  when that one's scope covers it: `all` covers every current course and task; `courses` covers
  those courses and their tasks; a recent-only or `skipSchoology` run covers nothing for this
  purpose. `GET /api/sync/current` returns the running request and the queue (with each request's
  covered course ids). Each request becomes a `sync_runs` row when it starts, as now; `trigger` is
  `page`, `button` or `scheduled`.
- **Freshness** (`POST /api/sync/ensure { scope }`): answers `{ state: 'fresh' | 'queued' | 'running'
  | 'needs_sign_in', runId? }`. Fresh = every course in scope has `course_synced_at` (or the task has
  `task_synced_at`) within 10 minutes. Otherwise it queues (or joins) a request.
- **Session preflight:** `sessionStatus({ refresh: true })` before a request with Schoology reads
  starts. Not live → the request moves to a held list; `POST /api/sync/resume` (called by the page
  after sign-in, and by the sign-in itself) re-queues held requests. The nightly run is exempt (no one
  can sign in at 03:00): it reads what it can, and its incomplete courses keep their older times.
- **Task syncs in the queue:** Sync Assignment's work (`assignmentSync.js` plus the assignment's
  mastery read) runs as a queued request of scope `task`, so it never interleaves with a course sync.
- **Stamps:** `fullSync` stamps a course only after the mastery and comment phases succeeded for it
  (the orchestrator passes the per-course outcome back); a task only when its submissions, grades and
  (if aligned) mastery succeeded.
- **Retired:** `POST /api/triage/refresh`, `POST /api/courses/:id/refresh` and the pages' use of the
  mastery `/refresh` routes. `refreshTasks` stays as Sync Assignment's submission and grade reader.
  `masteryRefresh.js` stays for PrisMCP's `get_assignment_context`.

### Client

- **`SyncStatus`** loses the check line; gains the chip (state from `POST /api/sync/ensure` on load,
  then `GET /api/sync/current` polled every 2 s while queued or running; stops when done and
  reloads the page's data).
- **Dialog on demand:** the chip opens `SyncDialog` following that run (join), never starting one.
  Sync Course and Sync Courses still open it as now.
- **Pages:** dashboard (scope all, its own `SyncStatus` beside the triage rail heading, time = the
  oldest current course), course, assessment, student (scope = the student's current courses, time =
  the oldest of them). The `useMasteryRefresh` uses on these pages and the triage rail's refresh go.

### #168 and #169

- **#168:** the page-versus-sync overwrite, the shared reader's single recheck and the silent
  submissions failure on the assessment page go with the partial reads. The deleted-task question is
  moot: a task sync reads the task's REST record first (404 = removed, verified on current sections).
- **#169:** joining uses the server's covered-course list (`all` excludes hidden courses unless the
  run includes them; `skipSchoology` covers nothing); a ticked archived course's comment threads are
  read and its mastery failure is reported (and withholds its stamp); the one-time backfills skip a
  course the list reads; closing a dialog never drops a queued request (the queue is on the server).

## Non-goals

- **PrisMCP** keeps reading SQLite (and `get_assignment_context` its own mastery refresh).
- **PowerSchool** blocks, alerts and calendar stay in the nightly run and the Sync Courses box.

## Verification

- Tests: the queue (join by cover, FIFO, held on a dead session, resume), `ensure` (fresh, queue,
  join), stamps only on complete syncs, the chip states and the dialog on click.
- Live on a dev server over a copy of prod: open a course page (background sync starts, chip, then
  "Synced"); open it again within 10 minutes (no sync); open the dashboard (all courses queue; a
  course page opened meanwhile shows "Waiting to sync…"); a session made unusable in the copy shows
  **Log in to Schoology** and runs nothing.
- Every suite, the build, CI, prod serving the commit.
