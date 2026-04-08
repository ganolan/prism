# Mastery / Standards-Based Grading Implementation Plan

**Issue:** ganolan/prism#7 — Assignment Scores Not Relevant  
**Status:** Backend complete (with bugfixes), UI scaffolded, first sync not yet verified  
**Started:** 2026-04-08

## Problem

Prism displays overall assignment scores, which are meaningless under HKIS standards-based grading. Students are awarded proficiency levels (IE/EM/D/EX/ED) per measurement topic per assignment. Only summative assessments count. The public Schoology API blocks this data (403 on `grading_rubrics`).

## Discovery (2026-04-08)

Found that Schoology's internal school-domain APIs expose all the mastery data. These work with a browser session (no OAuth), so we use Playwright.

### Confirmed internal endpoints

| Endpoint | Purpose |
|---|---|
| `GET /course/{id}/district_mastery/api/aligned-objectives?building_id=...&section_id=...` | Reporting categories + measurement topics (hierarchy) |
| `GET /course/{id}/district_mastery/api/material-observations/search?objective_id=...&section_id=...` | Per-student scores for one topic (bulk sync) |
| `GET /course/{id}/district_mastery/api/observations/search?student_uids=...&material_id=...` | All topic scores for one student+assignment (grading panel) |
| `GET /iapi2/district-mastery/course/{id}/materials?material_id_types[0]=...` | Assignment names + metadata |
| `POST /iapi2/district-mastery/course/{id}/observations` | Write mastery scores back |

### Write endpoint payload

```json
{
  "enrollmentId": 3359258824,
  "gradeInfo": { "<topic-uuid>": { "grade": "75.00", "gradingScaleId": 21337256 } },
  "gradeItemId": 8047104185,
  "materialId": 8047104185, "materialType": "ASSIGNMENT",
  "maxPoints": 100, "isGradebook": true,
  "gradingPeriodId": 1123041, "gradingCategoryId": 90141391
}
```

### Key mapping

- `student_uid` in observations matches Prism's `students.schoology_uid`
- `enrollmentId` for writes = Prism's `enrolments.schoology_enrolment_id`
- `alignment_id` in per-student GET = measurement topic UUID = `gradeInfo` keys in write
- `gradingScaleId: 21337256` = HKIS General Academic Scale (constant)
- Points: 0=IE, 25=EM, 50=D, 75=EX, 100=ED

## Architecture

### DB tables added (`server/db/schema.sql`)

- `reporting_categories` — UUID PK, course_id FK, external_id, title, weight
- `measurement_topics` — UUID PK, category_id FK, course_id FK, external_id, title, weight
- `mastery_scores` — student_uid + assignment_schoology_id + topic_id (unique), points, grade

Assignments table extended with `mastery_grading_period_id`, `mastery_grading_category_id`.

### Backend service (`server/services/masterySync.js`)

- `syncMasteryForCourse(courseId)` — Playwright scraper: navigates to district_mastery page, fetches aligned-objectives, loops topics to get observations, stores in DB
- `writeMasteryScores({...})` — POST to Schoology write endpoint
- `getRubricScoresForStudent({...})` — GET per-student per-assignment scores
- `getMasteryForCourse(courseId)` — Read from local DB (no Playwright)
- `interactiveLogin()` — Opens visible browser for user to log in to Schoology

### API routes (`server/routes/mastery.js`)

- `POST /api/mastery/login` — Open browser for Schoology login
- `POST /api/mastery/sync/:courseId` — Trigger Playwright sync (logs to sync_log)
- `GET /api/mastery/:courseId` — All mastery data from DB
- `GET /api/mastery/:courseId/student/:studentUid` — Per-student breakdown
- `GET /api/mastery/:courseId/rubric?studentUid=&assignmentId=` — Pre-populate grading panel
- `GET /api/mastery/:courseId/assignment/:assignmentId` — Class view for assessment summary
- `POST /api/mastery/:courseId/write` — Write scores to Schoology
- `POST /api/mastery/:courseId/write-comment` — Write grade comment to Schoology

### Frontend components

1. **`MasteryPerformanceSummary.jsx`** — Grid on student page (per course section):
   - Rows = summative assessments (linked to assessment summary)
   - Columns = measurement topics grouped by reporting category
   - Cells = color-coded proficiency levels (ED/EX/D/EM/IE)
   - Summary: topic averages, counts, modes, category averages
   - Letter grade badge + popup with HKIS translation scale
   - "Schoology Reported" row (placeholder, not yet populated)

2. **`AssessmentSummaryPage.jsx`** — Whole-class rubric view:
   - Route: `/course/:courseId/assessment/:assignmentId`
   - Per-student cards with topics x 5 proficiency columns
   - Current = green fill, pending change = green border
   - Editable teacher comment field
   - "Update Schoology" button: writes proficiencies + comment simultaneously

3. **CoursePage** — "Sync Mastery" button with:
   - Spinner during sync
   - Success/error messages
   - "Log in to Schoology" button when session expired

### Session management

Playwright uses a dedicated profile directory (`.playwright-session/`, gitignored) instead of Chrome's live profile (which is locked while Chrome is running). First-time setup: `npm run mastery:login` opens a visible browser for the user to log in to Schoology.

## What works (verified)

- DB schema: tables created, migrations run
- Server starts cleanly with all routes loaded
- Sync button triggers the sync flow
- Login detection returns clear error message

## What needs verification

- [ ] End-to-end sync: login → fetch objectives → fetch observations → store in DB
- [ ] MasteryPerformanceSummary renders when data is present
- [ ] AssessmentSummaryPage loads and displays student cards
- [ ] Write-back: proficiency changes POST correctly to Schoology
- [ ] Comment write-back via pushGradeComments

## Known issues / TODO

1. **"Schoology Reported" row** — bottom row of performance summary shows "—". Need to find the internal endpoint for per-student category averages or store them from write responses.
2. **Letter grade computation** — approximate heuristic, not the exact HKIS combination table. Labeled as approximate; popup shows scale reference.
3. **Session expiry** — no automatic re-login. If session expires, user must click "Log in to Schoology" or run `npm run mastery:login`.

## If we need to revert

All mastery code is cleanly separated:
- **DB:** `reporting_categories`, `measurement_topics`, `mastery_scores` tables can be dropped. Migrations in `db/index.js` add two columns to `assignments` (safe to leave).
- **Backend:** Delete `server/services/masterySync.js`, `server/routes/mastery.js`. Remove import from `server/index.js`.
- **Frontend:** Delete `client/src/components/MasteryPerformanceSummary.jsx`, `client/src/pages/AssessmentSummaryPage.jsx`. Remove imports from `App.jsx`, `StudentPage.jsx`, `CoursePage.jsx`. Remove mastery API functions from `api.js`.
- **Deps:** `playwright` can be removed from `package.json`. Remove `postinstall` and `mastery:login` scripts.

The existing assignment/grade data and features are completely untouched.
