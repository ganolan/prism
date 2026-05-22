# Submission status + flags on the gradebook rubric modal (#57)

**Issue:** [#57](https://github.com/ganolan/prism/issues/57) — follow-up to #32
**Date:** 2026-05-22

## Goal

`RubricModal` — the mini-rubric popover opened from a course gradebook rubric
cell — currently shows only the measurement-topic rubric grid and the overall
comment. It should also surface submission state and Prism-local flags, the way
the `/student/` page renders them around the same feedback.

Add a badge band to the modal, between the header divider and the rubric grid:

- **Submission-status badges** from `submissionStatus()` — Missing, Draft / In
  Progress, Late, Submitted.
- **`review_needed` flag** → amber `⚑ Review: <reason>` badge.
- **`resubmit_requested` flag** → `⟳ Re-submit requested` badge.
- **`resubmitted`** → `↩ Resubmitted` badge.

This is a display-only enhancement — all the data already exists in the
gradebook payload or the `flags` table.

## Approach

Extract the badge rendering into a shared `<SubmissionBadges>` component used by
both the modal and `StudentPage`'s `CourseSection`, so the two renderers cannot
drift. Placement: a dedicated band at the top of the modal body, above the
rubric grid (confirmed with the user).

## Components

### 1. `client/src/components/SubmissionBadges.jsx` (new)

Shared component rendering the badge row.

Props:

- `status` — array from `submissionStatus()`, shape `[{ kind, label, tone }]`.
- `flags` — array of flag objects. Renders `review_needed` (amber
  `⚑ Review: <reason>`), `resubmit_requested` (`⟳ Re-submit requested`), and any
  other `flag_type` via the generic capitalized `badge-green`/`badge-red` badge.
- `resubmitted` — boolean → `↩ Resubmitted` badge.
- `assignmentTitle` — optional. Used only by the generic-flag branch to
  suppress a reason that merely repeats the assignment title (StudentPage's
  current `flagReason !== g.assignment_title` guard). StudentPage passes it; the
  modal omits it (the modal's `flags` array only ever holds `review_needed` and
  the synthetic `resubmit_requested`, so the generic branch never runs there).

Behaviour:

- Renders badges in StudentPage's existing display order: status → flags →
  resubmitted.
- Reuses the existing `badge` / `badge-*` CSS classes and the `TONE_CLASS` map
  (`red→badge-red`, `blue→badge-blue`, `amber→badge-pink`,
  `neutral→badge-gray`), which moves into this file.
- `formatFlagReason` (currently a 2-line local function in `StudentPage.jsx`)
  moves into this file.
- Returns `null` when there is nothing to show (no status badges, no flags, not
  resubmitted) — so the modal band collapses cleanly for already-graded
  summatives, where `submissionStatus()` returns `[]`.

### 2. `client/src/pages/StudentPage.jsx` (adopt the component)

`CourseSection` (~lines 142–178) replaces its inline status / flag / resubmitted
JSX with:

```jsx
<SubmissionBadges status={statusBadges} flags={assignmentFlags} resubmitted={g.resubmitted} />
```

- The `Due:` span stays in `StudentPage` — it is page-specific, not part of the
  shared component.
- `formatFlagReason` and `TONE_CLASS` are removed from `StudentPage.jsx` (now in
  the component).
- **No visual change to `/student/`** — this is a pure refactor of that page.

### 3. `server/routes/courses.js` (gradebook payload)

Add `review_needed` flags to the gradebook payload. Mirror the existing
`resubmitFlags` block (~line 187):

- Query unresolved `review_needed` flags for the course — select `id`,
  `student_id`, `assignment_id`, `flag_reason`.
- Index by `student_id:assignment_id`.
- In the grade indexing loop, attach `g.review_needed = [{ id, flag_reason }]`
  (empty array when none).

`resubmit_requested` stays the boolean it already is — no payload-shape change
for existing consumers (the cell background at line 832 and title at line 856).

### 4. `client/src/pages/CoursePage.jsx` (thread the grade into the modal)

- `setRubricModal({...})` (~line 838) also passes `grade: g`.
- The `<RubricModal>` render (~line 911) also passes `grade={rubricModal.grade}`.
- `RubricModal`:
  - Computes `submissionStatus({ score, exception, late, draft, submitted_at,
    due_date: assignment.due_date })` from the grade.
  - Builds a `flags` array: `grade.review_needed` entries (tagged
    `flag_type: 'review_needed'`) plus a synthetic `{ flag_type:
    'resubmit_requested' }` entry when `grade.resubmit_requested` is true.
  - Renders `<SubmissionBadges status={...} flags={...}
    resubmitted={grade.resubmitted} />` as the band between the header divider
    and `<CompactRubric>`.

## Data flow

```
flags table ──┐
              ├─► server/routes/courses.js gradebook payload
grades table ─┘     g.review_needed = [{id, flag_reason}]   (new)
                    g.resubmit_requested = boolean          (existing)
                    g.resubmitted = boolean                 (existing)
                            │
                            ▼
                    CoursePage GradebookView
                            │  setRubricModal({ student, assignment, courseId,
                            │                   topics, comment, grade })
                            ▼
                    RubricModal
                            │  submissionStatus(grade + assignment.due_date)
                            │  flags = review_needed + synthetic resubmit
                            ▼
                    <SubmissionBadges status flags resubmitted />
```

## Testing

- **Server** — new `describe` block in `server/routes/courses.test.js`: insert an
  unresolved `review_needed` flag and assert it surfaces on
  `grades[studentId][assignmentId].review_needed`; assert a resolved flag is
  excluded. Mirrors the existing `resubmit_requested` / `resubmitted` describe
  blocks.
- **Client** — new `client/src/components/SubmissionBadges.test.jsx`, following
  `SyncConfig.test.jsx`:
  - status badges render with the correct `badge-*` tone class;
  - a `review_needed` flag renders `⚑ Review: <reason>`;
  - `resubmit_requested` and `resubmitted` badges render;
  - empty input (no status, no flags, not resubmitted) → renders nothing.

## Verification

- `cd client && npx vite build` — frontend build check.
- `npx vitest run server/` — server tests.
- `npx vitest run client/src/components/SubmissionBadges.test.jsx` — new
  component test.
- Manual: `npm run dev`, open a rubric cell on `/course/3` (ACSS — has aligned
  summatives + flags) and confirm the badge band renders above the rubric.

## Out of scope

- Showing the due date inside the modal — #57 does not ask for it.
- #61 (gradebook filters) and #62 (the `lti_submission` "Not Started" badge).
- The pre-existing unrelated `SyncConfig.test.jsx` failure on `main`.
