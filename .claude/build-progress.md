# Build Progress

Tracks implementation status across Prism's development phases. Check this before starting any new phase to avoid repeating work or missing spec items.

## Phase 1 MVP — COMPLETE (2026-04-03)

- [x] Project structure: Express backend + React/Vite frontend + SQLite
- [x] Database schema: students, courses, enrolments, assignments, grades, notes, flags, sync_log
- [x] Schoology sync service: OAuth 2-legged, paginated fetch of sections, enrollments, assignments, grades (with comments)
- [x] Express API: /api/courses, /api/students, /api/grades, /api/sync, /api/import, /api/features
- [x] React frontend: Dashboard, CoursePage (roster + gradebook), StudentPage (profile + grades), SearchPage, ImportPage
- [x] PowerSchool CSV import with flexible column mapping
- [x] Feature flags via config.yaml
- [x] Validated: 2,616 records synced (10 sections, 109 students, 1,575 grades, 310 with comments)

## Phase 2 Enrichment — COMPLETE (2026-04-03)

- [x] Notes CRUD: create, update, delete notes per student (general or course-specific)
- [x] Flags CRUD: create flags with type (custom, review_needed, late_submission, performance_change), resolve/reopen workflow
- [x] Notes + flags UI on student profile page with inline editing
- [x] Active flags banner on student page
- [x] Class tools backend + frontend page includes email list generation, random name picker, and group generator with CSV export
- [x] Course archive toggle on dashboard (show/hide archived, archive/unarchive button)
- [x] Preferred names already done in Phase 1 (displayed everywhere, legal name shown in parentheses)

## Phase 3 Analytics — COMPLETE (2026-04-03)

- [x] Recharts installed for charting
- [x] Course analytics page (`/course/:id/analytics`) with box-and-whisker distributions, class average trend, formative vs summative comparison, and assignment type tagging
- [x] Student analytics on profile page with per-course trends, cross-course comparison, and performance alerts
- [x] Automated flags engine (`POST /api/analytics/auto-flags/:courseId`) for missing work, performance drops, and low grades
- [x] Validated: 10 distributions generated for AIML, 179 auto-flags created, student alerts working

## Phase 4 Feedback Review — COMPLETE (2026-04-03)

- [x] Schema: feedback table + inbox_log table added to schema.sql
- [x] Inbox ingestion service (`server/services/inbox.js`) for JSON intake, validation, ID resolution, import, file processing, and error logging
- [x] Feedback API routes (`server/routes/feedback.js`) for CRUD, approval, revision requests, batch approval, history, manual entry, uploads, and inbox processing
- [x] Feedback Review UI page (`/feedback`) with filters, detail editing, revision history, batch approve, manual entry, and inbox tools
- [x] Feature flags enabled: feedback_inbox, feedback_review, revision_workflow
- [x] Validated: inbox ingestion, edit with revision history, approve/revision workflow, manual entry, filters

## Phase 5 Schoology Write-Back — ON HOLD

On hold pending a safe test plan for write-back without risking live student data.

Key discovery: bulk `PUT /sections/{id}/grades` works for writing grade comments. Individual PUT returns 405.

## Standards-Based Grading (Issue #7) — PHASES 1-3 COMPLETE

### Phase 0: API Discovery — COMPLETE (2026-04-04)

Comprehensive probing of ~40+ Schoology API endpoint patterns. Key findings:
- Per-topic measurement ratings NOT available via public REST API
- **RESOLVED**: Internal API on school domain provides full mastery data via Playwright browser session

### Phase 1: DB Schema — COMPLETE (2026-04-08)

- `reporting_categories` table (UUID, course_id, external_id, title, weight)
- `measurement_topics` table (UUID, category_id, course_id, external_id, title, weight)
- `mastery_scores` table (student_uid, assignment_schoology_id, topic_id, points, grade)

### Phase 2: Playwright Scraper Service — COMPLETE (2026-04-08)

- `server/services/masterySync.js`: `syncMasteryForCourse()`, `getRubricScoresForStudent()`, `writeMasteryScores()`
- Interactive login flow (`npm run mastery:login`)
- Bulk sync and per-student-assignment lookup

### Phase 3: API Routes + UI — COMPLETE (2026-04-08)

- `/api/mastery/sync/:courseId`, `/api/mastery/:courseId`, `/api/mastery/:courseId/student/:studentUid`
- `/api/mastery/:courseId/rubric`, `/api/mastery/:courseId/write`, `/api/mastery/:courseId/write-comment`
- `/api/mastery/:courseId/assignment/:assignmentId` (whole-class rubric view)
- MasteryPerformanceSummary component with per-topic grid, category averages, letter grade approximation
- AssessmentSummaryPage with whole-class mastery view and inline grading/write-back

### Phase 4: UI Enhancements — NOT STARTED

- Rubric grading panel: load current scores, pick new levels, write back to Schoology

## Unused API Fields (Issue #13) — COMPLETE (2026-04-20)

### Schema Additions
- `assignments`: added `grading_category_id`, `grading_scale_id`, `folder_id`
- `students`: added `grad_year`, `school_uid`
- `grades`: added `late`, `draft`
- New tables: `folders`, `grading_categories`

### Sync Enhancements
- Assignments now store `grading_category`, `grading_scale`, `folder_id`, `published`, `display_weight` from Schoology
- Student `school_uid` stored from enrollment response
- Student `grad_year`: column exists but **Schoology API does not return grad_year for student profiles** (only present on teacher/staff profiles). Needs PowerSchool API access.
- Late flag derived from Schoology exception code (exception=4)
- Folders and grading categories synced per course (folder API key fixed: `data.folders` not `data.folder`)
- Assignment ordering uses folder display_weight (primary) + assignment display_weight (secondary) to match Schoology page order

### Formative/Summative Auto-Detection
- **Rule**: `grading_scale_id === '21337256'` (General Academic Scale) = summative; everything else = formative
- Analytics and gradebook now auto-detect assignment type — no manual tagging needed
- Removes the prior bug where courses with non-standard category names (MAD, Robotics) showed no mastery data

### UI Changes
- Gradebook: shows S/F badges on column headers based on grading scale
- Gradebook: exception badges (Excused, Incomplete, Missing, Late) with color coding
- Gradebook: late indicator ("L" badge) on scores
- Student page: grade level + graduating year badge on profile header
- Student page: student ID displayed
- Student page: exception and late/draft badges per assignment
- Student page: student ID from email prefix (not school_uid which is Schoology-internal like "1_38757")
- Course page: section_school_code shown in header
- All assignment/grade queries filter `published = 1` (excludes unpublished)
- Mastery topic derivation fixed: queries join through mastery_scores→assignments by course_id, not measurement_topics.course_id (fixes shared standards across courses — MAD now shows mastery)

### Known Issues
- `grad_year` not available from Schoology API for students (needs PowerSchool credentials)
- Robotics mastery: course has summative assignments but mastery sync needs to be run for it
- Assignment ordering requires a fresh sync to populate the folders table (bug fixed: API returns `data.folders` not `data.folder`)

### Not Implemented (by design)
- Completion data: not useful for the mastery-based system
- count_in_grade: does not affect mastery calculation which determines final grades
- Folder grouping in UI: folder structure used only for ordering, not visual grouping

## UI Theme Redesign — COMPLETE (2026-04-04)

Merged via PR #2.

- [x] Theme system with CSS custom properties and `data-theme` attribute
- [x] Three themes: Prism (blues/pinks/purples light), Midnight (dark), Ocean (teals light)
- [x] React Context + localStorage persistence via `useTheme.jsx`
- [x] Theme switcher dots in sidebar
- [x] All page components updated for theme variables
