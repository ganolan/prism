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

## Standards-Based Grading (Issue #7) — IN PROGRESS

Branch: `feature/standards-based-grading`

### Phase 0: API Discovery — COMPLETE (2026-04-04)

Comprehensive probing of ~40+ Schoology API endpoint patterns. Key findings:
- Per-topic measurement ratings NOT available via API (mastery endpoint returns empty, grading_rubrics returns 403)
- Grade values ARE available and encode the number of measurement topics via averaging math
- Grading scales, categories, and periods are all accessible
- The `grading_rubrics` endpoint (documented, would have criteria+ratings) returns 403 — likely a permissions issue

Full details: `.claude/schoology-api-reference.md`

### Phase 1+: Implementation — NOT STARTED

Blocked on resolving API access for per-topic ratings. Two paths:
1. **Preferred**: Get admin/elevated API access to unlock `grading_rubrics` endpoint
2. **Fallback**: Scrape per-topic ratings from Schoology web UI via Playwright

## UI Theme Redesign — IN PROGRESS

Branch: `ui/theme-redesign`

- [x] Theme system with CSS custom properties and `data-theme` attribute
- [x] Three themes: Prism (blues/pinks/purples light), Midnight (dark), Ocean (teals light)
- [x] React Context + localStorage persistence via `useTheme.jsx`
- [x] Theme switcher dots in sidebar
- [x] All page components updated for theme variables
- [ ] Uncommitted — needs commit and PR
