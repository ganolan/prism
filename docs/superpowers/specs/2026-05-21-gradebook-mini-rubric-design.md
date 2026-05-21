# Design: Mini rubric on the course gradebook for summatives

- **Issue:** #32 (Wave 4 — Course gradebook)
- **Date:** 2026-05-21
- **Status:** Approved for implementation
- **Follow-up split out:** #57 (submission status + flags on the modal card)

## Goal

On the course gradebook (`/course/:id`, Gradebook tab), each cell for an
**aligned summative assessment** currently shows a raw numeric score. Replace
that with a small color-coded view of the student's per-measurement-topic
proficiency, so a teacher can judge performance at a glance. Clicking the cell
opens a modal with the full rubric grid and the overall comment — the same
rubric + comment shown for aligned summatives on the `/student/` page.

Formative cells are unchanged.

## User decisions (from brainstorm)

- **In-cell view:** a **segmented strip** — a single horizontal bar split into
  one segment per aligned measurement topic, each segment colored by the
  student's earned level. Chosen because it scales cleanly when an assessment
  has many topics.
- **Ungraded topics:** render the strip with **grey/empty segments** for topics
  the student has not been scored on (one segment per aligned topic regardless
  of grading state) so the column stays visually consistent and conveys how
  many topics the assessment covers.
- **Modal:** reuses the **same `CompactRubric` component** as the `/student/`
  page (extracted to a shared component so both stay in sync), plus the overall
  comment and a small header.
- **Flags on the modal card** (Missing/Draft/Late, review/resubmit flags) are
  **out of scope** — tracked as issue #57.

## Data approach

CoursePage already fetches course mastery data via `getMasteryForCourse` →
`GET /api/mastery/:courseId`. That payload (`{ categories, topics, scores,
rollups }`) is **reused** — no new endpoint, no extra request.

Gap: the payload does not include **alignments** (which measurement topics each
assignment assesses). The ungraded-strip requirement needs the full aligned
topic set for an assignment even when no student has been scored yet.

### Server change

Extend the `GET /api/mastery/:courseId` route handler in
`server/routes/mastery.js` to also return `alignments` — mirroring how
`rollups` is already attached in that handler. Query:

```sql
SELECT ma.assignment_schoology_id, ma.topic_id,
       mt.title              AS topic_title,
       mt.external_id        AS topic_external_id,
       mt.category_id        AS category_id,
       rc.title              AS category_title,
       rc.external_id        AS category_external_id
FROM mastery_alignments ma
JOIN measurement_topics  mt ON mt.id = ma.topic_id
JOIN reporting_categories rc ON rc.id = mt.category_id
JOIN assignments a ON a.schoology_assignment_id = ma.assignment_schoology_id
WHERE ma.course_id = ? AND a.published = 1
```

Response becomes `{ categories, topics, scores, rollups, alignments }`. This is
additive — existing consumers (RosterView) ignore the new field.

**Fallback:** if `alignments` is empty for an assignment (alignments table not
yet synced), the client derives that assignment's topic set from the union of
topics that have a `scores` row for it. Topic metadata for score-only topics
comes from the existing `topics` + `categories` arrays.

## Client components & files

### `client/src/components/CompactRubric.jsx` (new — extraction)

Move the existing `CompactRubric` component out of `StudentPage.jsx` into its
own file and `export` it. `StudentPage.jsx` imports it from the new location;
the modal imports the same component. No behavior change to `CompactRubric`
itself — pure extraction so the two call sites stay in sync.

`CompactRubric` props (unchanged): `topics` — array of
`{ topic_id, title, external_id, category_title, grade }`.

### `client/src/lib/gradebookMastery.js` (new — pure logic, TDD'd)

Two pure functions, unit-tested before implementation:

- `indexMastery(mastery)` → builds, from the `/api/mastery/:courseId` payload:
  - `topicMeta`: `{ [topicId]: { title, external_id, category_title } }` —
    merged from `alignments` rows and `topics` + `categories`.
  - `topicsByAssignment`: `{ [assignmentSchoologyId]: [topicId, …] }` — the
    aligned topic set per assignment, taken from `alignments`; falls back to the
    union of score-bearing topics for that assignment when no alignment rows
    exist. Topic ids ordered by `(category external_id, topic external_id)`.
  - `gradeLookup`: `{ [studentUid]: { [assignmentSchoologyId]: { [topicId]:
    grade } } }` from `scores` (`grade` is the letter code ED/EX/D/EM/IE).
- `buildAssignmentRubric(assignmentSchoologyId, studentUid, indexed)` → ordered
  `[{ topic_id, title, external_id, category_title, grade }]` for one cell.
  `grade` is `null` for topics the student has no score on.

### `MiniRubricStrip` (new — local component in `CoursePage.jsx`)

Presentational. Given the ordered topic+grade list, renders a fixed-width
horizontal bar (`display:flex`) with one equal-width segment per topic.
Segment background = the level's color from the shared rubric palette
(`LEVEL_COLORS`); `var(--bg-subtle)` for `grade === null`. The whole strip is a
button-like clickable element (`cursor:pointer`, keyboard accessible) with a
`title` summarising topic→level. Renders nothing meaningful for an empty topic
list (caller handles fallback).

### `RubricModal` (new — local component in `CoursePage.jsx`)

Modal overlay (same pattern as `OverridePopup` / `LetterGradePopup`):

- Header: student display name, assignment title, summative `S` badge, close ✕.
- Body: `<CompactRubric topics={…} />` then a comment block (label "Comment:" +
  text) — the comment block is omitted when there is no comment.
- Footer: "Open full grading page →" link to
  `/course/:courseId/assessment/:schoologyAssignmentId`.
- Closes on overlay click and ✕.

## Cell behavior (GradebookView)

`GradebookView` receives the course `mastery` object as a new prop (CoursePage
already holds it in state). It computes `indexMastery(mastery)` once.

Per data cell, for **aligned** assignments only (`a.aligned` truthy):

1. Exception set (Excused / Incomplete / Missing) → render today's exception
   badge, **no strip** (Schoology deletes scores while an exception is active).
2. Otherwise, `buildAssignmentRubric(...)` for `(assignment, studentUid)`:
   - Non-empty topic list → render `MiniRubricStrip`; click opens `RubricModal`.
   - Empty topic list (no alignments, no scores — `mastery` unavailable or not
     synced) → fall back to the current numeric `gradeLabel` rendering so the
     cell never breaks.
3. Submission-status badges (Missing/Not-Started/etc.) and resubmit styling
   continue to render as today, alongside the strip.

Non-aligned (formative) assignments: unchanged — numeric / scale label as now.

`studentUid` mapping: `mastery.scores` is keyed by `student_uid`
(`schoology_uid`); gradebook `students` rows carry `schoology_uid`.

## Data flow

```
CoursePage  ──getMasteryForCourse()──▶ mastery state (now includes alignments)
   │
   └─▶ GradebookView(data=gradebook, mastery, courseId)
          │  indexMastery(mastery)  ── once
          │
          └─ per aligned cell ─▶ buildAssignmentRubric() ─▶ MiniRubricStrip
                                                  │ onClick
                                                  └─▶ RubricModal ─▶ CompactRubric + comment
```

## Testing

- **Unit (`gradebookMastery.test.js`)** — TDD, written first:
  - `indexMastery`: builds topic metadata from alignments; merges score-only
    topic metadata from `topics`/`categories`; `topicsByAssignment` ordering;
    score-union fallback when alignments absent.
  - `buildAssignmentRubric`: ordered topics; `grade` null for ungraded topics;
    a student with no scores yields all-null grades; unknown assignment yields
    an empty list.
- **Manual browser check** — strip renders for summative cells with correct
  colors; grey segments for ungraded; modal opens with the rubric + comment and
  matches the `/student/` page look; exception cells show the badge, no strip;
  formative cells unchanged; a course with no mastery data falls back to numeric
  cells without error.
- Confirm the existing `StudentPage` rubric still renders after the
  `CompactRubric` extraction.

## Out of scope

- Submission-status badges and review/resubmit flags on the modal card — #57.
- Comment indicator + instant hover overlay on cells — #36 (separate issue,
  implemented next; touches the same cell rendering).
- Any change to formative cell rendering.
- Any change to how mastery data is synced from Schoology.
