# Linked Quiz Attempts Tab Implementation Plan (#200)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Attempts tab on a linked quiz's page, for every question type, By student and By question, replacing the Free response tab; the template comment moves to the test the student took; the result task gets the teacher's optional narrative.

**Architecture:** Server: `quizResults` learns each student's member test; `quizOverall` writes the template comment on that test and the levels/narrative on the result task, part by part; a new `quizAttempts` read serves every question and answer from stored data in one request. Client: the Grading tab's batch publish moves into a shared hook so the Attempts tab's test cards can use it; `AttemptsTab` draws By student (the test's `StudentRubricCard`, MCQ rows, `FrqCard`s) and By question; `FreeResponseTab` is retired.

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest; React 18 + React Testing Library; PrisMCP (`mcp/server.js`, zod).

**Spec:** `docs/superpowers/specs/2026-10-26-linked-quiz-attempts-design.md` (with `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md`, sections 7, 8, 12, 13, 14).

## Global Constraints

- **Tabs:** Grading, Questions, Attempts, in the #194 `tab-row tab-row--joined` with the `tab-panel`. A stored or linked `?tab=frq` opens Attempts.
- **One grade card:** the test's score and comment are `StudentRubricCard` for the member test (`canEditPoints` already refuses points on a test, so a comment save never changes the score).
- **Verified writes only:** test comments through `POST /api/mastery/:courseId/write-comment` / `sendAllGrades`; FRQ marks through `PostMarksBar` / `quizWriteback.js`. No new Schoology surface, no new Schoology read.
- **No MCQ comments** anywhere.
- **Template comment target:** the member test the student took (`quiz_attempts.assignment_id`), the extra-time copy included.
- **Suggestion source:** an agent run (impression required for the test comment); Prism builds no suggestion on its own.
- **Parts:** `impression` writes the test comment; `rubric_scores` or `narrative` write the result task; each only when the call carries it. Edited or accepted suggestions keep `upsertStudentSuggestion`'s protection.
- **Readiness:** the test comment and the levels need every FRQ confirmed (`st.ready`); the narrative does not.
- **Unlinked group:** test comment allowed; levels or narrative refused with `Link this quiz group to its result task first`.
- **Test card shows on Attempts only** (not the student page or the gradebook pop-up).
- **Copy:** no em dashes (`client/src/copy.test.js`); hover text via `Tip` / `useHelpPop`, never `title`; dates and times via `formatDate` / `formatDateTime`; colours from `app.css` tokens.

## Review Focus

1. **A student on the extra-time copy:** header, test card, comment write and template suggestion all use the copy (`8603667595` on prod), never `members[0]`. Tests in Tasks 1, 2, 5.
2. **A quiz with no FRQ, or FRQ only:** By student and By question work with zero MCQs or zero FRQs; the FRQ only filter and FRQ filters hide when there are no FRQs. Tests in Tasks 5, 6.
3. **A student who did not take the test:** in "Not taken" with a count, in both views; no card. Tests in Tasks 2, 5.
4. **Publish all on Attempts never touches the result task, and Grading's never touches the tests:** each tab's batch holds only its own cards. Test in Tasks 4, 5.
5. **A narrative written after the teacher accepted the test comment:** the test comment is unchanged. Test in Task 1.

---

### Task 1: Template comment on the member test; levels and narrative on the result task

**Files:**
- Modify: `server/services/quizResults.js`, `server/services/quizOverall.js` (and its top comment)
- Test: `server/services/quizResults.test.js`, `server/services/quizOverall.test.js`, `server/routes/mastery.test.js`

**Interfaces:**
- Produces, per `quizResults(db, { groupId }).students[]`: `member: { id, schoology_assignment_id, title, extra_time: boolean }` (`extra_time` = not `members[0]`), `attempt_id`, `score`, `max_score`, `started_at`, `completed_at`; `overall` read from the latest `quiz_overall` feedback on `member.id`.
- Produces: `writeOverallSuggestions(db, { groupId, students })`, each student `{ student, impression?, rubric_scores?, narrative?, reviewer_flags?, reviewer_flags_brief? }` → `{ written, results: [{ student, test: { status, feedbackId, message? } | null, result: { status, feedbackId, message? } | null }] }`. `written` counts students with any part written.
- Produces: `rebuildOverallSuggestion(db, { groupId, studentId })` rebuilds the member test's suggestion.

- [ ] **Step 1: Failing tests, `quizResults.test.js`:** `'each student names the member test taken, the attempt and its times'` (two members, student B on the copy: `member.schoology_assignment_id` is the copy's, `extra_time: true`, score and times from `quiz_attempts`); `'overall is read from the member test'` (a row on the result task is ignored).
- [ ] **Step 2: Failing tests, `quizOverall.test.js`:**
  - `'impression writes the built comment on the test the student took'` (row on the copy: `narrative_feedback` = `buildComment(template, …)`, `quiz_overall` set, no `rubric_scores`).
  - `'rubric_scores and narrative write the result task'` (levels and `narrative_feedback: 'Revise part (a)…'`, no `quiz_overall`).
  - `'a narrative alone leaves the test comment untouched'` (accepted test suggestion before and after is identical).
  - `'narrative is written for a student who is not ready; impression and levels are refused'` (message `Not ready: …`).
  - `'unlinked group: test comment written, levels refused'` (message `Link this quiz group to its result task first`).
  - `'Update numbers rebuilds the test suggestion only'`.
- [ ] **Step 3: Run** `npx vitest run server/services/quizResults.test.js server/services/quizOverall.test.js`: the new tests FAIL.
- [ ] **Step 4: Implement** in the two services (the `upsertStudentSuggestion` calls are the test part, then the result part).
- [ ] **Step 5: Run** `npx vitest run server/services server/routes/quizzes.test.js`: PASS.
- [ ] **Step 6: Pin the score on a test, `mastery.test.js`:** `'write-comment on a Schoology test echoes Schoology’s grade'`: `is_test = 1`, fresh grade 100, no `points`, `commentStatus: false` → PUT entry `grade: '100'`, `comment_status: null`. Run `npx vitest run server/routes/mastery.test.js`: PASS.
- [ ] **Step 7: Commit** `feat(quizzes): template comment on the test, narrative on the result task (#200)`

### Task 2: The attempts read

**Files:**
- Create: `server/services/quizAttempts.js`, `server/services/quizAttempts.test.js`
- Modify: `server/routes/quizzes.js`, `server/routes/quizzes.test.js`, `client/src/services/api.js`

**Interfaces:**
- Consumes: `quizResults` (Task 1), `frqResponses`'s per-response view (`answer_html`, `schoology`, `mark` via `schoologyMarkOf` / `markView`), `groupStats` (MCQ option counts, `facility`, `band`).
- Produces: `quizAttempts(db, { groupId })` → `{ group: { id, title, has_tags }, questions: [{ id, position, kind, stem_html, max_points, tags, options?: [{ letter, text, is_key, count }], facility?, band?, rubric? }], students: [{ student_id, name, schoology_uid, member, attempt_id, attempt_url, score, max_score, started_at, completed_at, quiz_line_values: { mcq, frq }, by_tag, responses: { [position]: { kind: 'mcq', chosen_letter, is_correct, points, max_points } | { kind: 'frq', answer_html, schoology, mark } } }], not_taken: [{ student_id, name }] }`. Students sorted as `frqResponses` sorts them.
- Produces: `GET /api/quizzes/:id/attempts`; client `getQuizAttempts(groupId)`.

- [ ] **Step 1: Failing tests, `quizAttempts.test.js`:** `'every question in order, MCQ options with the key and class counts'`; `'an MCQ response: chosen, correct, points; a blank one has chosen_letter null'`; `'an FRQ response carries the answer and the mark view FrqCard uses'`; `'the copy student’s member is the copy'`; `'no attempt: in not_taken'`; `'a quiz with no FRQ and one with no MCQ'`; `'has_tags is false when no question has tags'`.
- [ ] **Step 2: Run** `npx vitest run server/services/quizAttempts.test.js`: FAIL.
- [ ] **Step 3: Implement** from stored rows only (no Schoology call), reusing the helpers above rather than re-deriving marks or stats.
- [ ] **Step 4: Route tests:** `'GET /:id/attempts'` 200 with the keys above; unknown group 404 through `handle`.
- [ ] **Step 5: Run** `npx vitest run server/services/quizAttempts.test.js server/routes/quizzes.test.js`: PASS.
- [ ] **Step 6: Commit** `feat(quizzes): one read for every attempt and answer (#200)`

### Task 3: PrisMCP

**Files:**
- Modify: `mcp/server.js` (`write_quiz_overall_suggestions`, `get_quiz_results`, `get_frq_responses` descriptions; schema), `mcp/handlers.js`, `docs/prismcp-install-and-verify.md`
- Test: `mcp/handlers.test.js`, `mcp/server.test.js`

**Interfaces:**
- Consumes: `writeOverallSuggestions` (Task 1).
- Produces: per student `impression` optional, `rubric_scores` optional, new `narrative: z.string().optional()` ("Optional student-facing guidance for the result task: what to revise or improve. British spelling."). Description: the template comment (numbers, FRQ levels, impression, attempt line) goes on the test the student took; levels and the narrative on the linked result task; each part only when given; all for teacher review, never sent to Schoology.

- [ ] **Step 1: Failing tests:** `handlers.test.js` `'write_quiz_overall_suggestions passes narrative and returns test and result parts'`; `server.test.js` schema accepts a narrative-only student and the description names the test.
- [ ] **Step 2: Run** `npx vitest run mcp`: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run mcp`: PASS.
- [ ] **Step 5: Commit** `feat(mcp): quiz overall in parts: test comment, levels, narrative (#200)`

### Task 4: Shared batch publish for grade cards

**Files:**
- Create: `client/src/hooks/useCardBatch.js`, `client/src/hooks/useCardBatch.test.jsx`
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (the "Send all" state: `pendingByUid`, `displayByUid`, `cardsRef`, `registerCard` / `unregisterCard`, the batch send at about :405-470)

**Interfaces:**
- Produces: `useCardBatch({ courseId, studentsByUid, isShown })` → `{ pendingByUid, displayByUid, registerCard, unregisterCard, onPendingChange, onDisplayChange, publishAll(): Promise<void>, bulkSaving, bulkResult }`. Behaviour identical to today's Grading bar, including held levels on a final flag (#177).

- [ ] **Step 1: Failing test, `useCardBatch.test.jsx`:** `'publishAll sends only registered pending cards and applies each result'` and `'a card on a final flag is reported as held'`.
- [ ] **Step 2: Run** `cd client && npx vitest run src/hooks/useCardBatch.test.jsx`: FAIL.
- [ ] **Step 3: Move the logic** into the hook; the page uses it with no behaviour change.
- [ ] **Step 4: Run** `cd client && npx vitest run src/hooks/useCardBatch.test.jsx src/pages/AssessmentSummaryPage.test.jsx src/pages/AssessmentSummaryPage.quiz.test.jsx`: PASS (existing Send all tests unchanged).
- [ ] **Step 5: Commit** `refactor(grading): batch publish as a hook for more than one card list (#200)`

### Task 5: Attempts, By student

**Files:**
- Create: `client/src/components/quiz/AttemptsTab.jsx` (data, view switch, Not taken), `client/src/components/quiz/AttemptByStudent.jsx`, `client/src/components/quiz/McqAnswer.jsx`, tests beside each
- Modify: `client/src/app.css` (an ATTEMPTS block beside the FRQ styles)

**Interfaces:**
- Consumes: `getQuizAttempts` (Task 2); `getMasteryForAssignment(courseId, sid)` and `getFeedbackForAssignment(sid)` per member test; `useCardBatch` (Task 4); `StudentRubricCard` (`student`, `assignmentRow`, `topics=[]`, `courseId`, `assignmentId`, `feedbackRow`, `attemptLink`, `quizResult`, `onRebuildQuiz`, `registerCard`, …); `FrqCard`; `PostMarksBar`; `QuizResultLine`'s `quizLineText`; `rebuildQuizOverall`.
- Produces: `<AttemptsTab group courseId reloadKey />`; view state `?view=student|question` through `useStickyTab('assessment-attempts', 'student', { param: 'view' })`; `McqAnswer({ question, response })` reused by Task 6.

- [ ] **Step 1: Failing tests:**
  - `'By student opens on the first student; Previous and Next walk the class'`.
  - `'the header names the test taken, the extra-time copy, the attempt link, the quiz line and the time taken'` (`35 min`).
  - `'the test card is the member test’s grade card with the template suggestion'` (copy student → copy's `assignmentRow`).
  - `'Update numbers rebuilds the test suggestion'` (`rebuildQuizOverall(1, studentId)`).
  - `'an MCQ shows the choice, the key when wrong, and the class percent'` (accessible text: `Chose B, incorrect. Answer C. Class 55% correct.`).
  - `'an FRQ shows its marking card'`.
  - `'FRQ only hides the MCQs'`; hidden when the quiz has no FRQ.
  - `'By tag shows only when the quiz has tags'`.
  - `'Publish all sends the accepted test comments, each to the test taken, and nothing to the result task'`.
  - `'Publish all to Schoology for FRQ marks is the existing bar'` (behind `quiz_writeback`).
  - `'Not taken lists students with no attempt'`.
- [ ] **Step 2: Run** `cd client && npx vitest run src/components/quiz`: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same: PASS.
- [ ] **Step 5: Commit** `feat(quizzes): Attempts tab, By student (#200)`

### Task 6: Attempts, By question; the tabs; Grading

**Files:**
- Create: `client/src/components/quiz/AttemptByQuestion.jsx` and its test; `client/src/lib/frqFilters.js` (`FILTERS`, `matchesFilter` moved from `FreeResponseTab.jsx`)
- Delete: `client/src/components/quiz/FreeResponseTab.jsx`, `FreeResponseTab.test.jsx` (each test moved to the By question / By student tests first)
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (tabs, `?tab=frq` → `attempts`, Grading cards without Update numbers, unlinked message), `client/src/pages/AssessmentSummaryPage.test.jsx`, `AssessmentSummaryPage.quiz.test.jsx`, `client/src/pages/stickyTabs.test.jsx` if it names `frq`

**Interfaces:**
- Consumes: Task 5's `AttemptsTab` data and `McqAnswer`; `QuestionsTab`'s option bar styles.
- Produces: tabs `grading | questions | attempts`.

- [ ] **Step 1: Failing tests:**
  - `'By question: the picker lists every question; an MCQ shows each student’s choice and the option counts'`.
  - `'By question on an FRQ shows one marking card per student, with the FRQ filters'` (the moved Free response tests).
  - `'the tabs are Grading, Questions, Attempts; ?tab=frq opens Attempts'`.
  - `'Grading cards show the quiz line without Update numbers'`.
  - `'with no result task linked, Grading states it and opens Quiz setup'` (text `No result task is linked to this quiz.`, button `Link a result task`).
- [ ] **Step 2: Run** `cd client && npx vitest run src/components/quiz src/pages`: FAIL.
- [ ] **Step 3: Implement**, then grep for leftovers: `rg -n "FreeResponseTab|'frq'" client/src`.
- [ ] **Step 4: Run** `cd client && npx vitest run` and `npm run build`: PASS.
- [ ] **Step 5: Commit** `feat(quizzes): Attempts By question replaces the Free response tab (#200)`

### Task 7: The skill, the docs, verification and the live check

**Files:**
- Modify: `~/repos/graham-plugins/assessment-grader/skills/grade-theory-test/SKILL.md` (step 6), its `CHANGELOG.md` and plugin version, per that repo's own conventions
- Modify: the 26 Oct design ("As built" notes), the quiz spec (sections 7, 8, 12, 13), `docs/design-language.md` ("Attempts tab (#200)"), `.claude/build-progress.md` (a #200 section), `docs/prismcp-install-and-verify.md`, `AGENTS.md` only if a convention changed

- [ ] **Step 1: Skill step 6:** the impression goes into the test's comment (Prism builds it); `rubric_scores` are the result task's levels; the optional `narrative` is the result task's guidance to revise and improve, which may be written in a later call; keep the older-Prism fallback.
- [ ] **Step 2: Old wording:** `rg -n "Free response tab|on its linked result task|on the linked result task" --glob '!node_modules' --glob '!dist'` in the repo and the plugin; fix each hit that describes the old behaviour.
- [ ] **Step 3: Verify:** `npx vitest run` (root), `cd client && npx vitest run`, `npm run build`; push `main`; `gh run list --commit $(git rev-parse HEAD)` green; `curl -s 127.0.0.1:3001/api/version` serves it.
- [ ] **Step 4: Live check on prod, reads only:** TV Club group (course 581): tabs Grading, Questions, Attempts; By student shows 6 students, the extra-time student on `8603667595`; By question Q21 shows 6 marking cards. Screenshots local, deleted after.
- [ ] **Step 5: Close:** docs commit; #200 comment with commit ids and the live check; close #200; note on #145 that its attempt view now exists.
