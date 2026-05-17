# Submission-scoped review flags + student-profile cleanup

**Issues:** #20 (review flag → submission), #19 (Flags & Performance sections redundant)
**Milestone:** Wave 3 — Flag-model chain
**Status:** Approved design — ready for implementation plan

## Problem

Two related problems with how flags surface on student profiles:

1. **#20** — The "Review needed" flag is a manual, student-scoped option on the
   student profile. It should instead attach to an individual student's
   assignment submission, set while grading on the assessment page.
2. **#19** — Once review flags are submission-scoped, the student profile's
   manual "Flags" entry and the "Performance Alerts" / "Cross-Course
   Comparison" analytics sections have nothing left to justify them. They
   should be removed.

This is the first link in the Wave 3 flag-model chain. It reshapes flags from
student-scoped to submission-scoped; #49 (resubmission tracking) builds on the
reshaped model in a later spec.

## Approach

Reuse the existing `flags` table and `/api/flags` routes — **no schema change**.
The table already has a nullable `assignment_id`; today every flag is created
student-scoped (`assignment_id = NULL`) by `FlagsCard`. The change is
behavioral: stop creating student-scoped flags, start creating submission-scoped
ones (`student_id` + `assignment_id` + `flag_type = 'review_needed'`) from the
assessment page.

*Alternative considered:* a dedicated `review_flags` table or columns on
`grades`. Rejected — the `flags` table already models exactly this, and keeping
one flag mechanism means #49's "needs re-grading" flag can later join in as
another `flag_type` rather than inventing a third storage location.

## Design

### 1. Data layer

- **No schema change.** Review flags are `flags` rows with
  `flag_type = 'review_needed'`, `assignment_id` set, `student_id` set.
- `resolved` / `resolved_at` are **unused** for review flags — the model is a
  simple toggle: a flag exists or it does not; clearing it is a `DELETE`.
- **Migration:** add an idempotent `DELETE FROM flags WHERE assignment_id IS NULL`
  to `server/db/index.js`, alongside the existing #45 auto-flag purge. This
  wipes orphaned student-scoped flags on boot (clean slate — the table only
  ever holds submission-scoped flags afterward).
- `POST /api/flags` and `DELETE /api/flags/:id` already do what is needed:
  `POST` accepts `assignment_id` and `flag_type` and requires a non-empty
  `flag_reason`; `DELETE` removes by id. **No create/delete route changes.**

### 2. Assessment page — create / clear the review flag (#20)

- Extend `GET /api/mastery/:courseId/assignment/:assignmentId`
  (`server/routes/mastery.js`) to attach each student's current review flag.
  Add one query against `flags` joined on `assignment_id = assignmentRow.id`
  and `flag_type = 'review_needed'`, mapped by `student_id`, and include
  `review_flag: { id, flag_reason } | null` on each student in the response.
- `StudentRubricCard` (`client/src/pages/AssessmentSummaryPage.jsx`) already
  receives `student.id` (internal student id) and the internal `assignment.id`
  via `assignmentRow`. It calls `POST /api/flags`
  (`{ student_id, assignment_id, flag_type: 'review_needed', flag_reason }`)
  and `DELETE /api/flags/:id` directly.
- **UI:** a "⚑ Flag for review" control in the card's comment / button row.
  - Unflagged → a ghost button that reveals a reason input + confirm.
  - Flagged → an amber badge `⚑ Review: <reason>` in the card header (alongside
    the existing pending / saved badges) with a "Clear" action.
- The flag write is **immediate and independent** of the "Update Schoology"
  save. It is Prism-local state and must never be bundled into a Schoology
  write. Creating/clearing the flag re-fetches via the page's `load()` (or
  updates local state) so the badge reflects the new state.

### 3. Student profile cleanup (#19)

- **`client/src/pages/StudentPage.jsx`:**
  - Remove the top "Active flags banner".
  - Remove the "Flags" `CollapsibleCard` + `FlagsCard`.
  - Remove the `<StudentAnalytics>` usage.
  - Delete the `FlagsCard` component and now-unused handlers and imports
    (`createFlag`, `resolveFlag`, `reopenFlag`, `deleteFlag`, `handleAddFlag`,
    `handleResolveFlag`, `handleReopenFlag`, `handleDeleteFlag`, `activeFlags`,
    and related state).
  - **Keep** the `CourseSection` assignment-row badge rendering — a
    submission-scoped `review_needed` flag renders there as a badge
    automatically via the existing `flagsByAssignment` / `assignmentFlagMap`
    code path. Verify the badge label reads sensibly
    (`flag_type.replace('_', ' ')` → "review needed").
- **Delete `client/src/components/StudentAnalytics.jsx` entirely** (and its
  test, if any). With both the "Performance Alerts" and "Cross-Course
  Comparison" blocks removed, the component renders nothing — `trends` is
  destructured but never displayed.
- **Server:** remove the now-unused individual-student analytics route
  (`GET /api/analytics/student/:id` in `server/routes/analytics.js`) and the
  `getStudentAnalytics` helper in `client/src/services/api.js`. `AnalyticsPage`
  / `AnalyticsView` use separate analytics endpoints and are untouched — verify
  no shared helper is removed out from under them.
- Late-submission badges on assignment rows render via `submissionStatus()` and
  are **untouched**.

### 4. Testing

- **Server:**
  - Creating a flag with `assignment_id` + `flag_type: 'review_needed'`
    produces a submission-scoped row; `DELETE` removes it.
  - The boot migration deletes `NULL`-assignment flags and is idempotent.
  - `GET /api/mastery/:courseId/assignment/:assignmentId` includes
    `review_flag` per student — `null` when unflagged, `{ id, flag_reason }`
    when flagged.
- **Client:**
  - `StudentRubricCard` — flagging shows the badge; clearing removes it; the
    flag write does not trigger a Schoology write.
  - `StudentPage` no longer renders the active-flags banner, the Flags card, or
    `StudentAnalytics`.
  - `CourseSection` still renders a `review_needed` flag as an assignment-row
    badge.

## Out of scope

- Any aggregate "all flagged submissions" worklist view.
- #49 resubmission tracking (`needs_regrade` flag, revision auto-detect) — a
  separate Wave 3 spec. The reshaped `flags` table becomes its home: #49's
  teacher flag will be another `flag_type` on the same table.
- Flagging review on non-mastery-aligned assignments — those have no assessment
  page, so review flags can only be created for mastery-aligned assignments.
  Accepted limitation; the assessment page is the per-submission feedback
  surface #20 names.
