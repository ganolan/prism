# Suggested Feedback block — restore the teacher-facing analysis (strengths/suggestions)

**Date:** 2026-06-14
**Status:** Design — awaiting review
**Touches:** `prism` (frontend only) + `assessment-grader` plugin (docs/prompt only)

## Problem

The AI grading suggestion used to carry dot-point **Strengths** and **Suggestions** lists
alongside the narrative comment. These are rich, teacher/grader-facing signal (good for
post-grading analysis and cross-course/year comparison) and they still render on the legacy
`/feedback` review page. They have **vanished from recent runs** and are not shown at all on
the current `/assessment/` grading page.

### Root cause (investigated, evidence-backed)

The loss is on the **assessment-grader (grading-behaviour) side, not a Prism MCP change.**

- The Prism MCP tool `write_student_suggestions` (`mcp/server.js`) **accepts** `strengths[]`
  and `suggestions[]`, and `server/services/suggestions.js` stores them into
  `feedback.feedback_json`. This path is **unchanged since the fields were introduced**
  (commit `2d9ce7b`); no commit ever removed them.
- The data genuinely **differs by run** (verified directly against `server/db/students.db`):

  | assignment_id | title | rows | strengths/suggestions populated |
  |---|---|---|---|
  | `20282` | MAD Unit 3 Project – Personal Data App | 8 | **8/8 populated** |
  | `21398` | AP CSP CPT4-5 Validation Reassessment | 3 | **3/3 populated** |
  | `9894`  | ROB: HeroBot Notebook 3 | 19 | **0/19** (`strengths: []`, `suggestions: []`) |

  Same write path, same schema — the recent ROB run simply wrote empty arrays.
- The assessment-grader plugin **never instructs producing** strengths/suggestions. Its
  write step (`shared/orchestration.md` step 7) lists them only as *"optional"* fields with
  no upstream step that generates them, so populating them was always incidental LLM
  behaviour. (Commit `aafa279`, calibrated *from* the ROB run, even added a
  *"don't enumerate a checklist"* rule that nudged the model further away from dot-points.)
- On the Prism UI, the bullets only ever rendered on the legacy `FeedbackPage.jsx`
  (`/feedback`). The current `/assessment/` page (`AssessmentSummaryPage.jsx`) reads only
  `rubric_scores`, `reviewer_flags`, and `narrative_feedback` — it never read
  `strengths`/`suggestions` at any point in its history.

### Two gaps, both fixable with no schema or MCP change

1. **Emit reliably** — assessment-grader must always *produce + forward* strengths/suggestions
   (today it's "optional" → incidental).
2. **Render** — surface them on the `/assessment/` page inside the "Suggested Feedback" block.

## Decisions (confirmed)

1. **Persistence:** reuse the existing `feedback_json.strengths` / `feedback_json.suggestions`
   keys. They are already distinct from `reviewer_flags` (flags) and `narrative_feedback`
   (suggested feedback), already accepted by the MCP, already stored, and already queryable
   via `json_extract` for cross-course/year analysis. **No schema migration, no MCP change.**
2. **Emission:** make ~2-4 strengths + ~2-4 suggestions a **required** teacher-facing output
   of the grader every run (not "optional").
3. **Backfill:** **fix-forward only.** Build and verify against the already-populated MAD
   (`20282`) and AP CSP (`21398`) data. ROB (`9894`) is left as-is; re-grade later if its
   analysis is wanted.

## Section 1 — `/assessment/` card layout

The card keeps its header and rubric grid (suggested proficiencies overlaid as today). The
collapsible **"▸ Reviewer flags" strip at the top of the card is removed**; all
feedback-related content consolidates into one block placed **between the rubric and the
teacher's Overall Comment**.

```
┌─ ✶ Suggested Feedback ────────────────────────────────────────────────┐
│ ⚑ Reviewer flags   (uncollapsed, only if present)                      │
│   CAD Model D: the OnShape deliverable is a single custom flat aligner… │
│ ─────────────────────────────────────────────────────────────────────  │
│ ┄┄ expanded only ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│ Strengths                                                              │
│   • A genuinely non-trivial custom calendar …                          │
│   • A warm, cohesive pastel theme …                                    │
│ Suggestions                                                            │
│   • Add an edit flow so events can be changed …                        │
│   • Introduce a second model + a SwiftData relationship …              │
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│ Great thinking, Kyle. Your idea sprint was one of the most thorough…   │  ← narrative
│                                                                        │
│                            [▾ Show full analysis]  [↓ Use suggestion]  │  ← footer
└────────────────────────────────────────────────────────────────────────┘

Overall Comment  ✓ Published to Schoology
[ teacher's editable comment textarea                                  ]
[👁 toggle] [Publish to Schoology] [Discard Changes]
```

Block structure, top to bottom:

1. **Header:** title `✶ Suggested Feedback` only (no buttons).
2. **Reviewer flags:** rendered **uncollapsed**, only when `reviewer_flags` is present.
   Keeps the existing warning/flag styling; no longer a `<details>` and no longer at the top
   of the card.
3. **Strengths / Suggestions** (the "full analysis"): rendered **between the flags and the
   narrative**, **only when expanded**. Each is a `<ul>` of the array items under a plain
   "Strengths" / "Suggestions" heading — no extra label or note.
4. **Narrative** (the suggested student comment) — always shown.
5. **Footer** (right-aligned): `▾ Show full analysis` toggle + `↓ Use suggestion`.

Behaviour:

- **`↓ Use suggestion`** moves from the publish-controls row into the **block footer**. It
  copies the narrative *down* into the Overall Comment textarea below (unchanged behaviour;
  new location + a **down** arrow to match the source→destination direction).
- **`▾ Show full analysis`** toggles the strengths/suggestions region (collapsed by default,
  keeping the block compact). Label/affordance flips to "Hide full analysis" when expanded.
- The toggle button is **omitted entirely when both arrays are empty** (e.g. the current ROB
  run) — nothing to reveal, so no misleading affordance.
- The publish controls (`👁 toggle`, `Publish to Schoology`, `Discard Changes`) **stay with
  the Overall Comment**, below the block. `Use suggestion` is removed from that row.

Block visibility: render the block when **any** of narrative / flags / strengths / suggestions
is present (previously the block keyed on narrative only; flags previously rendered separately
at the top of the card, so this preserves the flags-only edge case).

## Section 2 — Prism wiring (frontend only, no backend change)

**File:** `client/src/pages/AssessmentSummaryPage.jsx` (component `StudentRubricCard`).

The component already receives the full parsed feedback (`feedbackRow.feedback_parsed`) via
`GET /api/feedback/for-assignment/:assignmentId`, which returns the complete `feedback_json`
including `strengths`/`suggestions`. **No API, service, route, schema, or MCP change.**

Changes:

1. Read the two new arrays alongside the existing reads
   (`rubric_scores` / `reviewer_flags` / `narrative_feedback`):
   `const strengths = feedbackRow?.feedback_parsed?.strengths || []` and the same for
   `suggestions`.
2. Remove the top-of-card collapsible reviewer-flags `<details>` strip.
3. Restructure the suggested-feedback block per Section 1: header (title) → flags →
   strengths/suggestions (expanded only) → narrative → footer (Show full analysis + Use
   suggestion). Add local `showFullAnalysis` state (default `false`).
4. Move the rubric block above the suggested-feedback block / Overall Comment so the order is
   rubric → Suggested Feedback → Overall Comment + publish controls. Remove `Use suggestion`
   from the publish-controls row.

**Styling:** reuse existing CSS custom properties and component classes per the frontend
conventions (`var(--accent)`, `.alert.alert-warning` family for flags, existing
suggested-feedback block styling). No hardcoded hex. New toggle uses an existing button class
(`.ghost`/`.tab-btn` family) rather than inline styles.

**Design language:** append the decision (consolidated Suggested Feedback block; flags inline
+ uncollapsed; expandable teacher-facing analysis; footer action buttons) to
`docs/design-language.md` per repo convention.

## Section 3 — reliable emission (assessment-grader plugin)

**Repo:** `/Users/gnolan/Library/CloudStorage/OneDrive-HongKongInternationalSchool/_repos/assessment-grader`
(docs/prompt-only plugin — no code, no test harness).

Changes:

1. `shared/orchestration.md` step 7 ("Write to Prism"): change `strengths`/`suggestions` from
   *"optional"* to a **required** part of the per-student write — ~2-4 strengths + ~2-4
   suggestions per student.
2. `shared/output-format.md`: add a per-student **teacher-facing analysis** section defining
   the strengths/suggestions dot-points, explicitly scoped as grader signal **distinct from
   the student-facing narrative comment**, and **not published to the student**.
3. Reconcile with the existing "specific ≠ exhaustive: name the direction, don't enumerate a
   checklist" rule (`grading-philosophy.md`, commit `aafa279`) by scoping that rule to the
   **student-facing narrative**. The teacher-facing strengths/suggestions are explicitly
   allowed to be a short structured list.

## Testing

- **Prism (real test):** add a client Vitest + React Testing Library test beside the page
  (e.g. `client/src/pages/__tests__/AssessmentSummaryPage.suggested-feedback.test.jsx`,
  matching existing client test conventions) asserting, with a mock feedback row:
  - reviewer flags render uncollapsed above the narrative when present;
  - strengths/suggestions are hidden by default and revealed by "Show full analysis";
  - the toggle button is absent when both arrays are empty;
  - "Use suggestion" lives in the block footer and populates the Overall Comment;
  - the block still renders narrative + flags when arrays are empty (ROB-style row).
- **assessment-grader:** prose-only; no automated harness. Verification is the wording change
  plus the next real grading run producing populated `strengths`/`suggestions` (a re-grade of
  any assignment shows non-empty arrays in `feedback_json`).

## Out of scope

- No DB schema migration; no change to `write_student_suggestions` schema or
  `server/services/suggestions.js`.
- No ROB (`9894`) backfill in this change (fix-forward).
- The legacy `FeedbackPage` (`/feedback`) is unchanged.
- `getAssessmentContext` read-back (`server/services/assessmentContext.js`) still omits
  strengths/suggestions from `existing_suggestion`; surfacing prior strengths/suggestions to a
  re-grading agent is a separate, deferred follow-up.

## Files touched

- `client/src/pages/AssessmentSummaryPage.jsx` — block restructure + new reads + state.
- `client/src/pages/__tests__/...` — new client test (path per existing convention).
- `docs/design-language.md` — append the UI decision.
- `assessment-grader/shared/orchestration.md` — require strengths/suggestions in step 7.
- `assessment-grader/shared/output-format.md` — define teacher-facing analysis section.
- `assessment-grader/shared/grading-philosophy.md` — scope the "don't enumerate" rule to the
  narrative (small clarification).
