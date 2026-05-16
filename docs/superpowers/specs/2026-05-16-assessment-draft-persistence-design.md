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
{ "pending": { "<topicId>": "ED" }, "comment": "…", "display": true, "base": "…" }
```

`autoFlipArmed` is **not** persisted. A restored draft means the teacher has
already interacted with the card, so on restore `autoFlipArmed` is set to
`false` (its disarmed state).

`base` is a deterministic signature of the synced Schoology values the draft
was diffed against — see *Staleness* below.

### Write

A `useEffect` in `StudentRubricCard` watches `pending`, `comment`, and
`display`:

- `hasPendingChanges` true → write the draft to the card's key.
- `hasPendingChanges` false → remove the key.

localStorage writes are synchronous and the payloads are tiny, so writes happen
on every change with no debounce.

### Restore

The card's `useState` initializers read the key on mount. A stored draft is
restored **only if it is not stale** (see *Staleness* below); a stale draft is
discarded and its key removed. When a draft is restored:

- `pending` ← stored `pending`, else `{}`
- `comment` ← stored `comment`, else `student.grade_comment || ''`
- `display` ← stored `display`, else `loadedDisplay`
- `autoFlipArmed` ← `false` if a draft was restored, else the existing
  expression `student.comment_status !== 1 && !student.grade_comment`

Restore is silent — no badge or banner. The card simply shows the teacher's
work as they left it.

### Staleness — Schoology is the source of truth

A draft is unsaved Prism-side intent. If the underlying Schoology data changes
underneath it — e.g. the teacher publishes feedback directly in Schoology, then
hits "Refresh from Schoology" in Prism — the draft is stale: it was diffed
against data that no longer exists. Showing it would override the freshly
synced source of truth.

To detect this, each draft stores a `base` signature: a deterministic string
built from the synced Schoology values the card was rendered against —
`grade_comment`, `comment_status`, `exception`, and the per-topic `scores`
grades. `base` is computed by `draftBaseline(student, topics)` in
`assessmentDraft.js`.

On mount, the card recomputes `draftBaseline` from the current (just-synced)
props and compares it to the restored draft's `base`:

- **Match** → the synced data is unchanged; the draft is the teacher's live
  work — restore it.
- **Mismatch** → Schoology changed underneath the draft; the draft is stale —
  discard it (remove the key) and fall back to the synced values.

This check runs on every mount, so it covers all reload paths uniformly: a
plain browser refresh, navigation, and the in-app "Refresh from Schoology"
button alike.

### Clearing the draft

- **On save success:** `handleSave` explicitly calls `removeItem(key)`. The
  post-save `load()` sets page-level `loading` true, which unmounts every card;
  removal therefore cannot be left to the write effect and must be explicit.
- **On discard:** "Discard Changes" resets card state to baseline, which makes
  `hasPendingChanges` false; the write effect then removes the key. No unmount
  happens here, so the effect is sufficient.
- **On "Refresh from Schoology":** the cards re-mount and re-evaluate. A draft
  survives the refresh *only if* Schoology's data for that student is unchanged
  (the *Staleness* check passes). If the synced data changed, the draft is
  discarded and the synced Schoology values — the source of truth — win.

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
- "Refresh from Schoology" with an unsaved draft, when Schoology's data for
  that student is unchanged → draft survives.
- "Refresh from Schoology" after the same student's comment/score changed in
  Schoology → draft is discarded; the card shows the synced Schoology values.
- Two students with independent drafts → each restores independently.
- A rubric-locked card (exception active) → comment/display draft still
  persists and restores.
