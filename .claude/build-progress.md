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

### Phase 5: Schoology Rollups + Overrides — COMPLETE (2026-04-24)

- **Authoritative per-(student, objective) rollups** (what Schoology's mastery gradebook UI actually displays): captured via `POST /course/{id}/district_mastery/api/outcomes/objectives`. Works for both reporting-category (parent) and measurement-topic (child) UUIDs.
- **Authoritative topic ↔ assignment alignments** via `POST /.../alignments/search` — replaces the previous inference-from-scores approach so "Pending" cells render even for topics with no scored student yet.
- **Override write-back**: `POST /.../nodes/{objectiveId}/outcome-override` sets or clears a teacher override. `grade_scaled` takes `"0.00"|"12.50"|"37.50"|"62.50"|"87.50"` (IE/EM/D/EX/ED) or `null`.
- **CSRF requirement documented**: all `/district_mastery/api/` POSTs need `X-CSRF-Token` + `X-CSRF-Key` from `window.Drupal.settings.s_common`. Added shared `postInternal()` helper in masterySync.js.
- **New tables**: `mastery_rollups` (per-student per-objective rollup with override_value), `mastery_alignments` (topic↔assignment). Both auto-create via `schema.sql`.
- **API additions**: `/api/mastery/:courseId` now includes rollups; `/api/mastery/:courseId/override` writes overrides.
- **UI**:
  - MasteryPerformanceSummary: "Schoology Reported per Reporting Category" row with accent-bordered cells. Click opens override popup (set any of 5 levels or clear). `*` marker when override is set.
  - CoursePage roster: replaced `Graded` / `Average` columns with grouped-header columns per reporting category (Computed / Schoology side-by-side), amber mismatch border when Prism-computed level ≠ Schoology-reported level. Schoology column accent-bordered, cells are clickable for override. Far-right "Computed Letter Grade" column with scale popover using the same `computeLetterGrade()` formula as MasteryPerformanceSummary.
  - StudentPage assignment table: 2 columns (Assignment | Score). For aligned assignments, title links to `/course/:id/assessment/:assignmentId` and a full-width CompactRubric renders below the name+due+flags row. Comment rendered as its own full-width `<tr>` below. CompactRubric uses each level's own palette for the student's earned cell (grading-green is reserved for the active rubric on the assessment page).
- **Reusable components**: `OverridePopup.jsx` (exported with `LEVEL_COLORS`, `LEVELS`, `LEVEL_LABELS`, `SCALED_FOR_LEVEL`). `LetterGradePopup` + `computeLetterGrade` + `LETTER_GRADE_COLORS` exported from MasteryPerformanceSummary.
- **Discovery scripts** for future API work: `scripts/capture-mastery-xhr.js` (`npm run mastery:capture [sectionId]`), `scripts/test-rollup-fetch.js`, `scripts/test-alignments-fetch.js`.

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

## OneDrive/GDrive Submission Badges (#62) + Gradebook Pre-filter (#55) — COMPLETE (2026-05-31)

The public revisions API (`/sections/{id}/submissions/{aid}/{uid}`) can't tell "submitted, awaiting
grade" from "never opened" for `lti_submission` (OneDrive/GDrive) dropbox assignments — both return an
empty revision array. Schoology's internal gradebook bootstrap closes the gap.

- **Endpoint**: `GET /iapi/grades/grader_header_data/{sectionId}` (browser session, one call/section).
  Verified shape (2026-05-31): `body.grades[{uid}][{gradeItemId}]` cells; a non-null `submission`
  (enum `"drop"`/`"assessment"`) = submitted. Outer key = uid (= `enrollment.uid`); inner key =
  grade-item id = public `assignment.id` (= `schoology_assignment_id`). See schoology-api-reference.md
  (the keying there was corrected — it had said enrollmentId/itemNid).
- **Parser**: `server/lib/parseGraderHeaderData.js` (pure, TDD — `parseGraderHeaderData` +
  `buildSubmissionLookup`; 11 tests).
- **Service**: `server/services/graderSubmissions.js` — `createSubmissionFetcher()` reuses one headless
  browser across the sync; best-effort (returns null with no session → public-API-only fallback, never
  throws into the sync).
- **Schema**: `grades.submission_type TEXT` (NULL = no positive signal / outside the grading period
  grader_header_data returns; `"drop"`/`"assessment"` = submitted). Migration + schema.sql.
- **Sync wiring** (`syncSectionData`): GHD lookup injected via `opts.fetchSubmissionLookup`, created
  once in `fullSync`. #62 — a GHD "submitted" cell upserts `submission_type` (inserting the row if
  needed, so submitted-but-ungraded OneDrive surfaces). #55 — a GHD "not submitted" (bare) cell SKIPS
  the rate-limited public revisions call (counted as `submissionSkipped`). Cells GHD doesn't cover fall
  back to the public API and leave `submission_type` untouched.
- **Badge**: `submissionStatus()` (client `gradeLabel.js`) treats `submission_type` as the authoritative
  "Submitted" signal, with `submitted_at>0` as fallback. Exposed via `courses.js` gradebook +
  `students.js`; CoursePage/StudentPage call sites pass it through. (4 sync tests + client
  `gradeLabel.test.js`.)
- **Still open**: #53 OneDrive resubmission *timing* — `submission` is a type enum with no timestamp;
  the per-cell grade-data POST behind the grid remains the lead.

## UI Theme Redesign — COMPLETE (2026-04-04)

Merged via PR #2.

- [x] Theme system with CSS custom properties and `data-theme` attribute
- [x] Three themes: Prism (blues/pinks/purples light), Midnight (dark), Ocean (teals light)
- [x] React Context + localStorage persistence via `useTheme.jsx`
- [x] Theme switcher dots in sidebar
- [x] All page components updated for theme variables

## Past-Course Discovery & Import (#5) — COMPLETE (2026-05-31)

Spec `docs/superpowers/specs/2026-05-31-past-course-discovery-design.md`, plan
`docs/superpowers/plans/2026-05-31-past-course-discovery.md`. Built via subagent-driven TDD; all tests
green (server 121, client 123).

- **Parser** `server/lib/parsePastCourses.js` (pure, TDD) — scrapes `GET /courses/mycourses/past` HTML
  (no JSON endpoint) into section-grained rows `{courseId, courseTitle, courseCode, sectionId, sectionTitle}`;
  empty `.course-code` → `null` (MASTER-style no-code signal).
- **Service** `server/services/archivedCourses.js` — best-effort one-shot browser-session fetch (mirrors
  `graderSubmissions.js`; shared `server/lib/browserSession.js` holds `SCHOOLOGY_BASE`/`isLoggedInUrl`),
  `getArchivedSections(fetchHtml)` injectable, returns `null` when no/expired session (never throws).
- **Endpoint** `GET /api/courses/archived/discover` (two-segment path, before `/:id`) —
  `{available:false, reason:'no_session'}` or `{available:true, sections:[…+imported,+noCourseCode]}`;
  reuses existing `POST /api/courses/import`.
- **UI** `client/src/components/ArchivedCoursesPanel.jsx` ("Import archived courses" panel in the Sync
  dialog) — import-once: imported archived courses grouped by year (via extracted
  `client/src/lib/courseDisplay.js`), explicit "Check Schoology for archived courses" scrape, per-course
  Import buttons + a full-width "Import all (excl. no-code)" with live progress; imported rows show a
  green "Imported ✓" badge (non-actionable); login prompt reused on no-session. Current courses got a
  `formatLastSynced` line (UK/AU `en-GB` DD/MM/YYYY).
- **Terminology** (see `CONTEXT.md`): **"archived"** is the canonical app term for past/completed courses;
  **"past"** is reserved for Schoology's `/mycourses/past` source page + its parser (`parsePastCourses`).
- **LIVE-VERIFIED 2026-05-31** against the real page: it is **45 `course-item` rows = 19 distinct courses
  (a course recurs once per term, one id up to 6×) / 49 unique sections** (49 distinct `section-{id}`,
  **0 duplicate rows**, 2 no-code). Parser attributes title/code per-row, so recurrence is harmless; import
  keys on the unique `sectionId`. Corrected the "~45 courses" claim in `schoology-api-reference.md`.
- **Decisions**: import is **gradebook-only** (`syncSectionData`) — mastery (SBG) stays opt-in via Step 2's
  Archived group; whether the internal mastery API serves past sections is **unverified**.
- **Not yet explored**: (a) the inert "Include archived" sync toggle (archived=past ⇒ never in the active
  batch) — flagged for a separate cleanup; (b) a configurable app-wide date-format/locale preference (asked
  for; deferred — would need a shared `formatDate` helper across the app); (c) discovery rows show repeated
  course names across terms with no year/term label (the scrape's per-row term metadata wasn't parsed);
  (d) bulk import only unit-tested — not yet exercised against a live multi-section import run.

## Archived-Import Relocation (#69) — COMPLETE (2026-05-31)

Spec `docs/superpowers/specs/2026-05-31-archived-import-relocation-design.md`, plan
`docs/superpowers/plans/2026-05-31-archived-import-relocation.md`. Frontend-only; built via subagent-driven
TDD with two-stage (spec + code-quality) review per task. All tests green (server 122, client 126); prod
build clean. Backend unchanged.

- **Relocation**: the archived-course discovery/import UI moved out of the **Sync dialog** onto the
  **Dashboard Archived tab**, rendered **above** the year-grouped imported-course cards. `SyncConfig` no
  longer renders the panel and `SyncDialog`'s `refreshCourses`/`onImported` wiring is gone (`loggedIn`/
  `onLogin`/`busy` stay — they drive the Step 2 mastery login prompt).
- **`ArchivedCoursesPanel` slimmed to discovery-only + self-contained**: dropped its internal
  imported-courses-by-year list (the Dashboard's cards are now the sole imported view — the de-dup), so it
  no longer needs `courses`/`courseDisplay` helpers; props are just `{ onImported }` (wired to the
  Dashboard's `reload`). Removed the collapse caret + "Import once" badge (always visible now). Owns its
  Schoology login: `triggerMasteryLogin` + local busy, and **auto-re-runs discovery** on login success
  (`handleCheck` solely owns the `needLogin` transition). Kept: Check→"Import all (excl. no-code)"
  transform-in-place, per-course Import, import-once, error display.
- **Removed** the Dashboard's manual "Add an archived course" (Section-ID) import form and its dead state/
  handler (`importId`/`importing`/`importError`/`importSuccess`/`handleImport`, the `importCourse` import).
- **Restyle**: replaced the panel's `sync-*` chrome with a Dashboard-matched `.archived-import*` class set
  in `app.css` (CSS variables only; uppercase-muted section header like the year groups). The login alert
  keeps the neutral shared `sync-login-prompt` spacing helper.
- **Tests**: rewrote `ArchivedCoursesPanel.test.jsx` (8 tests incl. login-failure path) and added
  `Dashboard.test.jsx` (panel present above cards via button-role assertion; manual form gone); removed the
  obsolete SyncConfig panel test. `CONTEXT.md` updated (the "Archived-course surfaces" section now notes the
  dialog has a single archived surface — the Step 2 mastery group — and the discovery surface lives on the
  Dashboard tab).
- **LIVE-VERIFIED 2026-05-31**: loaded the running app (Dashboard → Archived tab) — the "Import archived
  courses from Schoology" header + "Check Schoology for archived courses" button sit above the 2025-26 card
  group (the kept MOBILE GAMES DEVELOPMENT test course, shown once); no manual form; only a benign
  favicon.ico 404 in the console. Did **not** trigger the live Schoology scrape.
- **Not yet explored** (carried forward): (a) the inert "Include archived" sync toggle cleanup; (b) a
  configurable app-wide date-format/locale preference + shared `formatDate` helper (the relocated panel
  renders no dates now); (c) discovery rows still show repeated course names across terms with no year/term
  label (per-row term metadata not parsed); (d) "Import all" / bulk import still not exercised against a
  live multi-section run; (e) whether the internal mastery API serves archived sections is still unverified.

## Archived-Course Parity + Always-Fresh Student Data (#70) — COMPLETE (2026-05-31)

Spec `docs/superpowers/specs/2026-05-31-archived-parity-and-student-freshness-design.md`, plan
`docs/superpowers/plans/2026-05-31-archived-parity-and-student-freshness.md`. Sub-project A of the #5/#69
follow-up (sub-project B = #71). Backend-only; built via subagent-driven TDD with two-stage (spec +
code-quality) review per task + a final holistic review. Server 135 / client 126 tests green; prod build
clean. Resolves the prior entry's "not yet explored" (e) — **mastery for archived sections is confirmed
(user-verified) and now captured automatically**.

**Organising principle: immutability is per-data-type.** Gradebook + mastery freeze at archive time;
**student data never freezes** (refreshed + reconciled every sync for every retained student).

- **`enrichStudentProfiles(db, students, now)`** (`server/services/sync.js`) — extracted from `fullSync`'s
  inline profile loop and upgraded to **reconcile guardians**: upsert the guardians `getUserProfile`
  returns and **delete those it no longer returns — only on a successful fetch** (a failed fetch never
  wipes contacts). Normalises Schoology's single-guardian-as-object quirk. Students are never deleted.
  `fullSync` calls it for ALL students every sync (incl. students in no active course → no stale contacts).
- **`finalizeArchivedCourse(db, { courseId, sectionId, now, runMastery })`** — an archived course's
  IMMUTABLE snapshot: `syncSectionData` (gradebook, always) + `syncMasteryForCourse` (only when a browser
  session exists). Sets `courses.finalized_at` when a session was present (mastery attempted) so backfill
  doesn't retry forever; session-less leaves it null to retry next session-enabled sync.
- **`detectArchivedTransitions(db, activeSectionIds, now)`** in `fullSync` — auto-archive a previously-
  synced active course that dropped off `getMySections`, **confirmed via `getSection`**: `active:0` →
  finalise + `archived=1`; still `active:1` → leave (transient); 404 → `archived=1` (keep last snapshot);
  any other error → leave (no false-archive, explicitly tested).
- **`backfillUnfinalizedArchived(db, now)`** in `fullSync` — finalises archived courses with
  `finalized_at IS NULL` once (captures mastery for courses imported under the old flow). Runs **before**
  transition detection so a course archived this turn isn't double-finalised the same pass.
- **Import** (`POST /api/courses/import`) now finalises (gradebook + mastery) **and** enriches the
  imported section's students — closing the gap where archived imports lacked email/contacts.
- **Removed the redundant surfaces**: the inert **"Include archived" sync toggle** (+ its `includeArchived`
  plumbing through api → `/sync` → orchestrator → `fullSync`) and the **Step 2 "Archived courses" mastery
  group**. The recurring sync now **always skips archived** (immutable; never re-synced). Furthers #58.
- **Migration** `ALTER TABLE courses ADD COLUMN finalized_at TEXT`.
- **LIVE-VERIFIED 2026-05-31**: `finalized_at` column present in the real DB; the one existing archived
  course (`MOBILE GAMES DEVELOPMENT`) is `finalized_at=NULL` → correctly backfill-eligible; the Sync dialog
  no longer shows the "Include archived courses" toggle or the Step 2 "Archived courses" group. Did **not**
  trigger a real sync (would run backfill/transition against Schoology + mutate the DB) — backend covered
  by 135 server tests.
- **Out of scope / not yet explored**: sub-project B (#71 — archived-import UX: year/semester grouping,
  checkbox select-all/select-year, modal progress); PowerSchool safeguarding PII freshness (#66/#65 — the
  refresh-and-reconcile principle is recorded there); sync perf of enriching all retained students every
  sync as archived students accumulate (overlaps #55); a live end-to-end run of backfill + a real
  current→archived transition (logic is unit-tested, not yet observed against live Schoology).
