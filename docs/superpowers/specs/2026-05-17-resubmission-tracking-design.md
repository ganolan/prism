# Resubmission tracking — "Re-submit requested" flag + resubmission auto-detect

**Issue:** #49 (Resubmission tracking)
**Milestone:** Wave 3 — Flag-model chain
**Status:** Approved design — ready for implementation plan
**Spun-out work:** #53 (probe: OneDrive/GDrive resubmission detection via Schoology unsubmit)

## Problem

Teachers sometimes mark a piece of student work, decide it isn't good enough,
and ask the student to resubmit. Two failures follow:

1. **The teacher forgets they asked for a re-submission.** The assignment is
   already graded in Schoology — nothing in Prism or Schoology reminds the
   teacher this row is waiting on a redo.
2. **The teacher doesn't notice the resubmission.** A student can resubmit
   silently; Schoology's revision history isn't prominent.

Neither of Schoology's exception flags (Incomplete, Missing) is usable — both
wipe existing grade data on Schoology's side (#40). The teacher needs a
non-destructive, Prism-local indicator that survives Schoology syncs.

## Scope

This is the last issue in the Wave 3 flag-model chain. It builds directly on
the submission-scoped `flags` model established by #20/#19
(`docs/superpowers/specs/2026-05-17-submission-scoped-flags-design.md`).

The feature has two independent signals plus a shared visual treatment:

- **Part A — "Re-submit requested"** — a teacher-set, Prism-local flag.
- **Part B — "Resubmitted"** — an auto-detected indicator derived from
  Schoology submission-revision data.
- **Part C — visual treatment** across three surfaces.

One spec, one feature. The implementation plan is **phased**: Phase 1 ships
Part A (low risk, reuses the `flags` table); Phase 2 ships Part B. Each surface's
Part C treatment ships with whichever phase introduces the signal.

### Naming

- **"Re-submit requested"** — the *teacher* initiates this: they ask the student
  to redo work that has missing components or major issues. (Not "re-grade
  requested" — that wording implies the student acted.)
- **"Resubmitted"** — the *student* did it; Prism detected it.

The two form a **request → fulfilment** pair. A row showing both is the
strongest combined signal: the teacher asked and the student has now delivered.

## Approaches considered

### Part A storage — reuse `flags` (chosen)

Part A is another `flag_type` on the `flags` table reshaped by #20/#19, **not**
columns on `grades` as issue #49's data-model sketch suggested. The `flags`
table already models a submission-scoped teacher flag exactly; a third storage
location would fragment the flag mechanism. No schema change.

### Part B detection — timestamp comparison (chosen)

Three options were weighed for "resubmitted since last graded":

1. **`graded_revision_id` baseline** (issue's sketch) — store the revision id
   considered "graded"; bump it only on a Prism grade/comment write. Rejected:
   re-grading directly in Schoology never clears the indicator (blind spot), and
   it is a stored value that can drift from reality.
2. **Timestamp comparison** (chosen) — store the latest submission revision's
   `created` timestamp; derive `resubmitted` at read time as
   `latest_revision_at > grade_timestamp`. One source of truth, least code, no
   write-path coupling, and self-clearing whenever the grade changes — in Prism
   *or* in Schoology.
3. **Hybrid** (baseline re-based from the grade timestamp) — rejected: to
   re-base correctly it must perform the timestamp comparison anyway, so it
   inherits that dependency *and* adds a second drift-prone source of truth.

Timestamp comparison's one real risk — that the stored grade timestamp must
genuinely be *grade-modified* time — is retired by an explicit verification step
at the start of Phase 2 (see Implementation step 1). The issue's warning about
"don't auto-clear on grade change" applies to Part A's *manual* flag, where
false-clearing destroys teacher intent; for Part B's *auto-detected* indicator,
clearing slightly eagerly is low-harm.

## Design

### 1. Data layer

**Part A — `flags` table, no schema change.**
- A "re-submit requested" flag is a `flags` row with
  `flag_type = 'resubmit_requested'`, `student_id` set, `assignment_id` set,
  `flag_reason` left `NULL`. It is a **pure toggle** — no reason text.
- `resolved` / `resolved_at` are unused (as for `review_needed`): the flag
  exists or it does not; clearing it is a `DELETE`.
- `POST /api/flags` validation is relaxed: `flag_reason` is required **only**
  when `flag_type = 'review_needed'`. A `resubmit_requested` flag needs just
  `student_id` + `assignment_id`. (Today the route rejects any flag without a
  non-empty `flag_reason`.)
- `DELETE /api/flags/:id` clears it (unchanged).

**Part B — one new `grades` column.**
- `ALTER TABLE grades ADD COLUMN latest_revision_at INTEGER DEFAULT 0` — added
  to the migrations list in `server/db/index.js`. Holds the `created` timestamp
  of the student's latest **non-draft** submission revision, written by sync.
- `resubmitted` is **derived, never stored**. A shared server helper
  `isResubmitted(grade)` returns true when **all** hold:
  - `latest_revision_at > submitted_at`
  - the row has an actual grade (score present, or an exception set)
  - `submitted_at > 0` (guard: if the grade timestamp is unknown, no indicator)

**Dead-code cleanup.** #20/#19 left `PUT /api/flags/:id/resolve` and
`/reopen` (`server/routes/flags.js`) and `resolveFlag` / `reopenFlag`
(`client/src/services/api.js`) unreachable — neither flag type has a
resolve/reopen lifecycle. #49 was tasked with deciding their fate: **remove
them.** The `resolved` column itself stays (harmless; dropping it needs a
SQLite table rebuild).

### 2. Sync — Part B (Phase 2)

The sync's submission-status loop in `server/services/sync.js` already calls
`getSubmissionStatus` for every dropbox assignment × student to get late/draft —
**no extra Schoology API calls are needed.** The same response carries the full
`revision[]` array.

- A companion to `getSubmissionStatus` in `server/services/schoology.js`
  returns the **latest non-draft revision's `created`** timestamp (max `created`
  over revisions with `draft = 0`), or `0`. A draft revision is not a
  submission, so it must not seed the baseline — this also avoids a false
  positive where a student merely *opens* a OneDrive doc after grading.
- `upsertSubmissionStatus` writes `latest_revision_at` from that value;
  `clearSubmissionStatus` (empty revision array) zeroes it.
- `upsertGrade` (the grades-API path) does **not** list `latest_revision_at`,
  so its `ON CONFLICT` update preserves whatever submission-status sync wrote.
- **No change to the Prism grade-write routes** (`/api/mastery/:courseId/write`,
  `/write-comment`). Because detection is pure timestamp comparison, a re-grade
  moves `submitted_at` on the next sync and the indicator clears itself.

### 3. API surface — read endpoints (Phase 1 + Phase 2)

A shared server helper `isResubmitted(grade)` keeps the three surfaces
consistent.

- **`GET /api/courses/:id/gradebook`** — add `latest_revision_at` to the grades
  SELECT; one extra query for `resubmit_requested` flags across the course's
  assignments. Each grade cell gains `resubmit_requested: bool` and
  `resubmitted: bool`.
- **`GET /api/mastery/:courseId/assignment/:assignmentId`** — already builds
  `reviewFlagMap`; add a parallel `resubmitFlagMap` for
  `flag_type = 'resubmit_requested'`. Each student gains
  `resubmit_flag: { id } | null` and `resubmitted: bool`.
- **`GET /api/students/:id`** — `resubmit_requested` flags already flow through
  `student.flags` → `assignmentFlagMap` for free (the existing submission-scoped
  flag path). Add `latest_revision_at` + `submitted_at` to the student's grade
  rows so `CourseSection` can derive `resubmitted`.

### 4. UI — Part C visual treatment

One blue family, two intensities. Real colours come from theme tokens
(`app.css` CSS custom properties) so they adapt per theme — no hardcoded hex.

- **Re-submit requested** — a light-blue **tint**.
- **Resubmitted** — a darker-blue **border / inset ring**, read-only.
- **Both** — tint + ring stacked; the strongest signal.

**Course gradebook** (`client/src/pages/CoursePage.jsx`, `GradebookView`):
- `resubmit_requested` → light-blue cell-background tint.
- `resubmitted` → a 2px darker-blue **inset ring** (`box-shadow: inset`) — drawn
  inside the cell so it never collides with the grey gridlines and causes no
  layout shift.
- Both → tint + inset ring.
- A `title` tooltip on each marked cell names the signal.

**Assessment page** (`client/src/pages/AssessmentSummaryPage.jsx`,
`StudentRubricCard`) — the card header carries the control and badges:
- Unflagged → a dashed ghost pill `⟳ Request re-submit`. One click `POST`s the
  flag (`{ student_id, assignment_id, flag_type: 'resubmit_requested' }`) — a
  pure toggle, **no reason input**.
- Flagged → a tinted pill `⟳ Re-submit requested` with a `✕` clear action that
  `DELETE`s the flag.
- `resubmitted` true → a read-only bordered pill `↩ Resubmitted` (never a
  button).
- Both → both pills, plus a subtle blue outer ring on the card.
- The flag write is **immediate and independent** of the "Update Schoology"
  save — Prism-local state, never bundled into a Schoology write. The write
  re-fetches via the page's existing `load()` so badges reflect new state.

**Student page** (`client/src/pages/StudentPage.jsx`, `CourseSection`) — in the
assignment row's due+flags row:
- `resubmit_requested` → tinted pill `⟳ Re-submit requested`.
- `resubmitted` → bordered pill `↩ Resubmitted`.
- The existing amber `review_needed` flag (#20) is unchanged and coexists.

### 5. Testing

TDD — failing tests first, per phase.

**Server (`npm run test:server`):**
- `POST /api/flags` with `flag_type = resubmit_requested` + `assignment_id` and
  no `flag_reason` → 201, row created; `review_needed` without a reason still →
  400. `DELETE /api/flags/:id` removes the flag.
- The removed `PUT /api/flags/:id/resolve` and `/reopen` routes → 404.
- `isResubmitted()`: true only when `latest_revision_at > submitted_at`, the row
  is graded, and `submitted_at > 0`; false for ungraded, `latest_revision_at = 0`,
  and `submitted_at = 0`.
- Sync: submission-status upsert stores `latest_revision_at` from the latest
  non-draft revision; an empty revision array zeroes it; the grade-API upsert
  does not clobber it. The `ALTER TABLE` migration is idempotent.
- `/gradebook`, `/mastery/:courseId/assignment/:assignmentId`, and
  `/students/:id` include the new `resubmit_requested` / `resubmitted` /
  `resubmit_flag` fields.

**Client (`cd client && npm test -- --run`):**
- `StudentRubricCard`: ghost toggle → click `POST`s the flag and the pill
  appears; `✕` `DELETE`s it and the pill is removed; the flag write triggers
  **no** Schoology write. `resubmitted` prop → read-only pill renders; both →
  card emphasis ring.
- `GradebookView`: a cell renders the tint / inset ring / both correctly.
- `CourseSection`: row pills render per state; the amber `review_needed` flag
  still coexists.

## Limitations

**Part B auto-detect works for native Schoology dropbox assignments only.** For
OneDrive / Google Drive (`lti_submission`) assignments, Schoology's public API
does not expose post-submit revisions — the submitted state returns an empty,
timestamp-less `revision[]` array (documented in `server/services/schoology.js`
and `server/services/sync.js`). A resubmission on such an assignment is
therefore invisible to Part B: `latest_revision_at` stays `0` and `resubmitted`
reads false.

For OneDrive/GDrive assignments the fallback is **Part A** — the manual
"Re-submit requested" flag is fully Prism-local, depends on no Schoology data,
and works on every assignment type. A teacher who asks for a re-submission on a
OneDrive assignment sets the manual flag; it persists until they clear it.

A possible future path — Prism performing the unsubmit itself and inferring a
draft baseline — is filed as **#53** for empirical probing; it depends on an
unverified Schoology unsubmit endpoint and a destructive Schoology write, so it
is deliberately out of scope here.

No code branch on assignment type is needed: for OneDrive the empty revision
array naturally yields `latest_revision_at = 0` and no indicator.

## Out of scope

- Bulk "mark as re-graded" across multiple students.
- Notifications outside the app (email digest of pending re-grades).
- Revision history beyond the most recent round.
- An aggregate "all flagged submissions" worklist view.
- Any Schoology write-back (see #53).

## Acceptance

- A teacher can toggle "Re-submit requested" on any grade row from the
  assessment page; it shows on the gradebook and the student page.
- The flag is Prism-local, survives course syncs (cleared only by the teacher),
  and is never written to Schoology.
- When a student resubmits to a **native dropbox** assignment, the next sync
  surfaces a "Resubmitted" indicator on that row.
- The "Resubmitted" indicator clears when the teacher updates the grade or
  comment (the grade timestamp moves past the latest revision).
- A row with both signals shows both, with combined emphasis.
- OneDrive/GDrive resubmissions are not auto-detected; the manual flag is the
  documented fallback.

## Cross-references

- #20 / #19 — submission-scoped review flags; the reshaped `flags` model this
  builds on.
- #40 — Schoology destructive-write findings; why this feature is Prism-local.
- #13 — added the `grades.late` / `draft` / `submitted_at` columns and the
  `/submissions` sync path Part B extends.
- #53 — spun-out probe for OneDrive/GDrive resubmission detection.
