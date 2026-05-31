# Archived-Import UX — Year/Semester Grouping, Tri-State Selection, Progress Modal — Design

**Issue:** #71 (sub-project B). Depends on #70 (sub-project A — done: import already
finalises gradebook + mastery + enrich). Follows #69 (discovery UI relocated to the
Dashboard Archived tab).
**Date:** 2026-05-31
**Status:** Approved design, pending implementation plan
**Scope:** **Frontend** (one server-side parser enhancement). No backend import-flow
change — #70 already made `POST /api/courses/import` finalise + enrich. Three user-facing
deliverables: (1) year→semester grouping for **both** the Archived-tab cards and the import
**discovery list**; (2) tri-state select-all / select-year selection + per-year "Import
all"; (3) a modal progress popup mirroring `SyncProgress`, auto-refreshing the Archived tab
on completion.

## Problem

After #69 the Dashboard **Archived** tab hosts a discovery surface
(`ArchivedCoursesPanel`) above the imported-course cards. Two gaps:

1. **No term grouping where it matters most.** Imported **cards** group by academic year
   only (`groupByAcademicYear`, no semester sub-group); the **discovery list** is a flat,
   ungrouped queue. When the same course recurs across years/semesters (the live page
   shows e.g. *MOBILE GAMES DEVELOPMENT* taught in four different terms), the teacher
   can't tell the instances apart. The differentiator is **academic year + semester**.

2. **Discovery has no term metadata at all.** The `/courses/mycourses/past` scrape
   (`server/lib/parsePastCourses.js`) captures only
   `{ courseId, courseTitle, courseCode, sectionId, sectionTitle }` — no grading period.
   Cards carry `grading_period` (fetched at import time); discovery rows carry nothing,
   so they can't be grouped by year/semester as-is.

3. **Bulk import is a blind wait.** Today's "Import all" runs a silent client loop with a
   `Importing 3/7…` button label and no per-course feedback, log, or failure surface; the
   user must scroll to find newly-imported cards afterwards.

## Term-metadata source — resolved by live probe (2026-05-31)

A GET-only probe of the live `/courses/mycourses/past` page (45 course-items, 49
section-items) established that **Schoology already groups the page by grading period
using `<h3>` headers** that precede each course group, e.g.:

- `Semester 1: 08/14/2025 - 01/11/2026 · 8/14/25 - 1/11/26`
- `2024-2025: 08/13/24 - 06/15/25 · 8/13/24 - 6/15/25`
- `22-23 YR · 8/07/22 - 6/14/23`, `21-22 S2 · …`, `22-23 Summer · …`

The header→course association is clean: **every** course-item sits under a header (zero
orphans), in document order. So term metadata is obtained by **parsing the page in
document order** — **zero extra API calls** (the rejected alternative was an
`/sections/{id}/grading_periods` fetch per discovered section).

The probe also exposed a defect in the existing `parseGradingPeriod`: it returns
`academicYear: "Unknown"` for ~half the live headers (single-digit months like `1/09/23`;
abbreviated forms like `22-23 YR`, `21-22 S2`). Hardening it is therefore a **required**
companion task — and it also fixes the *existing* card grouping, which silently buckets
those same cases under "Unknown" today.

## Decisions (confirmed with the user, 2026-05-31)

| Decision | Choice |
|---|---|
| Discovery term-metadata source | **Parse the page** (document-order header walk). Zero extra API calls. Verified against the live page first |
| `parseGradingPeriod` for the header shapes | **Harden it** — prefer the explicit year-range prefix; accept single-digit months; understand `S1`/`S2`/`YR`/`Summer`. Shared by cards + discovery |
| Selection model | **Global "Select all" + per-year tri-state + per-row checkboxes**; semester is a visual sub-header (no checkbox). Per-row checkbox **replaces** today's per-row Import button |
| Import triggers | Per-year **"Import all (k)"** quick button + a bottom **"Import N selected"** primary action; both feed the same runner/modal |
| No-course-code sections | **Excluded** from Select-all / Select-year / "Import all" counts, but **individually tickable** (preserves today's behaviour) |
| Progress modal | **Mirror `SyncProgress`** (bar + per-course rows + scrolling log + Done). Non-dismissable while running |
| Completion / failure | Continue-on-error; on completion show a summary + **"Retry failed (n)"**; **refresh the Archived tab** so cards are current when the modal closes |
| Grouped surfaces | Discovery list and cards are **two parallel grouped surfaces** (not merged), both using the same grouper |
| Group collapse / parallel import / skip-mastery toggle | **Out of scope** (YAGNI; mastery requires sequential single-session imports; #70 fixed import to always finalise) |

## Architecture

### 1. `parsePastCourses` — ordered walk attaching `gradingPeriod` (server, pure)

Replace the `querySelectorAll('li.course-item')` pass (which loses document order
relative to the headers) with an **ordered DFS walk**:

- Carry `currentGradingPeriod`. On an `<h3>` whose text matches a **term-header pattern**
  — a date (`\d{1,2}/\d{2}/\d{2,4}`), a year-range (`\d{4}-\d{4}` / `\d{2}-\d{2}`), or a
  term token (`Semester`, `S1`/`S2`, `YR`, `Summer`, `Full Year`) — set it. On an
  `li.course-item`, parse its `.section-item`s as today and attach
  `gradingPeriod: currentGradingPeriod`. Non-matching `<h3>`s are ignored.
- New row shape: `{ courseId, courseTitle, courseCode, sectionId, sectionTitle,
  gradingPeriod }`. `gradingPeriod` is `null` if no header preceded it (null-safe; the
  probe found zero orphans).
- Defensive dedupe by `sectionId` (keep first occurrence).

`GET /api/courses/archived/discover` (`server/routes/courses.js:16`) is unchanged in
logic — each annotated section now also carries `gradingPeriod` via the existing `...s`
spread, flowing through alongside `imported` / `noCourseCode`.

### 2. `parseGradingPeriod` — hardened (client, pure; shared by cards + discovery)

Same return shape `{ academicYear, semester }`. Academic year by **preference order**:
1. Explicit 4-digit range `2024-2025` → `"2024-25"`.
2. Abbreviated range `22-23` → `"2022-23"`.
3. Date-derived, tolerant of single-digit months (`/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/`);
   month ≥ 8 ⇒ that's the start year (unchanged rule, looser regex).
4. else `"Unknown"`.

Semester: `Semester 1`/`S1` → `"Semester 1"`; `Semester 2`/`S2` → `"Semester 2"`;
`Summer` → `"Summer"`; else (incl. `YR`, year-only) → `"Full Year"`. Canonical AY format
stays `YYYY-YY` so all three derivations collide correctly. Every distinct live header the
probe pulled resolves to a real year after this (the current "Unknown" cases included).

### 3. `groupByYearAndSemester` — new grouper (client, pure)

```
groupByYearAndSemester(courses, getPeriod = (c) => c.grading_period)
  → [{ year, semesters: [{ semester, courses: [...] }] }]
```

Years sorted **descending**, `"Unknown"` always last; semesters ordered
`Semester 1 → Semester 2 → Summer → Full Year → Unknown`. The `getPeriod` accessor serves
both shapes — cards use the default (`grading_period`), discovery passes
`s => s.gradingPeriod`. Replaces `groupByAcademicYear` everywhere it is used; the old
helper is removed if no other consumer remains.

### 4. `TriCheckbox` — extracted to a shared module (client)

Lift the local `TriCheckbox` out of `SyncConfig.jsx` into its own module; `SyncConfig` and
the new `ArchivedImportList` both import it. One indeterminate-checkbox implementation.

### 5. `ArchivedImportList` — grouped, tri-state-selectable discovery list (new)

Extracted from `ArchivedCoursesPanel`. Props: `sections` (remaining, not-yet-imported),
`busy`, `onImport(sectionIds)`.

- Owns selection (a `Set` of `sectionId`); on `sections` change it **prunes** ids no
  longer present (imported courses fall out; failed ones stay selected).
- **Selectable universe = coded sections** (`!noCourseCode`). "Select all" and per-year
  checkboxes operate over that scope; tri-state (checked / indeterminate / unchecked) is
  computed over it, mirroring `SyncConfig`'s group roll-up. No-code rows are individually
  tickable but excluded from the bulk scope and counts.
- Grouping via `groupByYearAndSemester(sections, s => s.gradingPeriod)`; semesters are
  visual sub-headers; most-recent year first; non-collapsible.
- Actions: per-year **"Import all (k)"** (k = coded sections in the year, regardless of
  selection) and a primary **"Import N selected"** (current selection incl. hand-ticked
  no-code; disabled when `N = 0` or `busy`). A year with only no-code rows hides its
  year-checkbox + "Import all" but still lists the rows.
- Styling reuses `SyncConfig`'s `.sync-group*` / `.sync-course-row` classes and theme
  custom properties; any new classes go in `app.css` (no hardcoded hex).

### 6. `useImportRunner` — sequential loop + render model (new hook)

```
useImportRunner({ onComplete, importer = importCourse })
  → { model, run, retryFailed, reset }

model = { status: 'idle'|'running'|'done', total, done, progress,
          rows: [{ sectionId, title, status, counts?, error? }],
          log: string[], failures: [{ sectionId, title, error }] }
```

- `run(targets)` seeds `rows` pending, then **sequentially** `await importer(sectionId)`
  (sequential is required — mastery drives one browser session at a time). Success: row →
  `done`, attach `{ studentsCount, assignmentsCount, gradesCount }` from the POST
  response, log `"Imported <title> (N students, M grades)"`. Error: row → `error`, push to
  `failures`, log `"<title> failed: <message>"`, **continue**. Bar advances on attempts.
- On finish: `status='done'`, `onComplete(summary)`.
- `retryFailed()` re-runs the loop over just the current failures (rows updated in place).
  `reset()` → idle.
- `importer` is injectable (mirrors `fetchHtml` injection in `archivedCourses.js`) for
  unit testing.

### 7. `ImportProgress` — modal body (new, presentational)

Mirrors `SyncProgress`'s look via the existing `.sync-progress / .sync-bar / .sync-phase /
.sync-log / .sync-foot` classes; rendered in `.modal-overlay > .modal-content` like
`SyncDialog`. **Non-dismissable while running** (no backdrop/Escape).

- Running: `"Importing archived courses…"` + spinner + `"Please don't close Prism — this
  can take a few minutes."` (honest about ~20–40s/course mastery cost).
- Done: `"Import complete · {succeeded} of {total}"`, warn-styled with a `"· {failed}
  failed"` badge when applicable.
- Per-course `✓ / ● / ✕` rows (counts on success, reason on error) + scrolling log (last
  ~40 lines). Footer: `"Retry failed (n)"` (only when `done && failures`) + `"Done"`
  (disabled while running).
- **No login-remedy banner** (unlike `SyncProgress`): gradebook import is OAuth-based so
  it doesn't fail on browser-session expiry, and mastery is best-effort
  (`mastery-if-session`, per #70) — a dead session silently skips mastery.

### 8. `ArchivedCoursesPanel` — slimmed orchestrator

- Keeps discovery state (check / needLogin / login) as today.
- `useImportRunner({ onComplete })`. `onImport(ids)` builds `targets` from `discovered`
  and calls `runner.run(targets)`; `<ImportProgress>` shows while `status !== 'idle'`.
- `onComplete`: add succeeded `sectionId`s to the existing `importedIds` Set (they drop
  out of the list **without a re-scrape**) and call `onImported?.()` to refresh the
  Dashboard cards. Failed ones stay listed + selected.
- `busy = status === 'running'` → `ArchivedImportList`. "Done" → `reset()`.

### 9. Dashboard archived cards (`pages/Dashboard.jsx`)

Archived tab switches `groupByAcademicYear` → `groupByYearAndSemester(courses)` and renders
nested **year → semester sub-header → cards**, mirroring the discovery list above (two
parallel grouped surfaces). The now-redundant per-card **semester badge is removed** (the
sub-header conveys it); the archived dim/opacity treatment stays. Year keeps the
uppercase-muted header; a lighter semester sub-header class goes in `app.css`. The
**Current** tab is unchanged.

### End-to-end flow

1. Archived tab → `ArchivedCoursesPanel` (discovery) + card groups via
   `groupByYearAndSemester`.
2. "Check Schoology" → `GET …/archived/discover` → ordered-walk `parsePastCourses`
   attaches `gradingPeriod`; endpoint annotates `imported` / `noCourseCode`.
3. `ArchivedImportList` groups remaining (`s => s.gradingPeriod`); user selects / "Import
   all".
4. `useImportRunner` loops `POST …/import` per section (each finalises gradebook + mastery
   + enrich, per #70); `ImportProgress` shows progress.
5. Completion → imported drop from the list (`importedIds`), `onImported()` → Dashboard
   `reload()` → cards re-fetched and re-grouped; new imports appear under their
   year → semester.

## Testing (TDD)

- **Server — `npx vitest run`:** expand the `pastCoursesSample.js` fixture (synthetic) to
  interleave grading-period `<h3>` headers with course groups, including a year-only
  header, a single-digit-month header, and an abbreviated header. `parsePastCourses`:
  each section gets the correct `gradingPeriod` from its preceding header; a course under
  a year-only header; `null` when no header; the dedupe case. Discover route: `gradingPeriod`
  survives to the response.
- **Client pure — `cd client && npx vitest run`:** a table-driven `parseGradingPeriod`
  test over every probe header shape (the now-resolved ones, single-digit months,
  `S1`/`S2`/`YR`/`Summer`, year-only, abbreviated, and `null`/garbage → `Unknown`);
  `groupByYearAndSemester` ordering (year desc + `Unknown` last; semester order), both
  accessor shapes, empty input. The existing `groupByAcademicYear` test in
  `courseDisplay.test.js` is replaced by the `groupByYearAndSemester` test (Dashboard is
  its only consumer).
- **Components / hook:** `ArchivedImportList` — tri-state roll-up at row/year/global;
  select-year selects only coded; no-code excluded from bulk yet individually tickable;
  "Import all (k)" / "Import N selected" call `onImport` with the right ids; selection
  pruning when `sections` shrinks; all inputs disabled when `busy`. `ImportProgress` —
  running (disabled Done) / done / with-failures states; Retry-failed visibility; row
  icons + counts/errors; log truncation. `useImportRunner` (injected fake importer) —
  sequential order; success counts + log; failure recorded + loop continues; progress
  math; `onComplete` fires once; `retryFailed` re-runs only failures. `ArchivedCoursesPanel`
  integration — import triggers the modal; completion drops imported from the list and
  calls `onImported`.
- Baseline stays green (135 server / 126 client) + frontend prod build clean.

## Out of scope (deliberate)

- **Backend import-flow change** — #70 already finalises (gradebook + mastery) + enriches
  on import. No change here.
- **Group collapse/expand**, **parallel imports** (mastery is sequential by nature), and a
  **"skip mastery on bulk" toggle** (import always finalises, per #70).
- **Configurable date/locale** preference + shared `formatDate` helper — deferred
  follow-up (recorded in `CONTEXT.md` / memory).
- **Merging** the discovery list and the cards into a single surface — they stay two
  parallel grouped surfaces.
- **Live end-to-end verification** of a real multi-course import — the logic is
  unit-tested; a real run against live Schoology stays the user's call (per ops caveats),
  though the modal is built for exactly that. Overlaps the as-yet-unobserved #70 backfill
  / transition and bulk-import-at-scale items.
