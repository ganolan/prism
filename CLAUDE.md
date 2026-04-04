# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Prism is a local-first teacher dashboard for viewing, managing, and enriching student data from Schoology and PowerSchool. It combines a React frontend, an Express API, and a local SQLite database, with feature-flagged tools for analytics, notes, flags, feedback review, and future Schoology write-back workflows.

For the full product intent, roadmap, and phased requirements, see `product-spec.md`.

## Setup

```bash
npm install
cd client && npm install
```

Credentials live in `.env` (gitignored):
```
SCHOOLOGY_BASE_URL=https://api.schoology.com
SCHOOLOGY_CONSUMER_KEY=...
SCHOOLOGY_CONSUMER_SECRET=...
```

Optional local overrides:
```
PORT=3001
DB_PATH=server/db/students.db
INBOX_DIR=inbox
CONFIG_PATH=config.yaml
```

## Running

```bash
npm run dev        # Express + Vite
npm run dev:server # server only
npm run dev:client # client only
npm run build      # frontend production build
npm run test:api   # Schoology API smoke test
```

## Architecture

- **ESM project** (`"type": "module"` in package.json)
- **Local-first app** with React frontend, Express backend, and SQLite persistence
- **OAuth 1.0a** two-legged auth with PLAINTEXT signature via `oauth-1.0a` package
- Token is empty (`{ key: '', secret: '' }`) for two-legged flow
- Frontend talks to backend only through relative `/api/...` endpoints
- Feature flags live in `config.yaml`
- Local paths for DB, config, and inbox can be overridden via environment variables
- All Schoology API requests go to `https://api.schoology.com/v1/...` — never the school domain (`schoology.hkis.edu.hk`), which redirects to Microsoft SSO

## Schoology API Quirks

- **`/users/me` redirects** (303) to `/users/{uid}`. Must follow redirects manually with fresh OAuth headers per hop — reusing the same nonce/signature on the redirected URL fails.
- **Per-assignment grade endpoint is 403**: `GET /sections/{id}/assignments/{aid}/grades` returns 403. Use the section-level `GET /sections/{id}/grades` instead, which returns all assignment grades including the target.
- **Grade `comment` field**: Present on grade objects from the section-level grades endpoint. `comment_status: 1` means visible to student; `null` means no comment. Cannot be written via `PUT /sections/{id}/assignments/{aid}/grades/{uid}` (returns 405). **CAN be written via bulk `PUT /sections/{id}/grades`** — wrap in `{ "grades": { "grade": [{ assignment_id, enrollment_id, grade, comment, comment_status: 1 }] } }`. Returns 207 with per-entry `response_code: 204`. Works for single or multiple students.
- **Two comment systems**: (1) Submission comments: `POST /sections/{id}/submissions/{aid}/{uid}/comments` — per-student dropbox comments. (2) Assignment comments: `POST /sections/{id}/assignments/{aid}/comments` — discussion-thread style.
- **Comment POST body must be flat**: Use `{ "comment": "text" }`, NOT `{ "comment": { "comment": "text" } }`. The nested form causes PHP to cast the inner object to the string `"Array"`, resulting in a blank comment.
- **Enrollments**: `GET /sections/{id}/enrollments` returns all members. Filter by `admin !== 1` to get students only.
- **User profiles**: `GET /users/{uid}` returns full profile including `primary_email`, `name_first_preferred`, and `parents.parent[]` array with parent/guardian names and emails. Enrollment records only have basic name info — must fetch full profile separately per student for contact details.

## Verified Endpoints

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/users/me` | 200 (via redirect) | Follow 303 manually |
| GET | `/v1/users/{uid}` | 200 | Full profile: email, parents[], preferred name |
| GET | `/v1/users/{uid}/sections` | 200 | Lists all sections |
| GET | `/v1/sections/{id}/assignments` | 200 | Paginated (`?start=&limit=`) |
| GET | `/v1/sections/{id}/grades` | 200 | All grades, includes `comment` field |
| GET | `/v1/sections/{id}/enrollments` | 200 | Members with UIDs |
| GET | `/v1/sections/{id}/submissions/{aid}/{uid}/comments` | 200 | Per-student submission comments |
| POST | `/v1/sections/{id}/submissions/{aid}/{uid}/comments` | 201 | Post submission comment |
| POST | `/v1/sections/{id}/assignments/{aid}/comments` | 201 | Post assignment comment |
| PUT | `/v1/sections/{id}/grades` | 207 | Bulk grade+comment update; per-entry 204 on success |
| GET | `/v1/sections/{id}/assignments/{aid}/grades` | 403 | Blocked — use section-level instead |
| PUT | `/v1/sections/{id}/assignments/{aid}/grades` | 405 | Not allowed — use section-level bulk PUT |
| PUT | `/v1/sections/{id}/assignments/{aid}/grades/{uid}` | 405 | Not allowed — use section-level bulk PUT |

## Project Memory

### Build Progress

#### Phase 1 MVP — COMPLETE (2026-04-03)

- [x] Project structure: Express backend + React/Vite frontend + SQLite
- [x] Database schema: students, courses, enrolments, assignments, grades, notes, flags, sync_log
- [x] Schoology sync service: OAuth 2-legged, paginated fetch of sections, enrollments, assignments, grades (with comments)
- [x] Express API: /api/courses, /api/students, /api/grades, /api/sync, /api/import, /api/features
- [x] React frontend: Dashboard, CoursePage (roster + gradebook), StudentPage (profile + grades), SearchPage, ImportPage
- [x] PowerSchool CSV import with flexible column mapping
- [x] Feature flags via config.yaml
- [x] Validated: 2,616 records synced (10 sections, 109 students, 1,575 grades, 310 with comments)

#### Phase 2 Enrichment — COMPLETE (2026-04-03)

- [x] Notes CRUD: create, update, delete notes per student (general or course-specific)
- [x] Flags CRUD: create flags with type (custom, review_needed, late_submission, performance_change), resolve/reopen workflow
- [x] Notes + flags UI on student profile page with inline editing
- [x] Active flags banner on student page
- [x] Class tools backend + frontend page includes email list generation, random name picker, and group generator with CSV export
- [x] Course archive toggle on dashboard (show/hide archived, archive/unarchive button)
- [x] Preferred names already done in Phase 1 (displayed everywhere, legal name shown in parentheses)

#### Phase 3 Analytics — COMPLETE (2026-04-03)

- [x] Recharts installed for charting
- [x] Course analytics page (`/course/:id/analytics`) with box-and-whisker distributions, class average trend, formative vs summative comparison, and assignment type tagging
- [x] Student analytics on profile page with per-course trends, cross-course comparison, and performance alerts
- [x] Automated flags engine (`POST /api/analytics/auto-flags/:courseId`) for missing work, performance drops, and low grades
- [x] Validated: 10 distributions generated for AIML, 179 auto-flags created, student alerts working

#### Phase 4 Feedback Review — COMPLETE (2026-04-03)

- [x] Schema: feedback table + inbox_log table added to schema.sql
- [x] Inbox ingestion service (`server/services/inbox.js`) for JSON intake, validation, ID resolution, import, file processing, and error logging
- [x] Feedback API routes (`server/routes/feedback.js`) for CRUD, approval, revision requests, batch approval, history, manual entry, uploads, and inbox processing
- [x] Feedback Review UI page (`/feedback`) with filters, detail editing, revision history, batch approve, manual entry, and inbox tools
- [x] Feature flags enabled: feedback_inbox, feedback_review, revision_workflow
- [x] Validated: inbox ingestion, edit with revision history, approve/revision workflow, manual entry, filters

#### Phase 5 (Schoology Write-Back) — ON HOLD

Key discovery: bulk `PUT /sections/{id}/grades` works for writing grade comments. Individual PUT returns 405.

**Blocked on:** Need a safe testing plan before implementing. Write-back touches live student data — must establish a sandbox approach (e.g. test section, dry-run mode, timestamp guards) before coding begins.

#### UI Theme Redesign — COMPLETE (2026-04-04)

Branch: `ui/theme-redesign`

- [x] Theme system: ThemeProvider context (`client/src/hooks/useTheme.jsx`) with `data-theme` attribute on `<html>`, localStorage persistence
- [x] Three themes: Prism (purple/pink light — default), Midnight (dark mode), Ocean (teal/blue light)
- [x] Theme switcher dots in sidebar bottom
- [x] Full CSS variable system in `app.css` — all colors, shadows, borders, gradients are theme-aware
- [x] All 8 page components + StudentAnalytics updated to use CSS variables (no hardcoded colors)
- [x] New button classes: `.primary`, `.secondary`, `.ghost`, `.tab-btn`, `.filter-btn`
- [x] New alert classes: `.alert-warning`, `.alert-success`, `.alert-error`, `.alert-info`
- [x] Inter font via Google Fonts, card hover animations, sidebar gradient

**Adding new themes:** Add a `[data-theme="name"]` block in `app.css` with all CSS variables, add the theme key to `themes` in `useTheme.jsx`. No component changes needed.

### Run Commands

```bash
npm run dev        # Express (3001) + Vite (5173 with proxy)
npm run dev:server # server only
npm run dev:client # client only
```

### Working Notes

- Track build progress across sessions so work is not repeated and spec items are not missed.
- Check this before starting a new phase.
- Schema already has tables for notes/flags (Phase 2) and will need feedback table (Phase 4).
- Phase 2 spec item not yet built: **class checklist generator** (create a checklist for a class, track completion per student, export as CSV).
- Phase 5 is on hold pending a safe testing strategy for Schoology write-back.

### Frontend Conventions

- **Theming:** All colors must use CSS custom properties from `app.css` — never hardcode hex values in components. Use `var(--accent)`, `var(--bg-subtle)`, `var(--card-bg)`, etc.
- **Button classes:** Use `.primary`, `.secondary`, `.ghost` (with `.danger`, `.success`, `.accent` modifiers), `.tab-btn`, `.filter-btn` — avoid inline button styles.
- **Alert/banner classes:** Use `.alert.alert-warning`, `.alert.alert-success`, etc. instead of inline colored divs.
- **Page wrapper:** Add `className="fade-in"` to the top-level div of each page for entry animation.
- **Sidebar width:** 240px (set in CSS), content margin-left matches.
