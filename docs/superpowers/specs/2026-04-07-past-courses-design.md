# Past Courses: Manual Import + Dashboard Tab Toggle

**Date:** 2026-04-07  
**Status:** Approved

## Overview

Prism's active sync (`/users/{uid}/sections`) only returns sections from the current grading period. Completed semester courses (e.g. MGD, which ended January 2026) and all courses from prior years are absent. This feature adds:

1. A fix to the sync so grading period data is stored correctly for all courses
2. A manual import flow for past courses (enter a Schoology section ID, Prism fetches and syncs it)
3. A **Current / Archived** tab toggle on the Dashboard replacing the existing checkboxes
4. Archived courses grouped by academic year, descending

---

## 1. Data Model

Three new columns on `courses`:

| Column | Type | Description |
|---|---|---|
| `is_current` | `INTEGER DEFAULT 1` | 1 = returned by active sync; 0 = historical/manually imported |
| `academic_year` | `TEXT` | e.g. `"2025-26"`, derived from grading period start/end dates |
| `semester` | `TEXT` | `"Full Year"`, `"Semester 1"`, or `"Semester 2"`, derived from grading period title |

The existing `grading_period TEXT` column is kept and populated with the full API title string (e.g. `"Semester 1: 08/14/2025 - 01/11/2026"`).

Migration: `ALTER TABLE courses ADD COLUMN ...` (×3), safe and additive. Existing rows get NULLs and will be populated on next full sync.

### Deriving `academic_year` and `semester`

From the grading period title and start date:

- If title contains `"Semester 1"` → `semester = "Semester 1"`
- If title contains `"Semester 2"` → `semester = "Semester 2"`
- Otherwise → `semester = "Full Year"`

For `academic_year`, use the start date:
- Start month Aug–Dec → `academic_year = "{start_year}-{start_year+1 % 100}"` e.g. Aug 2025 → `"2025-26"`
- Start month Jan–Jul → `academic_year = "{start_year-1}-{start_year % 100}"` e.g. Jan 2026 → `"2025-26"`

---

## 2. Sync Fix — Grading Period Data

**Problem:** The section object returns `grading_periods` as an array of integer IDs (e.g. `[1123041]`). The current sync reads `grading_periods[0].title` which is always `undefined`.

**Fix:** In `fullSync()` in `server/services/sync.js`, after upserting each course, call `GET /sections/{id}/grading_periods` to fetch the period objects. Parse the first result to extract `grading_period` (title), `academic_year`, and `semester`. Update the course record. Add `grading_period`, `academic_year`, `semester` to the upsert statement.

This adds ~1 API call per section per sync (currently ~10 sections — well within rate limits).

---

## 3. Import Endpoint

**`POST /api/courses/import`**

Body: `{ sectionId: string }`

Steps:
1. Call `GET /sections/{sectionId}` — verify 200 (accessible section)
2. Call `GET /sections/{sectionId}/grading_periods` — get period details
3. Derive `academic_year` and `semester`
4. Upsert course with `is_current = 0`
5. Sync enrollments, assignments, grades (same logic as `fullSync` per-section block)
6. Return `{ course, studentsCount, assignmentsCount, gradesCount }`

Errors:
- 403 from Schoology → return 403 `{ error: "Section not accessible" }`
- 404 from Schoology → return 404 `{ error: "Section not found" }`
- Already exists → re-sync and return updated data (idempotent)

---

## 4. Courses API Changes

`GET /api/courses` gains a `view` query parameter:

- `?view=current` → `WHERE is_current = 1 AND hidden = 0 ORDER BY course_name`
- `?view=archived` → `WHERE is_current = 0 AND hidden = 0 ORDER BY academic_year DESC, course_name`

Default (no param): existing behaviour unchanged for backwards compatibility.

The existing `?archived=true` and `?hidden=true` params remain for now but are no longer used by the Dashboard.

---

## 5. Dashboard UI

### Tab Toggle

Replace the existing "Show archived" and "Show hidden" checkboxes with a two-button tab toggle at the top of the course list:

```
[ Current ]  [ Archived ]
```

Default: Current tab active.

### Current Tab

Identical to today's layout. No changes.

### Archived Tab

Courses grouped by `academic_year`, descending (most recent first). Within each year, courses are sorted alphabetically.

**Group header:** `2025-26` (plain text, styled as a section divider)

**Course cards:** Same component as current courses, with slightly reduced opacity (`0.75`) to visually distinguish past courses. Cards show `semester` as a small badge (e.g. `Semester 1`, `Full Year`).

The existing Archive/Unarchive button on course cards is removed — archive state is now determined by sync state only.

### Add Past Course Form

Rendered at the bottom of the Archived tab (not the Current tab).

```
Add a past course
─────────────────────────────────────────────
Section ID  [ _________________ ]
            Find this in the Schoology URL:
            schoology.hkis.edu.hk/course/[ID]/materials

                                    [ Import ]
```

On submit:
- Button shows loading state
- On success: course appears in the list immediately, a brief success banner shows the course name, student count, and assignment count
- On error: inline error message below the input

---

## 6. Files Affected

| File | Change |
|---|---|
| `server/db/schema.sql` | Add `is_current`, `academic_year`, `semester` columns |
| `server/db/index.js` | Run migration for new columns on startup |
| `server/services/sync.js` | Fetch grading periods per section; populate new fields; set `is_current = 1` on synced courses |
| `server/routes/courses.js` | Add `?view=` param handling; add `POST /import` endpoint |
| `client/src/services/api.js` | Update `getCourses()` to accept `view` param; add `importCourse(sectionId)` |
| `client/src/pages/Dashboard.jsx` | Replace checkboxes with tab toggle; add archived grouped view; add import form |

---

## Out of Scope

- Automatic backward probing for past sections (manual entry only)
- Deleting imported past courses from the UI (use hide for now)
- Editing `academic_year` or `semester` after import
