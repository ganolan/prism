# Display-to-student toggle on the assessment page

GitHub issue: [#34](https://github.com/ganolan/prism/issues/34)

## Problem

Schoology's gradebook lets a teacher toggle "Display to student" per (student, assignment) — controlling whether the student sees the grade comment AND the underlying mastery proficiencies for that assignment. Prism's assessment page writes comments and mastery scores from Schoology but exposes no control over visibility. After the #46 fix, every comment write hardcodes `comment_status: 1`, so Prism currently always publishes — there is no way to write privately or to unpublish.

Teachers want a per-student toggle on the assessment page so they can decide visibility without leaving Prism.

## Field findings (DevTools probe, 2026-05-07)

- The Schoology gradebook comment popup writes via the internal endpoint `PUT /iapi/grades/grader_grade_data/{sectionId}/{?}`. Payload shape:
  ```json
  { "grades": { "<enrollment_id>": { "<assignment_id>": { "grade": <num>, "exception": <int>, "comment": "<text>", "comment_status": <bool>, "flags": null, "updateSequence": null } } }, "sequence": <int> }
  ```
- Toggling "Display to student" OFF → ON only changes `comment_status` (boolean) and the per-tab `sequence` counter. No other field varies.
- The same field exists on Schoology's public OAuth API (`PUT /sections/{id}/grades`) as integer `1` (visible) / `null` (hidden). Both surfaces hit the same record. There is no separate field for mastery-observation visibility — `comment_status` controls visibility of the grade comment AND the rubric proficiencies the student sees for that assignment.
- Prism uses the public OAuth form via `pushGradeComments` already; we do not need the internal endpoint. Logged in [.claude/schoology-api-reference.md](../../../.claude/schoology-api-reference.md).

## Design

### UI placement

Inside [`StudentRubricCard`](../../../client/src/pages/AssessmentSummaryPage.jsx) — every student gets a slide toggle on the same row as the Update Schoology / Discard buttons, right-aligned, labelled **Display to student**. Disabled when the rubric is locked (exception active), matching the existing lock behaviour for the rubric grid.

### Initial toggle state on load

The `grades` row in Prism's local DB carries the `comment_status` value pulled from Schoology by the regular grades sync and by the assessment-page Refresh (the latter wired up in #46). The toggle reads from there:

- **A `grades` row exists** for this student+assignment → toggle reflects `comment_status` (`1`/`true` → ON, `null`/`false`/missing → OFF). No auto-flip — Schoology's known state wins, even if the local comment field is empty and the teacher then types a fresh comment.
- **No `grades` row** (truly virgin: never synced) → toggle defaults OFF, **auto-flip armed**.

### Auto-flip rule

When auto-flip is armed (virgin record only), the toggle flips ON the first time **either** of these happens:

1. The comment text transitions from empty to non-empty (any first character).
2. Any rubric cell is clicked (any first proficiency selection).

Auto-flip disarms after firing once OR after the user manually clicks the toggle. After disarm, the toggle is purely manual.

### Pending-change & save behaviour

`hasPendingChanges` is extended:
```
hasPendingChanges = !isLocked && (
  Object.keys(pending).length > 0 ||
  comment !== loadedComment ||
  display !== loadedDisplay
)
```

Update Schoology is enabled by any of the three. Discard reverts all three to their loaded values.

On save, the order in `handleSave` becomes:

1. If rubric scores changed → `writeMasteryScores` (unchanged; iapi2).
2. If `comment !== loadedComment` OR `display !== loadedDisplay` → `writeMasteryComment` with both `comment` and `commentStatus` (boolean) in the request body.

After both succeed: the page reloads via the existing `onSaved` → `load()` path, picking up the new state from local DB.

### Server route changes — `/api/mastery/:courseId/write-comment`

Today the route ([server/routes/mastery.js](../../../server/routes/mastery.js#L397)) accepts `{ enrollmentId, assignmentId, comment }`. Add:

- `commentStatus` (boolean, optional) on the request body.
- In the PUT payload to Schoology, send `comment_status: commentStatus === false ? null : 1`. If `commentStatus` is omitted, default to `1` (preserves current behaviour for any future caller that doesn't yet pass it).
- The fresh-grade-fetch added in #46 stays as-is (still needed to echo `grade` and `exception` correctly).
- After a successful PUT, the local-DB `UPDATE grades SET grade_comment = ?, comment_status = ?` writes the new `comment_status` (1 or null) instead of the hardcoded `1`.

### Data model

No schema changes. The existing `grades.comment_status` column already stores the integer form (`1` / `null`). The toggle is presentation of that column; pending state lives in component state until save.

### What this does NOT do

- No bulk class-level toggle. Per-student only. (Can be added later if requested.)
- No autosave on toggle flip. Stays inside Prism's existing batched-update model on this page.
- No control over the `comment_status` flag from anywhere other than the assessment page in this iteration.

## Acceptance

- Teacher can flip a per-student "Display to student" toggle on the assessment page, right-aligned with the Update Schoology button.
- Toggle's loaded state matches `grades.comment_status`: `1` → ON, `null`/missing → OFF.
- For a virgin record (no grade row), toggle defaults OFF and auto-flips ON on first comment keystroke or first rubric click. Once a record has been synced, the toggle's loaded value comes from Schoology and is never auto-changed.
- Update Schoology activates when toggle, scores, or comment differ from loaded values; Discard reverts all three.
- Saving with toggle ON writes `comment_status: 1` to Schoology and the student sees the grade + comment + proficiencies; saving with toggle OFF writes `comment_status: null` and the student sees nothing for that assignment until republished.
- Local DB `grades.comment_status` reflects the just-saved value without waiting for a full sync.

## Verification

Manual, in a real Schoology section with an aligned rubric assignment:

1. Fresh student + virgin record: comment field empty, toggle OFF. Type a character → toggle auto-flips ON. Save → confirm in Schoology UI the comment is visible to the student.
2. Same fresh student, virgin record: instead of typing, click a rubric cell → toggle auto-flips ON. Save → confirm in Schoology that proficiencies are visible to the student.
3. Existing student with synced `comment_status: null`: load the assessment page → toggle is OFF. Type a fresh comment → toggle stays OFF (Schoology's state respected). Save → student still cannot see the feedback.
4. Existing student with synced `comment_status: 1`: load → toggle ON. Manual flip OFF → Save → confirm Schoology UI shows comment hidden from student. Refresh from Schoology → local toggle reflects new OFF state.
5. Locked rubric (active exception): toggle disabled and does not flip on any interaction.
