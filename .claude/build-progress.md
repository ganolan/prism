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

## Archived-Import UX — Year/Semester Grouping + Bulk Import (#71) — COMPLETE (2026-05-31)

Spec `docs/superpowers/specs/2026-05-31-archived-import-ux-design.md`, plan
`docs/superpowers/plans/2026-05-31-archived-import-ux.md`. Sub-project B of the #5/#69 follow-up (A = #70).
Frontend + one server parser change; built via subagent-driven TDD with two-stage (spec + code-quality)
review per task + a final holistic review. Server 139 / client 153 tests green; prod build clean. Depends
on #70 (import already finalises gradebook + mastery + enriches — **no backend import-flow change here**).

- **Live-probe finding (resolved the open question):** Schoology's `/courses/mycourses/past` page already
  groups courses under `<h3>` grading-period headers (e.g. `Semester 1: 08/14/2025 - 01/11/2026`,
  `2024-2025: …`, `22-23 YR · …`). So term metadata is obtained by **parsing the page in document order —
  zero extra API calls** (the rejected alternative was a per-section `grading_periods` fetch).
- **`parsePastCourses`** (`server/lib/parsePastCourses.js`) rewritten as a document-order DFS that carries
  the most-recent term `<h3>` and attaches `gradingPeriod` to each section row (+ dedupe by sectionId).
  The discover route passes it through unchanged (the existing `...s` spread).
- **`parseGradingPeriod`** (`client/src/lib/courseDisplay.js`) hardened — prefers an explicit year range
  (`2024-2025`/`22-23`), tolerates single-digit months, understands `S1`/`S2`/`YR`/`Summer`. This also
  fixed the EXISTING card grouping, which silently bucketed those shapes under "Unknown". New
  **`groupByYearAndSemester`** (year desc, Unknown last; semester order S1→S2→Summer→Full Year→Unknown;
  accessor param serves both `c.grading_period` cards and `s.gradingPeriod` discovery rows).
  `groupByAcademicYear` removed (Dashboard was its only consumer).
- **Shared `TriCheckbox`** extracted from `SyncConfig` into its own component (used by both).
- **`ArchivedImportList`** — grouped, tri-state-selectable discovery list: global "Select all" + per-year
  tri-state + per-row checkboxes; per-year "Import all (k)" + a bottom "Import N selected". No-course-code
  sections are excluded from bulk select/counts but individually tickable. Selection prunes as sections
  drop out.
- **`useImportRunner`** hook — runs imports SEQUENTIALLY (mastery uses one browser session at a time),
  continue-on-error, exposes a render model (`rows`/`log`/`failures`/`progress`) + `retryFailed`/`reset`;
  re-entrancy-guarded; ref-stable `onComplete`.
- **`ImportProgress`** modal — mirrors `SyncProgress` (bar + per-course rows + scrolling log + Done),
  non-dismissable while running, with "Retry failed (n)". No login-remedy banner (gradebook import is
  OAuth-based; mastery is best-effort per #70, so a dead session silently skips mastery).
- **`ArchivedCoursesPanel`** slimmed to an orchestrator: discovery + `ArchivedImportList` +
  `useImportRunner` + `ImportProgress`; on completion it marks succeeded sections imported (drop from the
  list without a re-scrape) and refreshes the Dashboard cards (only when something succeeded).
- **Dashboard** archived cards now group **year → semester** (nested sub-headers), mirroring the discovery
  list; the redundant per-card semester badge was dropped (the raw `grading_period` date-range line stays).
- **Not yet explored / out of scope**: live UI verification of the grouped surfaces + a real multi-course
  bulk import (logic covered by the automated suites + clean build, but not yet exercised against live
  Schoology — the user's call); whether imported cards' stored `grading_period` strings group identically
  to discovery headers on live data (both funnel through the same hardened parser, not yet compared live);
  group collapse, parallel import, a skip-mastery-on-bulk toggle, and a configurable date/locale preference
  + shared `formatDate` helper (all deliberately deferred).

## Archived-Import Submission-Skip (#72) — COMPLETE (2026-06-03)

Import-side slice carved out of #55. Archived-course finalisation was slow for grade-heavy courses
(e.g. AP CSP) because `finalizeArchivedCourse` called `syncSectionData` with no opts, running the
public per-(assignment, student) `GET /sections/{id}/submissions/{aid}/{uid}` loop at concurrency 2.
Built via brainstorm → spec → plan → subagent-driven TDD (per-task spec + code-quality review + a final
holistic review). Server 150 tests green. Spec/plan at
`docs/superpowers/{specs,plans}/2026-06-03-skip-archived-import-submission-detection*`.

- **Determination (with the user):** imported archived courses are immutable (#70) and don't need per-cell
  OneDrive/GDrive M/NS or resubmission detection — that's a live grading-workflow signal, frozen for
  completed courses. The GHD pre-filter is also blind for archived/inactive sections (probed 2026-06-01),
  so it can't rescue the import. So archived finalisation **skips the submission loop entirely**; the bulk
  `GET /sections/{id}/grades` (one call) already provides scores.
- **`syncSectionData`** gained a `skipSubmissions` opt that short-circuits the dropbox list to `[]`, making
  the whole submission phase a clean no-op (the lookup fetch is `.length`-guarded, the loop never iterates,
  `writeSubmissions([])` is a no-op, counters zero out). Minimal one-ternary diff.
- **`finalizeArchivedCourse`** passes `{ skipSubmissions: true }` and logs
  `[archived] "<name>" — <grading_period> (section <id>): skipping per-cell submission detection (frozen)`.
  As the single chokepoint it covers all three archived paths — import, auto-archive transition, backfill.
- **Active recurring sync (`fullSync`) is untouched** — never sets the opt; verified by review + scope grep.
- **Frozen-state:** with the loop skipped, `late`/`draft`/`submission_type`/`latest_revision_at` come from
  the grades INSERT alone; the `ON CONFLICT` doesn't touch them, so re-finalisation preserves (never wipes)
  existing values. Accepted tradeoff: freshly-imported **native-dropbox** archived work won't get late/draft.
- **Docs:** added the GHD archived-section blindness note to `.claude/schoology-api-reference.md`.
- **Verified on real data (2026-06-03):** isolated before/after of the gradebook phase for **AI & MACHINE
  LEARNING 2024-25** (section `7361043390`, 12 students × 35 OneDrive dropbox assignments = 420 cells), run
  on a throwaway DB copy: **before = 96.2s** (420 per-cell submission GETs, `rateLimitHits=0`) → **after =
  3.0s** (0 submission calls, bulk only) — **93.2s saved, ~32× faster**. A full AP CSP 2024-25 import
  end-to-end measured **20.6s**, now dominated by mastery (gradebook loop off the critical path). Mastery
  (~20–40s/course) is the remaining archived-import floor, out of scope (next lever = the #77 spike).

## #62 True submission-state badges for lti_submission work — COMPLETE (2026-06-07)

Spec/plan `docs/superpowers/{specs,plans}/2026-06-07-lti-submission-state-badges*`. Built via subagent-driven TDD.

- **The bug:** the "Not Started" / "Missing" badges asserted a submission state Prism couldn't verify for
  OneDrive/GDrive (`lti_submission`) work — the public revisions API hides post-submit LTI revisions AND
  auto-provisions an empty `draft=1` revision at distribution, so neither presence nor absence is a real
  engagement signal; GHD's `submission` key gives *submitted* reliably but can't split in-progress from
  never-opened.
- **Spike (with the user):** driving the grader UI + grepping its React bundle found the endpoints behind
  the grader's own "In Progress" / "Submitted" tabs — `GET /iapi2/assignments/{aid}/submitted-documents/`
  and `/in-progress-documents/` (browser-session auth, per-assignment). In-progress entries carry a real
  boolean **`revisionCreated`**: `true` = opened/created their copy (In Progress), `false` = never opened
  (Not Started). Verified against teacher ground truth on Robotics Notebook 4. Recorded in
  `.claude/schoology-api-reference.md`.
- **Implementation:** new `assignments.is_lti_submission` (from Schoology's `assignment_type` field) +
  `grades.lti_submission_state` (`submitted`/`in_progress`/`not_started`). `server/lib/parseGraderDocuments.js`
  (pure parser) + `server/services/graderDocuments.js` (fetch via the existing single browser session, added
  as `fetchDocuments` on the GHD fetcher). Sync partitions dropbox work: lti uses the 2-call documents path
  (whole roster) and writes `lti_submission_state`; native dropbox keeps the per-cell public walk. This
  **removes** per-cell calls for lti — cheaper, not costlier (helps #55).
- **Badges (`gradeLabel.submissionStatus`):** one state machine, due-proximity tone ladder. lti: Submitted 🟢;
  In Progress 🔵 before due / 🟡 overdue; Not Started ⚪ early / 🔴 from a week before due through overdue;
  no-session fallback shows nothing before due, neutral "Ungraded" overdue (never a false Not Started).
  Non-lti consolidates to 🟢 Submitted or 🔴 Missing (overdue only). Both `SubmissionBadges` (full) and the
  gradebook compact badges updated; Submitted recoloured green per the user.
- **Tests:** parser unit tests; full `submissionStatus` matrix (13 client tests); a sync test that lti uses
  `fetchDocuments` and skips the per-cell walk. 195 server + 229 client green (the lone failing file,
  `mcp/server.test.js`, is a pre-existing missing-`@modelcontextprotocol/sdk` env gap, unrelated).
- **Live e2e (2026-06-07):** real Robotics sync → Notebook 4 `{in_progress:17, not_started:1, submitted:1}`,
  Maria = not_started, Brigid = submitted — exact ground-truth match. Caught a concurrency bug: the two
  document fetches ran via `Promise.all` (concurrent `page.evaluate` on one page) and the in-progress fetch
  silently dropped → fixed to sequential awaits.

## Sync bulk-perf wins — #55 / #104 / #105 (2026-06-08, branch `feat/sync-bulk-perf`)

Three independent, parity-exact bulk replacements for per-item sync loops. Each pairs unit TDD (pure
helpers + fetchers) with a **live parity probe** (`scripts/parity-*.js`) diffing old-vs-new against real
Schoology data — which caught two real shape bugs before merge (see below).

- **#55 — native-dropbox submissions: O(N×M) → O(M).** Replaced the per-(assignment×student)
  `getSubmissionStatus` walk with ONE `GET /sections/{sid}/submissions/{aid}` bulk fetch per native
  assignment, grouped by uid (`server/lib/submissionRevisions.js`: `summarizeRevisions` +
  `groupRevisionsByUid`; `schoology.js`: `getAssignmentSubmissions`). GHD wiring + all four
  `writeSubmissions` branches kept byte-for-byte; only the per-cell `revision` source changed.
  `retrySubmissions` converted too. **Parity probe finding:** the bulk endpoint returns only the
  **latest revision per student**, NOT full history (the spike's "all revisions" claim was wrong) — but
  it's **sync-equivalent** (the sync needs only the latest revision's late/draft + newest non-draft
  `created`; a genuine resubmit IS the latest). 0 summary-mismatches across MAD + all AP CSP CPT projects
  (heavy resubmission). Multi-file-across-revisions capture deferred to **#107** (lazy on-demand via
  `…/{uid}?with_attachments=1`). Live e2e: MAD sync = 4 bulk fetches (was ~32 cell calls), correct
  late/type/timing.
- **#104 — mastery observations: N GETs/course → 1 POST.** `syncCourseMastery` replaced the per-topic
  `material-observations/search` GET loop with one batched POST (`objective_ids` csv), regrouped by
  `objective_id` (`server/lib/masteryObservations.js`). **Parity probe finding:** the POST shape differs
  (`gradeable_material.material.id` + string `points`) — `normalizeObservation` maps it back to the GET
  shape, else the persist would have written `assignment_schoology_id="undefined"`. Parity exact on
  ACSS/AIML/AP CSP (212/314/439, 0 diff); live e2e re-sync wrote 212 ACSS scores, 0 bad assignment ids.
- **#105 — student profiles: N GETs → ceil(N/50) POSTs.** `enrichStudentProfiles` sources profiles from
  `getUserProfilesBatch` (`POST /v1/multiget`, chunk ≤50; `apiPost` mirrors `apiPut`). Preserve-on-failure
  semantics intact (absent-from-map → skip, never wipe). Live parity verified across all 211 students
  (email + preferred name + guardians; 0 mismatches).
- **Tests:** 228 server green. Probes kept under `scripts/`. api-ref rows flipped to SHIPPED with the two
  shape corrections. **Related spikes filed:** #107 (capture all submission-file refs on-demand;
  bulk-latest drops non-latest files) + an LTI "Open" file-link finding (Schoology MS/Google LTI submission
  app → 302 → SharePoint/OneDrive `Doc.aspx?sourcedoc={GUID}`; per-student launch id needs one more capture).

## GHD pre-filter cleanup — native submission path is now fully public-bulk (2026-06-08, branch `feat/drop-ghd-prefilter`)

Follow-up to the #55 bulk-submissions win. The grader_header_data (GHD) per-cell
**pre-filter** existed to skip expensive per-(student) submission calls for
not-submitted native-dropbox cells; once #55 made native dropbox ONE bulk fetch
per assignment, it saved zero calls and only supplied `submission_type`.

- `submission_type` is now **synthesized from the bulk revision** (`deriveNativeSubmission`
  in `server/lib/submissionRevisions.js`: a non-draft revision → `"drop"`, draft-only → null).
- The native write collapses to 2 branches (has-revision → upsert with type; none → clear),
  in both `syncSectionData` and `retrySubmissions` (retry now also carries `submission_type`).
- `fullSync` stops passing `fetchSubmissionLookup`; `submissions_skipped` metric removed.
- `graderSubmissions.js` slimmed to `fetchDocuments` (lti) only; **deleted** the dead
  `server/lib/parseGraderHeaderData.js` + `buildSubmissionLookup`. GHD is no longer read by Prism.
- Intended behavior change: `submission_type` now covers all grading periods (GHD was
  current-period only), and the public bulk revisions endpoint is authoritative for native.
  Live-verified on MAD: 4 bulk fetches (no browser session), 24/24 submitted cells →
  `submission_type 'drop'`, 0 mismatches vs the bulk-derived expectation.
- Net ~215 lines removed; 220 server tests green. api-ref GHD row marked NO-LONGER-USED.

## #106 — auto-populate courses.block_number from PowerSchool (2026-06-08, branch `spike/106-ps-block-number`)

Spike turned positive. The displayed "Block N" (teacher-confirmed ACSS = Block 3) is the PowerSchool
**period name**, reachable from `section_info` alone — no in-session date, no `userDcid`, no
`getattendance_integration` (which did NOT fire on the default grid render). Full intel in
`.claude/powerschool-api-reference.md` "Block number".

- **Resolution:** `section_info[0].bellScheduleItems[].period.name`, filtered to the section's periodId
  (`keys(periodIdToPsmPeriodIdMap)`), de-duped. ⚠️ `period.name` ≠ `periodNumber` ≠ Schoology expression
  number (APCSP: expr `7(A-B)`, periodNumber 7, but **Block 6**) — only `period.name` is correct.
- **Sync linchpin:** Schoology section → PS `sectionDcid` via `context.request.get(<LTI run URL>)` → regex
  `custom_sectiondcid` (Schoology fetch, no app load; empty = template → skip).
- **Code:** pure lib `server/lib/psBlockNumber.js` (+ `.test.js`, 18 tests) — `blockNumberFromName`,
  `resolveSectionBlock`, `pickBlockNumber`, `sectionDcidFromLaunchForm`. Playwright service
  `server/services/blockNumberSync.js` (one PS session bootstrap, then per-course `section_info`).
  Route `POST /api/courses/sync-block-numbers` (+ `courses.blockSync.test.js`, 5 tests, concurrency-guarded).
  Client: `syncBlockNumbers()` + a Dashboard "Sync blocks from PowerSchool" button.
- **Storage:** stores the parsed digit (matches the manual `[BK {n}]` UI). Non-numbered periods
  (PCG → "Pastoral Care", Interim → "Interim") and unresolved sections are **left unchanged** (never
  clobber a manual value).
- **Live-validated (full sweep):** ACSS=3 (unchanged), AIML→8, APCSP→6, MAD→1, Robotics→4, TA→4 (set);
  PCG/Interim skipped gracefully (one Interim `section_info` 500'd — skipped, not fatal). 243 server +
  229 client tests green. Probes: `scripts/probe-ps-block-number.js`, `scripts/probe-ps-sectiondcid.js`.
