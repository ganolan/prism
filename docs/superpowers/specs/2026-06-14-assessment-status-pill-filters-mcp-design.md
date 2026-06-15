# Assessment page: submission-status pill, status/grading/flag filters, and MCP exposure

**Date:** 2026-06-14
**Status:** Approved (design) — pending implementation plan
**Area:** Assessment summary page (`client/src/pages/AssessmentSummaryPage.jsx`),
mastery route (`server/routes/mastery.js`), shared assessment context
(`server/services/assessmentContext.js`), MCP (`mcp/server.js`, `mcp/handlers.js`)

## Problem

Submission status is captured and shown reliably in the **gradebook grid** (per the
2026-06-14 `lti-submission-status-display` work: retried LTI fetch, persisted
`lti_fetch_status`, `gradeLabel.js` badges). But that status does **not** flow to two
places where it matters:

1. **The assessment summary page** (`/course/:id/assessment/:assignmentId`) — the page a
   teacher actually grades from — shows no submission status at all. For LTI/OneDrive
   assignments the unsubmitted drafts and the finished work sit in the *same* synced folder
   with nothing to distinguish them when a file is opened, so the teacher (and the grading
   agent) can't tell at a glance who has actually submitted.

2. **The MCP** (`get_assignment_context`) — the grading agent's only structured view of the
   class. Its per-student roster object omits submission state entirely. In the ROB HeroBot
   Notebook 4 grading run, the agent graded straight from the synced folder, where every
   student's files *looked* ready; a check against Prism would have revealed who was
   `submitted` vs `in_progress` vs `not_started` and which to defer. The agent had no way to
   make that check.

The teacher also can't **filter** the assessment page roster — to a submission-state slice,
to the ungraded or **partially graded** (a final proficiency level missing on some topic, or
no comment entered), to the visible/not-visible feedback, to the students flagged for review,
or to those tagged "ask to resubmit" — so triaging a class during grading is all visual
scanning.

## Verified background (do not re-derive)

- **Submission status is already DB-backed.** `grades.lti_submission_state`
  (`'submitted'` | `'in_progress'` | `'not_started'` | NULL) is authoritative for LTI work;
  `grades.submission_type` (`'drop'` | `'assessment'` | NULL) + `grades.submitted_at` are the
  non-LTI signal. `assignments.is_lti_submission`, `assignments.due_date`, and
  `assignments.lti_fetch_status` are on the assignment row. No new persistence is required.
- **The two flags are already DB-backed**, in the `flags` table: `flag_type='review_needed'`
  (teacher-set, carries a `flag_reason`) and `flag_type='resubmit_requested'` (reason-less
  toggle), both with `resolved` and scoped by `assignment_id`. The assessment route already
  surfaces them per student as `review_flag` and `resubmit_flag`.
- **Nothing relevant is localStorage-only.** A client scan shows localStorage holds only the
  theme, sync prefs, and a *legacy* assessment-draft key (cleanup-only at
  `AssessmentSummaryPage.jsx:288`); the live draft store moved to the `assessment_drafts`
  table in the 2026-06-12 migration, precisely so the MCP can read in-progress grading. This
  feature is the same move applied to submission status.
- **The status rule lives once, client-side, in `gradeLabel.js`.** `submissionStatus({...})`
  → an array of `{ kind, label, tone }` badges; `dueProximity(due_date, today)` returns
  `'early'` / `'soon'` (≤7 days) / `'overdue'` / `'none'`. The gradebook computes its pill
  from raw DB fields through this module. Tones map to `badge-*` CSS classes
  (`SubmissionBadges.jsx`).
- **One query feeds both the assessment route and the MCP.** Both call
  `getGradeMetaRows(db, assignmentSchoologyId)` in `server/services/assessmentContext.js`.
  Extending that single SELECT reaches both consumers.

## Design

Computation stays **client-side** and reuses `gradeLabel.js` verbatim, so the
assessment-page pill is byte-identical to the gradebook pill (zero drift). The MCP returns a
**normalized readiness state** (about *readiness*, not colour), which does not need the
due-date/colour logic. The whole feature is plumbing + one new filter component + an MCP
shape extension.

### Layer 1 — One query carries the status fields

Extend `getGradeMetaRows()` (`assessmentContext.js`) to also select
`g.lti_submission_state, g.submission_type, g.late, g.draft` (it already selects `g.score`
and `g.submitted_at`). This single change flows into the assessment route **and** the MCP.

### Layer 2 — Assessment route payload (`server/routes/mastery.js`)

In the per-student `students.map(...)` (currently `:456-466`), add: `lti_submission_state`,
`submission_type`, `late`, `draft`. The route already returns the full `assignment` row, so
the client already has `is_lti_submission`, `due_date`, and `lti_fetch_status`. Grading
completeness and visibility need **no** new field — they derive from data already in the
payload (`scores`, `grade_comment`, `exception`, `comment_status`) plus the page's aligned
`topics`.

### Layer 3 — Status pill on each student card (`AssessmentSummaryPage.jsx`)

In the card header, call
`submissionStatus({ score, exception, late, draft, submitted_at, submission_type,
is_lti_submission: assignment.is_lti_submission, lti_submission_state, due_date:
assignment.due_date })` and render the resulting badge(s) as a **prominent** pill — full
text (`Submitted` / `In Progress` / `Not Started` / `Missing`, plus a `Late` overlay where
present), using the same tone → `badge-*` classes as the gradebook (`SubmissionBadges`'s
`TONE_CLASS`). Same colour and due-date rules, reused, not re-implemented.

- A graded cell returns `[]` from `submissionStatus` (the score is shown instead) — the pill
  simply doesn't render, which is correct.
- When `ltiStatusUnavailable({ is_lti_submission, lti_fetch_status, score, exception })` is
  true, show the same amber "submission status unavailable — re-sync" affordance the
  gradebook uses, rather than a misleading state.

### Layer 4 — Filter row (`AssessmentSummaryPage.jsx`)

A new row immediately **below** the header button row (after `:1626`), built from themed
toggle pills modelled on `TypeFilterToggle` (`CoursePage.jsx:1118`). State is **in-memory
only** (`useState`), resetting to all-off (= no constraint) each visit, exactly like the
Summative/Formative toggles.

**Pills, in five groups** (laid out with subtle group separators so the longer row reads as
groups, not a flat blob):

| Group | Pills | Notes |
|---|---|---|
| Status (LTI assignment) | `Submitted` · `In Progress` · `Not Started` | three pills |
| Status (non-LTI assignment) | `Submitted` · `Unsubmitted` | can't split in-progress from not-started without the LTI signal, but submitted-or-not IS knowable — so offer both; `Unsubmitted` reuses the `not_started` id |
| Grading | `Ungraded` · `Partially graded` · `Graded` | completeness, defined below |
| Visibility | `Visible` · `Not visible` | the display-to-student state (`comment_status`) |
| Flag | `Flag for review` | teacher-set `review_flag` (the `review_needed` flag) |
| Resubmit | `Ask to resubmit` | `resubmit_flag` (the `resubmit_requested` flag) |

**Grading completeness** (the three states are mutually exclusive and exhaustive). For a
student `s` on an assignment with aligned `topics`, let `scoredCount` = topics with a level
in `s.scores`, `hasComment` = `s.grade_comment` non-empty, `excepted` = `s.exception != 0`:
- `Graded` (complete): `excepted` **or** (`topics.length > 0 && scoredCount === topics.length
  && hasComment`). Excepted students (rubric locked) count as handled.
- `Ungraded` (empty): `!excepted && scoredCount === 0 && !hasComment`.
- `Partially graded`: `!excepted && !complete && !empty` — some topic missing a final level,
  **or** all topics scored but no comment, **or** a comment with topics still unscored.

Completeness is judged on the **published finals** (`scores` + `grade_comment`), not the
local unpublished draft — matching "a *final* proficiency score is missing."

**Combination semantics — OR within a group, AND across groups:**
- A group with **no** active pill imposes **no** constraint.
- A group with **≥1** active pill requires the student to match **at least one** active pill
  in that group.
- A student is shown only if they pass **every** constrained group.
- The single-pill groups (Flag, Resubmit) act as "only show matching" when on, no constraint
  when off.

This lets the teacher (and mirrors what the agent needs) express "submitted **and**
ungraded" — the ROB Notebook 4 question — which independent show/hide toggles can't.

**Filter predicates** (per student `s`, with `assignment`):
- Normalized status for filtering: `submissionState(s, assignment)` →
  - LTI: `lti_submission_state` (`submitted` / `in_progress` / `not_started`), else `unknown`.
  - non-LTI: `submitted` if `submission_type || submitted_at > 0`, else `not_started`
    (the `Submitted` and `Unsubmitted` pills — the latter labelled over the `not_started`
    id — match these two states).
- Grading: `Ungraded` / `Partially graded` / `Graded` per the completeness rule above.
- Visibility: `Visible` = `s.comment_status === 1`; `Not visible` = otherwise.
- Flag for review: `s.review_flag != null`. Ask to resubmit: `s.resubmit_flag != null`.

**Filter-pill colours follow the gradebook due-date rule.** Compute `prox =
dueProximity(assignment.due_date, now)` once for the assignment, then tone each status pill
exactly as `gradeLabel.js` would for a student in that state at that proximity (derive via
the same `ltiBadges`/`submissionStatus` path so there is one source of truth):
- `Submitted` → always green.
- `In Progress` → blue (early/soon), amber/yellow (overdue).
- `Not Started` → gray/neutral (early), red (soon/overdue).

The pills therefore shift colour as the deadline nears/passes, matching the per-student
badges (which share that single class-level due date). The non-status pills have no due-date
rule and take fixed tones: `Graded` green, `Partially graded` amber (the "finish me"
signal), `Ungraded` neutral; `Visible` green/blue and `Not visible` neutral (matching the
card's display-to-student affordance); `Flag for review` and `Ask to resubmit` reuse the
existing flag/resubmit colours already used on the cards. The active/inactive pill styling
reuses `TypeFilterToggle`'s pattern (dot + label + theme vars; muted/`opacity 0.7` when
inactive).

An empty-result state ("No students match the current filters") renders when every card is
filtered out, mirroring the assessment-list empty state.

### Layer 5 — MCP exposure

**`get_assignment_context`** (`getAssessmentContext` in `assessmentContext.js`). Add to each
per-student object (`:176-205`):
- `submission_status`: normalized `'submitted'` | `'in_progress'` | `'not_started'` |
  `'unknown'` — LTI from `lti_submission_state` (`unknown` when null / fetch failed),
  non-LTI `submitted` vs `not_started` from `submission_type`/`submitted_at`. This is the
  direct ROB Notebook 4 fix: the agent can see who actually submitted instead of trusting
  the synced folder.
- `is_lti` (boolean) and `due_date` passthrough, so the agent can reason about lateness /
  unknown-status itself.
- `grading_state`: `'ungraded'` | `'partial'` | `'complete'` — the same completeness rule as
  the page (all aligned topics levelled + comment present; excepted = complete). Subsumes a
  plain is-graded boolean and lets the agent see which students still need work.
  (`display_to_student` is already on the object; `existing_suggestion` / `draft_feedback`
  already convey AI/teacher draft state.)
- `flags`: `{ review_needed: { reason } | null, resubmit_requested: boolean }` — currently
  invisible to the agent. The MCP must add a flags query (reuse the route's `flags` SELECTs,
  keyed by `student_id`).
- `email` (from `students.email`, synced from Schoology) — for roster/contact use cases
  (e.g. "email list of students who haven't submitted yet"). Added to the shared `getRoster`
  SELECT, so it also reaches the assessment-page route payload.
- `submitted_at` / `latest_revision_at` (ISO strings) — submission timestamps for time-window
  queries ("submitted in the last X hours"). Reliable for native/dropbox submissions only;
  **null for LTI**, where Schoology auto-provisions revision rows (noise) and the reliable
  signal is `submission_status`. ("Submitted but not yet graded" needs no new field — it's
  `submission_status === 'submitted'` AND `grading_state !== 'complete'`.)

**`list_assignments`** (`mcp/handlers.js`). Add per-assignment counts so the agent can see
readiness at a glance before drilling in:
`submission_counts: { submitted, in_progress, not_started, unknown, total }` and
`grading_counts: { ungraded, partial, complete }`, computed over `grades` (+ aligned topics)
for that assignment. Submission counts: LTI uses `lti_submission_state`; non-LTI collapses to
`submitted`/`not_started`. Grading counts use the same completeness rule as the per-student
`grading_state`.

## What is explicitly NOT changing

- **No Schoology write-back** — read + display + MCP only.
- **No change to how status is synced** — Layers build on the existing capture
  (`lti_submission_state`, `lti_fetch_status`) from the 2026-06-14 gradebook work.
- **No new persistence** — every filtered dimension is already in the DB (`grades`, `flags`).
- **Filter selection is not persisted** — in-memory, resets each visit, like the existing
  Summative/Formative toggles.
- **The status rule is not lifted into a shared module** — the client reuses `gradeLabel.js`
  directly; the MCP needs only the raw 3-state, not the colour logic, so duplicating a tiny
  normalization on the server is correct and avoids a new cross-boundary pattern.

## Testing

The repo expects real automated tests (server Vitest; client RTL).

**Backend**
- `getGradeMetaRows` selects the four added columns (`lti_submission_state`,
  `submission_type`, `late`, `draft`).
- Mastery route: per-student payload includes the four status fields; graded/ungraded
  derivable from `scores`.
- `getAssessmentContext` (MCP): per-student `submission_status` normalization truth table
  (LTI submitted/in_progress/not_started/null→unknown; non-LTI submission_type/submitted_at
  → submitted/not_started); `grading_state` (ungraded / partial — some-topics-missing and
  no-comment variants / complete / excepted→complete); `flags` populated from the `flags`
  table.
- `list_assignments`: `submission_counts` and `grading_counts` totals match a seeded
  `grades` fixture.

**Frontend**
- `AssessmentSummaryPage` card: renders the prominent status pill from `submissionStatus`
  with the correct label + `badge-*` class for submitted / in_progress / not_started /
  missing / late / unavailable; no pill when graded.
- Filter row: status pills conditional on `is_lti_submission` (three vs one); the three
  grading-completeness pills (incl. a partially-graded student matching `Partially graded`
  but not `Graded`/`Ungraded`); the `Visible`/`Not visible` pills; OR-within / AND-across
  behaviour (e.g. `Submitted` + `Partially graded` shows only submitted-and-partial);
  single-pill flag/resubmit groups; all-off shows everyone; empty-result state.
- Filter-pill colour shifts with `due_date` proximity (early vs overdue) via the shared
  `gradeLabel` path.

## Docs to update

- `docs/design-language.md` — append: the assessment summary page shows a prominent
  per-student submission-status pill (same `gradeLabel` rule + colours as the gradebook), and
  a grouped filter row of themed toggle pills (submission status, grading completeness —
  ungraded/partial/graded, visibility, review flag, resubmit tag) with OR-within-group /
  AND-across-group semantics.

## Out of scope (YAGNI)

- No saved/named filter presets; no cross-device filter sync (in-memory only).
- No in-progress/not-started split for non-LTI work — not knowable (only
  submitted-vs-unsubmitted is offered there).
- No bulk actions from the filtered view (e.g. flag-all) — display + triage only here.
