# On-demand submission reads

Date: 19 Oct 2026. Issues: #108 (on-demand refresh), the base for #58 (Simplify Sync).

## Intent

Triage told Graham to chase a student who had already submitted. Prism's submission data is as old as
the last full sync: the nightly one at 03:00, or a manual one. The fix is the pattern #52 used for
mastery: a page shows what Prism holds at once, then reads what it shows from Schoology in the
background and updates itself.

This is the next step towards the direction recorded on #108 (owner call, 8 Jun 2026): Schoology data
read on demand, the nightly sync as the catch-all.

## Measured baseline (#108)

Full sync on prod, run 20, 19 Oct 2026 23:13 HKT, all plain HTTP, no browser (`sync_runs.summary_json`):

| Phase | Time |
|---|---|
| Schoology (10 sections, 2,566 records) | 91.5 s |
| Comments (7 assignments, 59 threads) | 39.4 s |
| Mastery (9 courses) | 16.2 s |
| Alerts | 6.3 s |
| Blocks | 5.6 s |
| Total | 2 min 39 s |

- **One section** takes 2 to 17 s in the Schoology phase; the two AP CSP sections are the slowest.
- **Run 19 (425 s)** included the one-time read of 25 archived courses' submissions (`8a6ca27`); all 25
  are stamped, so later runs do not repeat it.
- **Triage on prod at the same time:** 9 late items, 2 make-ups, 5 resubmissions, 5 feedback-owed tasks.

## Goals

1. **Dashboard.** After the dashboard loads, Prism re-reads the submissions **and the scores** of every
   task on its lists (late work, make-ups, resubmissions, feedback owed), plus past-due tests whose
   attempts are unchecked, then reloads the lists. A student who has submitted, or whom Graham has
   scored in Schoology, leaves the late list with no action from Graham, and a task he has graded leaves
   feedback owed (Graham, 19 Oct 2026: "scores too").
2. **Assessment page.** Its load-time refresh and its Refresh from Schoology button also read that
   task's submissions, not only scores and comments.
3. **Course page.** After it loads, it reads in the background the submissions of the course's tasks in
   the recent window, plus every task in the course's own triage panel (which can list tasks older than
   the window), and the scores of the triage panel's tasks. *(My call: the panel must not stay stale on
   the page that shows it.)*
4. **One line of freshness** on each of these pages: when submissions were last read from Schoology, or
   why the read failed (with the Settings sign-in link when the session has lapsed), as
   `MasteryFreshness` does now.

## Non-goals

- **Submission comment threads** (the sync's Comments phase). Graham named new submissions as the
  stale data; threads can follow with the same mechanism later.
- **#58's renames and the single "last synced" stamp.** This design adds the reads #58's Sync Course
  and Sync Assignment buttons will use; the renames are a separate step.
- **PrisMCP.** It reads SQLite directly and cannot call the refresh (#131). Its `get_triage` keeps
  reading what Prism holds.
- **Removing the nightly sync.** It stays the full catch-all.

## Anti-goals

- **A slow page.** Every read is in the background. The page renders from the database first and
  never waits for Schoology.
- **A wrong "not submitted".** A submission is cleared only by a read that finished in full; a failed
  native read leaves the task as it was.
- **Make-ups that vanish.** A read started by a page leaves the stored `lti_fetch_status` and
  `test_fetch_status` as they were when it fails, and reports the error (with the sign-in link when the
  session has lapsed). Otherwise one lapsed session would remove every known make-up from the dashboard,
  since `getTriage` lists make-ups only for tests whose status is `'ok'`. The full sync keeps its rule
  (record `'failed'`). The shared function takes this as an option. *(My call.)*
- **Two code paths.** The refresh and the full sync use the same function for one task's submissions,
  so they cannot disagree.
- **Load on Schoology from page visits.** A task read in the last 2 minutes is not read again, and two
  pages asking for the same task share one read.

## The design

### One task's submissions: one function

Extract from `syncSectionData` (`server/services/sync.js`) a function that reads the submissions of a
given list of tasks in one section and writes them:

- **Native dropbox:** one bulk `getAssignmentSubmissions(sectionId, assignmentId)` per task, written
  with the existing upsert and clear statements (`deriveNativeSubmission`).
- **OneDrive (LTI) tasks:** `reader.fetchDocuments(assignmentId)` with the existing retry, state
  writes, `lti_fetch_status` and `recordSchoologyUnsubmit`.
- **Tests:** `reader.fetchTestAttempts` through `syncTestAttempts`.

`syncSectionData` calls it for its windowed task list, so the full sync's behaviour is unchanged. The
function returns the ids it read in full (`revisionsRead`) and the ones that failed.

**The roster comes from the database** (current enrolments, `dropped_at IS NULL`, with their stored
`schoology_enrolment_id`), not a new enrolment read. A roster change reaches Prism at the next full
sync. (Builder's call to confirm: if the extraction is cleaner with the enrolment read kept, one extra
request per section is acceptable.)

**The task's metadata comes from the database** (`assignments` row: `schoology_assignment_id`,
`assignment_type`, `allow_dropbox`, type). Prism needs the columns that tell native dropbox, LTI and test
apart; add any that are missing to `schema.sql` and the `MIGRATIONS` array, filled by the sync.

### The stamp

New column `assignments.submissions_read_at` (ISO time), in `schema.sql` and `MIGRATIONS`. Set for a
task when its read finished in full: by the refresh and by the full sync. It is the freshness test and
the time shown on the page.

### The service: `server/services/submissionRefresh.js`

Modelled on `masteryRefresh.js` (same `FRESH_MS` of 2 minutes, same shared-read map, same `force`):

- **`refreshAssignmentSubmissions(courseId, assignmentId, { force })`** reads one task.
- **`refreshSubmissionsFor(tasks, { force })`** reads a list of tasks: skips the fresh ones, groups the
  rest by section, opens one session reader (`createSubmissionFetcher`) for the batch and closes it
  after, and reads with a small concurrency (about 4). A task already being read is shared, not read
  twice.
- **After a read:** `captureFeedbackSnapshots(db, { revisionsRead, ... })` and
  `settleResubmissions(db, { courseId })` for each course touched, as the full sync does, so a
  resubmission that arrived is recorded and settled.
- **With no saved session:** native dropbox tasks are still read (the public API needs no session).
  OneDrive and test tasks are left as they are, and the answer states that a sign-in is needed, as
  `masteryRefresh` does with `signIn: true`.
- **Answer:** `{ refreshed: <count read>, readAt, failed: [...], error?, signIn? }`. `readAt` for a
  list is the oldest `submissions_read_at` among its tasks, so the page never claims a fresher read than
  its stalest task.

### Scores for the listed tasks

- **Aligned tasks:** `refreshAssignmentMastery` (`masteryRefresh.js`), the read the assessment page
  already uses (about 2 to 3 s per task, needs the session). Its stamp and 2-minute freshness apply.
- **Tasks with no alignment:** their scores come from the section-wide public grades read
  (`getSectionGrades`). Probe first whether the public API filters that read to one task
  (`/sections/{id}/grades?assignment_id=`); document what the probe shows in
  `.claude/schoology-api-reference.md`, and use it if it answers. Otherwise, read the section's
  grades once per section touched (one request over the public API) and write only the listed tasks' rows.
  Either way, use the same write rules as the sync's grades step (extract them, as for submissions).
- **Order:** submissions first, then scores, then one reload of the lists.

### Routes

- **`POST /api/triage/refresh`** (optional `courseId`): takes the task ids from `getTriage`'s
  `lateWork`, `makeUps`, `resubmissions` and `feedbackOwed`, plus past-due tests whose
  `test_fetch_status` is not `'ok'` (the `makeUpsUnchecked` count; one test-attempt request per section
  covers them), then reads their submissions and scores. The course page calls it with its `courseId`
  for its triage panel. *(Unchecked tests: my call.)*
- **Assessment page:** the existing assignment refresh (`POST /api/mastery/:courseId/assignment/:id/refresh`
  and its forced `/sync`) also calls `refreshAssignmentSubmissions`. Builder's call whether this is one
  route doing both or a second request from the page.
- **`POST /api/courses/:id/submissions/refresh`** (path is the builder's call): reads the course's tasks
  in the full sync's recent window (`filterRecentAssignments`, 30 days, plus tasks with an open
  resubmission request).

All are `POST`, so the origin guard already covers them.

### Client

- **A hook** like `useMasteryRefresh` (generalise it, or a sibling `useSubmissionRefresh`): starts the
  refresh once the page's data is loaded; when `refreshed > 0`, reloads the page's data.
- **Dashboard:** the triage lists reload after the refresh. One line near the lists: "Submissions read
  from Schoology at 23:20", or the error. Same component pattern as `MasteryFreshness`
  (generalise it or add a sibling).
- **Assessment and course pages:** the same, beside the existing mastery line, or one line covering
  both reads. Builder's call; record the choice in `docs/design-language.md`.

## Verification

- **Unit tests** beside each new module, with the Schoology calls injected (the sync tests' pattern):
  fresh tasks skipped; shared reads; a failed read leaves submissions as they were; no session reads
  native tasks only and sets `signIn`; the stamp set only after a full read.
- **The full sync's existing tests pass unchanged** after the extraction.
- **Parity on a database copy** (`scripts/parity-*.js` pattern): refresh the dashboard's tasks on a copy
  of the prod database, then compare those tasks' `grades` rows with a full sync's on a second copy.
  Expected: no differences. Delete both copies after.
- **Unit tests for the failure rule:** a failed page read leaves `test_fetch_status` and
  `lti_fetch_status` unchanged; a failed sync read still records `'failed'`.
- **Timing on prod after deploy:** the dashboard refresh's wall time, recorded on #108.
- **Every suite, the client build, CI green, prod serving the commit** (AGENTS.md, Definition of done).

## Left to the builder

The file split inside `sync.js`, the concurrency number, the route paths marked above, whether to
generalise the mastery hook and freshness component or add siblings, and the wording of the freshness
line (no em dashes in UI copy).
