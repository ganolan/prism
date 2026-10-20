# Sync, simplified: one button, one signal, a first run

Date: 20 October 2026. Status: approved by Graham, 20/10/2026; builder check done, answers below. Follows background sync (`2026-10-20-background-sync-design.md`) and #131.

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
2. **A nightly-data line on the dashboard**, amber when the nightly read is over a day old (wording in
   decision 6).
3. **A help "?" beside the Synced time.** Graham's first wording named the two systems; decision 6
   replaced the bullets. The approved text (the button name follows the page):
   > Prism keeps this up to date for you.
   > - **Courses, students, grades and submissions:** refreshed when you open a page, if older than 10 minutes.
   > - **Blocks, calendar and alerts:** refreshed every night.
   >
   > Press Sync Courses only if you changed something in Schoology just now.
4. **First run, built now:** the first sign-in on an empty install syncs current courses first, then
   imports past courses in the background, newest year first, while the teacher works.
5. **A course appears when its sync finishes.** A course whose sync fails still appears, with "Sync
   failed" on its card, so it is never silently missing. A line shows "Getting your courses: 4 of 12"
   until all are in.
6. **Name the data, not the system** (Graham, later on 20/10/2026): "Teachers might not know or care
   about the difference between PowerSchool and Schoology. What they care about is the data that is
   refreshed by each sync. We need them to trust what they're seeing so a very concise way to educate and
   reassure them is the best way to do this." The freshness line and the help "?" name the data each
   refresh covers and when, never the system it comes from. Graham chose (question tool, 20/10/2026):
   - **Keep "Synced"** as the first line on every page, and add a second dashboard line for the nightly
     data: `Blocks, calendar and alerts: 03:01 today`. The "?" explains what each line covers.
   - **The amber line states only what to do,** one wording for a missed night and a failed one:
     `Blocks, calendar and alerts: 2 days old. Press Sync Courses to refresh them.` The reason stays in
     Settings, Recent syncs. (This replaces his earlier "name a missed or failed night".)

## How it works

### The dashboard's Sync Courses

- One click queues a button run of every current course with the PowerSchool pass and quiz refresh: the
  same scope as the nightly run (`kind: 'all'`, `syncBlocks: true`, `refreshQuizzes: true`, hidden
  courses as the nightly setting says). The chip shows its progress and opens the progress dialog, as now.
- The progress dialog stays (following a run, the held sign-in view, the per-phase log). Its retry buttons
  stay: they queue a mastery-only or PowerSchool-only run. The dialog may name PowerSchool: it is the
  detailed view a teacher opens when something failed, and the sign-in it asks for is PowerSchool's.
- **Removed:** the sidebar Sync Courses button, `SyncConfig` (the course list and the PowerSchool box),
  the dialog's config mode and `group` prop. Course, assessment and student pages keep their own buttons.
- **The Archived tab has no Sync Courses button** (archived courses refresh only by their own button,
  Graham's earlier choice). It keeps its Synced time, never amber, and its "?".

### The nightly-data line

- **Source:** a new stamp, the time of the last PowerSchool pass in which blocks, calendar and alerts all
  finished without error. Courses that PowerSchool has not published yet (`notReady`) are not an error.
  Written by the orchestrator at the end of that pass, whichever run made it (nightly, button, retry).
- **Text:** `Blocks, calendar and alerts: 03:01 today` (time via `freshnessTime`); `Blocks, calendar and
  alerts: not read yet` before the first pass.
- **Amber** when the stamp is over 26 hours old or missing: `Blocks, calendar and alerts: 2 days old.
  Press Sync Courses to refresh them.` The same wording whether the night was missed, failed, or the
  nightly run is off.
- **Where:** the Current tab of the dashboard header, under the Synced line. The Synced line's "?" covers
  both lines.

### The help "?"

- The shared `.help-dot` + `.help-pop` primitive (docs/design-language.md), beside every Synced time
  (dashboard, course, assessment, student page), with the text in decision 3. The last line names that
  page's button: Sync Courses, Sync Course or Sync Assignment.
- **When the nightly run is off, or its PowerSchool option is off** (Settings), the second bullet reads
  `Blocks, calendar and alerts: refreshed when you press Sync Courses.` on the dashboard and
  `... when you press Sync Courses on the dashboard.` elsewhere, so it never promises a night that does
  not happen.

### First run

- **When:** the dashboard finds no course in the database (a new install, or a restored empty database),
  and the Schoology session works. With no session it shows the existing sign-in prompt first.
- **Current courses:** a full discovery run (`kind: 'all'`, `courseIds: null`, PowerSchool included).
  The dashboard lists a course once its first sync has finished, successfully or not. A line above the
  courses reads `Getting your courses: 4 of 12` while the run is going (the run reports how many
  sections it found and how many it has finished).
- **Past courses, after:** a background import queue: discover archived sections (the existing
  `getArchivedSections`), then import each not yet in the database, newest school year first, one queue
  run per course. The Archived tab shows `Importing past courses: 7 of 30` while it runs. It runs once per
  install: a stamp records that the import finished, and an interrupted import resumes with the courses
  still missing.
- **The rule "a course appears when its sync finishes" applies from then on too:** a new section that
  appears mid-year (a new semester) shows once its first sync is done.

### What "its first sync has finished" means (builder check)

- **The course's section read**, not the whole run. `runUnifiedSync` runs one phase at a time across all
  courses (sections, PowerSchool, mastery, comments, quizzes) and stamps `course_synced_at` only at the
  end, so waiting for the full stamp would show every course at once. After its section read a course
  has its students, assignments and grades; mastery and comments follow in the same run.
- **Mechanism:** a course row created by discovery is marked as waiting for its first sync. `fullSync`
  clears the mark when that section's read finishes, or records the error when it fails. The dashboard
  hides a current course while it is marked, and shows "Sync failed" on its card when its first read
  failed. Rows that exist today carry no mark, so nothing on prod disappears and no backfill is needed.
- **"Sync failed" on a card means the first read failed,** not a later partial failure (a mastery or
  comment-thread error). Later failures already show in the chip and the progress dialog.
- **Mastery on a first run:** a `kind: 'all'` request fixes its mastery course list when it is queued,
  which is empty on an empty database. A `kind: 'all'` run takes its mastery list after its section phase,
  so it includes sections discovered in that run (first run and a new mid-year section alike).

## Non-goals

- Changing the nightly schedule or its Settings controls.
- Syncing hidden courses in the background (each hidden course's page has its button).
- A login or accounts (#167 keeps that).
- Removing "PowerSchool" from provenance labels (alert badges "From PowerSchool, read ...", Settings,
  the CSV import page): there the source is the fact the teacher needs.

## Anti-goals

- A course silently missing because its sync failed.
- A help text that promises more than Prism does ("live", "always current", a nightly refresh that is off).
- A first run that blocks the teacher for minutes before showing anything.

## Verification

- Server and client tests for each part, root and client suites, build, CI, prod serving the commit.
- Live on prod: the nightly-data line shows the last nightly read; one-click Sync Courses reads
  PowerSchool and moves the line.
- First run, live on a dev server with an empty database and the mini's Schoology session: current courses
  appear one by one with the progress line, then past courses import in the background. The dev
  database is deleted afterwards. (A dev clone never arms the nightly run, so its nightly-data line is
  amber until a button run: expected.)
- `npm run check:mobile` against the dev server: the dashboard header with the new line and "?" at phone
  width.

## Calls the agent made (builder check, 20/10/2026)

- "First sync finished" is the course's section read, marked per course (section above).
- "Sync failed" on a card is for a failed first read only.
- A first-run or any `kind: 'all'` run takes its mastery list after discovery.
- The nightly stamp needs blocks, calendar and alerts all without error; `notReady` is not an error.
- The help's second bullet follows the Settings: "every night" only when the nightly PowerSchool pass is on.
- The Archived tab loses its Sync Courses button; its Synced time and "?" stay.
- The progress dialog and provenance labels keep the name PowerSchool.

## Left to the builder

- The stamp's storage (a settings row or a column), and how the run reports found and finished counts.
- The queue run kind for a past-course import, and its retry on failure.
- Exact layout of the nightly-data line at phone width, within the PHONE LAYOUT block.
