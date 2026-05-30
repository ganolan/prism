# Past-Course Discovery & Import — Design

**Issue:** #5 (reopened portion) — "Archived Schoology courses should be pulled in
automatically … without manual course section code entry."
**Date:** 2026-05-31
**Status:** Approved design, pending implementation plan

## Problem

Issue #5's original five points are resolved. The remaining open ask: a teacher
should be able to pull in **past/archived** courses **without manually typing each
section ID** into the existing import form.

The mechanism is already verified (probe 2026-05-30, see
`.claude/schoology-api-reference.md` → "Three high-priority surfaces" #2):

- `GET /courses/mycourses/past` → **200 text/html** (~338 KB), browser-session auth.
  Server-rendered list of **45 `li.course-item` / 49 `div.section-item`**. There is
  **no JSON endpoint** — the active-courses JSON cannot be coaxed to include past
  courses, so the past inventory must be **scraped from this HTML**.
- Once a past `sectionId` is known, **all normal section reads already work** on it
  (verified for 5 archived sections, all `active:0`): `GET /v1/sections/{id}`,
  `/assignments`, `/grades`, `/enrollments` all 200 with real data.

So the only genuinely new capability is **enumerating past sections by scraping that
HTML**; everything downstream (per-section read + sync) already exists in
`POST /api/courses/import`.

## Key domain facts (confirmed with the user, 2026-05-31)

- **`archived` = past course; `hidden` = noise.** There are *no* archive-flagged
  courses that are still in the active section list. (`excluded` = template/no-code
  sections, set by `markExcludedCourses`, issue #56.)
- **Past courses are immutable and import-once.** Their data does not change once a
  grading period is over, so they never need re-syncing — they are pulled in once.
- **The recurring batch sync never touches past courses.** `fullSync` iterates only
  the *active* sections from `getMySections(userId)`; past courses are not in that
  set, so the existing "Include archived" toggle is **effectively inert in practice**
  (flagged as a follow-up cleanup candidate — see Out of Scope).

## Decisions

| Decision | Choice |
|---|---|
| Automation level | Discover + **bulk and per-course** import |
| No-code (template) sections | **Show but flag**, importable individually, **excluded from "Import all"** |
| Data-pull mechanism | **Import immediately per course** (full sync on the spot), reusing `POST /api/courses/import` |
| Bulk import location | **Frontend loop** over the existing per-section import (Approach A) — no new server bulk endpoint |
| Home surface | The **main-menu Sync dialog**, as a separate **"Past courses" panel** |
| On dialog load | Cheap: show **DB-known** courses only; the scrape is an **explicit** action, never on load |
| Display | Archived panel **grouped by academic year**; each row annotated with **semester (S1/S2/Full Year)** and **imported-state** (`Imported ✓` / `Import`). Current courses get a small **"last synced"** line for parity |
| Re-sync of imported past courses | **None** — they are immutable (`Imported ✓`, no re-sync affordance) |

## Architecture (Approach A — thin backend, frontend-driven bulk)

### 1. Parser — `server/lib/parsePastCourses.js` (pure, TDD-first)

```
parsePastCourses(html) → Array<{
  courseId:     string,        // li.course-item#course-{courseId}
  courseTitle:  string,        // .course-title text
  courseCode:   string|null,   // .course-code text; empty → null  (no-code signal)
  sectionId:    string,        // div.section-item#section-{sectionId}
  sectionTitle: string|null,   // section row label if present
}>
```

- **Section-grained**: one entry per `section-item`, so a 2-section course yields two
  rows sharing `courseId`/`courseTitle`/`courseCode`. (Why the page is 45 courses /
  **49 sections**.) `sectionId` is what feeds import.
- Pure, no I/O, uses `node-html-parser` (already a dependency). Ignores the ~5 admin
  action links per section — only the `section-item` id / `/course/{sectionId}` view
  link matters. Empty `.course-code` → `null`.

### 2. Service — `server/services/pastCourses.js` (best-effort, browser session)

Mirrors `graderSubmissions.js`'s session handling, but **one-shot** (not per-section):

- `fetchPastCoursesHtml()` — if no `.playwright-session/storage-state.json`, return
  `null`. Else launch headless chromium with the saved `storageState`, navigate to
  `/courses/mycourses/past`, confirm still logged-in (URL check), return
  `await page.content()`, close. Any failure → `null`. **Never throws.**
- `getPastSections(fetchHtml = fetchPastCoursesHtml)` — fetch → `parsePastCourses` →
  list, or `null`. `fetchHtml` is **injectable** so the endpoint is unit-testable
  without launching a browser.

### 3. Endpoint — `GET /api/courses/past`

- **Must be registered before `GET /:id`** in `server/routes/courses.js` (else Express
  matches `:id = "past"`).
- No session → `200 { available: false, reason: 'no_session' }` (a normal branch, not
  an error).
- Otherwise → `200 { available: true, sections: [...] }`, each section annotated:
  - `imported` — `true` if its `sectionId` already exists in
    `courses.schoology_section_id`.
  - `noCourseCode` — `true` if `courseCode` is null/empty.

### 4. Import — reuse `POST /api/courses/import` (unchanged)

Already takes `{ sectionId }`, reads the section via public OAuth, upserts a course
with `archived = 1`, and runs `syncSectionData`. The bulk import is the **frontend**
calling this once per selected section, sequentially, with a live progress count.

### 5. Frontend — "Past courses" panel in the Sync dialog

- `client/src/services/api.js`: add `getPastSections()`.
- Add a collapsible **"Past courses"** panel to the Sync dialog (`SyncConfig`),
  alongside the existing Step 1 / Step 2 (which are left unchanged):
  - **On load (cheap):** render the DB-known archived courses (already fetched via
    `getCourses(true, true)`) **grouped by academic year**, each row annotated with
    semester and imported-state. Imported rows show **`Imported ✓`** with `synced_at`;
    no re-sync affordance.
  - **"Check Schoology for past courses"** button → `getPastSections()`:
    - `available: false` → reuse the dialog's existing Schoology-login prompt
      (`onLogin` / `getMasteryLoginStatus` — the same browser session the scrape
      needs); after a successful login the user can re-run "Check Schoology for past
      courses". (The Dashboard manual "add by section ID" form still exists as an
      independent fallback, but the panel itself just surfaces the login prompt.)
    - `available: true` → merge discovered **not-yet-imported** sections into the
      grouped list. Each gets an **Import** button; no-code rows are greyed with a
      **"no course code"** badge and **excluded from "Import all"** (still individually
      importable). A header **"Import all (N, excl. no-code)"** imports every
      code-bearing, not-yet-imported section **sequentially** via `importCourse`, with
      a live count (*"Importing 3/27…"*). Partial success survives a single failure.
- **Current courses** get a small **"last synced"** line (parity), sourced from each
  course row's `synced_at`, shown inline on the current-course rows where they are
  already enumerated in the dialog (the Step 2 "Visible courses" group). Note: current
  courses all sync in one batch pass, so their timestamps are ~identical — the line is
  mainly a "synced recently / never synced" signal, not per-course drift.
- The Dashboard **Archived tab** stays the card **view** of imported past courses; its
  existing manual "add by section ID" form is untouched and remains a fallback.

## Testing

- `server/lib/parsePastCourses.test.js` (**TDD-first**): fixture covering multiple
  courses, a multi-section course, and a no-code (MASTER-like) course → assert counts,
  field extraction, and `courseCode: null`.
- Endpoint / service: inject a fake `fetchHtml` returning fixture HTML → assert the
  annotated response (`imported` / `noCourseCode`) and the no-session →
  `available: false` branch.
- Frontend (`SyncConfig`/panel): with mocked api → grouped archived inventory renders
  from props; "Check" merges discovered rows; "Import all" calls `importCourse` for
  code-bearing, not-yet-imported rows **only**.
- **Live verification (repo hard rule — never rely on an unobserved shape):** capture
  the real `/courses/mycourses/past` HTML into a throwaway, run the parser against it,
  and confirm **45 courses / 49 sections** before relying on the structure. The
  **committed fixture is synthetic/representative** of the verified structure — no real
  course data committed.

## Out of scope (deliberate)

- **Fully-automatic** past-course sync on every run (rejected by the user — too slow,
  hard browser-session dependency).
- A **server-side bulk import endpoint** (rejected — Approach A keeps import per-section
  for resilience and progress).
- **Re-syncing** imported past courses (not needed — immutable).
- **Removing the inert "Include archived" toggle** — confirmed effectively dead given
  `archived = past`, but treated as a separate follow-up cleanup, not bundled here.
