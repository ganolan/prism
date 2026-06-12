# Assessment draft feedback → DB (MCP-readable, autosaved) + draft cell colour fix

**Date:** 2026-06-12
**Status:** Approved design, pending implementation plan

## Problem

Draft teacher feedback on the `/assessment/` page — selected proficiency levels not yet
uploaded to Schoology, the typed comment, and the display-to-student toggle — lives in
browser `localStorage` (`client/src/lib/assessmentDraft.js`, keyed
`prism:assessment-draft:{courseId}:{assignmentId}:{enrollmentId}`). Two consequences:

1. **Invisible to agents.** The Prism MCP reads the SQLite DB; `localStorage` is per-browser
   and unreachable, so an agent grading an assignment cannot see the teacher's in-progress work.
2. **Not durable across devices.** A draft only exists in the browser that created it.

Separately, a recent "colour consistency" change left `RubricDescriptorGrid` filling
selected-but-unsaved (draft) proficiency cells with `var(--bg-subtle)` (a grey that reads as
the same neutral as the AI suggestion wash) instead of a pale tint of the level's own colour.

## Goals

- Persist draft feedback to the SQLite DB so the MCP can read it.
- Autosave on every proficiency selection and on typing, with **no perceptible delay or
  responsiveness degradation** in the UI.
- Surface the teacher's draft to MCP agents.
- Restore the draft cell background to a lighter shade of the level's final colour.

## Non-goals

- Changing the draft *shape* (`{ pending, comment, display, displayTouched, base }`) — stored verbatim.
- Reworking the stale-draft detection (#47) `base`-signature logic — preserved as-is.
- Schoology write-back changes — the publish path is untouched.
- A configurable app-wide locale / date refactor — out of scope.

## Decisions (resolved during brainstorming)

- **Persistence model: DB only + smart flush.** React state stays the single UI source of
  truth (instant). `localStorage` is removed. Saves are async/debounced and flushed on unload.
  Accepted edge case: a hard crash mid-debounce can lose the last ~500ms of typing.
- **MCP exposure: fold into `get_assignment_context`.** Add a `draft_feedback` field per student
  alongside the existing AI `existing_suggestion`, so an agent sees the draft in the call it
  already makes — no new tool, no extra round-trip.
- **Keying:** one row per `(assignment_id, student_id)` (local ids), matching `feedback` /
  suggestions, so the MCP join is identical to `getExistingSuggestions`.
- **Colour fix scope:** change the draft cell **background** only (the user's complaint). The
  dashed border stays `finalBorder` as today — not widened to also swap in `draftBorder`.

## Architecture

### 1. Schema — new table `assessment_drafts`

Added to `server/db/schema.sql`. `migrate()` runs `schema.sql` via `database.exec()` on every
boot, so `CREATE TABLE IF NOT EXISTS` auto-creates it — **no `MIGRATIONS` array entry** (that
array is for `ALTER TABLE`s).

```sql
CREATE TABLE IF NOT EXISTS assessment_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id    INTEGER NOT NULL REFERENCES students(id),
  enrollment_id INTEGER,
  draft_json    TEXT NOT NULL,            -- { pending, comment, display, displayTouched, base }
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_assessment_drafts_assignment ON assessment_drafts(assignment_id);
```

`enrollment_id` is stored so the GET response can be keyed by enrollment (the card's identity)
without a re-join. `draft_json` holds the existing draft object unchanged.

### 2. Express routes — `server/routes/assessment-drafts.js`

Registered in `server/index.js` as `app.use('/api/assessment-drafts', assessmentDraftsRouter)`.
Imports `getDb`. Reuses existing resolvers (`resolveAssignmentId`, and an enrollment→student
lookup against `enrolments`) so the client can keep sending the identifiers it already has
(local `course_id`, Schoology `assignment_id`, `enrollment_id`).

- **`GET /api/assessment-drafts?assignment_id=<schoology|local>`**
  → `{ [enrollment_id]: { pending, comment, display, displayTouched, base } }`.
  Page-level batch load, mirroring `getFeedbackForAssignment`.

- **`POST /api/assessment-drafts`** — upsert. Body
  `{ course_id, assignment_id, enrollment_id, draft }`. Resolves Schoology→local assignment id
  and enrollment→student id, then upserts on `(assignment_id, student_id)` with
  `updated_at = datetime('now')`. **Must parse `navigator.sendBeacon` POSTs** — beacons send a
  `Blob` with `type: 'application/json'`, so the existing JSON body parser handles it; this one
  endpoint serves both debounced saves and unload flushes.

- **`DELETE /api/assessment-drafts?assignment_id=&enrollment_id=`** — removes the row when a card
  returns to no-pending-changes, on publish, or on discard.

Bad/unresolvable ids → `400`/`404` following the `notes`/`flags` error convention.

### 3. Client — instant UI, async autosave

**Load (synchronous init preserved).** `AssessmentSummaryPage` fetches all drafts once
(`getDraftsForAssignment(assignmentId)`) alongside the existing feedback/analysis fetch and
passes each `StudentRubricCard` a `draftRow` prop. The card's
`useState(() => restoredDraft ?? …)` initialises from `draftRow` instead of `readDraft()` —
render stays synchronous, so there is **zero render delay**. The stale check is unchanged:
`draftRow.base !== currentBaseline` ⇒ ignore the draft and `DELETE` the server row.

**Save.** React state remains the UI source of truth; typing and clicks update it instantly and
never await the network. The current `localStorage` `useEffect` (the `hasPendingChanges`
write/clear at `AssessmentSummaryPage.jsx:214`) is replaced by an autosave layer:

- comment typing → **trailing debounce ~500ms** → `POST`
- proficiency / display-toggle click → **immediate flush** → `POST` (keeps MCP within a click
  of current)
- `pagehide` / `visibilitychange` → `navigator.sendBeacon` flush of the latest pending payload
- SPA route-change unmount → `fetch(url, { keepalive: true })` flush + debounce-timer clear
- transition to no-pending-changes → `DELETE`

All saves are fire-and-forget; failures degrade silently (the draft is recoverable from React
state until the next successful save), matching the current silent-degrade posture of
`writeDraft`.

**`lib/assessmentDraft.js`** keeps `draftBaseline` (still used for the stale check). Its
`draftKey` / `readDraft` / `writeDraft` / `clearDraft` localStorage functions are removed and
replaced by the API-backed autosave helpers (debounced saver with a `flush()`, plus
`saveDraft` / `deleteDraft` wrappers over the new `services/api.js` calls).

**One-time migration.** On first load, any existing `localStorage` draft under the
`prism:assessment-draft:` prefix is POSTed to the DB (when no server row exists yet) and then
removed from `localStorage`, so in-flight drafts created before this change are not lost.

### 4. MCP exposure

`server/services/assessmentContext.js` gains a `getDrafts(db, assignmentId)` read against
`assessment_drafts` (keyed like `getExistingSuggestions`). Each student object in
`getAssessmentContext` gets a sibling to `existing_suggestion`:

```js
draft_feedback: draft ? {
  updated_at,
  rubric_scores: { [topicId]: 'ED'|'EX'|'D'|'EM'|'IE' }, // teacher's unsaved level picks
  removed_topics: [topicId, …],                          // topics staged for removal (the '__remove__' sentinel)
  comment,
  display_to_student: display,
} : null
```

The `'__remove__'` sentinel in `pending` is surfaced as `removed_topics` rather than a fake
level. The `prism://assignment/{courseId}/{assignmentId}/context` resource inherits this
automatically (same builder). The `get_assignment_context` tool description in `mcp/server.js`
is updated to mention the teacher's in-progress draft.

### 5. Colour fix (independent)

`RubricDescriptorGrid` receives a new `levelDraftColors` prop. The call site
(`AssessmentSummaryPage.jsx:745`) passes
`Object.fromEntries(LEVELS.map(l => [l, LEVEL_COLORS[l].draftFill]))`, alongside the existing
`levelHeaderColors` (=`headerFill`) and `levelBorderColors` (=`finalBorder`).

In `RubricDescriptorGrid.jsx:46` the draft branch background changes:

```diff
- else if (st.draft) Object.assign(base, {
-   outline: `2px dashed ${levelBorderColors[l]}`, outlineOffset: '-1px', background: 'var(--bg-subtle)' });
+ else if (st.draft) Object.assign(base, {
+   outline: `2px dashed ${levelBorderColors[l]}`, outlineOffset: '-1px', background: levelDraftColors[l] });
```

Draft cells become a pale tint of their own proficiency colour (e.g. ED `#eff6ff` under final
`#bfdbfe`), matching the inline-table path and no longer colliding with the AI-suggestion wash.

Per the design-language log convention (`docs/design-language.md`), append a note recording the
draft-cell-fill = level `draftFill` decision.

## Testing

- **Server** `server/routes/assessment-drafts.test.js` (in-memory DB via
  `process.env.DB_PATH = ':memory:'`): POST upsert (insert + update paths), GET keyed by
  enrollment, DELETE, Schoology-assignment-id resolution, enrollment→student resolution,
  bad-id error codes.
- **MCP context** — extend `assessmentContext` coverage to assert `draft_feedback` is surfaced
  (including the `removed_topics` translation) and is `null` when no draft exists.
- **Client** (Vitest + RTL): card initialises from the `draftRow` prop; autosave debounces
  typing and flushes immediately on a proficiency click (fake timers); transition to
  no-changes issues a delete; the one-time localStorage migration path.
- The colour fix is visual — verify by running the app and confirming draft cells render a pale
  tint of the level colour, not grey.

## Rollout / sequencing

§1–4 + their tests are the migration and should land together. §5 is a standalone one-line
colour fix that can land independently (and first, if a quick win is wanted).

## Risks & mitigations

- **Lost last-keystroke on crash** — accepted; mitigated by immediate-flush on discrete picks
  and unload flushes. Typing risk window is ≤ the debounce interval.
- **DB write on the Express event loop** — writes are tiny single-row upserts; better-sqlite3 is
  synchronous but WAL keeps MCP readers concurrent, as with existing routes.
- **Two readers of the same row (Express + MCP)** — WAL + the existing `busy_timeout = 5000` on
  the MCP connection already cover this.
