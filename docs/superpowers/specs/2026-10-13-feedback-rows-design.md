# Feedback rows on unaligned tasks

Status: **design agreed with the teacher (2026-10-13); built on main (2026-10-13).**

## Goal

A formative task on the General Academic Scale (Unaligned) has one overall level and no
measurement topics. Prism grades it as a score scale (`config.yaml` `grading.scoreScales`, #41).
The teacher marks these tasks against a full multi-row rubric, usually the summative's rubric.
Prism should:

1. **Carry the rubric as feedback rows:** an attached rubric's criteria, marked in the usual
   rubric grid, stored in Prism only.
2. **Publish only the overall level:** Schoology receives the scale level and the comment through
   the existing publish path, as now. Row levels never reach Schoology.
3. **Stage the rubric average as the overall level,** which the teacher can replace with one click.
4. **Expose the rows to agents:** `get_assignment_context` returns the rows, the teacher's row
   finals and the AI row suggestions, separately.

The first use is MGD, section `8458134323`: Sprite Invaders (F), assignment `8532617388`, and
Flappy Bird (F), assignment `8590105935`. Both were ungraded on 13 October 2026, so nothing needs
a backfill.

## Decisions (teacher, 2026-10-13)

- **Overall level from the rows.** When every row is marked, Prism stages the average of the row
  levels as the overall level. The average uses the scale's points (ED 100, EX 75, D 50, EM 25)
  and reads the level from the scale's own cutoffs (`levelForScore`). The cutoffs are the
  midpoints, so the result is the nearest level and a tie rounds up: EX, EX, D, D averages 62.5,
  which is Exhibiting.
- **Insufficient Evidence stops the average.** If any row is IE, Prism stages no overall level and
  the teacher chooses it. IE means the evidence is missing, not that it is low.
- **One click replaces the average.** A hint under the overall picker reads "Average of the rubric
  rows: Exhibiting". When the teacher picks another level, the hint becomes the button "Use the
  rubric average (Exhibiting)". There is no separate override badge.
- **An agent's overall level is optional.** A grading agent sends row levels in `rubric_scores`. It
  sends `scale_level` only when its judgment differs from the average, or when a row is IE.
- **Separate fields in the MCP.** Rows are returned in their own fields. `topics` and
  `current_scores` stay empty, so an unaligned task never looks aligned.
- **Student history includes row finals,** in full detail only.

## Approach

Rubric criteria become feedback rows, and a new Prism-only table holds the row finals. The
alternatives were rejected:

- **Synthetic measurement topics:** Send all would post fake topic ids to Schoology's observations
  endpoint, and the mastery sync owns those tables.
- **A JSON column on `grades`:** `grades` mirrors Schoology, and per-row reads for history become
  awkward.

## 1. Data model

**Which tasks have feedback rows.** A rubric attached to a score-scale task (no aligned topics and
a configured scale, as `scoreScaleFor` decides) is read as feedback rows. `rubric_attachments` is
unchanged and has no mode column. Every criterion is a row, in rubric order (`position`).
`rubric_attachment_topics` stays empty for these tasks.

**Row finals.** A new table in `server/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS rubric_row_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_schoology_id TEXT NOT NULL,
  student_uid TEXT NOT NULL,
  criterion_name TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('ED','EX','D','EM','IE')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (assignment_schoology_id, student_uid, criterion_name)
);
```

- It is keyed like `mastery_scores`, but by criterion name: `write_rubric` with `update` deletes
  and re-inserts criteria, so criterion ids are not stable.
- No Schoology sync reads or writes it.
- `schema.sql` runs with `CREATE TABLE IF NOT EXISTS` on every `getDb()`, so an existing database
  gains the table without a `MIGRATIONS` entry. A test confirms this on a database created before
  the change.

**Staged picks (the card's draft).** In `assessment_drafts.draft_json.pending`:

- A row pick is stored under `row:<criterion name>`.
- The overall pick stays under `__scale__`. It is stored only when the teacher clicks a level or
  accepts an agent's level.
- The rubric average is never stored. Prism computes it from the rows each time.
- Save sends the teacher's pick, or the average when there is no pick.

**Rubric replaced after marking.** `attach_rubric` still replaces the attachment. Row finals whose
names are missing from the new rubric stay in the table, hidden. The reply counts them in
`hidden_row_levels`.

## 2. The rubric average

One rule, in two copies, because the client cannot import server code:
`server/lib/rubricAverage.js` and `client/src/lib/rubricAverage.js`.

`rubricAverage(scale, rowLevels, rowNames)` returns:

- `{ level }` when every row has a level and none is IE: the mean of the levels' points, read
  with `levelForScore`.
- `{ level: null, reason: 'insufficient_evidence' }` when any row is IE.
- `{ level: null, reason: 'incomplete' }` when a row has no level.

One table of test cases runs against both copies, so they cannot drift.

## 3. MCP tools

**`attach_rubric`**

- Accepts a Schoology or a local assignment id, as the other tools do. Today it accepts only the
  local id.
- On a score-scale task it attaches the rubric as feedback rows and returns
  `{ attached_to, rubric, mode: 'feedback_rows', score_scale, rows: [criterion names],
  hidden_row_levels }`. There is no `unmatched_criteria`.
- On every other task (aligned, or with no configured scale) it behaves as now.
- The HTTP route (`POST /api/rubrics/attach`) uses the same service function.

**`write_student_suggestions`**

- On a task with feedback rows, a `rubric_scores` key matches a row's criterion name, then its
  standard text, ignoring case. Prism stores the level under the exact criterion name.
- An unknown key is returned in `unresolved_rows`, and the message lists the valid row names.
- `scale_level` stays optional and is stored as now.
- On a score-scale task with no rubric, `rubric_scores` are unresolved as now, and the message
  states that a rubric must be attached first.

**`get_assignment_context`** on a task with feedback rows:

```
"score_scale": { "name": "General Academic Scale (Unaligned)", "levels": [...] },
"rubric": { "name": "MGD Flappy Bird Rubric 2026-27",
  "rows": [ { "criterion": "Features and Code",
              "standard": "Anchor Standard 5: ...",
              "category": "PRODUCE",
              "descriptors": { "ED": "...", "EX": "...", "D": "...", "EM": "...", "IE": "..." } } ] },
"topics": [],
students[i]: {
  "current_scale_level": "EX",
  "current_row_levels": { "Features and Code": "EX", ... },
  "current_scores": {},
  "grade_comment": "...", "display_to_student": true,
  "existing_suggestion": { "scale_level": null, "evidence": null,
                           "rubric_scores": { "Features and Code": "ED", ... }, ... },
  "draft_feedback": { "row_levels": { ... }, "scale_level": "EX",
                      "scale_level_source": "teacher" | "rubric_average", ... } }
```

- `current_row_levels` holds the teacher's finals only, for the rows of the attached rubric.
- `rubric` is null on a score-scale task with no rubric, and absent on an aligned task.
- Fix: `draft_feedback.rubric_scores` no longer contains the card's internal `__scale__` key, or
  any `row:` key.

**`list_assignments`** gains `feedback_rubric` (the attached rubric's name, or null) for
score-scale tasks.

**Descriptions and grading guidance** in `mcp/server.js` describe the rows: send row levels in
`rubric_scores` keyed by criterion name, and add `scale_level` only when it differs from the
average or a row is IE.

## 4. The grading card

On a score-scale task with feedback rows (`AssessmentSummaryPage.jsx`, `StudentRubricCard`):

- **The rubric grid first,** in the same look as an aligned task: the Descriptors and Compact
  views, the final, staged and suggested cell states, and the class distribution per row.
- **A label above the grid:** "Feedback rows: kept in Prism, not sent to Schoology".
- **The overall picker under the grid** (`ScaleLevelPicker`), labelled "Overall: General Academic
  Scale (Unaligned), sent to Schoology".
- **The average** uses each row's staged level, or its final level when nothing is staged:

| State | Overall picker | Hint |
|---|---|---|
| Nothing published; all rows marked, no IE, no pick | average staged (dashed) | "Average of the rubric rows: Exhibiting" |
| The teacher picked another level | the pick staged | button "Use the rubric average (Exhibiting)" |
| A row is IE, no pick | nothing staged | "A row is Insufficient Evidence: choose the overall level" |
| An overall level is published | published level | the button, only when the average differs |

Prism stages the average by itself only while the student has no published overall level. After
that, a change to the rows shows the button, so a published level is never replaced without a click.

- **Accept all suggestions** stages the AI row levels, and the agent's `scale_level` when it sent
  one, as a pick.
- **Manage rubrics:** attaching works from the modal. The Map criteria tab is disabled on these
  tasks, with the note "On an unaligned task, every criterion is a feedback row".
- **Design log:** the grid-plus-overall layout and the average hint are recorded in
  `docs/design-language.md`.

## 5. Publish path

**Save (one card)**

- If the overall level, the comment or the visibility changed, Prism makes the existing
  `POST /api/mastery/:courseId/write-comment` call, with the level's points as now. The body also
  carries `rowLevels: { criterion: level }`. The route writes `rubric_row_levels` only after
  `putSucceeded` confirms the Schoology write.
- If only row levels changed, a new Prism-only route,
  `PUT /api/rubrics/row-levels/:assignmentSchoologyId/:studentUid`, saves them. Schoology is never
  called.
- After either, the card clears its staged rows and the draft, as it does after a topic save.

**Send all** (`POST /api/mastery/:courseId/send-all`) works the same way per student:
`buildSendEntry` adds `rowLevels`, the route writes them after the Schoology write succeeds, and an
entry with only row changes makes no Schoology call.

Row levels are validated on the server: a known row name for the attached rubric and a level in
ED to IE, or the whole request is refused before any Schoology call.

## 6. Student history

In `server/services/studentHistory.js`:

- A formative with row finals gets `rubric_rows: [{ criterion, level }]`, in the attached rubric's
  order, with any rows no longer in the rubric after them.
- `detail: 'compact'` leaves `rubric_rows` out.
- With `include_teacher_drafts`, `teacher_draft` separates `row_levels` and `scale_level` from
  `topic_levels`. Today the `row:` and `__scale__` keys would appear in `topic_levels`.
- AI suggestions are never included, as now.

## 7. Tests (vitest)

- **Database:** the table, its unique key and level check; the table appears in a database created
  before the change.
- **Average:** one shared case table for both copies.
- **Services:** feedback-row attach and `hidden_row_levels`; row-key resolution in suggestions;
  the context shape (rubric, finals, suggestions, draft, `scale_level_source`); history.
- **Routes:** rows written only after a successful Schoology write; nothing written on a failed
  one; the rows-only route making no Schoology call; Send all; invalid row names refused.
- **MCP handlers:** the Schoology-id fix in `attach_rubric`; the `__scale__` fix.
- **Client (React Testing Library):** the grid on an unaligned task, the average hint, the reset
  button, the IE message, and Save sending `rowLevels`.

## 8. Docs and delivery

- `CONTEXT.md` gains the term **feedback rows**.
- `.claude/build-progress.md` and `docs/design-language.md` record the work.
- Built on a branch, merged to `main` and pushed. CI then deploys prod.

## 9. First real use (after the deploy, Prism only)

1. Import the Flappy Bird rubric from
   `Courses/Mobile Game Development/Projects/MGD Project Rubrics 2026-27/MGD Flappy Bird Rubric 2026-27.csv`
   with `write_rubric`.
2. Import the Sprite Invaders rubric from the sheet "Basic Project For Slides" in
   `Project Rubrics 2024-25.xlsx`. The sheet has no IE column, so IE takes the standard text.
3. Attach each to its task with `attach_rubric`, and show the teacher the context for one student.

Nothing is written to Schoology.

## 10. assessment-grader follow-up

Once this is on prod, `deliver-rubric-image` and the Prism write in `shared/orchestration.md`
need a small update. The exact change is reported to the teacher when the Prism work is done.
graham-plugins is edited only if the teacher asks.
