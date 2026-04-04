---
name: Prism Build Progress
description: Tracks which phases of the student-dashboard-spec.md have been built, validated, and what remains
type: project
---

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
- [x] Class tools backend + frontend page:
  - Email list generator (student/parent/both, Outlook-friendly semicolon format, copy to clipboard)
  - Random name picker with animation (configurable count)
  - Group generator (configurable count, optional grade-balanced serpentine distribution, CSV export)
- [x] Course archive toggle on dashboard (show/hide archived, archive/unarchive button)
- [x] Preferred names already done in Phase 1 (displayed everywhere, legal name shown in parentheses)

## Phase 3 Analytics — COMPLETE (2026-04-03)

- [x] Recharts installed for charting
- [x] Course analytics page (`/course/:id/analytics`):
  - Box-and-whisker distribution per assignment (Q1/Q3 box, median, whiskers at 1.5x IQR, outlier detection)
  - Class average trend line with +/- 1 SD band
  - Formative vs summative comparison panel
  - Assignment type tagger (formative/summative/assignment/discussion/assessment)
- [x] Student analytics on profile page (StudentAnalytics component):
  - Grade trend line chart per course
  - Cross-course bar chart comparison
  - Performance alerts (configurable threshold, default 15%)
- [x] Automated flags engine (`POST /api/analytics/auto-flags/:courseId`):
  - Missing/ungraded work detection
  - Significant performance drops between consecutive assignments
  - Grades below configurable threshold (default 50%)
  - Idempotent: won't duplicate existing unresolved flags
- [x] Validated: 10 distributions generated for AIML, 179 auto-flags created, student alerts working

## Phase 4 Feedback Review — COMPLETE (2026-04-03)

- [x] Schema: feedback table + inbox_log table added to schema.sql
- [x] Inbox ingestion service (server/services/inbox.js):
  - Scans inbox/ folder for JSON files, validates against schema
  - Resolves student/assignment IDs (internal, schoology_uid, or powerschool_id)
  - Imports to feedback table as draft, moves to inbox/processed/
  - Supports single objects or arrays of feedback items
  - Logs errors to inbox_log table
- [x] Feedback API routes (server/routes/feedback.js):
  - CRUD: list with filters (status, course, flagged), detail with parsed JSON, update, delete
  - Approve, request-revision (with teacher notes), batch-approve unflagged
  - Revision history: auto-saved on edit, stored as JSON array
  - Manual entry (status starts as approved), JSON file upload
  - Inbox processing trigger, inbox log viewer
- [x] Feedback Review UI page (/feedback):
  - Split panel: filterable list (left) + detail view (right)
  - Status filters: all, draft, flagged, revision_requested, revised, teacher_modified, approved
  - Course filter dropdown
  - Inline editing of score, narrative, teacher notes
  - Strengths/suggestions/rubric display
  - Revision history viewer with diff indicators
  - Batch approve button for unflagged drafts
  - Manual entry form (select course -> student -> assignment)
  - JSON upload button, process inbox button
- [x] Feature flags enabled: feedback_inbox, feedback_review, revision_workflow
- [x] Validated: inbox ingestion, edit with revision history, approve/revision workflow, manual entry, filters

## Phase 5 (Schoology Write-Back) — NOT STARTED

Key discovery: bulk `PUT /sections/{id}/grades` works for writing grade comments. Individual PUT returns 405.

## Run commands
```bash
npm run dev        # Express (3001) + Vite (5173 with proxy)
npm run dev:server # server only
npm run dev:client # client only
```

**Why:** Tracking build progress across sessions so we don't repeat work or miss spec items.
**How to apply:** Check this before starting any new phase. Schema already has tables for notes/flags (Phase 2) and will need feedback table (Phase 4).
