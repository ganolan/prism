# Linked Quiz Attempts Tab Implementation Plan (#200)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A linked quiz's assessment page gets an **Attempts** tab for the Schoology test itself (score, answers, attempt link, the test's own overall comment), and the template breakdown comment moves from the result task to the student's test.

**Architecture:** The page already redirects every task in a group to its canonical task (the result task when linked), so Grading already shows the result task. This plan adds one server read (`GET /api/quizzes/:id/attempts`), moves the template suggestion's target in `quizOverall.js` / `quizResults.js` from the result task to the member test the student took, adds an optional narrative for the result task to `write_quiz_overall_suggestions`, and adds the `AttemptsTab` component, which draws each student's test grade with the one grade card (`StudentRubricCard`) and their answers beside it.

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest; React 18 + React Testing Library; PrisMCP (`mcp/server.js`, zod).

**Spec:** GitHub issue #200 (design decided with Graham, 26 Oct 2026) and `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md` (sections 7, 8, 13).

## Global Constraints

- **Tab order (Graham):** Grading, Questions, Attempts, Free response. Attempts is a `role="tab"` button in the existing `tab-row tab-row--joined` (#194); Free response keeps its `frq_count > 0` rule.
- **One grade card (AGENTS.md):** the test's score and comment are drawn by `client/src/components/gradeCard/StudentRubricCard.jsx`, never a copy.
- **Test comment write:** the existing `POST /api/mastery/:courseId/write-comment` (verified on a test 26 Oct 2026, `.claude/schoology-api-reference.md` "A test's overall grade comment"). The card sends no `points`: the route re-reads and echoes the auto-scored grade. No new Schoology surface.
- **Per-question comments:** none. Only FRQ marks and comments, unchanged on the Free response tab (Graham, 26 Oct 2026).
- **Template comment target:** the member test the student took (`quiz_attempts.assignment_id`), including the extra-time copy.
- **Result task comment:** an optional narrative written by the teacher with AI/PrisMCP help, guiding the student to revise and improve (Graham, 26 Oct 2026).
- **Copy:** no em dashes in UI copy (`client/src/copy.test.js`); hover text through `Tip` / `useHelpPop`, never `title`; dates via `formatDate`.
- **Private details (#197):** the assessment page already renders only with the switch on; the Attempts tab adds nothing visible with it off.
- **Migration:** none. On 26 Oct 2026 prod's only group (TV Club, id 1) holds no overall suggestion.

## Review Focus

1. **A student who took the `*` copy:** their Attempts card, comment write and template suggestion use the copy's assignment id, not `members[0]`. Test in Tasks 1, 2 and 4.
2. **A student who did not take the test:** no Attempts card; listed under "Not taken" with a count. Test in Task 4.
3. **No result task linked:** the Attempts tab and the template comment still work; `rubric_scores` and `narrative` are refused with "Link this quiz group to its result task first"; Grading states that no result task is linked. Tests in Tasks 1 and 5.
4. **The test's score is never changed by a comment save:** the Attempts card passes no `points`; write-comment on an `is_test` task echoes Schoology's grade. Test in Task 4 (card payload) and Task 1 step 6 (route).
5. **Numbers change after the teacher edited the test suggestion:** Update numbers on the Attempts card rebuilds with the stored impression and keeps the edited state rules of `rebuildOverallSuggestion` today. Test in Task 1.

---

### Task 1: Template suggestion on the member test; result task gets levels and the narrative

**Files:**
- Modify: `server/services/quizResults.js` (per-student output, `overallFor`)
- Modify: `server/services/quizOverall.js` (`eligibleResults`, `store`, `writeOverallSuggestions`, `rebuildOverallSuggestion`)
- Test: `server/services/quizResults.test.js`, `server/services/quizOverall.test.js`, `server/routes/mastery.test.js`

**Interfaces:**
- Produces (each `quizResults(db, { groupId }).students[]` entry, added fields): `member: { id, schoology_assignment_id, title }` (the test the student took), `attempt_id`, `score`, `max_score` (from `quiz_attempts`). `overall` is now read from the feedback row on `member.id` (still matched by `quiz_overall.group_id`).
- Produces: `writeOverallSuggestions(db, { groupId, students })` where each student is `{ student, impression, rubric_scores?, narrative?, reviewer_flags?, reviewer_flags_brief? }`. Returns `{ written, results }` as today; each result adds `test: { status, feedbackId }` and `result: { status, feedbackId } | null`.
- Produces: `rebuildOverallSuggestion(db, { groupId, studentId })` rebuilds the suggestion on the student's member test.

- [ ] **Step 1: Write failing tests in `quizResults.test.js`**
  - `'each student names the member test taken, the attempt id and the score'`: a group of two tests where student B took the `*` copy; expect B's `member.schoology_assignment_id` to be the copy's, `score`/`max_score` from `quiz_attempts`, `attempt_id` set.
  - `'overall is read from the member test, not the result task'`: a `quiz_overall` suggestion stored on the copy is returned as B's `overall`; one stored on the result task is ignored.
- [ ] **Step 2: Write failing tests in `quizOverall.test.js`**
  - `'the built comment goes to the test the student took'`: after `writeOverallSuggestions`, the feedback row on the copy holds `narrative_feedback` equal to `buildComment(template, …)` and `quiz_overall.impression`; it has no `rubric_scores`.
  - `'levels and the narrative go to the result task'`: with `rubric_scores` and `narrative: 'Revise part (a): …'`, the result task's row holds those levels and that text and no `quiz_overall`.
  - `'without a narrative the result task gets the levels and an empty comment'`.
  - `'with no result task linked, the test comment is written and levels are refused'`: unlinked group, `rubric_scores` given → `result.status === 'error'`, message `'Link this quiz group to its result task first'`; `test.status === 'written'`.
  - `'Update numbers rebuilds the test suggestion with the stored impression'`: change an FRQ mark, call `rebuildOverallSuggestion`, expect the copy's row rebuilt and the result task's row untouched.
- [ ] **Step 3: Run them and see them fail**
  Run: `npx vitest run server/services/quizResults.test.js server/services/quizOverall.test.js`
  Expected: the new tests FAIL (missing `member`; suggestion lands on the result task).
- [ ] **Step 4: Implement**
  - `quizResults.js`: select `qa.id AS attempt_id, qa.score, qa.max_score, qa.assignment_id` and the member's sid/title per student; `overallFor` takes the latest feedback on the student's member test id.
  - `quizOverall.js`: `eligibleResults` requires only `loaded_at`; `store` makes two `upsertStudentSuggestion` calls: the test (`assignmentId: st.member.schoology_assignment_id`, `narrative_feedback` = built comment, `quiz_overall`), then, when the group has a result and the student sent `rubric_scores` or `narrative`, the result task (`rubric_scores`, `narrative_feedback: narrative ?? ''`, reviewer flags). Refuse levels/narrative on an unlinked group with the message above. Update the file's top comment.
- [ ] **Step 5: Run the tests and see them pass**
  Run: `npx vitest run server/services/quizResults.test.js server/services/quizOverall.test.js server/services/suggestions.test.js server/routes/quizzes.test.js`
  Expected: PASS.
- [ ] **Step 6: Pin the score echo on a test in `server/routes/mastery.test.js`**
  Test `'write-comment on a Schoology test sends the grade Schoology holds'`: an `is_test = 1` assignment, mocked fresh grade `100`, body without `points`; expect the PUT payload `grade: '100'`, `comment_status: null` for `commentStatus: false`. Run `npx vitest run server/routes/mastery.test.js`: PASS (no code change expected; if it fails, fix the route).
- [ ] **Step 7: Commit** `feat(quizzes): the template comment goes on the test the student took (#200)`

### Task 2: Attempts read: each student's answers

**Files:**
- Create: `server/services/quizAttempts.js`, `server/services/quizAttempts.test.js`
- Modify: `server/routes/quizzes.js` (route), `server/routes/quizzes.test.js`
- Modify: `client/src/services/api.js` (`getQuizAttempts`)

**Interfaces:**
- Consumes: `quizResults` (Task 1) for `member`, `attempt_url`, `score`, FRQ confirmed levels.
- Produces: `quizAttempts(db, { groupId })` → `{ group: { id, members: [{ id, schoology_assignment_id, title }] }, questions: [{ position, kind: 'mcq'|'frq', max_points }], students: [{ student_id, name, member, attempt_url, score, max_score, answers: [{ position, kind, chosen_letter, key_letter, is_correct, points, max_points, level }] }], not_taken: [{ student_id, name }] }`. `key_letter` from `options_json` (`is_key`); `level` is the FRQ's confirmed level name (Prism mark, else Schoology's), else null.
- Produces: `GET /api/quizzes/:id/attempts`; client `getQuizAttempts(groupId)`.

- [ ] **Step 1: Write failing tests in `quizAttempts.test.js`**
  - `'lists every answer in question order with the key'`: MCQ chosen `B`, key `C` → `{ chosen_letter: 'B', key_letter: 'C', is_correct: 0 }`; a blank MCQ → `chosen_letter: null`.
  - `'an FRQ answer carries its confirmed level and points'`.
  - `'a student on the extra-time copy gets that copy as member'`.
  - `'students with no attempt are in not_taken'`.
- [ ] **Step 2: Run** `npx vitest run server/services/quizAttempts.test.js`: FAIL (module missing).
- [ ] **Step 3: Implement `quizAttempts(db, { groupId })`** reading `quiz_responses` joined to `quiz_questions` by the group's logical questions (as `quizStats.js` does), merged with `quizResults` per student.
- [ ] **Step 4: Route test** in `quizzes.test.js`: `'GET /:id/attempts returns the attempts'` (200, shape keys) and 404 for an unknown group via the existing `handle` error path.
- [ ] **Step 5: Run** `npx vitest run server/services/quizAttempts.test.js server/routes/quizzes.test.js`: PASS.
- [ ] **Step 6: Commit** `feat(quizzes): read each student's answers for the Attempts tab (#200)`

### Task 3: PrisMCP: the tool writes the test comment, levels and an optional narrative

**Files:**
- Modify: `mcp/server.js` (`write_quiz_overall_suggestions`, `get_quiz_results` descriptions and schema), `mcp/handlers.js` (`writeQuizOverallSuggestionsTool` passes `narrative`)
- Test: `mcp/handlers.test.js`, `mcp/server.test.js`
- Modify: `docs/prismcp-install-and-verify.md` (any line naming the result task as the comment's home)

**Interfaces:**
- Consumes: `writeOverallSuggestions` (Task 1).
- Produces: tool input per student adds `narrative: z.string().optional()` ("Optional student-facing narrative for the result task: what to revise or improve. British spelling."). Description states: the template comment (numbers, FRQ levels, impression, attempt line) is written on the test the student took; levels and the narrative on the linked result task; both for teacher review, never sent to Schoology.

- [ ] **Step 1: Failing tests:** `handlers.test.js` `'write_quiz_overall_suggestions writes the test comment and passes the narrative to the result task'`; `server.test.js` asserts the schema accepts `narrative` and the description names the test.
- [ ] **Step 2: Run** `npx vitest run mcp/handlers.test.js mcp/server.test.js`: FAIL.
- [ ] **Step 3: Implement** the schema, description and pass-through.
- [ ] **Step 4: Run** the same command: PASS. Also `node scripts/check-mcp-endpoint.js http://127.0.0.1:<dev port>/mcp --expect-dev` against a dev server: the tool list includes both tools.
- [ ] **Step 5: Commit** `feat(mcp): quiz overall writes the test comment and the result narrative (#200)`

### Task 4: The Attempts tab

**Files:**
- Create: `client/src/components/quiz/AttemptsTab.jsx`, `client/src/components/quiz/AttemptsTab.test.jsx`, `client/src/components/quiz/AttemptAnswers.jsx` (the answer list)
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (tab button and panel), `client/src/pages/AssessmentSummaryPage.quiz.test.jsx`
- Modify: `client/src/app.css` (an `ATTEMPTS` block next to the FRQ styles; phone rules, if any, in PHONE LAYOUT)

**Interfaces:**
- Consumes: `getQuizAttempts` (Task 2); `getMasteryForAssignment(courseId, sid)` and `getFeedbackForAssignment(sid)` for each member test; `rebuildQuizOverall(groupId, studentId)`; `useQuizResults`; `StudentRubricCard` props `student`, `assignment`, `feedbackRow`, `attemptLink`, `quizResult`, `onRebuildQuiz`, `courseId`, and its existing comment save (`writeMasteryComment`).
- Produces: `<AttemptsTab group={quizGroup} courseId={courseId} reloadKey={…} />`; tab id `'attempts'` in `useStickyTab('assessment-quiz', …)`.
- Consumes for Publish all: `sendAllGrades(courseId, entries)` with the entry shape the Grading tab's Publish all already builds in `AssessmentSummaryPage.jsx` (reuse its builder, passing each student's member sid).

- [ ] **Step 1: Failing tests in `AttemptsTab.test.jsx`**
  - `'one card per student who took the test, on the member test they took'`: mocks two members; the `*`-copy student's card gets the copy's `assignment` and its mastery row.
  - `'each card shows the score and the attempt link'` (`13/20 (65%)`, link to `attempt_url`).
  - `'answers list each question: chosen, key, correct or not, FRQ level'`: `Q3 B (key C)` marked incorrect with an accessible label; `Q21 Developing`.
  - `'the suggested comment is the test suggestion, and Update numbers rebuilds it'` (calls `rebuildQuizOverall(1, studentId)`).
  - `'saving the comment writes to the member test without points'`: `writeMasteryComment` called with `assignmentId` = the copy's sid and no `points`.
  - `'students who did not take it are listed under Not taken'`.
  - `'Publish all on the Attempts tab sends each accepted test comment to the test that student took'`: two students on different members; `sendAllGrades(courseId, entries)` gets one entry per student with that member's sid, no points, and the Grading tab's Publish all is not involved.
- [ ] **Step 2: Run** `cd client && npx vitest run src/components/quiz/AttemptsTab.test.jsx`: FAIL.
- [ ] **Step 3: Implement `AttemptsTab`** (one card per student, sorted by last name as the Grading tab sorts; answers in a compact grid under the card, MCQ as chosen letter with a correct/incorrect mark and the key when wrong, FRQ as its level) and add the tab between Questions and Free response.
- [ ] **Step 4: Page test** in `AssessmentSummaryPage.quiz.test.jsx`: `'the tabs are Grading, Questions, Attempts, Free response'` and `'Attempts sits in the tab panel'`.
- [ ] **Step 5: Run** `cd client && npx vitest run src/components/quiz src/pages/AssessmentSummaryPage.quiz.test.jsx src/pages/AssessmentSummaryPage.test.jsx`: PASS.
- [ ] **Step 6: Commit** `feat(quizzes): Attempts tab for the test itself (#200)`

### Task 5: Grading tab: the result task only

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (Grading panel, `handleRebuildQuiz` removed from Grading cards)
- Test: `client/src/pages/AssessmentSummaryPage.test.jsx` (the quiz line tests near the existing "Update numbers" tests), `AssessmentSummaryPage.quiz.test.jsx`

**Interfaces:**
- Consumes: `quizGroup.result`, `setQuizSetupOpen`.
- Produces: with a result linked, Grading cards keep the quiz line text and the attempt link but no "Numbers changed" / Update numbers (that suggestion now lives on the test). Without a result, the Grading panel shows one `.alert.alert-warning` line "No result task is linked to this quiz." with a `.secondary` button "Link a result task" that opens Quiz setup.

- [ ] **Step 1: Failing tests:** `'Grading cards show the quiz line without Update numbers'`; `'with no result task, Grading states it and opens Quiz setup'`.
- [ ] **Step 2: Run** `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx src/pages/AssessmentSummaryPage.quiz.test.jsx`: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same: PASS; then the whole client suite `cd client && npx vitest run` and `npm run build`.
- [ ] **Step 5: Commit** `feat(quizzes): Grading is the result task only (#200)`

### Task 6: The grading skill and the docs

**Files:**
- Modify: `~/repos/graham-plugins/assessment-grader/skills/grade-theory-test/SKILL.md` step 6, the plugin's `CHANGELOG.md` and version (that repo's own release conventions)
- Modify: `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md` (sections 7, 8, 13 "As built, #200"), `docs/design-language.md` (an "Attempts tab (#200)" entry), `.claude/build-progress.md` (a #200 section), `AGENTS.md` (only if a convention changed), `docs/prismcp-install-and-verify.md`

- [ ] **Step 1: Skill:** step 6 states that the impression goes into the test's comment (Prism builds it), the optional `narrative` is the result task's student-facing guidance to revise and improve, and `rubric_scores` stay the result task's levels. Keep the "older Prism" fallback.
- [ ] **Step 2: Grep for the old wording** across code, client, tests, docs and the plugin: `rg -n "on its linked result task|on the linked result task|overall result on" --glob '!node_modules'`; fix each hit that describes the comment's home.
- [ ] **Step 3: Full verification:** `npx vitest run` at the root, `cd client && npx vitest run`, `npm run build`; push `main`; CI green (`gh run list --commit $(git rev-parse HEAD)`); `curl -s 127.0.0.1:3001/api/version` serves the commit.
- [ ] **Step 4: Live check on prod (reads only):** the TV Club group (course 581) shows Grading, Questions, Attempts, Free response; the Attempts tab lists 6 students, the `*` student's card on test `8603667595`; screenshots kept local and deleted after.
- [ ] **Step 5: Commit and close:** docs commit; comment on #200 with commit ids and the live check; close it.
