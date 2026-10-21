# Flags: Excused and Late Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set, change and clear Schoology's five grade flags from Prism (assessment card, gradebook pop-up, student page), keep a copy of any grade a flag removes, and show every flag as a symbol.

**Architecture:** One server service (`server/services/gradeFlags.js`) does the flag write with the quiz write-back safety pattern (lock, fresh read, refuse on change, write, read back, mirror), saves the pre-excuse grade in a new `excused_grades` table, withdraws open triage records, publishes an optional `excused` status line, and restores the saved grade into the card's draft on clear. One client component (`FlagsMenu`) serves the card header and the shared `AssignmentFeedback` view. Display work (late clocks, exception chips, colors, Overdue, removing Flag for review) is independent of the write path and lands first.

**Tech Stack:** Node ESM + Express + better-sqlite3, React + Vite, Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-21-flags-excused-late-design.md` (revised after the probes; mockups: https://claude.ai/artifact/RcePZWizTujDo17X1zpLf3, version 10).

**Revision (21 Oct 2026):** Tasks 1 to 6 are done. The probes changed the design (five settable flags, Late = 6, every flag removes the grade, symbols). Task 10 reworks the display from Tasks 2 to 4; Tasks 7 and 8 are rewritten. Order: 10, 7, 11, 12, 13, 8, 9.

## Global Constraints

- Every color comes from CSS custom properties in `client/src/app.css`; add tokens there, never hex in components.
- No em dashes in UI copy (a guard test enforces it); dates via `formatDate` / `lineDate` (DD/MM order).
- UI copy is American spelling: "grayed", "color".
- Status lines are plain printable ASCII (`plainLine`, `checkLine`).
- New columns or tables go in `server/db/schema.sql` **and** the `MIGRATIONS` array in `server/db/index.js`.
- Menu copy, flag names, symbols, colors and status-line text: verbatim from the spec (revised 21 Oct 2026). UI word "Exempt", never "Excused".
- Flag codes: 1 Exempt, 2 Incomplete, 3 Missing, 5 Absent, 6 Late (4 is invalid). Colors: Exempt green, Late red, Absent slate gray, Incomplete amber, Missing red outline, everywhere a flag shows.
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

### Task 10: Flag codes, symbols and Late as a flag (rework after the probes)

Done earlier and now partly wrong: Tasks 2 and 3 assumed Late = 4 and that Late keeps the grade; Task 4 drew dashed text chips. The probes (019bcc0) found Late = 6, Absent = 5, 4 invalid, and every flag removes the grade. This task makes the display match the revised spec.

**Files:**
- Create: `client/src/components/FlagSymbol.jsx`, `client/src/components/FlagSymbol.test.jsx`, `client/src/lib/flags.js` (+ test)
- Modify: `client/src/lib/gradeLabel.js` (labels and tones for 1, 2, 3, 5, 6; no 4), `server/services/submissionTimeline.js` and its client mirror (`flagged` = exception 6; `LATE_EXCEPTION` = 6), `client/src/components/LateClock.jsx` (drop the `flagged` form: the Late flag is a symbol now), `client/src/pages/CoursePage.jsx`, `client/src/components/AssignmentFeedback.jsx`, `client/src/pages/AssessmentSummaryPage.jsx` (EXCEPTION_LABELS, `isRubricLocked` = any flag, "Exempt" wording, lock badge), `client/src/app.css` (tokens `--flag-exempt`, `--flag-late`, `--flag-absent`, `--flag-incomplete`, `--flag-missing` and their `-bg`), `server/lib/feedbackFingerprint.js`, `server/lib/resubmission.js`, `server/services/assessmentContext.js`, `client/src/lib/assessmentFilters.js` (every flag counts as handled), `server/db/index.js` (no new migration; the "e":4 rewrite stays harmless), `mcp/server.js` descriptions, `server/services/studentHistory.js` (its exception label text), `docs/design-language.md`
- Delete: `client/src/components/ExceptionChip.jsx` and its test (replaced by `FlagSymbol`)

**Interfaces:**
- Produces: `client/src/lib/flags.js` exporting `FLAGS = { 1: { key: 'exempt', name: 'Exempt', verb: 'exempt' }, 2: { key: 'incomplete', name: 'Incomplete', verb: 'incomplete' }, 3: { key: 'missing', name: 'Missing', verb: 'missing' }, 5: { key: 'absent', name: 'Absent', verb: 'absent' }, 6: { key: 'late', name: 'Late', verb: 'late' } }`, `FLAG_ORDER = [1, 6, 5, 2, 3]`, `flagGuide(code, firstName) -> string` (the spec's verbatim menu lines), `FLAGS_MENU_HEADING = 'Flag in Schoology'`, `isFlag(code) -> boolean`; `<FlagSymbol code size="cell"|"inline" showName savedLevel reasonLine />` with a popover (hover and tap) holding name, `flagGuide` text without the "Visibly flags" sentence, the reason line, and "Grade saved in Prism: {savedLevel}. Clear the flag to restore it."; server `FLAG_CODES = [1, 2, 3, 5, 6]` exported from `server/lib/flags.js` (create) for Task 7.

- [ ] **Step 1: Write failing tests:**
  - `gradeLabel({ exception: 6, score: null, ... })` is `{ kind: 'exception', exception: 6, text: 'Late' }`; exception 5 gives 'Absent'; 1 gives 'Exempt'; exception 4 gives no exception label.
  - `submissionStatus` tones: 1 green, 6 red, 5 slate, 2 amber, 3 red.
  - timeline: `flagged` is true only for exception 6; `late` stays the submission signal.
  - `hasFeedback({ exception: 6 })`, `({ exception: 5 })` are true; `gradingState({ exception: 6, ... })` is 'complete'; client `gradingStateOf` agrees.
  - `FlagSymbol` renders each of the five with class `flag-symbol--{key}`, its name in capitals when `showName`, an `aria-label` of the name, and the popover text on focus/hover and on click.
  - a gradebook cell with exception 6 shows the Late symbol and no level chip; with `late: 1` and no flag it shows the outline corner clock only.
  - the card's lock badge reads "Exempt, rubric locked" for 1 and locks for 5 and 6 too.
- [ ] **Step 2: Run** the client and server tests named above. Expected: FAIL.
- [ ] **Step 3: Implement.** Symbols are inline SVG per the spec's table (Absent: a person beside a small circle with a diagonal stroke at its bottom left); colors only via the new tokens.
- [ ] **Step 4: Run both full suites and `npm run build`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(flags): five Schoology flags with symbols; Late is code 6 (#40)`.

---

### Task 11: Absent is a marker, not a decision

Graham, 21 Oct 2026, after Tasks 10 and 7: Absent must not be treated as "not doing the task". Only Exempt is a decision.

**Files:**
- Modify: `server/lib/flags.js` and `client/src/lib/flags.js` (`isNotDoingTask` is code 1 only; rename to `isExempt` if that reads better, updating every caller), every site Task 10's fix round changed to treat 5 like 1 (`server/services/triage.js`, `submissionStatus.js`, `submissionTimeline.js`, `cardAttention.js`, `resubmissions.js`, `unfinishedGrading.js` `NOT IN (1, 5)` back to code 1, `client/src/lib/assessmentFilters.js`, `client/src/pages/AssessmentSummaryPage.jsx` Extend), `server/services/gradeFlags.js` (withdrawals for code 1 only), their tests, `mcp/server.js` (the `excused` state is Exempt only), `docs/design-language.md`.

- [ ] **Step 1: Write failing tests:** for each site, code 5 behaves like an unflagged student (Extend shows; listed for make-ups and late work when otherwise due; owes; overdue clock counts; hidden feedback listed); code 1 unchanged; `setGradeFlag` with code 5 withdraws nothing.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both full suites and `npm run build`.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(flags): Absent is a marker; only Exempt is a decision (#40)`.

---

### Task 7: The flag write service and route

**Files:**
- Create: `server/services/gradeFlags.js`, `server/services/gradeFlags.test.js`, `server/routes/gradeFlags.js`, `server/routes/gradeFlags.test.js`
- Modify: `server/services/schoology.js` (rename `pushGradeComments` to `pushGradeUpdates`; update `server/routes/mastery.js`, `server/services/statusLinePublisher.js`, tests), `server/services/statusLinePublisher.js` (export `pairTarget`, `freshGrade`; add `'flag'` to `STATUS_LINE_KINDS`), `server/lib/statusLines.js` (`flagLine`), `server/db/schema.sql` + `server/db/index.js` (`excused_grades`), `server/index.js` (mount `/api/grade-flags`)

**Interfaces:**
- Consumes: probe facts (API reference, "Grade exceptions (flags)"): set with `exception: <code>` and every other field echoed; clear with `exception: 0`; 1, 2, 5, 6 remove score and levels; 3 sets score 0 and keeps levels; comment always kept; non-2xx or a per-entry code of 400+ means nothing was written. `FLAG_CODES` (Task 10). `lockPair`, `putSucceeded`, `publishStatusLine`, `removeStatusLine`; `cardBaselineFor`; `undoExtension`, `undoReferral`, `undoResubmission`.
- Produces:
  - table `excused_grades(student_id INTEGER NOT NULL, assignment_id INTEGER NOT NULL, flag INTEGER NOT NULL, saved_json TEXT NOT NULL, saved_at TEXT NOT NULL, restored_at TEXT, PRIMARY KEY (student_id, assignment_id))`; `saved_json` = `{ score, max_points, comment, comment_status, topics: { [topicId]: level }, rows: { [criterion]: level }, scale_level }`.
  - `flagLine({ code, on, note }) -> string`: `Marked ${verb} on ${lineDate(on)}.` plus `withNote`, e.g. `Marked exempt on Tue 21/10. Medical leave from 13 to 24 October.`
  - `readFlagState(db, { studentId, assignmentId }) -> Promise<{ exception, score, comment, commentStatus, graded, savedGrade|null, openRecords: [{ type: 'extension'|'resubmission'|'referral', id, label }], hasDraft }>` (fresh Schoology read).
  - `setGradeFlag(db, { studentId, assignmentId, code: 0|1|2|3|5|6, expected: { exception, score }, reason = null, restore = true }) -> Promise<{ exception, saved: boolean, withdrawn: [...], line: { published|removed|error }|null, restored: { draft: boolean, notRestored: string[] }|null }>`; `code: 0` clears. Throws `TriageError` with `CHANGED` (409, names what changed), `BUSY`, `NOT_FOUND`, `NOT_ELIGIBLE` (archived or excluded course, no enrolment), `BAD_VALUE` (code not in FLAG_CODES or 0), `SCHOOLOGY_READ_FAILED`, `SCHOOLOGY_WRITE_FAILED`, `READBACK_MISMATCH` (502).
  - Routes: `GET /api/grade-flags?studentId=&assignmentId=` → `readFlagState`; `POST /api/grade-flags` body `{ studentId, assignmentId, code, expected, reason, restore }` → `setGradeFlag`; errors `{ error, code }` with the triage status map plus `CHANGED: 409`, `READBACK_MISMATCH: 502`.

- [ ] **Step 1: Write failing tests** (mock `getSectionGrades` and `pushGradeUpdates` as `statusLinePublisher.test.js` does):
  - `flagLine({ code: 1, on: '2026-10-21', note: 'Medical leave.' }) === 'Marked exempt on Tue 21/10. Medical leave.'`; `flagLine({ code: 6, on: '2026-10-21' }) === 'Marked late on Tue 21/10.'`.
  - setting any flag on a graded pair stores `excused_grades` before the PUT (the row exists when the PUT mock runs), sends `exception: <code>` with echoed fields, reads back, mirrors `grades.exception` and the read-back score (null, or 0 for Missing).
  - storing the copy fails → no PUT, error thrown.
  - fresh exception or score differs from `expected` → `CHANGED`, no PUT.
  - read-back shows the old exception → `READBACK_MISMATCH`, `grades` unchanged, copy kept.
  - a 502 answer, and a 207 with a per-entry 400 → `SCHOOLOGY_WRITE_FAILED`, nothing mirrored.
  - code 1 with an open extension, resubmission and referral → each undone (record only) and listed; codes 5, 6, 2, 3 → none undone (Task 11).
  - with a reason, one `publishStatusLine` call with kind `flag`; without a reason, a stored line from a withdrawn record is removed.
  - `publishStatusLine` throws after the flag write → result has the new `exception` and `line.error`; records stay withdrawn.
  - code 0 from a flag with a saved copy and `restore: true` → PUT with `exception: 0`, `assessment_drafts` row holds `pending` with the saved topic, `row:` and `__scale__` levels, `comment`, `display`, and `base === cardBaselineFor(db, a)(student)`; an existing draft is replaced; `restored_at` set; a points-only task, or a saved overall that differs from the levels' computed score, returns `notRestored` naming it.
  - `restore: false` keeps the copy with `restored_at` null; clearing removes the `flag` status line.
  - two overlapping calls on one pair → the second rejects `BUSY` before any read; an archived course → `NOT_ELIGIBLE`; code 4 → `BAD_VALUE`.
- [ ] **Step 2: Run** `npx vitest run server/services/gradeFlags.test.js server/routes/gradeFlags.test.js server/lib/statusLines.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `gradeFlags.js` in this order: `lockPair` → `pairTarget` → eligibility → `freshGrade` → compare with `expected` → (graded pair, setting a flag) save the copy from the fresh record plus `mastery_scores`, `rubric_row_levels` and the scale level → PUT → re-read and confirm → mirror `grades` from the read-back → withdraw records (1 and 5) → status line → (clearing with restore) draft → release. The rename of `pushGradeComments` is mechanical: grep every package for the old name first.
- [ ] **Step 4: Run tests.** Expected: PASS; both full suites.
- [ ] **Step 5: Commit** `feat: write Schoology flags with a saved grade (#40)`.

---

### Task 12: Final flags and markers; clearing Missing

Graham, 21 Oct 2026: Exempt (1) and Missing (3) are final; Late (6), Incomplete (2) and Absent (5) are markers that the teacher grades straight through. Probe (dd0509e): Missing never reaches the topic averages; clearing Missing with `grade: null` removes the 0 and blanks the levels.

**Files:**
- Modify: `server/lib/flags.js`, `client/src/lib/flags.js` (`FINAL_FLAGS = [1, 3]`, `isFinalFlag(code)`, `isMarker(code)`; `flagGuide(code, firstName, { aligned })` with the spec's new Missing line), `server/lib/resubmission.js` (`hasFeedback`, `scoreDiffers`), `server/lib/feedbackFingerprint.js` (`fingerprint`, `hasPriorFeedback`), `server/services/assessmentContext.js` (`gradingState`), `client/src/lib/assessmentFilters.js` (`gradingStateOf`), `client/src/pages/AssessmentSummaryPage.jsx` (`isRubricLocked` = final only; marker note "Grading this work clears {name}."), `client/src/pages/CoursePage.jsx` (a marker cell still opens the pop-up), `client/src/components/AssignmentFeedback.jsx` (lock notice for final flags only), `server/routes/mastery.js` (write-comment and send-all: when the fresh exception is a marker and a score is written, send `exception: 0`; after a successful grade write over a marker, retire the pair's saved copy and remove a `flag` status line), `server/services/gradeFlags.js` (clearing Missing: save the current levels into the copy first when they are not already there, then send `grade: null`; export `retireCopy(db, { studentId, assignmentId })`), their tests, `mcp/server.js` descriptions, `docs/design-language.md`.

- [ ] **Step 1: Write failing tests:**
  - `isFinalFlag` true for 1 and 3 only; `isMarker` true for 2, 5, 6.
  - `hasFeedback({ exception: 6 })`, `({ exception: 2 })`, `({ exception: 5 })` are false; `({ exception: 1 })`, `({ exception: 3 })` true; `gradingState` and `gradingStateOf` 'complete' only for 1 and 3 (a marker with no scores is 'ungraded').
  - the card's rubric is editable for 6, 2, 5 with the note "Grading this work clears Late." and locked for 1 and 3.
  - write-comment with `points` on a pair whose fresh exception is 6 sends `exception: 0` with the grade; on exception 0 it echoes 0; on a final flag (1 or 3) with `points` the route refuses with 409.
  - after a successful grade write over a marker, the pair's `excused_grades` row has `restored_at` set and a `flag` status line is removed.
  - `setGradeFlag` code 0 from Missing: the PUT carries `grade: null`; when the pair holds levels the copy lacks, the copy holds them before the PUT.
  - `flagGuide(3, 'Sam', { aligned: true })` is "Scores this task as zero. Topic averages are unchanged."; `{ aligned: false }` gives "Scores this task as zero."
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both full suites and `npm run build`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(flags): final flags and markers; clearing Missing removes the 0 (#40)`.

---

### Task 13: Missing shows IE on every topic in the shared view

Graham, 21 Oct 2026 (spec "Missing shows IE on the student page").

**Files:**
- Modify: `client/src/components/AssignmentFeedback.jsx` (and the rubric pieces it renders: `RubricDescriptorGrid`, `CompactRubric`, feedback rows), `client/src/app.css`, their tests, `docs/design-language.md`.

- [ ] **Step 1: Write failing tests:** with `exception: 3` on an aligned task, every topic shows IE whatever levels the grade holds, each with the Missing symbol (`FlagSymbol` code 3, no name), and the line "Shown as IE because the work is marked Missing. Schoology's topic averages do not include it." appears above the rubric; on a task with feedback rows, every row shows IE the same way; with exception 0, 1, 2, 5 or 6 nothing changes; the student page and the gradebook pop-up both show it (they share the view); no per-topic summary on the student page changes.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** in `AssignmentFeedback` as a display transform of the levels it renders (never written anywhere).
- [ ] **Step 4: Run both full suites and `npm run build`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(flags): Missing shows IE on every topic in the feedback view (#40)`.

---

### Task 8: The Flags menu and panels

**Files:**
- Create: `client/src/components/FlagsMenu.jsx`, `client/src/components/FlagsMenu.test.jsx`, `client/src/components/FlagPanel.jsx`, `client/src/components/ClearFlagPanel.jsx`
- Modify: `server/routes/mastery.js` (`GET /:courseId/assignment/:assignmentId` adds `saved_grade` and `flag_line` per student), `server/routes/courses.js` (gradebook grades add `saved_level`), `server/routes/students.js` (same for the student page), `client/src/services/api.js` (`getGradeFlags`, `setGradeFlag`), `client/src/pages/AssessmentSummaryPage.jsx` (header slot after Refer; locked rubric shows saved levels with caption; "Restore saved grade" when a copy exists and no flag is set), `client/src/components/AssignmentFeedback.jsx` (badge row), `client/src/pages/CoursePage.jsx` (refresh after a change; pass `saved_level` to `FlagSymbol`), `client/src/pages/StudentPage.jsx`, `client/src/app.css`, `docs/design-language.md`

**Interfaces:**
- Consumes: Task 7 routes; `FLAGS`, `FLAG_ORDER`, `flagGuide`, `FlagSymbol` (Task 10); `ActionPanel` portal.
- Produces: `<FlagsMenu student={{ id, firstName }} assignmentId exception score size="md"|"sm" panelHost onChange={(result) => void} />`.

- [ ] **Step 1: Write failing tests:**
  - closed pill "Flags" with no flag; with exception 1 it shows the Exempt symbol, the text "Exempt" and class `flags-pill--exempt`; 6 gives `flags-pill--late`; 5 `--absent`.
  - open menu shows the subheading `FLAGS_MENU_HEADING`, then the five in `FLAG_ORDER` with `flagGuide` text verbatim, the divider note verbatim, and ticks the set flag with "Choose again to clear it."
  - choosing any flag calls `getGradeFlags` then opens `FlagPanel` titled "Mark Sam late?" (verb from `FLAGS`): reason input labeled "Reason for the student (optional)", preview `Added to the top of Sam's comment: "Marked late on Tue 21/10. <reason>"` when a reason is typed, "Also withdraws: Extension to Fri 24/10/2026" only for Exempt with an open record, the saved-grade note only on graded work (the Missing wording for code 3), the next-steps line for markers (Late, Incomplete, Absent; spec wording), buttons "Cancel" and "Mark late"; confirming calls `setGradeFlag` with `{ code: 6, expected, reason }`.
  - choosing the ticked flag with a saved copy opens `ClearFlagPanel` with the box ticked, "(replaces your current draft)" when `hasDraft`, and a "Re-enter in Schoology:" line for `notRestorable` parts; without a copy it calls `setGradeFlag` with `code: 0` at once.
  - a `CHANGED` error shows its message beside the pill and keeps the old state; while pending the pill is disabled.
  - keyboard: ArrowDown moves through the five, Enter chooses, Escape closes.
  - the flagged card shows the saved levels in the locked rubric under "Saved before the flag on Tue 21/10. Clear the flag to restore it."; a gradebook cell passes `saved_level` to `FlagSymbol`.
- [ ] **Step 2: Run** `cd client && npx vitest run src/components/FlagsMenu.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement**, then place `FlagsMenu` in the card header after Refer, and in `AssignmentFeedback`'s badge row (`size="sm"`, panel inside the view). On `onChange`, the card patches `student.exception`, `grade_comment`, the timeline and reloads drafts; the gradebook and student page refetch the pair.
- [ ] **Step 4: Run both full suites and `npm run build`.** Expected: PASS.
- [ ] **Step 5: Add to `docs/design-language.md`:** the Flags menu and panel, flag symbols and colors.
- [ ] **Step 6: Commit** `feat: Flags menu for all five Schoology flags (#40)`.

---

### Task 9: Live check, docs, issues, ship

- [ ] **Step 1: Ask Graham to approve four live writes** on the Task 1 targets, with the question tool: Excused with a reason on an ungraded student; Excused on a graded student, then Clear with restore and Publish; Late; clear Late. After each, read the pair back from Schoology and check the card, the gradebook cell and the student page in a real browser (`npm run dev` on a free port; stop it with `npm run dev:stop`). Delete any screenshots afterwards.
- [ ] **Step 2: Update docs:** `.claude/build-progress.md` (entry with commits), `docs/deploy.md` only if the migration needs a note, `AGENTS.md` if a convention changed, `mcp/server.js` descriptions (grading state, Overdue, no `review_needed`), and `docs/prismcp-install-and-verify.md` if a tool answer changed.
- [ ] **Step 3: Run** `npx vitest run`, `cd client && npx vitest run`, `npm run build`. Expected: all PASS.
- [ ] **Step 4: Ship:** fast-forward `main`, `git push -u origin main`; confirm CI green on that commit (`gh run list --branch main --limit 1`), then `curl -s 127.0.0.1:3001/api/version` on the mini shows it.
- [ ] **Step 5: Issues:** comment on #40 with the probe results, the shipped behavior and commit ids, and close it; open a new issue "Edit grades and comments from the gradebook and student page"; comment on #80 (design language entries) and #13 if the lock behavior changed.
- [ ] **Step 6: Memory:** update the project handoff memory (what shipped, what is next).
