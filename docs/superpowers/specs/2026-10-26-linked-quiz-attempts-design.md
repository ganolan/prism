# Linked quizzes: the Attempts tab (#200)

Decided with Graham on 26 Oct 2026. Builds on the linked quizzes design
(`docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md`, "the quiz spec" below) and the
tab panel of #194.

## Why

A linked quiz has two grades per student, and Prism draws only one of them well. Grading shows the
aligned result task (every task in a group already redirects to the group's canonical task, the
result task when one is linked). The Schoology test itself, with its score, its answers and its own
overall comment, has no view of its own: MCQ answers are visible only as class counts on Questions,
FRQs only on the Free response tab, and the template comment built from the attempt's numbers is
stored on the result task, where Graham wants his own narrative instead.

Graham wants a Prism version of the attempt, like Schoology's, that works for any mix of question
types, so the same page serves a theory test (MCQ and FRQ) and a validation test (FRQ only, #145).

## Goals

- **One Attempts tab** replaces the Free response tab and shows every question type.
- **Two views, as Schoology has:** By student (one student's whole attempt) and By question (one
  question, every student's answer).
- **The test's own overall comment** is edited and published on the Attempts tab, on the test the
  student took.
- **The template comment moves** from the result task to that test.
- **The result task's comment** becomes the teacher's optional narrative.

## Non-goals

- **Per-question comments on MCQs.** None, anywhere (Graham: he comments only on FRQs).
- **Validation-test specifics.** A rubric per question and the code screenshots stay in #145.
- **New Schoology surfaces.** The test comment uses the verified grade-comment write; FRQ marks keep
  their verified attempt write.
- **Changing Questions.** The class statistics tab stays as it is.

## Anti-goals

- A second copy of the grade card. The test's score and comment are drawn by
  `StudentRubricCard.jsx` (AGENTS.md "One grade card").
- A comment save that changes a test's auto-scored grade.
- Losing any FRQ marking ability the Free response tab has today.

## The page (decided)

**Tabs:** Grading, Questions, Attempts. The Free response tab is removed; its content moves into
Attempts. A stored or linked `?tab=frq` opens Attempts.

**Grading:** the result task, as today (the redirect). Cards keep the quiz line and the attempt link;
"Numbers changed" and Update numbers move to Attempts, since the template comment no longer lives
here. Without a linked result task, Grading shows one line, "No result task is linked to this quiz.",
and a button that opens Quiz setup's Result task picker.

**Attempts, By student** (the default view):
- **Student picker** and Previous / Next, so the teacher can walk the class.
- **Header:** the student's name, the member test they took (the extra-time copy named when it is
  that one), the attempt link, the quiz line (`MCQ 13/20 (65%), FRQ Q21: Developing`), and how long
  the attempt took (`quiz_attempts.started_at` to `completed_at`).
- **The test's grade card:** `StudentRubricCard` for the member test: the score, the overall comment
  with the template suggestion, Accept, edit, Display, and Update numbers when the numbers changed.
- **By tag:** the student's percent correct per tag (as `get_quiz_results` `by_tag` computes),
  shown only when the quiz has tags.
- **Every question in order:**
  - **MCQ:** the stem, each option with the student's choice and the key marked (correct, incorrect,
    the key when the choice was wrong, blank), the points, and the class's percent correct on that
    question in the Questions tab's band colours.
  - **FRQ:** the stem, the answer, and today's FRQ marking card (`FrqCard`): level, points, comment,
    Accept, Save edit, Keep mine, Copy comment.
- **FRQ only:** a filter that hides the MCQs, so one student's written answers sit together.

**Attempts, By question:**
- **Question picker** over every question (`Q1` to `Q21`), the stem shown once.
- **MCQ:** each student's choice and whether it is correct, plus the option counts the Questions tab
  already computes.
- **FRQ:** today's By question view: one `FrqCard` per student.
- **The FRQ filters** (All, To review, Accepted, Waiting to post, Posted, Failed, Changed in
  Schoology) apply to FRQ cards in both views.

**Publishing on Attempts:**
- **FRQ marks:** Publish all to Schoology, as today (`PostMarksBar`, behind `quiz_writeback`).
- **Test comments:** Publish all for the accepted test comments, each to the test that student took,
  through the existing `POST /api/mastery/:courseId/write-comment` (via `sendAllGrades`), with no
  points. A single card publishes itself, as every grade card does.

**Not taken:** students in the section with no attempt are listed once, with a count, in both views.

## The comments (decided)

- **Test (Attempts):** the template comment (numbers, FRQ levels, the impression, the line sending
  the student to the attempt), stored as a suggestion on the member test the student took.
- **Result task (Grading):** an optional narrative written by the teacher with AI or PrisMCP help,
  guiding the student to revise and improve. The Episode 1 TV Club result comments show the form: the
  student's name and an overall impression, then a pointer to the attempt and the one part to focus on.
- **`write_quiz_overall_suggestions`:** writes the template comment on the test, and the levels plus
  an optional `narrative` on the result task. Without a linked result task the test comment is still
  written and levels or a narrative are refused ("Link this quiz group to its result task first").
- **Migration:** none (26 Oct 2026: prod's only group holds no overall suggestion).
- **Where the test suggestion comes from (Graham):** an agent run, as today. The grading skill writes
  a short impression per student and Prism builds the comment around it; there is no suggestion
  until the skill runs. Prism does not build a numbers-only suggestion on its own.
- **Writing in parts (builder's call, agreed):** each part of a call is written only when the call
  carries it: `impression` writes the test comment; `rubric_scores` or `narrative` write the result
  task. So a narrative can be added later without touching the test comment. A suggestion the teacher
  has edited or accepted keeps the protection `upsertStudentSuggestion` gives it today.
- **Readiness (builder's call, agreed):** the test comment and the levels wait until every FRQ is
  confirmed, since both rest on the FRQ marks; the narrative can be written at any time.
- **Where the test's card shows (Graham):** the Attempts tab only. The student page and the gradebook
  pop-up keep the result task's card with the quiz line and the attempt link.

## Constraints

- **Verified writes only:** test comment through write-comment (`.claude/schoology-api-reference.md`
  "A test's overall grade comment", 26 Oct 2026); FRQ marks through `quizWriteback.js`.
- **Data already stored:** answers (`quiz_responses.chosen_letter`, `is_correct`, `points`,
  `answer_html`), the key (`quiz_questions.options_json` `is_key`), attempts (`quiz_attempts`
  `score`, `max_score`, `started_at`, `completed_at`). No new Schoology read.
- **Prism's rules:** tabs in the #194 panel; hover text through `Tip`, never `title`; no em dashes in
  UI copy; dates via `formatDate`; the assessment page is a desktop page (phone shows "Best on a
  larger screen") and must not break at phone width, but needs no phone layout.
- **Private details (#197):** the assessment page renders only with the switch on; nothing new shows
  with it off.
- **PrisMCP and the skill follow:** tool descriptions in `mcp/server.js`,
  `docs/prismcp-install-and-verify.md`, and the assessment-grader skill `grade-theory-test` step 6.

## Left to the builder

- The layout of an MCQ row and the answer list (compact; reuse the Questions tab's option and band
  styling).
- How the student picker and Previous / Next are drawn.
- Whether By question's MCQ list and the Questions tab share a component.
- The server shape of the attempts read, as long as it comes from stored data in one request.
- Test names, file split, and the order of the work.

## As built (26 Oct 2026)

Plan: `docs/superpowers/plans/2026-10-26-linked-quiz-attempts.md`. Calls made while building:
- **Header:** the student, the member test (only when the group has more than one: Prism reads nothing from titles, so no "extra-time" flag), the attempt link and the time taken. The quiz line and Update numbers come from the grade card's own quiz line, not repeated.
- **Result-task writes merge:** a call with only levels or only a narrative keeps the other half of the result task's latest suggestion.
- **Reviewer flags** go on the test suggestion when an impression is sent, else on the result task.
- **Serves:** `get_quiz_results` records its read on every member test as well as the result task, so the test suggestion is stamped with the results' load time.
- **Publish:** the Grading tab's batch became `useCardBatch`, one instance per tab; the Attempts button reads "Publish test comments (n)".
- **Attempts shows for every linked quiz**, not only one with an FRQ.

