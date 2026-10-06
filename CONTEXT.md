# CONTEXT

Domain language and cross-cutting conventions for Prism. Keep this current when
terminology or a cross-cutting decision changes.

## Ubiquitous language

### Course lifecycle states

- **Archived** — the **canonical** term for a completed / past course (a previous
  year or semester). Backed by the `courses.archived` flag. Use it everywhere
  user-facing (the Dashboard **Archived** tab — which hosts both the imported-course
  cards and the **Import archived courses** discovery surface — and the Sync dialog's
  **Include archived courses** toggle) and in app-level code
  (`server/services/archivedCourses.js`, `getArchivedSections`,
  `discoverArchivedCourses`, `GET /api/courses/archived/discover`,
  `ArchivedCoursesPanel`).
  - **"Past" is reserved** for naming Schoology's own source page,
    `/courses/mycourses/past`, and the code that scrapes/parses *that specific
    page*: `server/lib/parsePastCourses.js`, the `pastCoursesSample.js` fixture,
    and `PAST_COURSES_HTML`. Do **not** use "past" for the app concept.
- **Hidden** — noise: a course the teacher chose to hide from view
  (`courses.hidden`). Independent of archived.
- **Excluded** — template / no-course-code sections auto-marked `courses.excluded`
  (issue #56); never synced.

There is no separate "archived-but-still-active" state: **archived ≡ past**, and
past courses are not in the active section list, so the recurring sync never
touches them — they are **import-once**.

### Dates

- Render in **UK/AU format** (`toLocaleDateString('en-GB')` → DD/MM/YYYY); the app
  is used by an Australian teacher at HKIS. A configurable locale/date-format
  preference is a deferred follow-up (would want a shared `formatDate` helper that
  all dates funnel through — formatting is currently scattered).

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

## Archived-course surfaces (avoid label collisions)

After #69 the **Sync dialog** has a single archived-course surface — the **Step 2 →
"Archived courses"** group, which selects already-imported archived courses for the
optional **mastery (SBG)** sync. The **Import archived courses** discovery surface
(`ArchivedCoursesPanel`: discovers archived sections from Schoology and imports them
once — gradebook only; mastery stays opt-in via the Step 2 group) now lives on the
**Dashboard Archived tab**, above the imported-course cards. Keep these two labels
distinct.

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
- **A process that touches student data must declare which database it opens.**
  PrisMCP reads SQLite directly and loads no dotenv, so a launch without an
  explicit `DB_PATH` silently opens whatever sits beside the code — on a dev
  clone, a throwaway copy. Processes run where the data is; they do not reach
  across a network to it.
