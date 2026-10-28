# CONTEXT

Domain language and cross-cutting conventions for Prism. Keep this current when
terminology or a cross-cutting decision changes.

## Ubiquitous language

### Course lifecycle states

- **Archived** — the **canonical** term for a completed / past course (a previous
  year or semester). Backed by the `courses.archived` flag. Use it everywhere
  user-facing (the Dashboard **Archived** tab — which hosts both the imported-course
  cards and the **Import archived courses** discovery surface) and in app-level code
  (`server/services/archivedCourses.js`, `getArchivedSections`,
  `discoverArchivedCourses`, `GET /api/courses/archived/discover`,
  `ArchivedCoursesPanel`).
  - **"Past" is Schoology's word** (`include_past=1` on its section list, and its
    `/courses/mycourses/past` page, which Prism read until #178 replaced it with
    the REST list). The past-course import (`pastImport.js`, 'Importing past
    courses') also keeps the word. Use "archived" for the app concept otherwise.
- **Linked sections**: Schoology sections that share one set of tasks (the same
  task ids) and keep their own students and grades; the child sections carry the
  parent's id in `parent_id`. Prism holds a linked set as **one course**: the
  parent is `courses.schoology_section_id`, each child a `linked_sections` row,
  and each enrolment records its own section (#178). Every read of the course
  reads each section; every Schoology write to a linked set is refused
  (`courseSections.assertSectionWritable`) until writes go to each student's own
  section. Today only past courses are linked (AI & ML 2023-24, AP CSA self-paced
  2021-22 and 2022-23).
- **Hidden** — noise: a course the teacher chose to hide from view
  (`courses.hidden`). Independent of archived.
- **Excluded** — template / no-course-code sections auto-marked `courses.excluded`
  (issue #56); never synced.

There is no separate "archived-but-still-active" state: **archived ≡ past**, and
past courses are not in the active section list, so the recurring sync never
touches them — they are **import-once**. Since #178 every full sync imports any
past section Prism does not hold (one REST list read when nothing is missing).

### Dates

- Render in **UK/AU format** (`toLocaleDateString('en-GB')` → DD/MM/YYYY); the app
  is used by an Australian teacher at HKIS. A configurable locale/date-format
  preference is a deferred follow-up (would want a shared `formatDate` helper that
  all dates funnel through — formatting is currently scattered).

### Submitted (one rule everywhere, 19 Oct 2026)

- **Submitted** = a real submission signal: the OneDrive (LTI) state from the grader, a native dropbox
  revision (`grades.submission_type`), or a test attempt (`test_attempt = 'took'`). Never
  `grades.submitted_at`, which is the REST **grade** time (a teacher's comment alone sets it).
  Triage, the card pill and filters, the timeline and PrisMCP all use this rule.
- **Not tracked** = paper / gradebook-only work (`accepts_submissions = 0`, not a test): no submission
  channel, so no Submitted / Overdue badge; it counts as handed in for "to grade".
- After an unsubmit, sync keeps the last-seen `latest_revision_at` / `late` as history (resubmission
  detection needs them); no screen or tool shows them unless the work is submitted again.

### School days, lessons and "day N" (triage clock)

- **School day** — a teaching day in the PowerSchool calendar (`school_days`: in session *and* a cycle day).
  **Every Prism clock counts school days**: late work / referral, feedback owed, make-ups, extensions and
  resubmission deadlines.
- **School days late / waiting / since** — what every screen shows: the distance from the due date (or
  extended date, test date, ask date). "Refer at 8 school days late", "feedback overdue at 10 school days
  waiting". **Never "day N" in the UI** (2026-10-07): the timetable numbers its 8-day cycle 1-8, so "day 5"
  read as cycle day 5. Internally rows still carry `day` = a clock position with the due date = day 1, so
  school days late = `day - 1`; the stored limits (8, 10) are the same numbers the screens show.
- **Lesson** — a meeting of one class (`class_meetings`, from PowerSchool's bell schedules). Only ever a
  *hint* next to a school-day deadline ("3 lessons from today"); never a unit Prism counts or stores.
  The API/DB field `lessons` on extensions and resubmissions is historical: it holds **school days**.
- **Extension / extended deadline** — N school days added to the original due date (or test date) by
  default, even once it has passed, so 3 days on work 5 school days overdue leaves it 2 school days overdue
  (27 Oct 2026). Once the due date has passed the teacher can count **from today** instead, a fresh future
  deadline. A resubmission ask's extension counts from the ask date, or from today once its deadline has
  passed. The resulting date is stored (`until`).
- **Waive (a referral)** — the teacher's decision not to refer work that was handed in late past the limit.
  Recorded in `referrals` as the legacy `exempt` action, shown as "waived". Not Schoology's *Exempt* flag.

### Proficiency levels (standards-based grading)

The five HKIS General Academic Scale levels and their codes, ordered best → worst:
**Exhibiting Depth (ED) · Exhibiting (EX) · Developing (D) · Emerging (EM) ·
Insufficient Evidence (IE)**.

Prism owns the proficiency↔gradebook-score mapping. **Callers emit levels; teachers
review and publish in levels; the gradebook number is derived downstream by Prism
and is never a caller or teacher input.** The numeric mapping is configured once in
`config.yaml` (`grading.proficiencyScale`) and derived through
`server/lib/proficiencyScale.js` (server) and `client/src/lib/masteryLevels.js` +
`useProficiencyScale()` (client, via `GET /api/proficiency-scale`). See
`docs/adr/0001-prism-owns-proficiency-gradebook-mapping.md`.

### Valid feedback scales (teacher decision, 2026-09-29)

- **Summative feedback**: **General Academic Scale (aligned)** only, meaning levels
  against measurement topics in the mastery gradebook.
- **Formative feedback**: **Completion**, **Approaches to Learning** (Consistent ·
  Inconsistent · Seldom) and **General Academic Scale (Unaligned)** (the GAS levels
  with no measurement topic) only. Prism grades these as score scales
  (`config.yaml` `grading.scoreScales`, #41).
- **Numeric scores are data, not feedback.** A quiz's numeric result isn't graded
  in Prism. To give standards feedback on a quiz, the teacher makes a **second
  assessment** named with a **"- Result"** suffix (e.g. the AP CSP quiz results) and
  aligns that to one or more standards on the aligned GAS.
- **Letter-grade scales (HS Letter Grade, HKIS Grade Scale) are vestigial.** They are
  never used; don't build grading support for them or for numeric scales.
- Every scale renders **best on the left → worst on the right**.
- **Feedback rows**: a rubric attached to a score-scale task. Each criterion is a row the
  teacher marks in Prism; row levels are Prism-only feedback data (`rubric_row_levels`) and
  never reach Schoology. Only the overall scale level is published. On the General Academic
  Scale (Unaligned), Prism stages the rubric average as the overall level (ties round up; an
  Insufficient Evidence row stops it) until a level is published. On other score scales the
  row levels do not match the scale's levels, so no average is staged.

### PowerSchool alerts vs flags (#117, #40)

- **PowerSchool alert**: an alert PowerSchool's custom-alerts plugin shows beside a student's
  name (accommodation plan, learning support level, EpiPen, siblings, ...), read on each sync and
  shown as a badge (`student_ps_alerts`, feature `powerschool_alerts`). It says a plan exists, not
  what it contains. Categories: learning, health, other, and **family** (correspondence,
  divorced/separated, staff child, siblings). Family alerts appear on the student page (behind
  "Show family alerts", #185) and in PrisMCP only, never on a roster. Every view hides alerts until the
  teacher turns on Private details.
- **Flag**: one of Schoology's five grade flags on a student's task, set from Prism or from
  Schoology's gradebook (#40): **Exempt** (1), **Incomplete** (2), **Missing** (3), **Absent** (5),
  **Late** (6). Schoology's API calls them exceptions (`grades.exception`; 4 is invalid). While a
  flag is set Schoology removes the grade (Missing sets it to 0). Prism has no flags of its own
  (the Prism `flags` table and Flag for review were removed on 21 Oct 2026). Never call a
  PowerSchool alert a flag.
- **Final flag**: Exempt or Missing. The rubric stays locked while it is set, and the work counts
  as handled (feedback given, grading complete).
- **Marker**: Late, Incomplete or Absent. The teacher grades straight through it; publishing a
  grade clears it in Schoology. Until then the work stays in feedback owed.
- **Overdue**: Prism's own status for work past its due date with no submission. Not the
  Missing flag, which only the teacher sets.
- **Saved grade**: the copy of a grade (score, topic levels, rubric row levels, comment) Prism
  keeps in `excused_grades` before a flag removes it. Clearing the flag offers to restore it as a
  draft; a grade published since retires it.

## Archived-course surfaces (avoid label collisions)

The **Import archived courses** discovery surface (`ArchivedCoursesPanel`: discovers archived
sections from Schoology and imports them once) lives on the **Dashboard Archived tab**, above
the imported-course cards. Archived courses have no Sync Courses button there: they are read in
full once when archived, then only by a button on a course page, or on a past student's page
(#171, 20/10/2026; the Sync Courses dialog and its "Archived courses" group are gone). The
**past-course import** (below) fills the same tab without that surface. Keep the labels distinct.

## First run and the past-course import (#171)

- **First run**: the dashboard's first sync on an empty database (a new install, or a restored
  empty one). It reads every current course, PowerSchool included, with no setup screen. A course
  found by it stays off the dashboard until its first section read finishes (`courses.first_sync`
  `'pending'`); a course whose first read failed shows with a **Sync failed** badge
  (`first_sync = 'failed'`, the error in `first_sync_error`). Not a later partial failure (mastery,
  comment threads): those show in the chip and the progress dialog. A new section that appears
  mid-year follows the same rule. The line above the cards reads "Getting your courses: 4 of 12".
- **Past-course import**: the background import of the teacher's archived courses after a first
  run, newest school year first, one queue run per course (run kind `import`), while the teacher
  works. The Archived tab reads "Importing past courses: 7 of 30". It happens once per install:
  the settings row `firstRun.pastImport` holds its state (`waiting`, `importing`, `done`), and an
  interrupted import resumes with the courses still missing (the course whose run the restart cut
  off is never taken as done: it is retried at the end, unless that run was already its retry). Any `kind: 'all'` run on an empty database (the nightly run
  too) makes it due. Not the **Import archived courses**
  discovery surface, which the teacher drives by hand.
- **Nightly data**: blocks, calendar and alerts, the data only the PowerSchool pass reads. Its
  stamp (settings key `sync.nightlyDataReadAt`) is the last pass in which all three finished
  without error, whichever run made it; a blocks pass that stopped early (its time budget) or had
  no current course to read is not one. The dashboard shows it as "Blocks, calendar and alerts:
  03:01 today", amber over 26 hours.

## Deployment topology and its vocabulary

**Status: live — cutover done 2026-09-24; the mini is master.** See `docs/deploy.md`,
`docs/adr/0003-prism-served-from-a-home-server-over-tailscale.md` and
`docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md`.  Prod
runs on the mini and holds the authoritative database; the laptop is a dev clone.

These terms are canonical (the pipeline is built; cutover has not happened yet):

- **prod** — the single always-on instance on the home Mac mini, serving
  `~/prism/current` on loopback and published to the tailnet by `tailscale serve`.
  It holds the **one authoritative database** at `~/prism/data/students.db`.
- **release** — a deployed checkout under `~/prism/releases/<date>-<sha>/`.
  `current` is a symlink to the active one; the previous release is retained so
  rollback is a symlink swap. Releases are **machine-owned**: deploys write them,
  humans never edit them.
- **dev clone** — any other checkout (`~/repos/prism`, the same path on every
  machine), running against a **disposable** database. Never a master; its data
  is a snapshot copy that may be overwritten at any time.
- **snapshot** — a consistent single-file copy written by `npm run db:backup`
  via SQLite's backup API, into `PRISM_BACKUP_DIR`. Snapshots are the **only**
  form in which the database is ever copied or synced. The live
  `.db`/`-wal`/`-shm` trio is never handed to a syncing tool.
- **cutover** — the one-time step that makes prod the master: the laptop's
  writers stop, it takes a fresh snapshot, and `scripts/deploy/cutover.js`
  restores exactly that snapshot into prod, verifies it, and publishes prod on
  the tailnet. Before cutover the laptop is master; after it, the laptop's copy
  is a disposable dev clone.

Two rules follow, and both have already been violated once:

- **The database never lives in a cloud-synced folder** (#121). This now includes
  `~/Documents`: macOS Desktop & Documents sync is one setting away, and on a
  school-managed Mac OneDrive Known Folder Move redirects it outright. Clones
  live at `~/repos/`, which neither can reach. Check a new machine with
  `readlink ~/Documents` — any output means redirected.
- **A process that touches student data runs where the data is.** Only the Prism
  server opens the database. PrisMCP is part of that server and is reached at
  `/mcp` over the tailnet (#131, 20/10/2026), so no other process opens the
  database file, and a wrong `DB_PATH` cannot send grading to a copy.
