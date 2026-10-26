# Linked quizzes: question stats, free-response marking and the overall result

Status: **design agreed with the teacher (2026-10-12). Phase 1 and 1b on main (2026-10-13); phase 2 on main (§12); phase 3 on main (§13); phase 4 on main with `quiz_writeback` on (§14); posting by question agreed 2026-10-13 (§15).** The read-only probe in §2 ran
on 12 October 2026, and every page shape in this document comes from it.

## Goal

A teacher gives a Schoology test or quiz with any mix of multiple choice questions (MCQ) and free
response questions (FRQ), then reports the result on a separate aligned task. Prism should:

1. **Show question statistics:** percent correct per question, by question type and by tag, and
   which distractors drew students.
2. **Mark the FRQs:** each student's answer beside an AI-suggested rubric cell and comment, which
   the teacher accepts or edits, then posts to the student's attempt in Schoology.
3. **Suggest the overall result** on the aligned task: levels per measurement topic and a short
   comment that shows the numbers behind them.
4. **Link to each student's attempt** from the feedback card, for review and for parent conferences.

The first course is AP CSP (the Episode 1 theory test, sections `8458134135` BK 6 and
`8458134140` BK 7). The design is general: it assumes no naming convention, so other teachers can
use it.

## Decisions (teacher, 2026-10-12)

- **Robust to any teacher's conventions.** Prism reads nothing from titles: the `*` / `#`
  extra-time suffixes are only Graham's habit.
- **Quiz group.** A teacher combines one or more unaligned tests in one section into a group,
  which Prism treats as one quiz. A single test is a group of one. Combining replaces the
  extra-time convention.
- **Parity.** Tests whose question sets differ cannot be combined.
- **Link is optional.** A group may link to one aligned summative (the result task, for example
  `... - Result (S)`). Only unaligned quiz to aligned summative; never two aligned items.
- **Prism reads the data itself**, through its saved browser session, not through an agent.
- **FRQ feedback goes on the attempt** in Schoology, written by Prism; an agent posts it as the
  fallback.
- **FRQs are marked with the Schoology rubric attached to the question.** Points follow from the
  rubric cell.
- **Tags:** free text per question (for example College Board codes), imported by the agent.
- **The overall comment is short:** MCQ percent and FRQ levels, a brief overall impression, and a
  line sending the student to their attempt for the feedback on each FRQ.
- **FRQ view by question:** one picker sets the FRQ for every card, like Schoology's "view by
  question".

## 1. Why Prism has to read the pages

- **Public REST has no per-question data.** The REST v1 documentation lists assignments,
  submissions, grades and rubrics, and nothing for test questions or attempts
  (developers.schoology.com, read 2026-10-12). `GET /v1/sections/{s}/submissions/{testId}` returns
  0 revisions for a test (`schoology-api-reference.md`, "Did the student take the test?").
- **The CSV export is unreliable for FRQs.** It cuts an essay answer at the first `<-`, needs a
  two-step form, and emails the teacher once per export.
- **The pages have everything** (§2), and Prism already keeps a Schoology browser session: the
  nightly sync reads `grader_grade_data` with it (`server/services/graderTestAttempts.js`), and
  PrisMCP uses it on the mini to unsubmit work on request.

## 2. Probe findings (read-only, 2026-10-12)

Probed on test `8544307969` and its extra-time copy `8603667595` (section `8458134135`), one
student's attempt. GET only; every non-GET request was aborted. Scripts:
`scripts/probe-assessment-attempt.js`, `scripts/probe-assessment-rubric.js`. Recorded in
`.claude/schoology-api-reference.md`, "Questions, attempts and FRQ rubrics".

| Page | What it holds |
|---|---|
| `/assignment/{id}/assessment_questions` | One row per question: id (`edit_question/{qid}`), number (`td.component-number`), type (`component-multiple_choice`, `component-essay` on `.component-summary-wrapper`), stem HTML (`.component-title`), points (`.component-points`). No options or key. |
| `/assignment/{id}/assessment_results` | One `tr.student-row-{uid}` per assignee; a taker's `td.cell-submissions` reads like `1/1`. |
| `.../assessment_results/student_stats/{uid}` | Links to each attempt, `student_stats/{uid}/{attemptId}`. Also carries the `/unsubmit` and `/delete` links, which are never fetched. |
| `.../student_stats/{uid}/{attemptId}` | Form `#s-assessment-edit-submission-form`. Per question: `components[0][{qid}][points|override|original_points|max_points|rubric_score|comment]`. MCQ options in `ul.multiple-choice-review#question-{qid}-review`, one `li` per option in order, classed `selected correct`, `selected incorrect` or `correct` (the key, when not chosen). FRQ answer HTML in `.essay-review`. |
| `GET /iapi/grades/rubric/{rubricId}` | The FRQ's Schoology rubric: `title`, `total_points`, `rows[]` with `id`, `title`, `max_points`, `columns[]` of `{pts, description}`. Each description opens with the level name ("Exhibiting Depth:", 4 points, down to "Emerging:", 1). |
| `GET /iapi/grades/assessment_component_submission_rubric_grade_info/{rubricId}/{qid}/{enrollmentId}/{attemptId}` | The chosen cell per rubric row: `{gradeInfo: {<rowId>: {grade, comment}}, overrideGrade}`. |

- **The rubric id and enrollment id** are attributes on the attempt page's rubric button
  (`rubric-id`, `enrollment-id`, `item-id`).
- **A copy gets new question ids** (standard `2327504483…`, extra time `2329012780…`), so a group
  matches questions by content, never by id.

## 3. Concepts

- **Quiz group:** one or more unaligned Schoology tests in one Prism course (one section). A test
  belongs to at most one group.
- **Parity:** the member tests have the same questions, compared by type, normalized stem, points
  and FRQ rubric id when combining, and by options and key once attempts load. Order is ignored,
  because a test can randomize it. A test that draws questions from a bank fails parity.
- **Link:** a group links to at most one aligned summative in the same course, and that summative
  to at most one group. Unlinking keeps every mark.
- **Logical question:** one question of the group, mapped to each member test's own question id.
- **Counted attempt:** the attempt Prism uses for a student. The latest one, with a warning when a
  student has more than one, until the test's `attempts_scoring` setting is read.

## 4. Data model

New tables, all `CREATE TABLE IF NOT EXISTS` in `server/db/schema.sql`. No existing table changes.

| Table | Columns |
|---|---|
| `quiz_groups` | `id`, `course_id`, `title`, `result_assignment_id` (nullable, unique), `comment_template` (phase 3, §13), `parity_status`, `parity_detail_json`, `loaded_at`, timestamps |
| `quiz_group_members` | `group_id`, `assignment_id` (unique) |
| `quiz_questions` | `id`, `group_id`, `position`, `kind` (`mcq`, `frq`, `other`), `stem_html`, `options_json` (`[{letter, html, is_key}]`), `max_points`, `schoology_rubric_json` (FRQ), `tags_json` |
| `quiz_question_copies` | `question_id`, `assignment_id`, `schoology_question_id` |
| `quiz_attempts` | `id`, `group_id`, `assignment_id`, `student_id`, `schoology_attempt_id`, `enrollment_id`, `started_at`, `completed_at`, `score`, `max_score`, `attempt_count`, `fetched_at` |
| `quiz_responses` | `attempt_id`, `question_id`, `chosen_letter`, `is_correct`, `points`, `answer_html`, `schoology_rubric_cells_json`, `schoology_comment` |
| `quiz_tag_texts` | `course_id`, `tag`, `text` (phase 1b: the full wording of a tag, shown on hover) |
| `frq_marks` | `attempt_id`, `question_id`, `suggested_cells_json`, `suggested_comment`, `suggestion_history_json`, `suggestion_revised`, `final_cells_json`, `final_comment`, `state` (`suggested`, `accepted`, `edited`), `writeback_status` (`pending`, `posted`, `failed`), `writeback_at`, `writeback_error`, `posted_cells_json`, `posted_comment` (phase 2, §12) |

- **The overall result reuses `feedback`:** the suggestion on the result task is an ordinary
  suggestion (levels per measurement topic and a narrative), so that task grades like every other
  task in Prism.
- **FRQ without a Schoology rubric** (another teacher's quiz): marked in points (up to
  `max_points`) and a comment. A level-to-points map is left out of v1.

## 5. Loading

`server/services/quizResults.js` (browser I/O) and pure parsers in `server/lib/` (one per page).

1. For each member test: the question list, the results page, each taker's `student_stats` page,
   the counted attempt page, and `rubric_grade_info` for each FRQ with a rubric. Each rubric is
   fetched once.
2. About 2 pages per taker, about 45 requests for a 20-student section, one after another with a
   short pause. Loading is on demand (the **Load results** button, or `load_quiz_results`), and from
   phase 2 the nightly sync also reloads each loaded group that students sat in the last 28 days (§12).
3. **Reloading is safe:** attempts and responses are upserted; `frq_marks` is never touched. A
   response whose Schoology cell or comment differs from `posted_*` is flagged.
4. A student without an attempt on any member test shows as "not taken". Make-up tracking is unchanged.
5. **Read-only guard:** the loader refuses any URL containing `unsubmit` or `delete`.
6. Best effort, like `graderTestAttempts`: a failed page leaves that student unknown and is
   reported; nothing is guessed.

## 6. MCP tools

Combining and linking stay in the UI in v1.

| Tool | Does |
|---|---|
| `list_quiz_groups(course)` | Groups, member tests, linked result task, parity, `loaded_at` |
| `load_quiz_results(group)` | Runs §5; returns counts and warnings |
| `get_frq_responses(group, question?)` | Per student: answer text, the Schoology rubric (levels and descriptions), the current Schoology mark, any Prism mark |
| `write_frq_suggestions(group, question, students[])` | Per student: a cell per rubric row and a comment, upserted as `suggested` |
| `set_question_tags(group, tags?, texts?)` | Tags per question number (for example from `<title> - Codes.csv`), and each tag's full text for the course (for AP CSP, from the CED) |
| `get_quiz_results(group)` | Per student: MCQ correct, total and percent, percent by tag, confirmed FRQ levels |
| `get_tag_results(course, tag)` | One tag across every group in the course, MCQs only: per test (date, questions, percent) and per student (#139) |
| `write_quiz_overall_suggestions(group, students[])` | Per student: levels per measurement topic and a short impression. Prism builds the comment (§7). Refuses a student with an FRQ mark still `suggested`. |
| `list_frq_writebacks(group)` | Accepted or edited marks not yet posted, each with its attempt URL, cells and comment |
| `mark_frq_writeback(group, attempt, question, status, error?)` | Records an agent's post |

The `assessment-grader` skill `grade-theory-test` changes to read FRQs from Prism instead of the
CSV export, once phase 2 ships.

## 7. The overall comment

Prism builds the comment from a template stored on the group, so the numbers always match the
data. The agent writes only the impression. Default template (student-facing, so British spelling):

```
Multiple choice: {mcq_correct}/{mcq_total} ({mcq_percent}%)
Free response: {frq_levels}
{impression}
Open your attempt on the test to read the feedback on each free-response question.
```

`{frq_levels}` lists each FRQ as `Q21 Exhibiting`, separated by commas. The suggested levels follow
the course's own cut-off guide, applied by the agent. For AP CSP that is the Achievement Cut-Off
Guide in `AP CSP Theory Test Marking Guides 2026-27.json`.

## 8. UI

**One tabbed page.** A member test or the linked result task opens the same assessment page, with
tabs **Grading** (only when linked), **Questions** and **Free response**. *(As built: Grading always shows. Every task in the group redirects to the group's canonical task (`canonical_schoology_id`: the result task when linked, else the first member test), so with a link Grading is already the result task. #200, decided 26 Oct 2026, adds an Attempts tab for the test and moves the template comment there.)* The header shows the
linked tests as a chip, the **Load results** button and the load time.

- **Lists fold the group.** In the course list and gradebook, member tests sit under their result
  task (or the group title) as one row, with the chain chip.
- **Grading tab:** the existing student cards for the result task. Each card adds a quiz line
  (`MCQ 17/20 (85%), FRQ Q21: Exhibiting`) and an **Open** link to the attempt beside the status
  pill (the #120 pattern, `SchoologyLink`). The gradebook modal and the student page get the same
  link.
- **Questions tab:** counts only. No discrimination indices or reliability figures: a class-sized
  cohort cannot support them.
  - **Summary:** takers out of assignees, split by member test, and the MCQ median.
  - **By tag:** questions, correct out of total, percent; lowest first.
  - **By type:** MCQ percent; FRQ level counts.
  - **Question list:** number, type, tags, stem, a facility bar and band (Strong, Mixed, Divided),
    option counts with the key marked, and flags. Expanding shows the stem and options as HTML,
    so code keeps its line breaks.
  - **Flags** (from csp-tools' `build_theory_test_review.py`): a distractor drew more students than
    the key; fewer than half correct; nobody missed it; a distractor nobody chose; every distractor
    drew exactly one student.
- **Free response tab:**
  - **View by question (default):** one picker sets the FRQ for every card; scrolling shows every
    student's answer to it.
  - **View by student:** each card stacks all of one student's FRQs.
  - **Card:** name, **Open attempt** link, state and write-back chips, the full answer, the
    Schoology rubric in a grid (`FrqRubricGrid`, §12) with the AI cell in fuchsia, and the comment
    (prefilled, editable) with **Accept** and **Save edit**.
  - **Filter:** to review, accepted, posted, failed.
  - **Command bar:** **Post accepted to Schoology (n)** (accepted or edited marks). While `quiz_writeback` is off, it shows
    "n waiting for the agent".
- **Quiz setup modal** (opened from the test page header, built like the rubric manager):
  - **Combine:** Prism suggests unaligned tests in the course with similar titles; the teacher
    ticks them; parity shows inline, and a mismatch lists the differing questions and disables
    **Combine**.
  - **Link:** the picker lists only aligned summatives in the course that are not linked yet.
- **Feature flags:** `quizzes` in `config.yaml` for the feature, `quiz_writeback` for posting.
- Each UI decision is added to `docs/design-language.md` as it is built.

## 9. Writing back to the attempt

Behind `quiz_writeback`, off until proven.

- **What is written:** the FRQ's rubric cells (the points follow) and the comment. MCQ points are
  never changed. Schoology's save posts the whole attempt form, so every other field is sent exactly as
  the page loaded it (decided by the teacher after the phase 4a probe, 2026-10-13).
- **The request is unknown.** A write probe, approved by the teacher, saves one mark in the browser
  on a throwaway copy of a test with one attempt, and captures the request. The candidates are the
  attempt form itself or the rubric popup's own save.
- **Before each write, Prism re-reads the attempt** and refuses if the Schoology cell or comment
  differs from the one it last saw, so a hand edit is never overwritten.
- **Every write is recorded** in `frq_marks`; a failure is reported per student and never thrown.
- **The agent fallback** (`list_frq_writebacks`, `mark_frq_writeback`) works from phase 2.

## 10. Phases

Each phase ships and is useful on its own.

1. **Read and stats:** tables, parsers, loader, parity, Quiz setup, Questions tab, the attempt
   link on cards, `list_quiz_groups`, `load_quiz_results`, `set_question_tags`.
1b. **Charts and tag text (agreed 2026-10-13):** the MCQ dot plot with a box toggle, the level bar
   in the summary and on FRQ rows, percent bars per tag, and tag texts shown on hover. Clicking a tag
   for course-wide results is issue #139 (built 17/10/2026: `TagResultsDrawer`, `GET /api/quizzes/tag-results`,
   `get_tag_results`).
2. **FRQ marking:** Free response tab, `get_frq_responses`, `write_frq_suggestions`, the agent
   write-back tools, and the `grade-theory-test` change.
3. **Overall:** `get_quiz_results`, `write_quiz_overall_suggestions`, the comment template.
4. **Prism write-back:** the write probe, then **Post accepted to Schoology**.

## 11. Testing

- **Parsers:** fixtures made from the probe pages with names and answers masked.
- **Server:** parity rules; link rules (unaligned to aligned only, same course, one each); stats
  (facility, distractors, tag rollup); the comment builder; the overall gate.
- **MCP:** a handler test per tool.
- **Client (React Testing Library):** the tabs, both FRQ views, accepting a suggestion, the
  disabled **Combine** on a parity mismatch.
- **Live parity probe:** `scripts/parity-quiz-results.js` compares Prism's MCQ counts for the Ep 1
  test with the review generator's output from the CSV exports.

## Out of scope for v1

- A view that compares sections.
- Reading `attempts_scoring` (latest attempt, with a warning, until then).
- A level-to-points map for FRQs without a Schoology rubric.
- Combining or linking through MCP.

## 12. Phase 2 design (agreed with the teacher, 2026-10-13)

Prism keeps a full copy of every answer and mark; nothing on a page or in a tool reads Schoology
live. The copy is refreshed by **Load results**, by `load_quiz_results`, and nightly (below).

### Marks and their states

- **No Prism mark yet:** the card shows the stored copy of Schoology's mark (`quiz_responses`) as the
  current mark, labelled "In Schoology". Nothing is written to `frq_marks` until an agent suggests or
  the teacher acts.
- **The suggestion layer works like assessment suggestions** (`server/services/suggestions.js`). A new
  `write_frq_suggestions` call replaces `suggested_*` and pushes the old suggestion onto
  `suggestion_history_json`; it never changes `final_*`. When the teacher has already accepted or edited
  the mark and the new suggestion differs, `suggestion_revised` is set and the card shows **Revised
  suggestion** until the teacher accepts it or keeps their own.
- **Teacher states:** `suggested` (no teacher action), `accepted` (final equals the suggestion), `edited`
  (the teacher changed the cell or the comment). A card started from Schoology's mark and then edited is
  `edited` with no suggestion.
- **Write-back states:** a mark whose final cells and comment differ from the stored Schoology copy is
  `pending`; `posted` and `failed` are recorded by an agent (`mark_frq_writeback`) or detected on load.
- **Detection on every load:** after the responses are stored, each `pending` or `failed` mark whose
  Schoology cell and comment now match its final cell and comment becomes `posted` (posted by an agent
  or pasted by hand, it makes no difference). A `posted` mark whose Schoology copy later differs from
  `posted_*` is flagged "Changed in Schoology" and is never overwritten.

### Posting until phase 4

Both routes, and the load detects either:
- **An agent** posts from `list_frq_writebacks` with a browser and records each with `mark_frq_writeback`.
- **The teacher** pastes by hand: the card has **Copy comment** and **Open attempt**.

### Nightly refresh

The scheduled sync reloads every quiz group that has been loaded at least once and that students sat
in the last 28 days (its latest attempt; before anyone has sat it, the day the group was made), after
the section sync, through the same saved browser session and the same read-only loader. The window
follows the attempts rather than `loaded_at`, because each nightly reload renews `loaded_at`. A failure
is logged in the sync run and never fails the sync.

### Shuffle guard

The probe of a test with shuffled options is skipped (no test of Graham's shuffles). Instead the
loader compares options and the key by their text as sets, and stores each chosen option under the
stored letter with the same text, so counts stay correct when a copy or attempt shows the options in
another order. Options whose texts differ as a set remain a "different answer options" warning.

### Student answer HTML

Answers are student-authored. The client renders `answer_html` only through DOMPurify (a client
dependency), allowing text formatting, lists, `pre`/`code` and line breaks, and nothing that runs or
loads. MCP tools return the answer as plain text with line breaks kept.

### MCP tools (phase 2)

| Tool | Does |
|---|---|
| `get_frq_responses(group, question?)` | Per student and FRQ: the answer as plain text, the Schoology rubric (rows, level names, points, descriptions), the stored Schoology mark (level per row, comment), any Prism mark (state, suggestion, final, write-back), and the attempt URL |
| `write_frq_suggestions(group, question, students[])` | Per student: `cells` as `{ row title or id: level name }` (Prism converts to points, as `write_student_suggestions` does), or `level` alone for a one-row rubric, or `points` for an FRQ without a rubric; and a `comment`. Reports unknown students, rows and levels per student |
| `list_frq_writebacks(group)` | Marks with write-back `pending` or `failed`: student, question number, attempt URL, level and points per row, comment |
| `mark_frq_writeback(group, student, question, status, error?)` | Records `posted` (copies final to `posted_*`) or `failed` |

### Free response tab

Shown when the group has an FRQ.
- **Command bar:** **By question** (default) or **By student**; in By question, one picker sets the FRQ
  for every card. Filter chips: To review, Accepted, Waiting to post, Posted, Failed, Changed in
  Schoology. While `quiz_writeback` is off, a note shows "n waiting for the agent".
- **Card:** name, **Open attempt**, state and write-back chips, the answer (sanitized), the Schoology
  rubric grid (`FrqRubricGrid`: rows by levels from the stored rubric, level colours by name), the
  comment, and **Accept**, **Save edit** and **Copy comment**.
- **Grid marks:** the final cell filled in its level colour, the AI cell with the fuchsia sparkle, and
  the stored Schoology cell with a small "S" corner mark. Clicking a cell sets the final cell.
- **Comment box:** prefilled from the final comment, else the suggestion, else Schoology's comment.
- **FRQ without a rubric:** a points field (0 to `max_points`) in place of the grid.

### The grade-theory-test skill

In `graham-plugins`, `assessment-grader:grade-theory-test` reads FRQs with `get_frq_responses` and
writes with `write_frq_suggestions` when Prism is reachable and the test is in a quiz group. The CSV
route stays as the fallback for when Prism is down; nothing in it is deleted.

### Testing (phase 2)

- **Server:** the suggestion layer (replace, history, revised flag, final untouched); state changes on
  accept and edit; posted detection and "changed in Schoology"; the shuffle guard; the nightly selection
  (28 days, failure isolated).
- **MCP:** a handler test per tool, including level-name conversion and the per-student error report.
- **Client:** both views, the picker, filters, accept, edit (cell and comment), copy, the revised tag,
  the no-rubric points field, and sanitizing (an answer's `<script>` and `onerror` are removed before
  it renders).
- **Schema test:** the table list gains `frq_marks`.

## 13. Phase 3 design (agreed with the teacher, 2026-10-13)

The overall result is an ordinary suggestion on the linked result task, so that task grades like every
other task in Prism. Prism builds its comment from the group's template and the stored data; the agent
writes only the levels and the impression.

### Phase 2 follow-ups first

- **`write_frq_suggestions`:** a number in `cells` fails that student only (`z.union([z.string(),
  z.number()])`; `resolveCells` refuses it).
- **`mark_frq_writeback`:** refuses a mark whose write-back is not `pending` or `failed`.
- **`sanitizeHtml.js`:** `ALLOW_DATA_ATTR: false` and `ALLOW_ARIA_ATTR: false`, so the comment is true.
- **Stem images:** a stem sanitizer (`sanitizeStemHtml`) keeps `img` with an `http(s)` `src` and `alt`,
  for the Free response tab.
- **Left in the hand-off list:** an ungraded FRQ without a rubric (a fix needs a live example to test against).

### Confirmed FRQ marks

For each student and FRQ, the mark the overall result uses:
- **Prism `accepted` or `edited`:** the final mark (source `prism`).
- **No Prism mark, Schoology marked:** the stored Schoology mark (source `schoology`).
- **Prism `suggested`:** not confirmed, "Q21 to review".
- **No mark anywhere:** not confirmed, "Q21 not marked".

A student is **ready** when every FRQ is confirmed. A group without an FRQ has every student ready.

### The comment template

- **Storage:** `quiz_groups.comment_template` (TEXT, null means the default), in `schema.sql` and
  `MIGRATIONS`.
- **Placeholders:** `{mcq_correct}`, `{mcq_total}`, `{mcq_percent}`, `{frq_levels}`, `{impression}`.
- **Default:** the §7 template. Its MCQ line appears only when the group has an MCQ, and its two
  free-response lines only when the group has an FRQ.
- **Building:** placeholders are replaced; a line whose placeholders all resolve to empty is dropped;
  blank lines at the start and end are removed.
- **`{frq_levels}`:** FRQs in question order, separated by commas.
  - **One-row rubric:** `Q21 Exhibiting`.
  - **Several rows:** `Q21 (Content: Exhibiting, Code: Developing)`.
  - **No rubric:** `Q21 3/4 points`.
- **Saving:** refused for an unknown placeholder or a template without `{impression}`. An empty template
  resets it to the default.
- **Editing:** a textarea in the Quiz setup modal, with the placeholders listed and **Reset to default**.

### Results service

`server/services/quizResults.js`, built only from Prism's stored copy. `quizResults(db, { groupId })`
returns:
- **Group:** id, title, the linked result task (id, Schoology id, title, aligned topics), the template in
  use and whether it is the default, `loaded_at`.
- **Per student with an attempt:** name, ids, attempt URL; MCQ correct, total and percent; per tag
  correct, total and percent (MCQs only, blanks counted as wrong); per FRQ the levels per row, points,
  source and confirmed flag; `ready` and the blocking reasons; and the overall suggestion if one exists
  (rubric levels, impression, suggestion state, `stale`).
- **Not taken:** students in the course without an attempt.

**Stale:** the suggestion stores `quiz_overall: { group_id, impression }` in `feedback_json`. It is stale
when building again from that impression, the current numbers and the current template gives a
comment different from the stored `narrative_feedback`.

### Writing the overall suggestion

`writeOverallSuggestions(db, { groupId, students })`, one entry per student: `student`,
`rubric_scores` (as in `write_student_suggestions`), `impression`, and optionally `reviewer_flags` and
`reviewer_flags_brief`.
- **Refused for the group:** no linked result task, or results never loaded.
- **Refused per student:** no attempt, or not ready (the reasons name each FRQ).
- **Otherwise:** `upsertStudentSuggestion` on the result task, with `narrative_feedback` set to the
  built comment and `quiz_overall` added to `feedback_json`. The suggestion history and the revised flag
  work as for any suggestion.

**Update numbers** (`rebuildOverallSuggestion`) writes the suggestion again with the stored impression,
levels and flags, so a teacher who already used the comment sees it as revised. It is refused for a
student who is no longer ready.

### MCP tools (phase 3)

| Tool | Does |
|---|---|
| `get_quiz_results(group)` | The results service output, with answers left out. The agent reads it before suggesting levels, then applies the course's cut-off guide |
| `write_quiz_overall_suggestions(group, students[])` | As above. Returns `{ written, results: [{ student, status: written\|error, message }] }` |

### REST

- `GET /api/quizzes/:id/results`: the results service output.
- `PUT /api/quizzes/:id/template`: `{ template }`, validated as above; returns the group.
- `POST /api/quizzes/:id/overall/:studentId/rebuild`: Update numbers.

### UI

- **Grading tab cards (result task):** the quiz line beside the attempt link, `MCQ 17/20 (85%), FRQ
  Q21: Exhibiting`, with "Q21: to review" for an unconfirmed FRQ.
- **Stale suggestion:** the card shows "Numbers changed" and **Update numbers**.
- **Quiz setup modal:** the template editor (above).

### The grade-theory-test skill

In `graham-plugins`, `assessment-grader:grade-theory-test` gains a Prism route for the overall result:
`get_quiz_results`, the cut-off guide, then `write_quiz_overall_suggestions`. The CSV route stays as the
fallback.

### Testing (phase 3)

- **Server:** confirmed marks (each source and state); per-tag percents; the builder (default by kind,
  dropped lines, multi-row and no-rubric levels); template validation; the write gate; stale detection;
  rebuild.
- **MCP:** a handler test per tool, including the per-student refusals.
- **Client:** the quiz line, Update numbers, the template editor (save, invalid placeholder, reset).
- **Follow-ups:** a test for each of the four fixes.
- **Live:** on the BK 6 group in a dev clone, write one overall suggestion and see it on the Grading tab.

## 14. Phase 4 design (agreed with the teacher, 2026-10-13)

Prism posts accepted FRQ marks to the student's attempt itself. The request is learned from one
supervised probe, then replayed. Everything here follows §9: re-read before each write, never overwrite a
hand edit, record every write, never change MCQ points.

### Known before the probe

The schoology plugin's `export-test-results` entered 15 FRQ marks on 12 October 2026 by driving the
attempt page: open the rubric popup from `.grading-rubric-grading-launch` (mousedown, mouseup and click),
choose the level by its label (`td.rating-wrapper` text `^\d\s*<Level>:`), the popup's Save
(`button.submit-btn`), the question's Add Comment, then the form's **Save Changes**, and read every one
back. So driving the page is proven; the requests it sends are not yet recorded.

### The probe

`scripts/probe-attempt-write.js`, run on the mini from the repo root with the saved Schoology session, on
one attempt of **AP CSP: Unit 3 - Organizing Data Theory Test (S)** (2024-25, archived course 830).
- **Stage A (read-only):** every non-GET request is aborted. It reports whether the attempt form is
  editable in the archived section, whether the FRQ has a Schoology rubric, and the stored cell and
  comment. It chooses an attempt whose FRQ is already marked.
- **Stage B (one same-value save):** only with `--write` and the teacher's approval of the attempt Stage A
  chose. It chooses the current level again by its label, saves the popup, leaves the comment text as it
  is, and presses **Save Changes**, recording every non-GET request (URL, header names, body) to a file
  outside the repo. It then reads the attempt back and confirms the cell, the comment and every other
  question's points are unchanged.
- **Accepted risk:** the values do not change, but Schoology may record a grading time or notify the
  former student.
- **Recorded:** the request shapes go in `.claude/schoology-api-reference.md` with the probe date, only as
  observed in the captured file.

If Stage A finds the archived form read-only, or no rubric FRQ, the probe moves to a current-year attempt
the teacher chooses, saving the mark that student should get anyway, with the teacher watching.

### Writing a mark

`server/services/quizWriteback.js`, through the saved browser session (the loader's), one mark at a time:
1. Re-read the attempt page. If Schoology's cell or comment differs from Prism's stored copy, refuse:
   the mark becomes `failed` with "Changed in Schoology since the last load".
2. Send the captured requests for the final cells and comment: the rubric cell as a JSON `PUT` to
   `rubric_grade_info` with Drupal's CSRF headers, then the attempt form `POST` (the form alone leaves the
   rubric grade unchanged; probe stage C and the round trip, 2026-10-13).
3. Read the attempt back. If it shows the final cells and comment, the mark is `posted` (the stored
   Schoology copy is updated from the read-back); otherwise `failed` with what it shows.

- **Scope:** FRQs with a Schoology rubric. A points-only FRQ stays with the agent or the teacher's paste.
- **Never changed:** MCQ points, and any field other than the FRQ's level, points and comment. The
  probe showed that **Save Changes** posts the whole form (every question's points included), so the
  writer serializes the freshly loaded form, changes only those fields, and refuses if any other field
  it would send differs from the loaded page (`.claude/schoology-api-reference.md`, "Saving an FRQ level
  and comment").
- **Errors:** an expired session stops the batch (`NO_SESSION`); any other failure is recorded for that
  student and never thrown. Requests are sent one after another with a short pause, like the loader.
  A request that fails outright (HTTP 0, for example a sign-in redirect the browser blocks) opens
  Schoology's home again: a sign-in page stops the batch with `NO_SESSION`, no page with `UNREACHABLE`
  (2026-10-14; the loader does the same).
- **One lock per quiz group:** a load, a publish and `mark_frq_writeback` never run at once on the same
  group (`BUSY`), per process.
- **Guard:** the loader's read-only guard stays; the writer allows only the URL patterns the probe
  recorded.

### Posting in the UI

Only while `quiz_writeback` is on. The flag ships off; the teacher turns it on after the first real post
looks right in Schoology.
- **Publish all to Schoology (n)** on the Free response tab publishes every accepted or edited mark on
  every FRQ of the quiz (both copies) in one click, each read back, with a line per student: Published,
  Failed with the reason, or Skipped. A mark that fails stays waiting, and the button returns for it. (The
  first version posted one student first; the teacher dropped that step on 2026-10-13, because every write
  is read back and feedback is usually hidden from students until the teacher releases it.)
- The overall result is not part of it: the Result task publishes from the Grading tab as before.
- The cards update from the read-back; a failed mark shows its error and stays in "Failed".

The agent tools (`list_frq_writebacks`, `mark_frq_writeback`) stay as they are. No new MCP tool.

### Testing (phase 4)

- **Server:** the writer with a fake page (as `fakeSchoologyPage.js`): conflict refusal, posted from the
  read-back, failed on a mismatched read-back, the batch stops on `NO_SESSION`, and only the recorded URL
  patterns are sent.
- **Client:** the two-step post, the result lines, the flag off.
- **Live:** the first real post of a current mark, with the teacher checking it in Schoology.

## 15. Posting by question (agreed with the teacher, 2026-10-13)

The teacher asked whether Schoology's grade-by-question page is quicker. A read-only spike and a supervised
same-value save (stage D) showed that the FRQ's by-question page holds one form for the whole class and
that one form POST saves it (`.claude/schoology-api-reference.md`, "Grade by question" and "Stage D"). The
writer moves to that page; everything in §9 and §14 about safety stays.

### What changes

- **One page per question and member test.** The writer groups the marks to post by member test and
  question. For each group it reads the copy's question list (`assessment_questions`, for the copy's own
  question number), the `question_stats` index (for the page link), and the question's page.
- **Checks before any write, per student:** the page's rubric entry for the attempt names the copy's
  question id and Prism's stored rubric id; the student's points, comment and rubric grade are as Prism
  last saw them (else "Changed in Schoology since the last load"). The question's points must equal the
  rubric's top level.
- **The rubric cell:** the same per-student `rubric_grade_info` PUT as §14, each re-read before the form.
- **The rubric PUT usually completes the mark.** The by-question round trip (2026-10-13) showed that for
  an essay already marked, the PUT also saves the points, the rubric score and the comment. After the PUTs
  the writer reads the page again: a student whose four fields now equal Prism's mark is done; only the
  others go into the form save.
- **A hand edit made meanwhile is never sent back:** in that fresh read, any difference other than the
  posted students' fields reaching Prism's values refuses the page.
- **One form POST**, only when a student still needs it (for example an essay never marked, not yet
  observed): the fresh form, with only those students' `rubric_score`, `points`, `override` and
  `comment` changed. The form holds only this question's fields, so MCQ points stay out of the request.
- **Read-back:** the page once, and each posted student's rubric grade. Any other field that changed (another
  student, another field) stops the batch (`UNSAFE`).
- **All at once:** the button publishes every waiting mark (§14). The route keeps `limit: 1` for agents.
- **Half-written:** a student whose rubric was saved but whose form save failed is recorded as before
  ("The rubric level was saved in Schoology but the form was not: post it again").

### Effect

For a class of 20 on one FRQ, essays already marked: 2 page loads and, per student, a grade read, the
rubric save and its check; no form save. Phase 4b needed 40 attempt page loads and 20 form saves.

### Testing

- **Server:** the writer against a fake by-question page (grouping by copy and question, the copy's own
  question number, checks per student, one POST changing only the posted students, read-back, half-written,
  `UNSAFE`, one first).
- **Live:** with the teacher's approval, a round trip on the 2024-25 test through Prism (one student changed
  and restored), read back field by field.

