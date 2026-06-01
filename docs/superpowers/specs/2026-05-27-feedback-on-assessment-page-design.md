# Surface uploaded AI feedback on the /assessment/ page (#64)

**Issue:** [#64](https://github.com/ganolan/prism/issues/64)
**Date:** 2026-05-27

## Goal

Uploaded JSON feedback (inbox folder or **Upload JSON**) currently lands on the
standalone `/feedback` page (`FeedbackPage.jsx`), away from the assignment it
describes. Move the review experience onto the per-student rubric card on
`/assessment/:id` (`StudentRubricCard`), so a draft's narrative sits next to the
teacher's editable comment and its suggested proficiencies sit on the rubric
they refer to.

The inbox upload flow, the `feedback` table, and the JSON schema are unchanged —
only the *surfacing* of drafts moves. Suggestions are advisory: nothing is
auto-applied or sent to Schoology without the teacher accepting it.

## Approach

Fetch any `draft` / `teacher_modified` feedback row for each student+assignment
alongside the mastery data the page already loads, then render two new
affordances inside `StudentRubricCard`:

1. an **uneditable "Suggested feedback (AI)"** box below the Overall Comment
   textarea, with a **Copy to comment** button;
2. a **suggestion overlay** on rubric cells — faded yellow fill, thin solid
   yellow border — for each level named in the row's `rubric_scores`, clickable
   to accept into the existing `pending` changes.

Both reuse the card's existing draft-persistence + **Update Schoology** path, so
no new write mechanism is introduced.

## Data flow

```
feedback table  ──►  GET /api/feedback?assignment_id=&student_id=
(status draft /        → { feedback_parsed: { narrative_feedback, strengths,
 teacher_modified)        suggestions, rubric_scores }, score, ... }
                              │
                              ▼
            AssessmentSummaryPage loads feedback per card
            (alongside getMasteryForAssignment)
                              │
                              ▼
                    StudentRubricCard
                       │  suggested narrative  → SuggestedFeedback box
                       │  suggested rubric_scores → cell overlay state
                       ▼
            Copy to comment → applyComment()
            Accept cell     → selectLevel()  (→ pending → draft → Update Schoology)
```

## Components

### 1. Server — feedback retrieval

`GET /api/feedback?assignment_id=&student_id=` already exists
([server/routes/feedback.js:17-38](../../../server/routes/feedback.js#L17-L38))
and returns rows joined to student/assignment, but it does **not** parse
`feedback_json`. Two options (decide in review):

- **(a)** Add a bulk endpoint `GET /api/feedback/for-assignment/:assignmentId`
  returning all rows for the assignment keyed by `student_id`, each with
  `feedback_parsed`. One request per assessment page, mirrors how mastery loads.
- **(b)** Reuse the existing list endpoint per card and parse `feedback_json`
  client-side.

**Recommendation: (a)** — the assessment page renders every student at once, so
one keyed payload avoids N requests and matches the existing
`getMasteryForAssignment` shape. Filter to `status IN ('draft',
'teacher_modified')` so already-`approved`/`revision_requested` rows don't
re-surface as suggestions.

### 2. `rubric_scores` → measurement-topic mapping

The imported `rubric_scores` is a free-form `{ key: value }` object
([server/services/inbox.js:64-71](../../../server/services/inbox.js#L64-L71)).
The rubric grid keys on measurement-topic `t.id` / `t.external_id`
([AssessmentSummaryPage.jsx:474-485](../../../client/src/pages/AssessmentSummaryPage.jsx#L474-L485)),
and levels are the `LEVELS` codes `ED/EX/D/EM/IE`. The spec must pin a
convention:

- **Key:** match `rubric_scores` key against topic `external_id` first, then
  `title` (case-insensitive). Unmatched keys are ignored (logged, not shown).
- **Value:** must be one of `ED/EX/D/EM/IE`. A numeric or out-of-set value is
  ignored for the overlay (it may still inform the comment box). Document this
  in the feedback JSON schema section of `product-spec.md`.

Keys that don't resolve to a topic on this assignment are silently skipped — the
overlay is best-effort and never blocks grading.

### 3. `client/src/pages/AssessmentSummaryPage.jsx` — suggested-comment box

Below the Overall Comment textarea ([line 540-564](../../../client/src/pages/AssessmentSummaryPage.jsx#L540-L564)),
render a new `<SuggestedFeedback>` block when a feedback row exists for the card:

- Header: **Suggested feedback (AI)** with a muted "not yet applied" hint.
- Body: read-only render of `narrative_feedback`, plus `strengths` /
  `suggestions` bulleted lists when present (reuse the read-only render style
  already in `FeedbackDetail`).
- **Copy to comment** button → `applyComment(narrative_feedback)`. Per the
  existing paste handling, run the text through `normalizePastedText()` first so
  it matches the cleaning applied to pasted comments
  ([AssessmentSummaryPage.jsx:35-44](../../../client/src/pages/AssessmentSummaryPage.jsx#L35-L44)).
  Decide in review: replace vs. append (recommend **replace**, with the button
  disabled when the current comment already equals the suggestion).
- Collapses entirely when there is no draft row for the card.

### 4. `client/src/pages/AssessmentSummaryPage.jsx` — rubric suggestion overlay

Add a new cell state to the rubric-cell styling block
([lines 487-531](../../../client/src/pages/AssessmentSummaryPage.jsx#L487-L531)).
Current precedence is: current (solid green) → pending (green border) →
overridden (dimmed) → default. Insert a **suggested** state:

- A cell is `isSuggested` when the resolved `rubric_scores` level for this topic
  equals this level `l`, **and** it is neither current nor pending.
- Style: `background: faded yellow` (e.g. token-aligned `#fef9c3` at reduced
  opacity), `border: 1px solid` yellow (e.g. `#fde047`). Keep it visually below
  current/pending so an awarded or pending cell always wins.
- Render the level code in the cell, muted, so the suggestion is legible.
- `onClick` still calls `selectLevel(t.id, l)` — accepting a suggestion is
  identical to a manual pick, so it flows into `pending`, the localStorage draft
  ([lib/assessmentDraft.js](../../../client/src/lib/assessmentDraft.js)), and
  the **Update Schoology** write with no new code path.
- `title`: `Suggested: <LEVEL_LABELS[l]> — click to accept`.

Colors live inline in this file today (`LEVEL_COLORS`), so the yellow suggestion
styling follows the same inline pattern rather than `app.css` tokens — matches
the existing rubric code, noted as a deliberate local exception to the
CSS-variable convention.

### 5. Status lifecycle

- Copying the comment or accepting a suggestion produces `pending` changes →
  card already shows **Update Schoology** as enabled.
- On save, after the Schoology write succeeds, `PUT /api/feedback/:id` flips the
  row to `teacher_modified` (if only edited) and then **Update Schoology**
  marking it `approved`. Resolve the exact transition in review — simplest is:
  any accept/edit → `teacher_modified`; successful Update Schoology → `approved`.
- A row already `approved` is not re-surfaced (filtered server-side per §1).

### 6. `/feedback` page disposition

Out of scope to delete here. Options for a follow-up:

- repurpose `FeedbackPage` as an **inbox-log + bulk-import** view (keep Process
  Inbox / Upload JSON / inbox-log, drop the per-item review list); or
- remove it and move Upload JSON into the assessment page header.

Leave the route in place for this change; add a banner pointing reviewers to the
assessment page.

## Testing

- **Server** (if endpoint (a)): new `describe` in `server/routes/feedback.js`
  tests — insert draft feedback for two students on one assignment, assert the
  keyed payload returns parsed `feedback_parsed` and excludes `approved` rows.
- **Client** — extend `AssessmentSummaryPage.test.jsx`:
  - suggested-comment box renders only when a draft row is present;
  - **Copy to comment** populates the textarea with normalized text and arms
    pending changes;
  - a `rubric_scores` entry resolving to a topic renders the suggested cell
    state, and is suppressed when that level is already current/pending;
  - clicking a suggested cell adds it to `pending` (same as `selectLevel`);
  - an unresolvable `rubric_scores` key renders no overlay and does not throw.

## Verification

- `cd client && npx vite build` — frontend build check.
- `npx vitest run server/` — server tests.
- `npx vitest run client/src/pages/AssessmentSummaryPage.test.jsx`.
- Manual: drop a draft JSON with `narrative_feedback` + `rubric_scores` into the
  inbox, Process Inbox, open the matching `/assessment/:id`, confirm the
  suggested box + yellow rubric overlay appear, accept one, Update Schoology, and
  confirm the row goes `approved` and stops re-surfacing.

## Out of scope

- Deleting or rebuilding the `/feedback` page (follow-up).
- Numeric / non-`ED..IE` `rubric_scores` values driving the overlay.
- Bulk "accept all suggestions" across students (possible later; #51 is the
  adjacent bulk-write request).
- Any change to the inbox JSON schema beyond documenting the `rubric_scores`
  key/value convention.
