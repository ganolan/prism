# Past Courses: Manual Import + Dashboard Tab Toggle

**Date:** 2026-04-07  
**Status:** Approved

## Overview

Prism's active sync (`/users/{uid}/sections`) only returns sections from the current grading period. Completed semester courses (e.g. MGD, which ended January 2026) and all courses from prior years are absent. This feature adds:

1. A fix to the sync so `grading_period` is stored correctly for all courses
2. A manual import flow for past courses (enter a Schoology section ID, Prism fetches and syncs it)
3. A **Current / Archived** tab toggle on the Dashboard replacing the "Show archived" checkbox
4. Archived courses grouped by academic year on the frontend, descending

---

## 1. Data Model

**No new columns.** The existing `archived INTEGER DEFAULT 0` field is repurposed:

| Value | Meaning |
|---|---|
| `0` | Current — returned by the active sync |
| `1` | Archived — manually imported past course |

The existing `grading_period TEXT` column is kept and correctly populated (see §2). Academic year and semester are **derived on the frontend** from this string — not stored in the DB.

### Sync behaviour change

The full sync upsert currently does not touch `archived` on conflict. It must now explicitly set `archived = 0` for every course it finds, so that courses can't get stuck as archived if they reappear in an active sync.

### Import behaviour

Courses added via the import endpoint are upserted with `archived = 1`.

---

## 2. Sync Fix — Grading Period Data

**Problem:** The section object returns `grading_periods` as an array of integer IDs (e.g. `[1123041]`). The current sync reads `grading_periods[0].title` which is always `undefined`, leaving `grading_period` null for all courses.

**Fix:** In `fullSync()` in `server/services/sync.js`, after upserting each course, call `GET /sections/{id}/grading_periods` and store the first result's `title` in `grading_period`. Add `grading_period` to the upsert's `ON CONFLICT DO UPDATE` clause. Also set `archived = 0` in the same upsert.

This adds ~1 API call per section per sync (~10 sections currently — well within rate limits).

---

## 3. Import Endpoint

**`POST /api/courses/import`**

Body: `{ sectionId: string }`

Steps:
1. Call `GET /sections/{sectionId}` — verify 200
2. Call `GET /sections/{sectionId}/grading_periods` — get period title
3. Upsert course with `archived = 1`, `grading_period` set
4. Sync enrollments, assignments, grades (same logic as `fullSync` per-section block)
5. Return `{ course, studentsCount, assignmentsCount, gradesCount }`

Errors:
- 403 from Schoology → 403 `{ error: "Section not accessible" }`
- 404 from Schoology → 404 `{ error: "Section not found" }`
- Already exists → re-sync and return updated data (idempotent)

---

## 4. Courses API Changes

`GET /api/courses` gains a `view` query parameter:

- `?view=current` → `WHERE archived = 0 AND hidden = 0 ORDER BY course_name`
- `?view=archived` → `WHERE archived = 1 AND hidden = 0 ORDER BY course_name`

Default (no param): existing behaviour unchanged for backwards compatibility.

The existing `?archived=true` and `?hidden=true` params remain but are no longer used by the Dashboard.

---

## 5. Frontend — Academic Year + Semester Derivation

Derived from the `grading_period` string. No DB storage needed.

**Semester:**
- Title contains `"Semester 1"` → `"Semester 1"`
- Title contains `"Semester 2"` → `"Semester 2"`
- Otherwise → `"Full Year"`

**Academic year** — parse the start date from the title string (format: `MM/DD/YYYY`):
- Start month Aug–Dec → `"{year}-{(year+1).toString().slice(-2)}"` e.g. Aug 2025 → `"2025-26"`
- Start month Jan–Jul → `"{year-1}-{year.toString().slice(-2)}"` e.g. Jan 2026 → `"2025-26"`

If `grading_period` is null, fall back to `"Unknown"` for grouping.

---

## 6. Dashboard UI

### Tab Toggle

Replace the "Show archived" checkbox with a two-button tab toggle:

```
[ Current ]  [ Archived ]
```

Default: Current tab active.

The "Show hidden" checkbox is removed from the main controls area — hidden course management is handled entirely through the "Show/Hide Courses" panel (see below).

### "Show/Hide Courses" Button

The existing "Edit courses" button is renamed **"Show/Hide Courses"**. Functionality unchanged — opens the same panel for toggling per-course visibility.

### Current Tab

Identical to today's layout. No changes.

### Archived Tab

Courses grouped by derived `academic_year`, descending (most recent first). Within each year, courses sorted alphabetically.

**Group header:** e.g. `2025-26` — plain section divider

**Course cards:** Same component as current courses, slightly reduced opacity (`0.75`). Each card shows a small `semester` badge (`Semester 1`, `Semester 2`, `Full Year`).

The Archive/Unarchive button on course cards is removed — archive state is set by the import flow, not manually.

### Add Past Course Form

Rendered at the bottom of the Archived tab only.

```
Add a past course
─────────────────────────────────────────────────────
Section ID  [ _______________________________________ ]

            Find this in the Schoology URL:
            schoology.hkis.edu.hk/course/[ID]/materials

                                             [ Import ]
```

On submit:
- Button shows loading state
- On success: course appears in the grouped list immediately; brief success banner shows course name, student count, and assignment count
- On error: inline error message below the input

---

## 7. Files Affected

| File | Change |
|---|---|
| `server/services/sync.js` | Fetch grading periods per section; store title in `grading_period`; set `archived = 0` in upsert |
| `server/routes/courses.js` | Add `?view=` param; add `POST /import` endpoint |
| `client/src/services/api.js` | Update `getCourses()` to accept `view` param; add `importCourse(sectionId)` |
| `client/src/pages/Dashboard.jsx` | Tab toggle; archived grouped view with derivation logic; import form; rename button |

No schema migrations required.

---

## Out of Scope

- Automatic backward probing for past sections (manual entry only)
- Deleting imported past courses from the UI (use Show/Hide Courses for now)
- Editing `grading_period` after import
