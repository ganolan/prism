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

## Archived-course surfaces (avoid label collisions)

After #69 the **Sync dialog** has a single archived-course surface — the **Step 2 →
"Archived courses"** group, which selects already-imported archived courses for the
optional **mastery (SBG)** sync. The **Import archived courses** discovery surface
(`ArchivedCoursesPanel`: discovers archived sections from Schoology and imports them
once — gradebook only; mastery stays opt-in via the Step 2 group) now lives on the
**Dashboard Archived tab**, above the imported-course cards. Keep these two labels
distinct.

## Deployment topology and its vocabulary

**Status: decided 2026-09-23, not yet built.** See
`docs/adr/0003-prism-served-from-a-home-server-over-tailscale.md` and
`docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md`. Until it
is built, Prism runs the way it always has — a dev server started by hand. Do not
write code or docs that assume the topology below already exists.

Once built, these terms are canonical:

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
