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

## Archived-course surfaces (avoid label collisions)

After #69 the **Sync dialog** has a single archived-course surface — the **Step 2 →
"Archived courses"** group, which selects already-imported archived courses for the
optional **mastery (SBG)** sync. The **Import archived courses** discovery surface
(`ArchivedCoursesPanel`: discovers archived sections from Schoology and imports them
once — gradebook only; mastery stays opt-in via the Step 2 group) now lives on the
**Dashboard Archived tab**, above the imported-course cards. Keep these two labels
distinct.
