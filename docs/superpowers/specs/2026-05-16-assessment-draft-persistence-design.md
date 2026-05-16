# Persist unsaved /assessment/ drafts across page reloads

GitHub issue: [#47](https://github.com/ganolan/prism/issues/47)

## Problem

The `/assessment/` page renders one [`StudentRubricCard`](../../../client/src/pages/AssessmentSummaryPage.jsx)
per student. Each card holds the teacher's in-progress, unsaved grading work
entirely in React `useState`:

- `pending` — rubric proficiency selections not yet written to Schoology
- `comment` — edited overall-comment text
- `display` — the display-to-student toggle

A browser refresh or navigation away re-mounts the component and resets all of
this to the last-synced values. Nothing is lost on the Schoology side, but the
teacher's unsaved grading is — they have to redo it. For a teacher part-way
through grading a class set, this is a real data-loss bug.

## Scope

In scope: persist the three unsaved fields so a reload restores them.

Out of scope (filed as separate enhancement issues):

- Sending the Schoology PUT without the post-save page reload.
- A bulk "send all grades" button.

## Design

### Storage mechanism

Drafts are stored in browser **localStorage**. Prism is a local-first,
single-teacher app, so localStorage keeps the data on the teacher's machine
with zero server changes — no schema migration, no API routes, no load-time
merge logic. The accepted limitation: a draft does not follow the teacher to a
different browser or device.

### Storage key

One key per card:

```
prism:assessment-draft:{courseId}:{assignmentId}:{enrollmentId}
```

Per-card keys keep each `StudentRubricCard` self-contained — a card reads and
writes only its own key, with no cross-card coordination. This matches the
existing component isolation.

### What is persisted

When a card has unsaved changes (`hasPendingChanges` is true), the stored value
is:

```json
{ "pending": { "<topicId>": "ED" }, "comment": "…", "display": true }
```

`autoFlipArmed` is **not** persisted. A restored draft means the teacher has
already interacted with the card, so on restore `autoFlipArmed` is set to
`false` (its disarmed state).

### Write

A `useEffect` in `StudentRubricCard` watches `pending`, `comment`, and
`display`:

- `hasPendingChanges` true → write the draft to the card's key.
- `hasPendingChanges` false → remove the key.

localStorage writes are synchronous and the payloads are tiny, so writes happen
on every change with no debounce.

### Restore

The card's `useState` initializers read the key on mount:

- `pending` ← stored `pending`, else `{}`
- `comment` ← stored `comment`, else `student.grade_comment || ''`
- `display` ← stored `display`, else `loadedDisplay`
- `autoFlipArmed` ← `false` if a draft was restored, else the existing
  expression `student.comment_status !== 1 && !student.grade_comment`

Restore is silent — no badge or banner. The card simply shows the teacher's
work as they left it.

### Clearing the draft

- **On save success:** `handleSave` explicitly calls `removeItem(key)`. The
  post-save `load()` sets page-level `loading` true, which unmounts every card;
  removal therefore cannot be left to the write effect and must be explicit.
- **On discard:** "Discard Changes" resets card state to baseline, which makes
  `hasPendingChanges` false; the write effect then removes the key. No unmount
  happens here, so the effect is sufficient.
- **On "Refresh from Schoology":** the draft is deliberately kept. Surviving a
  refresh is exactly the behaviour this issue asks for; the cards re-mount and
  restore from localStorage.

### Robustness

All localStorage reads and writes are wrapped in `try/catch`. If localStorage
is unavailable (private-mode disable, quota exceeded), the card degrades to
today's behaviour — no persistence — rather than throwing and breaking the
page.

## Testing

- Make rubric selections, edit a comment, toggle display; reload the page →
  all three are restored.
- Save to Schoology → draft cleared; reload shows the synced values, no draft.
- Discard changes → draft cleared; reload shows synced values.
- "Refresh from Schoology" with an unsaved draft → draft survives.
- Two students with independent drafts → each restores independently.
- A rubric-locked card (exception active) → comment/display draft still
  persists and restores.
