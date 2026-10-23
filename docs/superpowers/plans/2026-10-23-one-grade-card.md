# One Grade Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One grade card (`StudentRubricCard`) renders a student's grade and comment on the assessment page, the student page and the gradebook pop-up, read-only by default outside the assessment page and editable in place with **Edit**; `AssignmentFeedback` is removed.

**Architecture:** The server's assessment-page builder is extracted into a service that can build one student's card; a new per-student route returns card data for every task of a course (or one task). The card moves to its own module, gains `mode` (`'view'` | `'edit'`), `meeting`, `heading`, `hasDraft` and `onEdit`/`onDone` props, absorbs what only `AssignmentFeedback` drew (points score, Missing as IE), and gets an **Add update** button. The student page and `RubricModal` render the card from the new route.

**Tech Stack:** React 18 + Vite, React Testing Library + Vitest (client), Express + better-sqlite3 + Vitest (server).

**Spec:** `docs/superpowers/specs/2026-10-23-edit-grades-outside-assessment-design.md`

## Global Constraints

- Colours only from CSS custom properties in `client/src/app.css`; buttons use `.primary` / `.secondary` / `.ghost`; no em dashes in UI copy (a guard test enforces it).
- Dates DD/MM/YYYY via `formatDate` (`client/src/lib/formatDate.js`).
- Phone rules only in the single `PHONE LAYOUT` `@media (max-width: 768px)` block at the end of `app.css`.
- The assessment page's behaviour is unchanged except: points-only score shown, Missing shown as IE, Add update, grid balance.
- No new Schoology write path: every write goes through the card's existing publish, flag, refer, extend and resubmit code.
- Root tests run with `DB_PATH=:memory:` (vitest.config.js); never open a real database.
- Commit after each task; messages end with the `Co-Authored-By` line the session gives.

## Review Focus

1. **A student with many tasks:** the batch route for one course stays under 300 ms on a dev copy of prod data, and a view-mode card makes no network request of its own (Task 1 timing note; Task 5 test that `getProficiencyScale` is requested once for many cards).
2. **A dropped or individually-targeted student:** `getRoster` hides them, but their student page still lists the task; the builder must still return their card (Task 1 test `builds a card for a dropped student`).
3. **Stale data after an edit elsewhere:** Edit always refetches that one card, and Done refetches the course (Task 7 test `Edit refetches the task; Done reloads the course`).
4. **A course Prism cannot write:** archived, excluded or a linked set shows no Edit and no Flags menu (Task 1 test `writable`; Task 7 test `no Edit on an archived, excluded or linked course`).
5. **The update line with a status line on top:** the update goes below it, so `composeComment` and the server's top-line check still match (Task 4 tests).

---

### Task 1: Server: one builder for the assessment view, and the per-student grade-cards route

**Files:**
- Create: `server/services/assessmentView.js`
- Modify: `server/routes/mastery.js:506-657` (route body becomes a call to the builder)
- Modify: `server/services/courseSections.js` (add `isLinkedSet`)
- Modify: `server/routes/students.js` (new route)
- Test: `server/services/assessmentView.test.js`, `server/routes/students.gradeCards.test.js`; `server/routes/mastery.test.js` must pass unchanged

**Interfaces:**
- Produces: `buildAssessmentView(db, { courseId, assignmentId, studentId = null }) -> { course, assignment, topics, scoreScale, masterySyncedAt, students }`, the exact JSON `GET /api/mastery/:courseId/assignment/:assignmentId` returns today, plus `course.writable: boolean`. `assignmentId` is the Schoology id; `studentId` the local `students.id`.
- Produces: `isLinkedSet(db, courseId) -> boolean` (a row in `linked_sections` for the course).
- Produces: `GET /api/students/:id/grade-cards?courseId=<local>[&assignmentId=<schoology>]` returning
  `{ course: { id, archived, excluded, writable }, cards: { [schoologyAssignmentId]: { assignment, topics, scoreScale, student, rubric, draft, hasDraft } } }`, where `student` is the builder's one student object, `rubric` is `getAttachmentForAssignment(db, aid)` shaped `{ id, rubric, topicByCriterion }` or null, `draft` is this student's `assessment_drafts.draft_json` parsed or null, and `hasDraft` is true when `getUnfinishedGrading(db, { courseId, studentId })` lists the task with reason `'draft'` for this student (stale drafts excluded). Tasks are the student's grade rows in that course (the same set `GET /api/students/:id` returns).

- [ ] **Step 1: Write the failing tests.** In `assessmentView.test.js` (seed with the helpers `mastery.test.js` uses):
  - `matches the mastery route for the whole class`: `buildAssessmentView(db, {courseId, assignmentId})` deep-equals the route's JSON minus `course.writable`.
  - `studentId keeps only that student`: `students.length === 1`, `students[0].id === studentId`, and its object equals the whole-class entry for that student.
  - `builds a card for a dropped student`: enrolment `dropped_at` set; with `studentId` the result still has one student with the grade's `grade_comment`.
  - `writable`: false for `archived = 1`, false for `excluded = 1`, false when `linked_sections` has a row for the course, true otherwise.
  In `students.gradeCards.test.js`: `returns a card per task in the course`; `assignmentId narrows to one card`; `hasDraft is true only for a current draft` (a draft whose `base` differs from the card baseline gives false); `cards never hold another student` (class of 3; every `card.student.id` is the requested id).
- [ ] **Step 2: Run them to see them fail.** `npx vitest run server/services/assessmentView.test.js server/routes/students.gradeCards.test.js`: FAIL, module not found.
- [ ] **Step 3: Implement.** Move the route body into `buildAssessmentView`; with `studentId`, filter the roster to that student, and when `getRoster` has no row for them, read their `students` row joined to any enrolment in the course (dropped or untargeted). The mastery route calls the builder with no `studentId`. The grade-cards route calls the builder once per task.
- [ ] **Step 4: Run them to see them pass,** plus `npx vitest run server/routes/mastery.test.js`: all PASS. Time the route for one course on a dev copy of prod data (`DB_PATH=<copy>`, never prod) and record the figure in the commit message; over 300 ms, cache `getAlignedTopics`/`scoreScaleFor` per course inside the route.
- [ ] **Step 5: Commit** `feat(cards): one assessment-view builder and a per-student grade-cards route (#176)`.

### Task 2: Client: move the card to its own module, with shared inputs

**Files:**
- Create: `client/src/components/gradeCard/StudentRubricCard.jsx` (moved from `AssessmentSummaryPage.jsx:56-130` helpers used only by the card, and `130-1870`)
- Create: `client/src/lib/cardPatches.js` (`flagClearedPatch`, `resubmissionFieldsPatch`, `GRADE_WRITTEN_PATCH`)
- Create: `client/src/lib/cardInputs.js`
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (imports the card and `cardInputs`; Send-all imports the patches)
- Modify: imports in `AssessmentSummaryPage.test.jsx`, `AssessmentSummaryPage.undo.test.jsx`
- Test: `client/src/lib/cardInputs.test.js`

**Interfaces:**
- Produces: `cardInputs({ topics, scoreScale, rubricData, student }) -> { topics, rubric, student }`, the page's `cardTopics` / `cardRubric` / `cardStudent(student)` derivation (`AssessmentSummaryPage.jsx:2469-2490`) as one pure function. `rubricData` is `{ id, rubric, topicByCriterion }` or null.
- Produces: `StudentRubricCard` default export from the new file; props unchanged in this task.

- [ ] **Step 1: Write the failing test** `cardInputs.test.js`: `aligned task passes topics and rubric through`; `feedback-row task turns criteria into row topics and row_levels into scores` (fixtures from `AssessmentSummaryPage.test.jsx:2291-2306`: `topics.map(t => t.id)` equal `feedbackRowTopics(CRITERIA).map(t => t.id)`, `student.scores` equal `rowScores(row_levels)`); `no rubric gives rubric null`.
- [ ] **Step 2: Run it to see it fail.** `cd client && npx vitest run src/lib/cardInputs.test.js`: FAIL.
- [ ] **Step 3: Move the code** with no behaviour change; the page calls `cardInputs` per student.
- [ ] **Step 4: Run the card's suites:** `cd client && npx vitest run src/lib/cardInputs.test.js src/pages/AssessmentSummaryPage`: all PASS.
- [ ] **Step 5: Commit** `refactor(cards): StudentRubricCard in its own module; cardInputs shared (#176)`.

### Task 3: Card: what only the read-only view drew (points score, Missing as IE), and `meeting`

**Files:**
- Create: `client/src/lib/missingView.js` (moved `missingView` and its four line constants from `AssignmentFeedback.jsx:36-55`)
- Create: `client/src/components/gradeCard/ScoreLabel.jsx` (moved `ScoreLabel` from `AssignmentFeedback.jsx:64-77`)
- Modify: `client/src/components/gradeCard/StudentRubricCard.jsx`; `client/src/components/AssignmentFeedback.jsx` imports the moved pieces until Task 9
- Test: `client/src/components/gradeCard/StudentRubricCard.view.test.jsx` (new; reuse `makeStudent`/`renderCard` from `AssessmentSummaryPage.test.jsx:74-106`, extracted to `client/src/components/gradeCard/testFixtures.js`)

**Interfaces:**
- Produces: card prop `meeting = false`. True hides the photo and treats `feedbackRow` as null (no reviewer notes, no suggested cells or sparkles, no scale suggestion, no narrative box).
- Produces: points-only branch: no topics and no `scoreScale` renders `Score:` and `ScoreLabel` with `gradeLabel({ score: student.score, max_points: assignmentRow.max_points, exception: student.exception, grading_scale_id: assignmentRow.grading_scale_id, scales: null })`, in place of today's empty compact table.
- Produces: under `exception === 3` the rubric draws `missingView(3, grades, { rows })` (IE with the Missing symbol on every topic or row when Schoology holds none, the real levels otherwise) and its line above the rubric. Exempt keeps the card's own lock.

- [ ] **Step 1: Write the failing tests:** `points-only shows "50 / 100" and no table`; `Missing with no levels shows IE with the Missing symbol on every topic, and the no-levels line` (descriptor and compact, ported from `AssignmentFeedback.test.jsx` cases 9, 10); `Missing with levels shows them under the levels line` (cases 11, 12, 13); `Missing on a feedback-row task` (cases 15, 16); `exceptions 0, 2, 5, 6 show no IE` (case 18); `meeting hides the photo and every suggestion` (a `feedbackRow` with `narrative_feedback`, `rubric_scores` and `scale_level`: no `img` with the picture URL, no text "Suggested feedback", no "Reviewer notes", no element with the `AiSparkle` test id or class, no "Suggested" mark in `ScaleLevelPicker`).
- [ ] **Step 2: Run them to see them fail.** `cd client && npx vitest run src/components/gradeCard`: FAIL.
- [ ] **Step 3: Implement** in the card.
- [ ] **Step 4: Run** `cd client && npx vitest run src/components src/pages/AssessmentSummaryPage`: all PASS.
- [ ] **Step 5: Commit** `feat(cards): points score, Missing as IE and meeting on the card (#176)`.

### Task 4: Add update on the comment

**Files:**
- Create: `client/src/lib/commentUpdate.js`, `client/src/lib/commentUpdate.test.js`
- Modify: `client/src/components/gradeCard/StudentRubricCard.jsx` (button beside the "Overall Comment" label, edit mode only)
- Test: `client/src/components/gradeCard/StudentRubricCard.view.test.jsx`

**Interfaces:**
- Produces: `addUpdateLine(comment: string, topLine: string | null, dateText: string) -> { text: string, cursor: number } | null`. Prefix is exactly `Update (${dateText}): `. Null when `comment.trim()` is empty. With `topLine` on top (`text === topLine || text.startsWith(topLine + '\n')`) the update goes after `topLine + '\n\n'`; otherwise at position 0. The update line is followed by `\n\n` and the rest unchanged. When the insertion point already starts with the same prefix, `text` is unchanged and `cursor` is the end of that line.
- Consumes: the card's `topLineIs`, `insertedLine`, `student.status_line?.line` (the top line is `insertedLine` when `topLineIs(comment, insertedLine)`, else `student.status_line?.line` when on top, else null), `applyComment(next, { step: true })`, and `formatDate(new Date())`.

- [ ] **Step 1: Write the failing tests** in `commentUpdate.test.js`: `puts the update above the comment` (`addUpdateLine('Good work.', null, '23/10/2026')` → text `'Update (23/10/2026): \n\nGood work.'`, cursor 21); `goes below a status line` (`'Resubmission received 20/10 - regraded.\n\nGood work.'` with that top line → the update is the third line and the status line is still first); `a comment that is only the status line`; `empty comment gives null`; `a second press the same day adds nothing`. In the card test: `Add update inserts the line and focuses after the colon`; `no Add update in view mode or with an empty comment`.
- [ ] **Step 2: Run them to see them fail.** `cd client && npx vitest run src/lib/commentUpdate.test.js`: FAIL.
- [ ] **Step 3: Implement** the function and a `.ghost` button labelled "Add update"; set the textarea selection to `cursor` after the change.
- [ ] **Step 4: Run** `cd client && npx vitest run src/lib/commentUpdate.test.js src/components/gradeCard`: PASS.
- [ ] **Step 5: Commit** `feat(cards): Add update puts a dated line above the comment (#176)`.

### Task 5: Card view mode

**Files:**
- Modify: `client/src/components/gradeCard/StudentRubricCard.jsx`
- Modify: `client/src/services/api.js:116` (`getProficiencyScale` memoised: one request per page load, cleared on failure)
- Modify: `client/src/app.css` (`.grade-card__comment-view`, moved from `.assignment-feedback__comment`)
- Test: `client/src/components/gradeCard/StudentRubricCard.view.test.jsx`

**Interfaces:**
- Produces: card props `mode = 'edit'` (`'view'` | `'edit'`), `heading` (node; default the student-name link; `false` draws none), `hasDraft = false`, `onEdit = null`, `onDone = null`.
- View mode: same header, timeline, notes and rubric; the rubric gets no `onSelect`; the comment is text in `.grade-card__comment-view` under "Comment:"; no textarea, Display switch, Publish, Discard, Add update or restore box; of the header write controls only `FlagsMenu` (as today's read-only view); an **Edit** button (`.secondary`, small) when `onEdit` is given; the card's "● Draft - not published" mark when `hasDraft`. No draft saver, autosave, stale-draft delete, legacy migration or parent-reporting effect runs.
- Edit mode with `onDone`: a **Done** button (`.ghost`) in the control band calls `onDone()` after the saver flushes.

- [ ] **Step 1: Write the failing tests:** `view mode draws the grid read-only` (no `title` matching `/^Set /`, awarded cell `data-awarded="true"`); `view mode shows the comment as text, with no textarea or Publish`; `view mode starts no draft saver` (the mocked `makeDraftSaver` is not called and `deleteDraft` is never requested); `view mode shows the Flags menu only` (no Refer, Extend or Resubmit control); `Edit calls onEdit; Done calls onDone`; `hasDraft shows the draft mark`; `heading replaces the name; false draws none`; `twenty view cards request the proficiency scale once`.
- [ ] **Step 2: Run them to see them fail.** `cd client && npx vitest run src/components/gradeCard`: FAIL.
- [ ] **Step 3: Implement** with guards: effects return early in view mode; the saver is created lazily on first use in edit mode.
- [ ] **Step 4: Run** `cd client && npx vitest run src/components src/pages/AssessmentSummaryPage`: PASS.
- [ ] **Step 5: Commit** `feat(cards): read-only view mode with Edit and Done (#176)`.

### Task 6: Client API and the grade-cards hook

**Files:**
- Modify: `client/src/services/api.js` (add `getGradeCards`)
- Create: `client/src/hooks/useGradeCards.js`, `client/src/hooks/useGradeCards.test.jsx`

**Interfaces:**
- Consumes: Task 1's route.
- Produces: `getGradeCards(studentId, { courseId, assignmentId })` and `useGradeCards({ studentId, courseId, enabled, reloadKey }) -> { cards, course, loading, error, refetchOne(assignmentId) -> Promise<card> }`. `refetchOne` replaces that card in `cards` and returns it.

- [ ] **Step 1: Write the failing tests:** `loads a course's cards when enabled`; `does nothing while disabled`; `refetchOne replaces one card`; `reloadKey refetches`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd client && npx vitest run src/hooks/useGradeCards.test.jsx`: PASS.
- [ ] **Step 5: Commit** `feat(cards): getGradeCards and useGradeCards (#176)`.

### Task 7: Student page renders the card

**Files:**
- Modify: `client/src/pages/StudentPage.jsx:74-224` (`CourseSection`)
- Modify: `client/src/pages/StudentPage.feedback.test.jsx` (port to the card; mock `getGradeCards`)

**Interfaces:**
- Consumes: `useGradeCards` (enabled while the section is expanded, `reloadKey={refreshKey}`), `cardInputs`, the card's view props.
- Each task row renders `StudentRubricCard` with `mode` from a per-section `editing: Set<aid>`, `meeting`, `heading` = today's task-title link (`StudentPage.jsx:182-186`), `hasDraft={card.hasDraft}`, `draftRow={card.draft}`, `feedbackRow={null}`, the links, file and comment summaries the section already has (`filesEnabled`/`commentsEnabled` as today's `showFiles`/`showComments`), `resubmitEnabled={course.writable}`, `reasons={studentReasons(card.student, { assignment: card.assignment, topics: card.topics, hasDraft: () => card.hasDraft, commentSummaryOf: () => summary })}` (the spec keeps attention chips; check the ctx shape against `AssessmentSummaryPage.jsx:2174`), `onEdit` only when `course.writable`, `onSaved`/`onRefreshPair` = refetch that one card. Edit: `await refetchOne(aid)` then add `aid` to `editing`. Done: remove it, then `onFlagChange`-style reload (`getStudent` and the course's cards).
- While the cards load, the row shows the title and "Loading…"; on error, "Could not load the grades for this course. Reload the page." in `.alert.alert-warning`.

- [ ] **Step 1: Port the failing tests:** the cases in `StudentPage.feedback.test.jsx` (shared view 59-86, Missing 94-104, links 112-154, loading 181-215, flags 238-261) against the card; add `Edit refetches the task; Done reloads the course`; `an Overdue task shows its attention chip`; `no Edit on an archived, excluded or linked course`; `the student page never shows a portrait or a suggestion`.
- [ ] **Step 2: Run them to see them fail.** `cd client && npx vitest run src/pages/StudentPage`: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd client && npx vitest run src/pages/StudentPage`: PASS.
- [ ] **Step 5: Commit** `feat(student): every task is the grade card, editable in place (#176)`.

### Task 8: Gradebook pop-up renders the card

**Files:**
- Modify: `client/src/pages/CoursePage.jsx:678-800` (`RubricModal`) and `:906-921` (`modalFor`)
- Modify: `client/src/pages/CoursePage.feedbackModal.test.jsx`, `client/src/pages/CoursePage.rubricModal.test.jsx`

**Interfaces:**
- Consumes: `useGradeCards({ studentId: student.id, courseId, enabled: true })` narrowed with `getGradeCards(student.id, { courseId, assignmentId })` (one card), `cardInputs`.
- The modal keeps its own header (name, title, S/F badge) and "Open full grading page →"; the card gets `heading={false}`, `meeting`, `reasons` built as in Task 7, `mode` from local state, `onEdit` only when `course.writable`, `onDone` = leave edit and call the existing `refreshAfterFlag`. Wide (`feedback-modal--wide`) when `buildDescriptorRows(topics, rubric).length > 0` or in edit mode.

- [ ] **Step 1: Port the failing tests** (feedbackModal 50-223, rubricModal 36-110) and add `Edit in the pop-up switches the card to edit mode; Done refreshes the gradebook`.
- [ ] **Step 2: Run them to see them fail.** `cd client && npx vitest run src/pages/CoursePage`: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd client && npx vitest run src/pages/CoursePage`: PASS.
- [ ] **Step 5: Commit** `feat(gradebook): the pop-up is the grade card, editable in place (#176)`.

### Task 9: Grid balance, removal of AssignmentFeedback, docs

**Files:**
- Modify: `client/src/components/RubricDescriptorGrid.jsx:17-23` (topic column `width: '16%', minWidth: 140`; level headers lose `width: '15%'`), `client/src/components/RubricDescriptorGrid.test.jsx`
- Delete: `client/src/components/AssignmentFeedback.jsx`, `client/src/components/AssignmentFeedback.test.jsx`, `.assignment-feedback*` rules in `app.css:1508-1519, 1609-1610` (the phone rule at `1836` moves to the card's rubric wrapper class)
- Modify: `docs/design-language.md` (replace "Shared feedback view" `1409-1422` with "One grade card (October 2026, #176)": modes, meeting, Edit/Done, Add update, draft mark; update `265-298` for the grid balance with the 23 Oct measurements; fix mentions at `818-825`, `1271`, `1397`, `1573`, `1583`, `1587`, `1590`, `1597`, `1601`), `.claude/build-progress.md`, `AGENTS.md` Frontend Conventions (one line: the grade card is the only component that draws a student's grade and comment)

- [ ] **Step 1: Write the failing test** in `RubricDescriptorGrid.test.jsx`: `the topic column is 16% and level columns share the rest` (first `th` style width `16%`; level `th` elements have no `width`).
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement**, delete the old view, and `grep -rn "AssignmentFeedback\|assignment-feedback\|missingView\|ScoreLabel" client/src docs` until only the moved modules and history remain.
- [ ] **Step 4: Verify.** `npx vitest run` (root), `cd client && npx vitest run`, `npm run build`: all PASS. In a browser on a dev server (`PORT=3002 npm run dev`), at 1440 px and at phone width (`npm run check:mobile http://127.0.0.1:3002`): grid rows on the student page and the assessment page are shorter than the 23 Oct measurement (200 px first row), and the topic cell is never the tallest cell. Delete any screenshots and `.playwright-mcp/` afterwards.
- [ ] **Step 5: Commit** `feat(cards): balanced rubric grid; AssignmentFeedback removed; docs (#176)`.

### Task 10: Live check, ship, close

- [ ] **Step 1: Live write** (Graham approves first): dev server on 3002 with `PRISM_SESSION_DIR=~/repos/prism/.playwright-session`; on the student page of the test student, task "AIML: Prism Flags Check (F)" (`8619091769`): Edit, set one topic level, Add update, Publish; read back from Schoology (levels and comment); then restore the record to its starting state and read back again.
- [ ] **Step 2: Ship:** fast-forward `main`, push, confirm CI green on the commit and `curl -s 127.0.0.1:3001/api/version` serves it.
- [ ] **Step 3: Close out:** comment on #176 with commits and the live-check evidence, close it; note on #181 that the card is ready for a points box; update the project memory handoff; `npm run dev:stop`.
