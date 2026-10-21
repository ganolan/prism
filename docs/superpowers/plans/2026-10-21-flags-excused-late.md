# Flags: Excused and Late Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set, change and clear Schoology's Excused and Late flags from Prism (assessment card, gradebook pop-up, student page), keep a copy of any grade Excused removes, and show every flag clearly in the gradebook.

**Architecture:** One server service (`server/services/gradeFlags.js`) does the flag write with the quiz write-back safety pattern (lock, fresh read, refuse on change, write, read back, mirror), saves the pre-excuse grade in a new `excused_grades` table, withdraws open triage records, publishes an optional `excused` status line, and restores the saved grade into the card's draft on clear. One client component (`FlagsMenu`) serves the card header and the shared `AssignmentFeedback` view. Display work (late clocks, exception chips, colors, Overdue, removing Flag for review) is independent of the write path and lands first.

**Tech Stack:** Node ESM + Express + better-sqlite3, React + Vite, Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-21-flags-excused-late-design.md` (mockups: https://claude.ai/artifact/RcePZWizTujDo17X1zpLf3, version 7).

## Global Constraints

- Every color comes from CSS custom properties in `client/src/app.css`; add tokens there, never hex in components.
- No em dashes in UI copy (a guard test enforces it); dates via `formatDate` / `lineDate` (DD/MM order).
- UI copy is American spelling: "grayed", "color".
- Status lines are plain printable ASCII (`plainLine`, `checkLine`).
- New columns or tables go in `server/db/schema.sql` **and** the `MIGRATIONS` array in `server/db/index.js`.
- Menu copy, verbatim: Excused "Visibly flags the work as excused in Schoology. It is left out of {first name}'s grade, and the rubric locks."; Late "Visibly flags the work as late in Schoology. The grade still counts."; ticked item "Choose again to clear it."; caption "In Schoology only"; hover "Set these in Schoology for now. Prism may add them later."
- Colors: Excused green, Late red, Incomplete amber, Missing red, everywhere a flag shows.
- A live Schoology write happens only after Graham approves it, on a target he names, followed by a read-back (AGENTS.md "Schoology write-back is live").
- Tests: `npx vitest run` at the root and `cd client && npx vitest run`, then `npm run build`, before every commit that touches code.

## Review Focus

1. **The Schoology row changed after the page loaded** (a teacher edited it in Schoology): the write is refused with what changed, nothing is written. Test in Task 7.
2. **The flag write lands but the read-back disagrees or fails:** Prism mirrors nothing it did not read back, keeps the saved copy, and reports the error. Test in Task 7.
3. **The status line fails after the flag write succeeded:** the flag and withdrawals stand, and the response reports the line failure so the client shows it. Test in Task 7.
4. **Restore when the student already has a draft:** the draft is replaced, and its `base` equals `cardBaselineFor` for the post-clear state, so the card keeps it. Test in Task 7.
5. **Two quick clicks, or a triage action on the same pair at the same moment:** the second gets `BUSY` (409) from `lockPair` before any read. Test in Task 7.

---

### Task 1: Probe Schoology's exception behavior (live, Graham-approved)

Blocks Tasks 6 and 7: the results fix the payload, the clear value, and what Excused removes.

**Files:**
- Create: `scripts/probe-grade-exceptions.js`
- Modify: `.claude/schoology-api-reference.md` (new dated section "Grade exceptions (#40, verified 2026-10-..)")

**Interfaces:**
- Produces: documented answers used by Task 7: `CLEAR_VALUE` (0 or null), `EXCUSED_REMOVES` (subset of `score`, `topic_levels`, `comment`), `LATE_KEEPS_GRADE` (bool), `LATE_INDEPENDENT` (bool), and the list of Schoology menu flags beyond the four exceptions.

- [ ] **Step 1: Ask Graham, with the question tool, for two test targets**: one numeric or scale task and one aligned summative, each with a student he names (section, task, student). Nothing is written before his answer.
- [ ] **Step 2: Write the script.** `node scripts/probe-grade-exceptions.js <sectionId> <assignmentId> <enrollmentId>` prints the pair's public grade record (`getSectionGrades`), its `mastery_scores` levels after a single-pair mastery pull (reuse the existing mastery sync function for one assignment), and the gradebook cell from `grader_grade_data` (the internal read documented in the API reference, which shows any separate `flags` field). It writes only when `CONFIRM=<op>:<assignmentId>:<enrollmentId>` matches, with `op` one of `excused`, `excused-nullgrade`, `late`, `clear0`, `clearnull`, sending through `pushGradeComments` with every unchanged field echoed (the #46 rule), then prints the same three reads again and the raw 207 body. Copy the CONFIRM pattern from `scripts/verify-lti-unsubmit-http.js`.
- [ ] **Step 3: Run the read-only form** on both targets and show Graham the output.
- [ ] **Step 4: Run the matrix, one approved write at a time:** Excused on ungraded; Excused on graded (numeric); Excused with `grade: null`; Late on graded; Excused to Late; clear with 0; clear with null; Excused on the aligned task with topic levels and a comment, then clear; a two-entry bulk write with one invalid enrollment id. After each, the three reads. Also ask Graham to open Schoology's flag menu once and list its items (Absent and any other).
- [ ] **Step 5: Record each result** in the API reference: date, payload, raw response shape as observed, before and after. State the five answers named under Interfaces. Restore both targets to their starting state with one more approved write each.
- [ ] **Step 6: Commit**

```bash
git add scripts/probe-grade-exceptions.js .claude/schoology-api-reference.md
git commit -m "probe: Schoology grade exceptions, verified live (#40)"
```

---

### Task 2: Late shows as two clocks, and the grade stays

**Files:**
- Modify: `client/src/lib/gradeLabel.js` (`gradeLabel`, `submissionStatus`)
- Modify: `server/services/submissionTimeline.js:76` (`schoologyLate`) and its client mirror if one exists (`client/src/lib/submissionTimeline.js`, `lateText`)
- Modify: `client/src/components/LateClock.jsx`, `client/src/app.css` (`.late-clock--flagged`)
- Modify: `client/src/pages/CoursePage.jsx` (cell `isLate`), `client/src/components/SubmissionBadges.jsx`, `client/src/pages/AssessmentSummaryPage.jsx` (remove "Marked late in Schoology")
- Test: `client/src/lib/gradeLabel.test.js`, `server/services/submissionTimeline.test.js`, `client/src/pages/CoursePage.cellMarkers.test.jsx`, `client/src/components/LateClock.test.jsx` (create)

**Interfaces:**
- Produces: timeline `submission.flagged: boolean` (exception 4), `submission.late` from submission timing only; `<LateClock variant flagged title />`; `lateText(timeline)` returns "Marked late with Flags" when only flagged, "Marked late with Flags\n<submission text>" when both.

- [ ] **Step 1: Write failing tests:**
  - `gradeLabel({ score: 87.5, max_points: 100, exception: 4, grading_scale_id, scales })` returns the scale level, not `{ text: 'Late' }`.
  - `submissionStatus` with `exception: 4` and a submission returns the status badge (unchanged behavior) and never a `{ kind: 'exception', label: 'Late' }`.
  - timeline for a grade with `exception: 4, late: 0` has `submission.flagged === true` and `submission.late === false`.
  - `render(<LateClock variant="corner" flagged />)` has class `late-clock--flagged`; without `flagged`, it does not.
  - a gradebook cell with `exception: 4` shows the level chip and a flagged clock whose title is "Marked late with Flags"; a cell with `late: 1, exception: 4` shows one flagged clock with both lines in its title.
- [ ] **Step 2: Run** `npx vitest run server/services/submissionTimeline.test.js` and `cd client && npx vitest run src/lib/gradeLabel.test.js src/components/LateClock.test.jsx src/pages/CoursePage.cellMarkers.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** `gradeLabel` handles exceptions 1 to 3 only. `schoologyLate` reads `g.late` only; add `flagged: g.exception === LATE_EXCEPTION`. `LateClock` takes `flagged` and renders a filled disc (circle `fill="currentColor"`, hands stroked with `var(--card-bg)`). The cell, `SubmissionBadges` and the card status pill show the clock when `late || flagged`, flagged form when `flagged`. Delete the amber "Marked late in Schoology" badge.
- [ ] **Step 4: Run the same tests.** Expected: PASS. Then both full suites.
- [ ] **Step 5: Commit** `feat(late): one clock per source, flagged Late keeps the grade (#40)`.

---

### Task 3: Late is not feedback

**Files:**
- Modify: `server/lib/resubmission.js` (`hasFeedback`), `server/lib/feedbackFingerprint.js` (`fingerprint`, `hasPriorFeedback`), `server/services/assessmentContext.js` (`gradingState`), `server/db/index.js` (`MIGRATIONS`)
- Test: `server/lib/resubmission.test.js`, `server/lib/feedbackFingerprint.test.js`, `server/services/assessmentContext.test.js`, `server/db/index.test.js` (or the existing migrations test)

**Interfaces:**
- Produces: exception 4 counts as 0 for feedback, fingerprints and grading state.

- [ ] **Step 1: Write failing tests:** `hasFeedback({ score: null, exception: 4, grade_comment: '' }) === false`; `hasFeedback({ exception: 1 }) === true`; `fingerprint({ exception: 4 }) === fingerprint({ exception: 0 })`; `hasPriorFeedback('{"s":null,"e":4,"l":[],"c":""}') === false`; `gradingState({ scoredCount: 0, topicsCount: 2, hasComment: false, exception: 4 }) === 'ungraded'`; after migrations run on a DB holding a `feedback_snapshots` row whose `fingerprint`, `synced_fingerprint`, `arrival_baseline` and `save_log` contain `"e":4,"l"`, each holds `"e":0,"l"`.
- [ ] **Step 2: Run** `npx vitest run server/lib server/services/assessmentContext.test.js server/db`. Expected: FAIL.
- [ ] **Step 3: Implement.** A shared `const feedbackException = (e) => (Number(e) === 4 ? 0 : Number(e) || 0)` in `server/lib/resubmission.js`, used by all three. Migration: one idempotent `UPDATE feedback_snapshots SET fingerprint = replace(fingerprint, '"e":4,"l"', '"e":0,"l"'), …` over the four columns.
- [ ] **Step 4: Run tests.** Expected: PASS; then both full suites.
- [ ] **Step 5: Commit** `fix(triage): a Late flag is not feedback or a grade (#40)`.

---

### Task 4: Exception chips and flag colors

**Files:**
- Create: `client/src/components/ExceptionChip.jsx`, `client/src/components/ExceptionChip.test.jsx`
- Modify: `client/src/app.css` (tokens `--flag-excused`, `--flag-excused-bg`, `--flag-late`, `--flag-late-bg`, `--flag-incomplete`, `--flag-missing`; class `.exception-chip`), `client/src/lib/gradeLabel.js` (exception tones), `client/src/pages/CoursePage.jsx` (cell), `client/src/components/AssignmentFeedback.jsx` (score slot), `client/src/pages/StudentPage.jsx`, `client/src/pages/AssessmentSummaryPage.jsx` ("Excused, rubric locked")
- Test: `client/src/pages/CoursePage.cellMarkers.test.jsx`, `client/src/lib/gradeLabel.test.js`

**Interfaces:**
- Produces: `<ExceptionChip exception={1|2|3} savedLevel={string|null} />` rendering `Exc` / `Inc` / `Miss` with titles "Excused: left out of the grade" (plus ". Grade saved in Prism: {level}" when `savedLevel`), "Incomplete (set in Schoology)", "Missing (set in Schoology): counts as zero"; `EXCEPTION_TONE = { 1: 'green', 2: 'amber', 3: 'red' }` exported from `gradeLabel.js`.

- [ ] **Step 1: Write failing tests:** chip text and title per exception; chip has class `exception-chip exception-chip--excused` (dashed border in CSS); a gradebook cell with exception 1 renders the chip, is a button that opens the pop-up, and shows no level chip; `submissionStatus({ exception: 1 })[0].tone === 'green'`, Incomplete `'amber'`, Missing `'red'`; the assessment card badge "Excused, rubric locked" has class `badge-green`.
- [ ] **Step 2: Run** the client tests above. Expected: FAIL.
- [ ] **Step 3: Implement.** Chip: card background, 1.5px dashed border in the ink color, the level chip's size and radius. In the cell, an exception 1 to 3 renders the chip inside the same `cell-open` button graded cells use. `AssignmentFeedback` renders the chip where it renders the score.
- [ ] **Step 4: Run tests.** Expected: PASS; both full suites.
- [ ] **Step 5: Commit** `feat(gradebook): dashed exception chips; Excused green, Late red (#40)`.

---

### Task 5: Rename Prism's Missing status to Overdue

**Files:**
- Modify: `client/src/lib/gradeLabel.js` (`nonLtiBadges`: kind `overdue`, label `Overdue`), `client/src/pages/CoursePage.jsx` (`SHORT_BADGE.overdue = 'O'`), and every other hit of the status sense of "Missing" found by `grep -rn "'missing'\|Missing" client/src server mcp --include=*.js --include=*.jsx` (keep exception 3 "Missing" and `referred_missing`'s wording "not submitted")
- Test: `client/src/lib/gradeLabel.test.js`, any test asserting the old label

- [ ] **Step 1: Write failing tests:** an overdue unsubmitted task gives `[{ kind: 'overdue', label: 'Overdue', tone: 'red' }]`; its gradebook letter is `O`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** and update every hit; PrisMCP descriptions in `mcp/server.js` that name the status.
- [ ] **Step 4: Run both full suites.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: Prism's past-due status is Overdue; Missing means Schoology's flag (#40)`.

---

### Task 6: Remove Flag for review

**Files:**
- Delete: `server/routes/flags.js` (and its test if any); unmount in `server/index.js`
- Modify: `server/routes/courses.js` (`review_needed`), `server/routes/students.js` (`SELECT * FROM flags`; keep the resubmission entries), `server/services/assessmentContext.js` (`getFlagsByStudent`: return only `resubmit_requested`), `server/services/unfinishedGrading.js` (drop the `flagged` reason), `client/src/pages/AssessmentSummaryPage.jsx` (pill, input, handlers, `review_flag`), `client/src/components/SubmissionBadges.jsx`, `client/src/pages/CoursePage.jsx`, `client/src/pages/StudentPage.jsx`, `client/src/lib/assessmentFilters.js` (`review` pill, `flagged` reason, `REFINE_IDS`), Triage's Unfinished grading panel, `client/src/services/api.js`, `mcp/server.js` (descriptions), `server/db/schema.sql` (remove `flags`), `server/db/index.js` (`MIGRATIONS`: `DROP TABLE IF EXISTS flags`)
- Test: update every test that references `review_needed`, `review_flag`, `flagged` or `/api/flags`

**Interfaces:**
- Produces: `get_assignment_context` students carry `flags: { resubmit_requested }` only. Task 8 places `FlagsMenu` where the pill was.

- [ ] **Step 1: Write failing tests:** `getFlagsByStudent` result has no `review_needed` key; `GET /api/flags` answers 404; `UNFINISHED_GRADING_REASONS` equals `['draft', 'feedback_hidden', 'unread_comment']`; the assessment card renders no "Flag for review" button; after migrations, `SELECT name FROM sqlite_master WHERE name = 'flags'` is empty.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the removals; `grep -rn "review_needed\|review_flag\|flag_reason\|/api/flags\|Flag for review" server client/src mcp scripts docs/agents` returns only historical docs and the AI `reviewer_flags`.
- [ ] **Step 4: Run both full suites.** Expected: PASS.
- [ ] **Step 5: Commit** `refactor: remove Flag for review and the flags table (#40)`.

---

### Task 7: The flag write service and route

**Files:**
- Create: `server/services/gradeFlags.js`, `server/services/gradeFlags.test.js`, `server/routes/gradeFlags.js`, `server/routes/gradeFlags.test.js`
- Modify: `server/services/schoology.js` (rename `pushGradeComments` to `pushGradeUpdates`; update `server/routes/mastery.js`, `server/services/statusLinePublisher.js`, tests), `server/services/statusLinePublisher.js` (export `pairTarget`, `freshGrade`; add `'excused'` to `STATUS_LINE_KINDS`), `server/lib/statusLines.js` (`excusedLine`), `server/db/schema.sql` + `server/db/index.js` (`excused_grades`), `server/index.js` (mount `/api/grade-flags`), `server/services/triage.js` / `resubmissions.js` (no change expected: reuse `undoExtension`, `undoResubmission`, `undoReferral`)

**Interfaces:**
- Consumes: Task 1's five answers; `lockPair`, `putSucceeded`, `publishStatusLine`, `removeStatusLine` (statusLinePublisher); `cardBaselineFor` (unfinishedGrading); `undoExtension`, `undoReferral` (triage), `undoResubmission` (resubmissions).
- Produces:
  - table `excused_grades(student_id INTEGER, assignment_id INTEGER, saved_json TEXT NOT NULL, saved_at TEXT NOT NULL, restored_at TEXT, PRIMARY KEY (student_id, assignment_id))`; `saved_json` = `{ score, max_points, comment, comment_status, topics: { [topicId]: level }, rows: { [criterion]: level }, scale_level }`.
  - `excusedLine({ on, note }) -> string`: `Excused on ${lineDate(on)}.` plus `withNote`, e.g. `Excused on Tue 21/10. Medical leave from 13 to 24 October.`
  - `readFlagState(db, { studentId, assignmentId }) -> Promise<{ exception, score, comment, commentStatus, graded, savedGrade|null, openRecords: [{ type: 'extension'|'resubmission'|'referral', id, label }], hasDraft }>` (fresh Schoology read).
  - `setGradeFlag(db, { studentId, assignmentId, flag: 'excused'|'late'|'none', expected: { exception, score }, reason = null, restore = true }) -> Promise<{ exception, saved: boolean, withdrawn: [...], line: { published|removed|error }|null, restored: { draft: boolean, notRestored: string[] }|null }>`; throws `TriageError` with codes `CHANGED` (409, message names what changed), `BUSY`, `NOT_FOUND`, `NOT_ELIGIBLE` (archived or excluded course, no enrolment), `SCHOOLOGY_READ_FAILED`, `SCHOOLOGY_WRITE_FAILED`, `READBACK_MISMATCH` (502).
  - Routes: `GET /api/grade-flags?studentId=&assignmentId=` → `readFlagState`; `POST /api/grade-flags` body `{ studentId, assignmentId, flag, expected, reason, restore }` → `setGradeFlag`; errors as `{ error, code }` with the triage status map plus `CHANGED: 409`, `READBACK_MISMATCH: 502`.

- [ ] **Step 1: Write failing tests** (mock `getSectionGrades` and `pushGradeUpdates` as `statusLinePublisher.test.js` does):
  - `excusedLine({ on: '2026-10-21', note: 'Medical leave.' }) === 'Excused on Tue 21/10. Medical leave.'`; without a note, `'Excused on Tue 21/10.'`.
  - excusing a graded pair stores `excused_grades` before the PUT (assert the row exists when the PUT mock runs), sends `exception: 1` with echoed fields per Task 1, reads back, mirrors `grades.exception = 1`.
  - storing the copy fails → no PUT, error thrown.
  - fresh exception or score differs from `expected` → `CHANGED`, no PUT.
  - read-back shows the old exception → `READBACK_MISMATCH`, `grades` unchanged, saved copy kept.
  - open extension, resubmission and referral → each undone (record only), listed in `withdrawn`; with a reason, one `publishStatusLine` call with kind `excused`; without a reason and a stored line from a withdrawn record, one `removeStatusLine`.
  - `publishStatusLine` throws after the flag write → result has `exception: 1` and `line.error`, records stay withdrawn.
  - Late sends `exception: 4`, keeps the grade, opens no records step.
  - `flag: 'none'` from 1 with a saved copy and `restore: true` → PUT with the clear value, `assessment_drafts` row holds `pending` with the saved topic, `row:` and `__scale__` levels, `comment`, `display`, and `base === cardBaselineFor(db, a)(student)`; an existing draft is replaced; `restored_at` set; a points-only task returns `notRestored: ['score']`.
  - `restore: false` keeps the row with `restored_at` null.
  - two overlapping calls on one pair → the second rejects `BUSY` before any read.
  - an archived course → `NOT_ELIGIBLE`.
- [ ] **Step 2: Run** `npx vitest run server/services/gradeFlags.test.js server/routes/gradeFlags.test.js server/lib/statusLines.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `gradeFlags.js` in this order per call: `lockPair` → `pairTarget` → eligibility → `freshGrade` → compare with `expected` → (Excused on a graded pair) save the copy from the fresh record plus `mastery_scores` and `rubric_row_levels` → PUT (echoing every field Task 1 found the write could clear, such as a separate `flags` value) → re-read and confirm → mirror (`grades` score, exception, comment from the read-back) → withdraw records → status line → (clear with restore) draft → release. The rename of `pushGradeComments` is mechanical: grep every package for the old name first.
- [ ] **Step 4: Run tests.** Expected: PASS; both full suites.
- [ ] **Step 5: Commit** `feat: write Excused and Late to Schoology with a saved grade (#40)`.

---

### Task 8: The Flags menu and panels

**Files:**
- Create: `client/src/components/FlagsMenu.jsx`, `client/src/components/FlagsMenu.test.jsx`, `client/src/components/ExcusePanel.jsx`, `client/src/components/ClearExcusedPanel.jsx`
- Modify: `server/routes/mastery.js` (`GET /:courseId/assignment/:assignmentId` adds `excused_grade` per student from `excused_grades` while unrestored), `server/routes/courses.js` (gradebook grades add `excused_saved_level`), `client/src/services/api.js` (`getGradeFlags`, `setGradeFlag`), `client/src/pages/AssessmentSummaryPage.jsx` (header slot; locked rubric shows saved levels with caption), `client/src/components/AssignmentFeedback.jsx` (badge row), `client/src/pages/CoursePage.jsx` (`RubricModal` refresh after a change), `client/src/pages/StudentPage.jsx`, `client/src/app.css`, `docs/design-language.md`

**Interfaces:**
- Consumes: Task 7 routes; `ExceptionChip`, `EXCEPTION_TONE` (Task 4); `ActionPanel` portal (`client/src/components/ActionPanel.jsx`).
- Produces: `<FlagsMenu student={{ id, firstName }} assignmentId exception score size="md"|"sm" panelHost onChange={(result) => void} />`.

- [ ] **Step 1: Write failing tests:**
  - closed pill text "Flags" with no flag, "Excused" with class `flags-pill--excused` when exception 1, "Late" with `flags-pill--late` when 4.
  - open menu lists Excused and Late with the verbatim copy, a divider, the caption "In Schoology only", then every other Schoology menu flag Task 1 found (Incomplete, Missing, and any such as Absent) with `aria-disabled="true"`; exception 3 ticks Missing in the grayed group.
  - choosing Late calls `setGradeFlag` with `flag: 'late'` and `expected` from props, no panel; while pending the pill is disabled.
  - choosing Excused opens `ExcusePanel` (after `getGradeFlags`): reason input labeled "Reason for the student (optional)", the comment preview `Excused on Tue 21/10. <reason>`, "Excusing also withdraws: Extension to Fri 24/10/2026" when an open record exists, the saved-grade note and list on a graded task, buttons "Cancel" and "Excuse".
  - choosing the ticked Excused with a saved copy opens `ClearExcusedPanel` with the box ticked and "(replaces your current draft)" when `hasDraft`; a points-only copy lists "Re-enter in Schoology: 45 / 50".
  - an excused card with `excused_grade` shows the saved levels in the locked rubric under "Saved before excusing on Tue 21/10. Clear the flag to restore it."; a gradebook cell passes `excused_saved_level` to `ExceptionChip`.
  - a `CHANGED` error shows its message beside the pill and keeps the old state.
  - keyboard: ArrowDown moves between Excused and Late, Enter chooses, Escape closes.
- [ ] **Step 2: Run** `cd client && npx vitest run src/components/FlagsMenu.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement**, then place `FlagsMenu` in the card header where Flag for review was, and in `AssignmentFeedback`'s badge row (`size="sm"`, panel inside the view). On `onChange`, the card patches `student.exception`, `grade_comment`, the timeline, and reloads drafts; the gradebook and student page refetch the pair.
- [ ] **Step 4: Run both full suites and `npm run build`.** Expected: PASS.
- [ ] **Step 5: Add to `docs/design-language.md`:** the Flags menu (grayed group under one caption, explained without hover), the dashed exception chips, the outline and filled clocks, flag colors, Overdue.
- [ ] **Step 6: Commit** `feat: Flags menu for Excused and Late on the card, gradebook and student page (#40)`.

---

### Task 9: Live check, docs, issues, ship

- [ ] **Step 1: Ask Graham to approve four live writes** on the Task 1 targets, with the question tool: Excused with a reason on an ungraded student; Excused on a graded student, then Clear with restore and Publish; Late; clear Late. After each, read the pair back from Schoology and check the card, the gradebook cell and the student page in a real browser (`npm run dev` on a free port; stop it with `npm run dev:stop`). Delete any screenshots afterwards.
- [ ] **Step 2: Update docs:** `.claude/build-progress.md` (entry with commits), `docs/deploy.md` only if the migration needs a note, `AGENTS.md` if a convention changed, `mcp/server.js` descriptions (grading state, Overdue, no `review_needed`), and `docs/prismcp-install-and-verify.md` if a tool answer changed.
- [ ] **Step 3: Run** `npx vitest run`, `cd client && npx vitest run`, `npm run build`. Expected: all PASS.
- [ ] **Step 4: Ship:** fast-forward `main`, `git push -u origin main`; confirm CI green on that commit (`gh run list --branch main --limit 1`), then `curl -s 127.0.0.1:3001/api/version` on the mini shows it.
- [ ] **Step 5: Issues:** comment on #40 with the probe results, the shipped behavior and commit ids, and close it; open a new issue "Edit grades and comments from the gradebook and student page"; comment on #80 (design language entries) and #13 if the lock behavior changed.
- [ ] **Step 6: Memory:** update the project handoff memory (what shipped, what is next).
