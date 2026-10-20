# Sync, simplified: one button, one signal, a first run

Date: 20 October 2026. Status: design, for Graham's approval. Follows background sync (`2026-10-20-background-sync-design.md`) and #131.

## Intent

Graham, 20/10/2026: teachers, including ones new to Prism, should understand that they are looking at
up-to-date data "without having to think too hard". The master Sync Courses dialog asks them to choose
courses and a PowerSchool option they should never need to think about.

What a teacher who never presses a sync button misses today (checked in the code, 20/10/2026):
- **PowerSchool waits for the 03:00 run.** Block numbers, the school calendar and student alerts are read
  only at night (`syncBlocks` is true only for the nightly run and a ticked dialog).
- **A failed or skipped nightly run is invisible** outside Settings.
- **Hidden courses** refresh only when opened; **archived courses** only by their own button (Graham's
  choice, kept).
- **A brand-new install shows nothing until 03:00:** the dashboard's background sync covers the courses
  already in the database, and an empty database has none.

Everything else (new sections, archiving ended courses, students, grades, submissions, threads, mastery)
already refreshes in the background within 10 minutes of opening a page.

## Decisions Graham made (20/10/2026)

1. **Remove the master Sync Courses dialog** (the course-ticking list) and the sidebar button. The
   dashboard's **Sync Courses** syncs everything for current courses in one click, PowerSchool included.
2. **A PowerSchool line on the dashboard**, amber when the nightly read is over a day old.
3. **A help "?" beside the Synced time** with this text (the button name follows the page):
   > Prism keeps this up to date for you.
   > - Schoology: refreshed when you open a page, if older than 10 minutes.
   > - PowerSchool (blocks, calendar, alerts): refreshed every night.
   > Press Sync Courses only if you changed something in Schoology just now.
4. **First run, built now:** the first sign-in on an empty install syncs current courses first, then
   imports past courses in the background, newest year first, while the teacher works.
5. **A course appears when its sync finishes.** A course whose sync fails still appears, with "Sync
   failed" on its card, so it is never silently missing. A line shows "Getting your courses: 4 of 12"
   until all are in.

## How it works

### The dashboard's Sync Courses

- One click queues a button run of every current course with the PowerSchool pass and quiz refresh: the
  same scope as the nightly run (`kind: 'all'`, `syncBlocks: true`, `refreshQuizzes: true`, hidden
  courses as the nightly setting says). The chip shows its progress and opens the progress dialog, as now.
- The progress dialog stays (following a run, the held sign-in view, the per-phase log). Its retry buttons
  stay: they queue a mastery-only or PowerSchool-only run.
- **Removed:** the sidebar Sync Courses button, `SyncConfig` (the course list and the PowerSchool box),
  the dialog's config mode and `group` prop. Course, assessment and student pages keep their own buttons.

### The PowerSchool line

- **Source:** the time of the last PowerSchool pass that finished without error (a new stamp, written by
  the orchestrator when the blocks phase completes).
- **Text:** `PowerSchool: read 03:01 today` (time via `freshnessTime`).
- **Amber** when that time is over 26 hours old, with the reason: `PowerSchool: last read 2 days ago. The
  nightly sync did not run.` When the last PowerSchool pass failed, name it: `PowerSchool could not be
  read last night.` Pressing Sync Courses reads it.
- **Where:** the dashboard header, under the Synced line. Its own help "?" is the same text as above.

### The help "?"

- The shared `.help-dot` + `.help-pop` primitive (docs/design-language.md), beside every Synced time
  (dashboard, course, assessment, student page). The last line names that page's button: Sync Courses,
  Sync Course or Sync Assignment.

### First run

- **When:** the dashboard finds no course in the database (a new install, or a restored empty database),
  and the Schoology session works. With no session it shows the existing sign-in prompt first.
- **Current courses:** a full discovery run (`courseIds: null`, PowerSchool included). The dashboard lists
  a course once its own sync has finished, successfully or not (`course_synced_at` or `sync_attempted_at`
  set). A line above the courses reads `Getting your courses: 4 of 12` while the run is going (the run
  reports how many sections it found and how many it has finished).
- **Past courses, after:** a background import queue: discover archived sections (the existing
  `getArchivedSections`), then import each not yet in the database, newest school year first, one queue
  run per course. The Archived tab shows `Importing past courses: 7 of 30` while it runs. It runs once per
  install: a stamp records that the import finished, and an interrupted import resumes with the courses
  still missing.
- **The rule "a course appears when its sync finishes" applies from then on too:** a new section that
  appears mid-year (a new semester) shows once its first sync is done.

## Non-goals

- Changing the nightly schedule or its Settings controls.
- Syncing hidden courses in the background (each hidden course's page has its button).
- A login or accounts (#167 keeps that).

## Anti-goals

- A course silently missing because its sync failed.
- A help text that promises more than Prism does ("live", "always current").
- A first run that blocks the teacher for minutes before showing anything.

## Verification

- Server and client tests for each part, root and client suites, build, CI, prod serving the commit.
- Live on prod: the PowerSchool line shows the last nightly read; one-click Sync Courses reads PowerSchool.
- First run, live on a dev server with an empty database and the mini's Schoology session: current courses
  appear one by one with the progress line, then past courses import in the background. The dev
  database is deleted afterwards.
- `npm run check:mobile` against the dev server: the dashboard header with the new line and "?" at phone
  width.

## Left to the builder

- The stamp's storage (a settings row or a column), and how the run reports found and finished counts.
- The queue run kind for a past-course import, and its retry on failure.
- Exact layout of the PowerSchool line at phone width, within the PHONE LAYOUT block.
