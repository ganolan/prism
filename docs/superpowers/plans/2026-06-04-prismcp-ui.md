# PrisMCP UI — Surfacing Reviewer Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface reviewer (AI grading) suggestions, per-student flags, and assessment-wide noticings on `/assessment/:id`, rendering against the existing local `feedback` table plus one small new `assessment_analysis` record — teacher marks and suggestions coexist.

**Architecture:** Project A — the UI layer only. Two new read-only server endpoints expose parsed `feedback` rows (keyed by student) and an `assessment_analysis` record for an assignment. The existing `AssessmentSummaryPage` fetches them alongside mastery data and renders: a rewritten five-family rubric cell language (final / draft / suggestion / removal), a per-student card chrome (flags strip, hero comment, control band, suggested-feedback box), and a header-mounted Reviewer Analysis drawer (computed proposed-score distribution + prose noticings). No MCP server, no ingestion changes, no final-grade distribution (those are Projects B / #78, out of scope).

**Tech Stack:** Express + better-sqlite3 (server, ESM), React + Vite (client), Vitest + @testing-library/react (tests). Rubric colours stay **inline** (deliberate local exception to the `app.css` CSS-var convention, consistent with the existing rubric code and the spec §1).

---

## File Structure

**Server**
- `server/db/schema.sql` — add the `assessment_analysis` table (idempotent `CREATE TABLE IF NOT EXISTS`).
- `server/routes/feedback.js` — add `GET /api/feedback/for-assignment/:assignmentId` and `GET /api/feedback/analysis/:assignmentId`. **Both must be registered above the existing `GET /:id`** (which is a catch-all), exactly like the existing `/inbox-log` route.
- `server/routes/feedback.test.js` — **new** test file (mirrors `server/routes/flags.test.js` harness).

**Client**
- `client/src/services/api.js` — add `getFeedbackForAssignment` and `getAssessmentAnalysis` wrappers.
- `client/src/lib/rubricSuggestions.js` — **new** pure helper resolving a free-form `rubric_scores` object to `{ [topicId]: level }` and aggregating a per-topic distribution. Unit-testable, shared by the card (overlay) and the page (distribution).
- `client/src/lib/rubricSuggestions.test.js` — **new** unit tests for the helper.
- `client/src/pages/AssessmentSummaryPage.jsx` — the bulk of the work:
  - module-level colour constants (`CELL_COLORS`, `SUGGEST`, `CELL_TEXT`, `REMOVE`);
  - `StudentRubricCard` — rewritten rubric cell rendering, new `selectLevel` interaction, flags strip, control band, suggested-feedback box, `Use suggestion`; accepts a new `feedbackRow` prop;
  - `AssessmentSummaryPage` — loads feedback + analysis alongside mastery, passes each card its row, sticky header, legend removed, Reviewer Analysis button + drawer.
- `client/src/pages/AssessmentSummaryPage.test.jsx` — extend with new `describe` blocks; update the `vi.mock` to include the two new api fns.

**Shared interfaces locked here (used across tasks):**
- `feedbackRow` (prop on `StudentRubricCard`): the parsed feedback object or `null`/`undefined`. Shape:
  ```jsonc
  { narrative_feedback: "string", rubric_scores: { "<key>": "ED|EX|D|EM|IE" },
    reviewer_flags: "string|null", strengths: ["..."], suggestions: ["..."] }
  ```
- `REMOVE` sentinel: the value stored in `pending[topicId]` to mean "stage this synced final for removal" (distinct from a level code and from absence).
- `resolveRubricScores(rubricScores, topics) -> { [topicId]: level }` and `distributionByTopic(rows, topics) -> { [topicId]: { ED, EX, D, EM, IE } }` from `rubricSuggestions.js`.

---

## Slice ordering (smallest shippable first)

1. **Rubric colour system & cell language** — pure visual; no data dependency; existing behaviour intact.
2. **Rubric interaction** — clear-draft + stage-removal; needs the removal marker from Slice 1.
3. **Server data layer** — `assessment_analysis` table + two read endpoints + client api wrappers.
4. **Load feedback + rubric suggestion overlay** — wire the fetch into the page; render the violet overlay with coexistence (the agree-case). Needs 1 + 3.
5. **Per-student card chrome** — flags strip, hero comment, control band, suggested-feedback box, `Use suggestion`. Needs 4.
6. **Sticky header + Reviewer Analysis drawer** — sticky header, legend removed, conditional button, drawer with computed distribution + noticings. Needs 3 + 4.

Each slice ends green (`cd client && npx vite build`, `npx vitest run server/`, and the page test file all pass) and is independently shippable.

---

# Slice 1 — Rubric colour system & cell language

Replaces the current "all selections solid green" scheme with the five per-level families from spec §1–§2. Header tint = final fill. Cell text is always black. No behaviour change yet (clicking still drafts; removal/clear arrive in Slice 2). Existing card tests keep passing because the `title` selectors and pending logic are unchanged.

### Task 1.1: Add the colour constants

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (after `LEVEL_COLORS`, ~line 22)

- [ ] **Step 1: Add the new module-level constants**

Insert directly after the existing `LEVEL_COLORS` object (keep `LEVEL_COLORS` in place — it is still used elsewhere; the new constants drive the rubric grid and header):

```jsx
// PrisMCP cell language (spec §1). Header tint = final fill; cell text is always
// black because descriptor text will later replace the level codes, so colour
// cannot carry meaning in the text. Kept inline (deliberate local exception to
// the app.css CSS-var convention) — consistent with LEVEL_COLORS above.
const CELL_COLORS = {
  ED: { headerFill: '#bfdbfe', draftFill: '#eff6ff', finalBorder: '#2563eb', draftBorder: '#93c5fd' },
  EX: { headerFill: '#bbf7d0', draftFill: '#f0fdf4', finalBorder: '#16a34a', draftBorder: '#86efac' },
  D:  { headerFill: '#fef08a', draftFill: '#fefce8', finalBorder: '#ca8a04', draftBorder: '#fcd34d' },
  EM: { headerFill: '#fed7aa', draftFill: '#fff7ed', finalBorder: '#ea580c', draftBorder: '#fdba74' },
  IE: { headerFill: '#fecaca', draftFill: '#fef2f2', finalBorder: '#dc2626', draftBorder: '#fca5a5' },
};
// Suggestion accent — deliberately violet, NOT yellow (Developing is already yellow).
const SUGGEST = { fill: '#ede9fe', ring: '#a78bfa', glyph: '#8b5cf6' };
const CELL_TEXT = '#1a1a1a';
// Sentinel stored in pending[topicId] to stage a synced final for removal (Slice 2).
const REMOVE = '__remove__';
```

- [ ] **Step 2: Verify the build still compiles**

Run: `cd client && npx vite build`
Expected: build succeeds (constants are unused so far — that is fine; the next tasks consume them).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx
git commit -m "feat(assessment): add PrisMCP cell-language colour constants"
```

### Task 1.2: Recolour the rubric header row

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (header `<th>` map, ~lines 571-581)

- [ ] **Step 1: Write the failing test**

Add to `client/src/pages/AssessmentSummaryPage.test.jsx` a new describe block (place it after the existing `describe('StudentRubricCard draft persistence'...)`):

```jsx
describe('StudentRubricCard — cell language (Slice 1)', () => {
  it('renders each level header with its header-tint fill and black text', () => {
    renderCard();
    const edHeader = screen.getByText('Exhibiting Depth').closest('th');
    expect(edHeader).toHaveStyle({ background: '#bfdbfe', color: '#1a1a1a' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "header-tint"`
Expected: FAIL — current header uses `LEVEL_COLORS[l].bg` (`#dbeafe`) and `LEVEL_COLORS[l].text`, not `#bfdbfe` / `#1a1a1a`.

- [ ] **Step 3: Recolour the header**

Replace the level-header `<th>` style (the `{LEVELS.map(l => (...))}` block, ~lines 571-581) with:

```jsx
{LEVELS.map(l => (
  <th key={l} style={{
    padding: '0.3rem 0.5rem', textAlign: 'center', width: '12%',
    background: CELL_COLORS[l].headerFill, color: CELL_TEXT,
    border: '1px solid var(--border)', fontWeight: 600, fontSize: '0.72rem',
    whiteSpace: 'nowrap',
  }}>
    {l}
    <div style={{ fontWeight: 400, fontSize: '0.6rem', opacity: 0.8 }}>{LEVEL_LABELS[l]}</div>
  </th>
))}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "header-tint"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment): recolour rubric header to per-level tints"
```

### Task 1.3: Rewrite body-cell rendering (final / draft / empty)

This is the heart of Slice 1. It rewrites the per-cell style computation (current code ~lines 598-641) into the new final/draft/empty language. Suggestion + removal states are stubbed (rendered only when their inputs exist; those inputs arrive in Slices 2 & 4) but the structure is built now so later slices only add data, not restructure.

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (the `{LEVELS.map(l => {...})}` cell block, ~lines 598-642)

- [ ] **Step 1: Write the failing tests**

Add to the `describe('StudentRubricCard — cell language (Slice 1)'...)` block:

```jsx
it('renders a synced final cell with its final fill, 2px final border, bold, black text', () => {
  const s = { ...makeStudent(), scores: { t1: { grade: 'ED', points: 100 } } };
  renderCard({ student: s });
  const cell = screen.getByTitle('Set Topic 1 to Exhibiting Depth');
  expect(cell).toHaveStyle({
    background: '#bfdbfe', border: '2px solid #2563eb', color: '#1a1a1a', fontWeight: '700',
  });
  expect(cell).toHaveTextContent('ED');
});

it('renders a pending draft cell with its draft fill, 2px draft border, black text', () => {
  renderCard(); // empty scores
  fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
  const cell = screen.getByTitle('Set Topic 1 to Developing');
  expect(cell).toHaveStyle({
    background: '#fefce8', border: '2px solid #fcd34d', color: '#1a1a1a',
  });
});

it('renders an empty cell with the default card background and no level code', () => {
  renderCard();
  const cell = screen.getByTitle('Set Topic 1 to Emerging');
  expect(cell).toHaveStyle({ background: 'var(--card-bg)' });
  expect(cell).toHaveTextContent('');
});

it('renders the overridden synced final as empty when a draft is pending on another cell', () => {
  const s = { ...makeStudent(), scores: { t1: { grade: 'ED', points: 100 } } };
  renderCard({ student: s });
  fireEvent.click(screen.getByTitle('Set Topic 1 to Developing')); // draft on D
  const oldFinal = screen.getByTitle('Set Topic 1 to Exhibiting Depth'); // ED
  expect(oldFinal).toHaveStyle({ background: 'var(--card-bg)' });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "cell language"`
Expected: FAIL — current code paints current cells solid green (`#16a34a`) and overridden finals dimmed, not the new language.

- [ ] **Step 3: Rewrite the cell block**

Replace the entire `{LEVELS.map(l => { ... })}` block (currently ~lines 598-642) with:

```jsx
{LEVELS.map(l => {
  const c = CELL_COLORS[l];
  const pendingVal = pendingGrade;                 // pending[t.id] || null (from outer scope)
  const stagedRemoval = pendingVal === REMOVE && l === currentGrade;
  const isDraft = pendingVal !== REMOVE && l === pendingVal;
  // A synced final shows ONLY when nothing is pending for this topic (a pending
  // draft on another cell overrides it → that old final renders Empty; spec §2).
  const isFinal = l === currentGrade && pendingVal == null;
  // Suggestion overlay inputs arrive in Slice 4; null-safe until then.
  const isSuggested = suggestedLevel != null && l === suggestedLevel;
  const hasTeacherMark = isFinal || isDraft || stagedRemoval;

  let cellStyle = {
    padding: '0.25rem 0.4rem',
    border: '1px solid var(--border)',
    textAlign: 'center',
    cursor: 'pointer',
    userSelect: 'none',
    transition: 'all 0.1s',
    color: CELL_TEXT,
    background: 'var(--card-bg)',
  };

  if (isFinal) {
    cellStyle = {
      ...cellStyle, background: c.headerFill,
      border: `2px solid ${c.finalBorder}`, fontWeight: 700,
      position: 'relative', zIndex: 2,
    };
  } else if (isDraft) {
    cellStyle = {
      ...cellStyle, background: c.draftFill,
      border: `2px solid ${c.draftBorder}`,
      position: 'relative', zIndex: 2,
    };
  } else if (stagedRemoval) {
    // Removal marker (Slice 2): default bg, red dashed ring + ✕ glyph.
    cellStyle = {
      ...cellStyle, background: 'var(--card-bg)',
      outline: '1.5px dashed #ef4444', outlineOffset: '-3px',
      position: 'relative', zIndex: 2,
    };
  }

  // Suggestion overlay (Slice 4) composes on top: dashed violet ring always;
  // violet wash only when there is no teacher mark in this cell (spec §2).
  if (isSuggested) {
    cellStyle = {
      ...cellStyle,
      outline: stagedRemoval ? cellStyle.outline : `1px dashed ${SUGGEST.ring}`,
      outlineOffset: '-3px',
      position: 'relative', zIndex: 2,
      ...(hasTeacherMark ? {} : { background: SUGGEST.fill }),
    };
  }

  const showCode = isFinal || isDraft || stagedRemoval || isSuggested;

  return (
    <td
      key={l}
      style={cellStyle}
      onClick={() => selectLevel(t.id, l)}
      title={`Set ${t.title} to ${LEVEL_LABELS[l]}`}
    >
      {showCode ? (
        <span style={{ fontWeight: isFinal ? 700 : 400, fontSize: '0.75rem', color: CELL_TEXT }}>
          {l}
        </span>
      ) : null}
      {isSuggested && (
        <span style={{
          position: 'absolute', top: 1, right: 3, fontSize: '0.58rem',
          lineHeight: 1, color: SUGGEST.glyph,
        }}>✦</span>
      )}
      {stagedRemoval && (
        <span style={{
          position: 'absolute', top: 0, right: 2, fontSize: '0.6rem',
          lineHeight: 1, color: '#ef4444',
        }}>✕</span>
      )}
    </td>
  );
})}
```

- [ ] **Step 4: Add the `suggestedLevel` placeholder in the row scope**

`suggestedLevel` is referenced above but does not exist yet (it is wired in Slice 4). Add it inside the `topics.map(t => {...})` body, right after the existing `pendingGrade` line (~line 587), so Slice 1 compiles and the overlay stays inert until Slice 4:

```jsx
const currentGrade = student.scores[t.id]?.grade || null;
const pendingGrade = pending[t.id] || null;
const suggestedLevel = null; // wired in Slice 4 (rubric suggestion overlay)
```

- [ ] **Step 5: Run the new tests + the full card suite**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS — the four new cell-language tests pass and all pre-existing draft-persistence / flag / send-all tests stay green (their `title` selectors and pending counts are unchanged).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment): rewrite rubric cells to final/draft/empty language"
```

---

# Slice 2 — Rubric interaction: clear-draft + stage-removal

Changes `selectLevel` so a drafted cell toggles off on re-click and a synced final stages for removal (red dashed marker, already rendered by Slice 1). The staged removal flows through the existing `pending` → draft → Update Schoology lifecycle: `buildGradeInfo` omits the topic (Schoology's `/observations` replace then clears it) and `buildSavedScores` drops it from the in-place patch.

### Task 2.1: Make `selectLevel` toggle drafts and stage removals

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (`selectLevel`, ~lines 173-188)

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `AssessmentSummaryPage.test.jsx`:

```jsx
describe('StudentRubricCard — rubric interaction (Slice 2)', () => {
  it('clears a pending draft when its cell is clicked again', () => {
    renderCard();
    const cell = screen.getByTitle('Set Topic 1 to Developing');
    fireEvent.click(cell);
    expect(screen.getByText('1 pending change')).toBeInTheDocument();
    fireEvent.click(cell);
    expect(screen.queryByText(/pending change/)).not.toBeInTheDocument();
  });

  it('stages a synced final for removal on click, showing the red removal marker', () => {
    const s = { ...makeStudent(), scores: { t1: { grade: 'ED', points: 100 } } };
    renderCard({ student: s });
    const finalCell = screen.getByTitle('Set Topic 1 to Exhibiting Depth'); // ED
    fireEvent.click(finalCell);
    expect(screen.getByText('1 pending change')).toBeInTheDocument();
    expect(finalCell).toHaveStyle({ outline: '1.5px dashed #ef4444' });
    expect(finalCell).toHaveTextContent('✕');
  });

  it('unstages a removal when the staged final cell is clicked again', () => {
    const s = { ...makeStudent(), scores: { t1: { grade: 'ED', points: 100 } } };
    renderCard({ student: s });
    const finalCell = screen.getByTitle('Set Topic 1 to Exhibiting Depth');
    fireEvent.click(finalCell); // stage removal
    fireEvent.click(finalCell); // unstage
    expect(screen.queryByText(/pending change/)).not.toBeInTheDocument();
    expect(finalCell).toHaveStyle({ background: '#bfdbfe' }); // back to final fill
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "rubric interaction"`
Expected: FAIL — current `selectLevel` re-sets the same value (no toggle-off) and clicking a final only deletes pending (no removal staging / marker).

- [ ] **Step 3: Rewrite `selectLevel`**

Replace `selectLevel` (~lines 173-188) with:

```jsx
function selectLevel(topicId, level) {
  if (isRubricLocked) return;
  const currentGrade = student.scores[topicId]?.grade;
  const pendingVal = pending[topicId];

  // Re-clicking a drafted cell toggles it off (back to whatever is synced).
  if (pendingVal != null && pendingVal !== REMOVE && level === pendingVal) {
    setPending(p => { const n = { ...p }; delete n[topicId]; return n; });
    return;
  }
  // Re-clicking the staged final cell unstages the removal.
  if (pendingVal === REMOVE && level === currentGrade) {
    setPending(p => { const n = { ...p }; delete n[topicId]; return n; });
    return;
  }
  // Clicking the synced final with nothing pending stages it for removal.
  if (pendingVal == null && level === currentGrade) {
    armAutoFlip();
    setPending(p => ({ ...p, [topicId]: REMOVE }));
    return;
  }
  // Otherwise set/replace a draft on this level.
  armAutoFlip();
  setPending(p => ({ ...p, [topicId]: level }));
}

// Auto-flip the display toggle ON the first real selection for a virgin record.
function armAutoFlip() {
  if (autoFlipArmed) {
    setDisplay(true);
    setAutoFlipArmed(false);
  }
}
```

- [ ] **Step 4: Run the interaction tests + full suite**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS — note the existing draft-persistence test "restores pending rubric selection..." still passes (it clicks an *empty* cell → draft, unchanged). The "clears a stored draft after a successful save" test still clicks an empty cell → draft → save, unchanged.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment): clear-draft toggle and stage-removal interaction"
```

### Task 2.2: Honour staged removal in the Schoology write payload

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (`buildGradeInfo` ~lines 195-205, `buildSavedScores` ~lines 209-217)

- [ ] **Step 1: Write the failing tests**

Add to the `describe('StudentRubricCard — rubric interaction (Slice 2)'...)` block:

```jsx
it('omits a removal-staged topic from the Schoology grade payload', async () => {
  const s = { ...makeStudent(), scores: { t1: { grade: 'ED', points: 100 } } };
  const onSaved = vi.fn();
  renderCard({ student: s, onSaved });
  fireEvent.click(screen.getByTitle('Set Topic 1 to Exhibiting Depth')); // stage removal of ED
  fireEvent.click(screen.getByRole('button', { name: 'Update Schoology' }));

  await waitFor(() => expect(writeMasteryScores).toHaveBeenCalled());
  const payload = writeMasteryScores.mock.calls[0][1];
  expect(payload.gradeInfo.t1).toBeUndefined(); // topic cleared → not in the replace set
  // The in-place patch also drops the removed score.
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(onSaved.mock.calls[0][1].scores.t1).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "removal-staged topic"`
Expected: FAIL — `buildGradeInfo` uses `pending[t.id] ?? current`, so a `REMOVE` value passes through and `LEVEL_POINTS['__remove__']` is `undefined`; the topic is dropped only by accident on the points check, but `buildSavedScores` would still try to read `LEVEL_POINTS[REMOVE]`. Make the intent explicit and tested.

- [ ] **Step 3: Update both builders to treat `REMOVE` as omission**

Replace `buildGradeInfo` (~lines 195-205):

```jsx
function buildGradeInfo() {
  const gradeInfo = {};
  for (const t of topics) {
    // `t.id in pending` distinguishes a cleared draft (key deleted → fall back to
    // synced) from a staged removal (REMOVE → omit so the /observations replace
    // clears it in Schoology).
    const level = (t.id in pending) ? pending[t.id] : student.scores[t.id]?.grade;
    if (level == null || level === REMOVE) continue;
    const points = LEVEL_POINTS[level];
    if (points == null) continue;
    gradeInfo[t.id] = { grade: String(points), gradingScaleId: 21337256 };
  }
  return gradeInfo;
}
```

Replace `buildSavedScores` (~lines 209-217):

```jsx
function buildSavedScores() {
  const newScores = {};
  for (const t of topics) {
    const level = (t.id in pending) ? pending[t.id] : student.scores[t.id]?.grade;
    if (level == null || level === REMOVE) continue;
    newScores[t.id] = { points: LEVEL_POINTS[level], grade: level };
  }
  return newScores;
}
```

- [ ] **Step 4: Run the test + full suite**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS. The existing in-place-save test (#50) still passes — a normal draft on `t1` still yields `patch.scores.t1 = { points: 50, grade: 'D' }`.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment): clear removed scores in Schoology on Update"
```

---

# Slice 3 — Server data layer

Adds the `assessment_analysis` table and two read-only endpoints. Both endpoints accept the **Schoology assignment id** (matching the page URL param and `GET /api/mastery/:courseId/assignment/:assignmentId`), resolving it to the local `assignments.id` internally. `approved` rows are filtered out so they stop re-surfacing as suggestions.

### Task 3.1: Add the `assessment_analysis` table

**Files:**
- Modify: `server/db/schema.sql` (after the `feedback`/`inbox_log` tables, ~line 176)

- [ ] **Step 1: Add the table definition**

Insert after the `inbox_log` table (~line 176), before the `folders` table:

```sql
-- Assessment-level reviewer analysis (PrisMCP Project A). One row per assignment.
-- analysis_json holds { noticings: [{title, body}], moderation_note?: string }.
-- Populated by Project B / inbox ingestion (out of scope here); read-only in the UI.
CREATE TABLE IF NOT EXISTS assessment_analysis (
  assignment_id INTEGER PRIMARY KEY REFERENCES assignments(id),
  analysis_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Verify the schema loads**

Run: `node -e "process.env.DB_PATH=':memory:'; const { getDb } = await import('./server/db/index.js'); const db = getDb(); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='assessment_analysis'\").get());"`
Expected: prints `{ name: 'assessment_analysis' }` (schema is applied on `getDb()` via `CREATE TABLE IF NOT EXISTS`).

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(db): add assessment_analysis table"
```

### Task 3.2: `GET /api/feedback/for-assignment/:assignmentId`

**Files:**
- Create: `server/routes/feedback.test.js`
- Modify: `server/routes/feedback.js` (register the new route **above** `GET /:id`, ~line 40)

- [ ] **Step 1: Write the failing test**

Create `server/routes/feedback.test.js`:

```js
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './feedback.js';
import { getDb } from '../db/index.js';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/feedback', router);
  const server = app.listen(0);
  return { server, port: server.address().port };
}

async function call(method, path, payload) {
  const { server, port } = startServer();
  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

let courseId, assignmentSchoolId, localAssignmentId, s1, s2;

beforeEach(() => {
  const db = getDb();
  db.exec(
    'DELETE FROM assessment_analysis; DELETE FROM feedback; DELETE FROM assignments; ' +
    'DELETE FROM students; DELETE FROM courses;'
  );
  courseId = db.prepare(
    `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'Course')`
  ).run().lastInsertRowid;
  assignmentSchoolId = 'sa-1';
  localAssignmentId = db.prepare(
    `INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, ?, 'Project')`
  ).run(courseId, assignmentSchoolId).lastInsertRowid;
  s1 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1','Ada','Lovelace')`).run().lastInsertRowid;
  s2 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u2','Alan','Turing')`).run().lastInsertRowid;
});

function insertFeedback(studentId, status, json) {
  return getDb().prepare(
    `INSERT INTO feedback (student_id, assignment_id, status, feedback_json) VALUES (?, ?, ?, ?)`
  ).run(studentId, localAssignmentId, status, JSON.stringify(json)).lastInsertRowid;
}

describe('GET /api/feedback/for-assignment/:assignmentId', () => {
  test('returns draft + teacher_modified rows keyed by student_id with parsed feedback', async () => {
    insertFeedback(s1, 'draft', { narrative_feedback: 'Great', rubric_scores: { 'X1': 'ED' } });
    insertFeedback(s2, 'teacher_modified', { narrative_feedback: 'Good', reviewer_flags: 'placeholder remains' });
    const { status, body } = await call('GET', `/api/feedback/for-assignment/${assignmentSchoolId}`);
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([String(s1), String(s2)].sort());
    expect(body[s1].feedback_parsed.rubric_scores).toEqual({ X1: 'ED' });
    expect(body[s2].feedback_parsed.reviewer_flags).toBe('placeholder remains');
  });

  test('excludes approved rows', async () => {
    insertFeedback(s1, 'approved', { narrative_feedback: 'done' });
    const { body } = await call('GET', `/api/feedback/for-assignment/${assignmentSchoolId}`);
    expect(body[s1]).toBeUndefined();
  });

  test('returns an empty object for an unknown assignment', async () => {
    const { status, body } = await call('GET', '/api/feedback/for-assignment/nope');
    expect(status).toBe(200);
    expect(body).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes/feedback.test.js -t "for-assignment"`
Expected: FAIL — route does not exist; `/for-assignment/...` falls through to `GET /:id`, returning 404 `Feedback not found`.

- [ ] **Step 3: Add the route**

In `server/routes/feedback.js`, immediately after the `GET /inbox-log` route (~line 14) and before `GET /` / `GET /:id`, add:

```js
// GET /api/feedback/for-assignment/:assignmentId — all draft/teacher_modified
// feedback rows for one assignment, keyed by student_id, each with parsed JSON.
// :assignmentId is the SCHOOLOGY assignment id (matches the assessment page URL
// + the mastery route); resolved to the local assignment id internally.
// Must be registered before GET /:id (catch-all). approved rows are excluded so
// they stop re-surfacing as suggestions.
router.get('/for-assignment/:assignmentId', (req, res) => {
  const db = getDb();
  const assignment = db.prepare(
    'SELECT id FROM assignments WHERE schoology_assignment_id = ?'
  ).get(req.params.assignmentId);
  if (!assignment) return res.json({});
  const rows = db.prepare(`
    SELECT * FROM feedback
    WHERE assignment_id = ? AND status IN ('draft', 'teacher_modified')
  `).all(assignment.id);
  const byStudent = {};
  for (const row of rows) {
    row.feedback_parsed = JSON.parse(row.feedback_json || '{}');
    byStudent[row.student_id] = row;
  }
  res.json(byStudent);
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/routes/feedback.test.js -t "for-assignment"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/routes/feedback.js server/routes/feedback.test.js
git commit -m "feat(feedback): add GET /for-assignment/:assignmentId"
```

### Task 3.3: `GET /api/feedback/analysis/:assignmentId`

**Files:**
- Modify: `server/routes/feedback.js` (register above `GET /:id`)
- Modify: `server/routes/feedback.test.js`

- [ ] **Step 1: Write the failing test**

Add to `server/routes/feedback.test.js`:

```js
describe('GET /api/feedback/analysis/:assignmentId', () => {
  test('returns the parsed analysis record when present', async () => {
    const analysis = { noticings: [{ title: 'AI use', body: 'half the class' }], moderation_note: 'spot-check' };
    getDb().prepare(
      'INSERT INTO assessment_analysis (assignment_id, analysis_json) VALUES (?, ?)'
    ).run(localAssignmentId, JSON.stringify(analysis));
    const { status, body } = await call('GET', `/api/feedback/analysis/${assignmentSchoolId}`);
    expect(status).toBe(200);
    expect(body.analysis_parsed).toEqual(analysis);
  });

  test('returns null when no analysis exists', async () => {
    const { status, body } = await call('GET', `/api/feedback/analysis/${assignmentSchoolId}`);
    expect(status).toBe(200);
    expect(body).toBeNull();
  });

  test('returns null for an unknown assignment', async () => {
    const { status, body } = await call('GET', '/api/feedback/analysis/nope');
    expect(status).toBe(200);
    expect(body).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes/feedback.test.js -t "analysis"`
Expected: FAIL — route missing; `/analysis/...` falls through to `GET /:id` → 404.

- [ ] **Step 3: Add the route**

In `server/routes/feedback.js`, directly after the `/for-assignment/:assignmentId` route, add:

```js
// GET /api/feedback/analysis/:assignmentId — the assessment_analysis record for
// one assignment (Schoology id), parsed, or null. Must precede GET /:id.
router.get('/analysis/:assignmentId', (req, res) => {
  const db = getDb();
  const assignment = db.prepare(
    'SELECT id FROM assignments WHERE schoology_assignment_id = ?'
  ).get(req.params.assignmentId);
  if (!assignment) return res.json(null);
  const row = db.prepare(
    'SELECT * FROM assessment_analysis WHERE assignment_id = ?'
  ).get(assignment.id);
  if (!row) return res.json(null);
  row.analysis_parsed = JSON.parse(row.analysis_json || '{}');
  res.json(row);
});
```

- [ ] **Step 4: Run the test + full server suite**

Run: `npx vitest run server/`
Expected: PASS — all server route suites green.

- [ ] **Step 5: Commit**

```bash
git add server/routes/feedback.js server/routes/feedback.test.js
git commit -m "feat(feedback): add GET /analysis/:assignmentId"
```

### Task 3.4: Client api wrappers

**Files:**
- Modify: `client/src/services/api.js` (Feedback section, ~lines 127-141)

- [ ] **Step 1: Add the wrappers**

After `getFeedbackItem` (~line 129), add:

```js
export const getFeedbackForAssignment = (assignmentId) => request(`/feedback/for-assignment/${assignmentId}`);
export const getAssessmentAnalysis = (assignmentId) => request(`/feedback/analysis/${assignmentId}`);
```

- [ ] **Step 2: Verify the build**

Run: `cd client && npx vite build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add client/src/services/api.js
git commit -m "feat(api): add feedback for-assignment + analysis wrappers"
```

---

# Slice 4 — Load feedback into the page + rubric suggestion overlay

Introduces the shared `rubricSuggestions.js` helper, wires the feedback fetch into the page, and activates the violet suggestion overlay on rubric cells — including the coexistence (agree-case) rule.

### Task 4.1: The `rubricSuggestions` helper

**Files:**
- Create: `client/src/lib/rubricSuggestions.js`
- Create: `client/src/lib/rubricSuggestions.test.js`

- [ ] **Step 1: Write the failing tests**

Create `client/src/lib/rubricSuggestions.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { resolveRubricScores, distributionByTopic } from './rubricSuggestions.js';

const TOPICS = [
  { id: 't1', external_id: 'X1', title: 'Ideation' },
  { id: 't2', external_id: 'X2', title: 'UI Design' },
];

describe('resolveRubricScores', () => {
  it('matches a key against external_id first', () => {
    expect(resolveRubricScores({ X1: 'ED' }, TOPICS)).toEqual({ t1: 'ED' });
  });
  it('falls back to a case-insensitive title match', () => {
    expect(resolveRubricScores({ 'ui design': 'EX' }, TOPICS)).toEqual({ t2: 'EX' });
  });
  it('ignores unresolvable keys and out-of-set values', () => {
    expect(resolveRubricScores({ NOPE: 'ED', X1: '99', X2: 'EX' }, TOPICS)).toEqual({ t2: 'EX' });
  });
  it('returns an empty object for null/empty input', () => {
    expect(resolveRubricScores(null, TOPICS)).toEqual({});
    expect(resolveRubricScores({}, TOPICS)).toEqual({});
  });
});

describe('distributionByTopic', () => {
  it('counts resolved levels per topic across rows', () => {
    const rows = [
      { feedback_parsed: { rubric_scores: { X1: 'ED', X2: 'ED' } } },
      { feedback_parsed: { rubric_scores: { X1: 'ED', X2: 'EX' } } },
    ];
    const dist = distributionByTopic(rows, TOPICS);
    expect(dist.t1).toEqual({ ED: 2, EX: 0, D: 0, EM: 0, IE: 0 });
    expect(dist.t2).toEqual({ ED: 1, EX: 1, D: 0, EM: 0, IE: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run src/lib/rubricSuggestions.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

Create `client/src/lib/rubricSuggestions.js`:

```js
// Resolve a free-form rubric_scores object to { [topicId]: level }.
// Key match: topic external_id first, then title (both case-insensitive).
// Value must be one of ED/EX/D/EM/IE; unmatched keys / out-of-set values are
// dropped (logged, never blocking) — the overlay is best-effort (spec §5).
const VALID_LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];

export function resolveRubricScores(rubricScores, topics) {
  const out = {};
  if (!rubricScores || typeof rubricScores !== 'object') return out;
  const byExternal = new Map();
  const byTitle = new Map();
  for (const t of topics) {
    if (t.external_id) byExternal.set(String(t.external_id).toLowerCase(), t.id);
    if (t.title) byTitle.set(String(t.title).toLowerCase(), t.id);
  }
  for (const [key, value] of Object.entries(rubricScores)) {
    const k = String(key).toLowerCase();
    const topicId = byExternal.get(k) ?? byTitle.get(k);
    if (topicId == null) { console.debug('[rubricSuggestions] unresolved key', key); continue; }
    if (!VALID_LEVELS.includes(value)) { console.debug('[rubricSuggestions] out-of-set value', key, value); continue; }
    out[topicId] = value;
  }
  return out;
}

// Aggregate resolved suggestions across feedback rows into per-topic counts.
// rows: array of { feedback_parsed: { rubric_scores } }.
export function distributionByTopic(rows, topics) {
  const dist = {};
  for (const t of topics) dist[t.id] = { ED: 0, EX: 0, D: 0, EM: 0, IE: 0 };
  for (const row of rows || []) {
    const resolved = resolveRubricScores(row?.feedback_parsed?.rubric_scores, topics);
    for (const [topicId, level] of Object.entries(resolved)) {
      if (dist[topicId]) dist[topicId][level] += 1;
    }
  }
  return dist;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && npx vitest run src/lib/rubricSuggestions.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/rubricSuggestions.js client/src/lib/rubricSuggestions.test.js
git commit -m "feat(assessment): add rubricSuggestions resolver + distribution helper"
```

### Task 4.2: Fetch feedback + analysis on the page and pass each card its row

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (imports ~line 3, `load()` ~lines 829-835, card render ~lines 906-919)
- Modify: `client/src/pages/AssessmentSummaryPage.test.jsx` (`vi.mock` ~lines 8-16)

- [ ] **Step 1: Update the test mock and write the failing test**

In `AssessmentSummaryPage.test.jsx`, add the two new fns to the `vi.mock` factory (so the existing page tests keep running) and to the import on line 6:

```jsx
vi.mock('../services/api.js', () => ({
  getMasteryForAssignment: vi.fn(),
  getFeedbackForAssignment: vi.fn().mockResolvedValue({}),
  getAssessmentAnalysis: vi.fn().mockResolvedValue(null),
  syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn().mockResolvedValue({}),
  writeMasteryComment: vi.fn().mockResolvedValue({}),
  sendAllGrades: vi.fn().mockResolvedValue({ results: [] }),
  createFlag: vi.fn().mockResolvedValue({ id: 99, flag_reason: 'Check citations' }),
  deleteFlag: vi.fn().mockResolvedValue({ success: true }),
}));
```

Update the import line 6 to include them:

```jsx
import { createFlag, deleteFlag, writeMasteryScores, writeMasteryComment, sendAllGrades, getMasteryForAssignment, getFeedbackForAssignment, getAssessmentAnalysis } from '../services/api.js';
```

Add a new describe block for the page-level wiring:

```jsx
describe('AssessmentSummaryPage — feedback load (Slice 4)', () => {
  function makeData() {
    return {
      assignment: { id: 50, schoology_assignment_id: '8', title: 'Quiz', mastery_grading_period_id: 1, mastery_grading_category_id: 2 },
      topics: [{ id: 't1', title: 'Topic 1', category_title: 'Cat', external_id: 'X1' }],
      students: [{ ...makeStudent(), id: 1, schoology_uid: 'uid-1', enrollment_id: 'enr-1', scores: {} }],
    };
  }
  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/course/4/assessment/8']}>
        <Routes>
          <Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('fetches feedback + analysis for the assignment alongside mastery', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    renderPage();
    await waitFor(() => expect(getFeedbackForAssignment).toHaveBeenCalledWith('8'));
    expect(getAssessmentAnalysis).toHaveBeenCalledWith('8');
  });

  it('renders a suggestion overlay (✦) for a resolvable rubric_scores entry', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    getFeedbackForAssignment.mockResolvedValue({
      1: { feedback_parsed: { rubric_scores: { X1: 'ED' }, narrative_feedback: 'nice' } },
    });
    renderPage();
    const cell = await screen.findByTitle('Set Topic 1 to Exhibiting Depth'); // ED
    await waitFor(() => expect(cell).toHaveTextContent('✦'));
    expect(cell).toHaveStyle({ background: '#ede9fe' }); // violet wash, no teacher mark
  });

  it('does not throw or overlay for an unresolvable rubric_scores key', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    getFeedbackForAssignment.mockResolvedValue({
      1: { feedback_parsed: { rubric_scores: { NOPE: 'ED' } } },
    });
    renderPage();
    await screen.findByTitle('Set Topic 1 to Exhibiting Depth');
    expect(screen.queryByText('✦')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "feedback load"`
Expected: FAIL — page does not call `getFeedbackForAssignment`; no overlay renders.

- [ ] **Step 3: Wire the fetch into the page**

Update the import on line 3:

```jsx
import { getMasteryForAssignment, syncMasteryForAssignment, writeMasteryScores, writeMasteryComment, sendAllGrades, createFlag, deleteFlag, getFeedbackForAssignment, getAssessmentAnalysis } from '../services/api.js';
```

Add `resolveRubricScores` import after the draft import (line 4):

```jsx
import { resolveRubricScores } from '../lib/rubricSuggestions.js';
```

Add page state next to the existing `data` state (~line 747):

```jsx
const [feedbackByStudent, setFeedbackByStudent] = useState({});
const [analysis, setAnalysis] = useState(null);
```

Replace `load()` (~lines 829-835) with a parallel fetch:

```jsx
function load() {
  setLoading(true);
  Promise.all([
    getMasteryForAssignment(courseId, assignmentId),
    getFeedbackForAssignment(assignmentId).catch(() => ({})),
    getAssessmentAnalysis(assignmentId).catch(() => null),
  ])
    .then(([mastery, feedback, analysisRow]) => {
      setData(mastery);
      setFeedbackByStudent(feedback || {});
      setAnalysis(analysisRow || null);
    })
    .catch(e => setError(e.message))
    .finally(() => setLoading(false));
}
```

Pass each card its row in the `students.map` (~lines 906-919) by adding the prop:

```jsx
<StudentRubricCard
  key={student.schoology_uid}
  student={student}
  topics={alignedTopics}
  courseId={courseId}
  assignmentId={assignmentId}
  assignmentRow={assignment}
  feedbackRow={feedbackByStudent[student.id] || null}
  onSaved={handleCardSaved}
  onPendingChange={handlePendingChange}
  registerCard={registerCard}
  unregisterCard={unregisterCard}
/>
```

- [ ] **Step 4: Consume `feedbackRow` in the card to drive the overlay**

Add `feedbackRow` to the `StudentRubricCard` destructured props (~line 48):

```jsx
export function StudentRubricCard({ student, topics, courseId, assignmentId, assignmentRow, feedbackRow, onSaved, onPendingChange, registerCard, unregisterCard }) {
```

Add a resolved-suggestions map near the top of the component body (after `currentBaseline`, ~line 53):

```jsx
// Reviewer rubric suggestions resolved to topic ids (spec §5). Best-effort:
// unresolved keys / out-of-set values are silently dropped by the resolver.
const suggestedByTopic = resolveRubricScores(feedbackRow?.feedback_parsed?.rubric_scores, topics);
```

Replace the Slice-1 placeholder line inside `topics.map` (`const suggestedLevel = null;`) with the real value:

```jsx
const suggestedLevel = suggestedByTopic[t.id] || null;
```

- [ ] **Step 5: Run the tests + full suite**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS — overlay tests green; the existing `Send all bar` tests still pass (their `makeData` returns no feedback; the mock defaults `getFeedbackForAssignment` to `{}`).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment): load reviewer feedback and render rubric suggestion overlay"
```

### Task 4.3: Verify coexistence (the agree-case)

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.test.jsx`

This task adds the explicit coexistence tests required by spec §9. The rendering already supports it (Slice 1 composed suggestion-on-top); this locks it with tests and catches any regression.

- [ ] **Step 1: Write the coexistence tests**

Add to the `describe('AssessmentSummaryPage — feedback load (Slice 4)'...)` block:

```jsx
it('keeps the solid final border + dashed ring + ✦ when teacher mark and suggestion agree', async () => {
  const data = makeData();
  data.students[0].scores = { t1: { grade: 'ED', points: 100 } }; // teacher final on ED
  getMasteryForAssignment.mockResolvedValue(data);
  getFeedbackForAssignment.mockResolvedValue({
    1: { feedback_parsed: { rubric_scores: { X1: 'ED' } } }, // suggestion also ED
  });
  renderPage();
  const cell = await screen.findByTitle('Set Topic 1 to Exhibiting Depth');
  await waitFor(() => expect(cell).toHaveTextContent('✦'));
  // Final fill wins (no violet wash over a finalized cell), final border stays,
  // dashed violet ring nests inside via outline.
  expect(cell).toHaveStyle({
    background: '#bfdbfe', border: '2px solid #2563eb',
    outline: '1px dashed #a78bfa',
  });
});

it('places teacher mark and suggestion on different cells side by side', async () => {
  const data = makeData();
  data.students[0].scores = { t1: { grade: 'ED', points: 100 } }; // final ED
  getMasteryForAssignment.mockResolvedValue(data);
  getFeedbackForAssignment.mockResolvedValue({
    1: { feedback_parsed: { rubric_scores: { X1: 'EX' } } }, // suggestion EX
  });
  renderPage();
  const finalCell = await screen.findByTitle('Set Topic 1 to Exhibiting Depth'); // ED
  const suggCell = screen.getByTitle('Set Topic 1 to Exhibiting');             // EX
  expect(finalCell).toHaveStyle({ background: '#bfdbfe' });   // final, no ✦
  expect(finalCell).not.toHaveTextContent('✦');
  expect(suggCell).toHaveStyle({ background: '#ede9fe' });    // violet wash + ✦
  expect(suggCell).toHaveTextContent('✦');
});
```

- [ ] **Step 2: Run to verify they pass (no code change needed)**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "agree"`
Expected: PASS — if either fails, the Slice-1 cell composition is wrong; fix the `isSuggested` branch (the violet wash must be suppressed whenever `hasTeacherMark`, and `outline` must not clobber a removal outline).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "test(assessment): lock rubric suggestion coexistence (agree-case)"
```

---

# Slice 5 — Per-student card chrome

Adds, top-to-bottom (mockup 02): the reviewer-flags strip above the rubric; the hero Overall Comment; the control band (Update Schoology, eye-icon display toggle, trash-icon discard, `↑ Use suggestion`); and the unbranded suggested-feedback box. All new colours are inline per the spec.

### Task 5.1: Reviewer flags strip (above the rubric)

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (insert before the rubric grid `<div>`, ~line 555)

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `AssessmentSummaryPage.test.jsx`:

```jsx
describe('StudentRubricCard — card chrome (Slice 5)', () => {
  const withFeedback = (parsed) => ({ feedbackRow: { feedback_parsed: parsed } });

  it('renders the reviewer-flags strip, collapsed by default, when reviewer_flags is present', () => {
    renderCard(withFeedback({ reviewer_flags: 'No prototype link pasted.' }));
    const summary = screen.getByText(/Reviewer flags/);
    expect(summary).toBeInTheDocument();
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open'); // collapsed by default
    expect(details).toHaveTextContent('No prototype link pasted.');
  });

  it('does not render the flags strip when reviewer_flags is absent', () => {
    renderCard(withFeedback({ narrative_feedback: 'x' }));
    expect(screen.queryByText(/Reviewer flags/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "reviewer-flags strip"`
Expected: FAIL — no flags strip exists.

- [ ] **Step 3: Add a derived value + the strip markup**

Add near `suggestedByTopic` (~line 53):

```jsx
const reviewerFlags = feedbackRow?.feedback_parsed?.reviewer_flags || null;
const narrativeSuggestion = feedbackRow?.feedback_parsed?.narrative_feedback || null;
const hasSuggestion = !!narrativeSuggestion || Object.keys(suggestedByTopic).length > 0;
```

Insert the strip immediately inside the rubric-grid wrapper, *before* the `<table>` — but since the wrapper applies `overflow-x:auto`, place the strip just **before** that wrapper `<div style={{ overflowX: 'auto'... }}>` (~line 555):

```jsx
{reviewerFlags && (
  <details style={{
    border: '1px solid #e6c98a', background: '#fffbef', borderRadius: 7,
    margin: '0.75rem 1rem 0',
  }}>
    <summary style={{
      cursor: 'pointer', listStyle: 'none', padding: '0.45rem 0.7rem',
      fontSize: '0.72rem', fontWeight: 600, color: '#92740f',
      display: 'flex', alignItems: 'center', gap: '0.45rem',
    }}>
      ⚑ Reviewer flags
    </summary>
    <div style={{ padding: '0 0.7rem 0.6rem', fontSize: '0.72rem', lineHeight: 1.5, color: '#5a4a1f' }}>
      {reviewerFlags}
    </div>
  </details>
)}
```

- [ ] **Step 4: Run the tests + full suite**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment): reviewer-flags strip above the rubric"
```

### Task 5.2: Hero comment + control band (eye-icon toggle, trash-icon discard)

Reworks the comment/control area (current ~lines 650-738) into the hero comment + control band from mockup 02. The display toggle becomes an eye icon + switch (no text label, `title="Display to student"`), and Discard becomes an always-shown trash icon, disabled when there are no pending changes. `Use suggestion` is added in Task 5.3.

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (~lines 650-738)

- [ ] **Step 1: Write the failing tests**

Add to the `describe('StudentRubricCard — card chrome (Slice 5)'...)` block:

```jsx
it('makes the comment the hero with a bold label and a larger textarea', () => {
  renderCard();
  const ta = screen.getByPlaceholderText(/Teacher comment/i);
  expect(ta).toHaveStyle({ fontSize: '0.84rem' });
});

it('shows the display toggle as an eye-icon switch with no text label', () => {
  renderCard();
  const toggle = screen.getByRole('switch', { name: /display to student/i });
  expect(toggle).toBeInTheDocument();
  // The old visible "Display to student" text label is gone (title carries it).
  expect(screen.queryByText('Display to student')).not.toBeInTheDocument();
});

it('always shows the discard control, disabled when there are no pending changes', () => {
  renderCard();
  const discard = screen.getByRole('button', { name: /discard changes/i });
  expect(discard).toBeDisabled();
});

it('enables discard once there is a pending change and clears it on click', () => {
  renderCard();
  fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
  const discard = screen.getByRole('button', { name: /discard changes/i });
  expect(discard).toBeEnabled();
  fireEvent.click(discard);
  expect(screen.queryByText(/pending change/)).not.toBeInTheDocument();
});
```

> Note: the existing draft-persistence test `clears the stored draft when changes are discarded` uses `getByRole('button', { name: /discard changes/i })` — it keeps working because the trash button carries `aria-label="Discard changes"`.

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "card chrome"`
Expected: FAIL — textarea is `0.82rem`, the text label still renders, discard is conditionally rendered (not disabled-when-empty).

- [ ] **Step 3: Rewrite the comment + control band**

Replace the entire `{/* Comment + update */}` block (~lines 650-738) with:

```jsx
{/* Overall Comment — the hero */}
<div style={{ padding: '0.75rem 1rem' }}>
  <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, margin: '0 0 0.35rem', color: '#333' }}>
    Overall Comment
  </label>
  <textarea
    value={comment}
    onChange={e => applyComment(e.target.value)}
    onPaste={e => {
      const raw = e.clipboardData.getData('text/plain');
      if (!raw) return;
      e.preventDefault();
      const cleaned = normalizePastedText(raw);
      const el = e.target;
      const { selectionStart, selectionEnd } = el;
      const next = comment.slice(0, selectionStart) + cleaned + comment.slice(selectionEnd);
      applyComment(next);
      requestAnimationFrame(() => {
        const pos = selectionStart + cleaned.length;
        el.setSelectionRange(pos, pos);
      });
    }}
    rows={4}
    style={{
      width: '100%', boxSizing: 'border-box', border: '1.5px solid var(--border)',
      borderRadius: 8, padding: '0.6rem', fontSize: '0.84rem', lineHeight: 1.45,
      fontFamily: 'inherit', resize: 'vertical', color: 'var(--text)',
    }}
    placeholder="Teacher comment for this student on this assessment..."
  />

  {/* Control band — directly under the comment (creates the focus boundary) */}
  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.6rem' }}>
    <button
      className="primary"
      onClick={handleSave}
      disabled={saving || !hasPendingChanges}
      title="Write scores & comment back to Schoology"
    >
      {saving ? 'Saving...' : 'Update Schoology'}
    </button>

    {/* Display-to-student: eye icon + switch, no text label */}
    <span
      role="switch"
      aria-checked={display}
      aria-label="Display to student"
      title="Display to student"
      tabIndex={0}
      onClick={() => { setDisplay(d => !d); setAutoFlipArmed(false); }}
      onKeyDown={e => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          setDisplay(d => !d);
          setAutoFlipArmed(false);
        }
      }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
        border: '1px solid var(--border)', borderRadius: 7,
        padding: '0.18rem 0.4rem', background: 'var(--card-bg)',
        color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none',
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" />
      </svg>
      <span style={{
        position: 'relative', width: 28, height: 16, borderRadius: 9,
        background: display ? 'var(--accent)' : 'var(--bg-subtle)',
        border: '1px solid var(--border)', transition: 'background 0.15s',
      }}>
        <span style={{
          position: 'absolute', top: 1, left: display ? 13 : 1,
          width: 12, height: 12, borderRadius: '50%', background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)', transition: 'left 0.15s',
        }} />
      </span>
    </span>

    {/* Discard — trash icon, always shown, disabled when nothing pending */}
    <button
      onClick={() => {
        setPending({});
        setComment(student.grade_comment || '');
        setDisplay(loadedDisplay);
        setAutoFlipArmed(student.comment_status !== 1 && !student.grade_comment);
      }}
      disabled={!hasPendingChanges}
      aria-label="Discard changes"
      title={hasPendingChanges ? 'Discard changes' : 'Discard changes (nothing to discard)'}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 30, height: 28, borderRadius: 7,
        border: '1px solid var(--border)', background: 'var(--card-bg)',
        color: hasPendingChanges ? 'var(--text-muted)' : 'var(--border)',
        cursor: hasPendingChanges ? 'pointer' : 'default',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
      </svg>
    </button>

    {/* ↑ Use suggestion — added in Task 5.3 */}
  </div>
</div>
```

- [ ] **Step 4: Run the tests + full suite**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS — including the pre-existing display-toggle and discard tests (they target the `switch` role and the `discard changes` accessible name, both preserved).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment): hero comment + icon control band"
```

### Task 5.3: `↑ Use suggestion` + suggested-feedback box

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (control band + below it)

- [ ] **Step 1: Write the failing tests**

Add to the `describe('StudentRubricCard — card chrome (Slice 5)'...)` block:

```jsx
const withFeedback2 = (parsed) => ({ feedbackRow: { feedback_parsed: parsed } });

it('shows the suggested-feedback box and Use suggestion only when a suggestion exists', () => {
  renderCard(); // no feedbackRow
  expect(screen.queryByText('✦ Suggested feedback')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /use suggestion/i })).not.toBeInTheDocument();
});

it('renders the suggestion box (read-only) and Use suggestion when narrative_feedback exists', () => {
  renderCard(withFeedback2({ narrative_feedback: 'Excellent work, Ada!' }));
  expect(screen.getByText('✦ Suggested feedback')).toBeInTheDocument();
  expect(screen.getByText('Excellent work, Ada!')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /use suggestion/i })).toBeInTheDocument();
});

it('Use suggestion overwrites the comment with normalized text and arms pending changes', () => {
  renderCard(withFeedback2({ narrative_feedback: 'Line one.\v\v​Line two.' }));
  fireEvent.click(screen.getByRole('button', { name: /use suggestion/i }));
  const ta = screen.getByPlaceholderText(/Teacher comment/i);
  expect(ta).toHaveValue('Line one.\n\nLine two.'); // normalizePastedText applied
  expect(screen.getByRole('button', { name: 'Update Schoology' })).toBeEnabled();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "Use suggestion"`
Expected: FAIL — neither the button nor the box exists.

- [ ] **Step 3: Add the button to the control band**

Replace the `{/* ↑ Use suggestion — added in Task 5.3 */}` comment with:

```jsx
{hasSuggestion && narrativeSuggestion && (
  <button
    className="btn-violet"
    onClick={() => applyComment(normalizePastedText(narrativeSuggestion))}
    title="Copy the suggestion up into your comment"
    style={{
      borderRadius: 7, padding: '0.4rem 0.75rem', fontSize: '0.74rem',
      fontWeight: 600, cursor: 'pointer',
      background: '#ede9fe', color: '#6d28d9', border: '1px solid #c4b5fd',
    }}
  >
    ↑ Use suggestion
  </button>
)}
```

- [ ] **Step 4: Add the suggested-feedback box below the control band**

Immediately after the control-band closing `</div>` (still inside the `padding: '0.75rem 1rem'` comment wrapper), add:

```jsx
{narrativeSuggestion && (
  <div style={{
    marginTop: '0.55rem', border: '1px solid #e6e1f3', background: '#faf9fd',
    borderRadius: 7, padding: '0.5rem 0.65rem',
  }}>
    <div style={{
      fontSize: '0.63rem', fontWeight: 600, color: '#9a90b8',
      letterSpacing: '0.03em', marginBottom: '0.28rem',
      display: 'flex', alignItems: 'center', gap: '0.3rem',
    }}>
      ✦ Suggested feedback
    </div>
    <div style={{ fontSize: '0.72rem', lineHeight: 1.4, color: '#716b85', whiteSpace: 'pre-wrap' }}>
      {narrativeSuggestion}
    </div>
  </div>
)}
```

- [ ] **Step 5: Run the tests + full suite**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment): suggested-feedback box + Use suggestion"
```

---

# Slice 6 — Sticky header + Reviewer Analysis drawer

Makes the page header sticky, removes the now-stale proficiency legend, and adds a header-mounted `✦ Reviewer Analysis` button (rendered only when an analysis exists) that opens a right-side drawer with the computed proposed-score distribution + prose noticings.

### Task 6.1: Sticky header + remove the proficiency legend

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (header ~lines 862-898)

- [ ] **Step 1: Write the failing test**

Add a new describe block to `AssessmentSummaryPage.test.jsx` (reuse the Slice-4 `makeData`/`renderPage` — declare local copies inside this block to keep it self-contained):

```jsx
describe('AssessmentSummaryPage — header + Reviewer Analysis (Slice 6)', () => {
  function makeData() {
    return {
      assignment: { id: 50, schoology_assignment_id: '8', title: 'Quiz', mastery_grading_period_id: 1, mastery_grading_category_id: 2 },
      topics: [{ id: 't1', title: 'Topic 1', category_title: 'Cat', external_id: 'X1' }],
      students: [{ ...makeStudent(), id: 1, schoology_uid: 'uid-1', enrollment_id: 'enr-1', scores: {} }],
    };
  }
  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/course/4/assessment/8']}>
        <Routes>
          <Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('removes the stale proficiency legend', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    renderPage();
    await screen.findByText('Quiz');
    expect(screen.queryByText(/green border = pending/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "stale proficiency legend"`
Expected: FAIL — the legend with `green border = pending · solid green = current` still renders.

- [ ] **Step 3: Make the header sticky and delete the legend**

Replace the header wrapper opening `<div style={{ marginBottom: '1.25rem' }}>` (~line 863) with a sticky wrapper:

```jsx
<div style={{
  position: 'sticky', top: 0, zIndex: 5, background: 'var(--bg)',
  marginBottom: '1.25rem', padding: '0.55rem 0',
  borderBottom: '1px solid var(--border)',
}}>
```

Delete the entire `{/* Proficiency level legend */}` block (~lines 883-898).

- [ ] **Step 4: Run the test + full suite**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS — legend gone; no other test referenced it.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment): sticky header, remove stale proficiency legend"
```

### Task 6.2: Reviewer Analysis button (conditional) + drawer shell

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (header row ~line 870; new drawer markup; imports)

- [ ] **Step 1: Write the failing tests**

Add to the `describe('AssessmentSummaryPage — header + Reviewer Analysis (Slice 6)'...)` block:

```jsx
it('does not render the Reviewer Analysis button when no analysis exists', async () => {
  getMasteryForAssignment.mockResolvedValue(makeData());
  getFeedbackForAssignment.mockResolvedValue({});
  getAssessmentAnalysis.mockResolvedValue(null);
  renderPage();
  await screen.findByText('Quiz');
  expect(screen.queryByRole('button', { name: /reviewer analysis/i })).not.toBeInTheDocument();
});

it('renders the button when at least one feedback row exists', async () => {
  getMasteryForAssignment.mockResolvedValue(makeData());
  getFeedbackForAssignment.mockResolvedValue({ 1: { feedback_parsed: { rubric_scores: { X1: 'ED' } } } });
  getAssessmentAnalysis.mockResolvedValue(null);
  renderPage();
  expect(await screen.findByRole('button', { name: /reviewer analysis/i })).toBeInTheDocument();
});

it('renders the button when an analysis record exists even without feedback rows', async () => {
  getMasteryForAssignment.mockResolvedValue(makeData());
  getFeedbackForAssignment.mockResolvedValue({});
  getAssessmentAnalysis.mockResolvedValue({ analysis_parsed: { noticings: [] } });
  renderPage();
  expect(await screen.findByRole('button', { name: /reviewer analysis/i })).toBeInTheDocument();
});

it('opens the drawer with the not-student-facing tag and closes via ✕', async () => {
  getMasteryForAssignment.mockResolvedValue(makeData());
  getFeedbackForAssignment.mockResolvedValue({ 1: { feedback_parsed: { rubric_scores: { X1: 'ED' } } } });
  getAssessmentAnalysis.mockResolvedValue({ analysis_parsed: { noticings: [] } });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: /reviewer analysis/i }));
  expect(screen.getByText('not student-facing')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /close reviewer analysis/i }));
  await waitFor(() => expect(screen.queryByText('not student-facing')).not.toBeInTheDocument());
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "Reviewer Analysis"`
Expected: FAIL — no button, no drawer.

- [ ] **Step 3: Add drawer state + presence flag + button**

Add page state near the other `useState`s (~line 758):

```jsx
const [drawerOpen, setDrawerOpen] = useState(false);
```

After `const { assignment, topics, students } = data;` (~line 857), compute the presence flag:

```jsx
const hasAnalysis = Object.keys(feedbackByStudent).length > 0 || !!analysis;
```

Add the button at the right of the header meta row — inside the `<div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>` (~line 870), after the `refreshResult` span:

```jsx
{hasAnalysis && (
  <button
    onClick={() => setDrawerOpen(true)}
    title="Reviewer Analysis — not student-facing"
    style={{
      marginLeft: 'auto', border: '1px solid #c4b5fd', background: '#ede9fe',
      color: '#6d28d9', borderRadius: 7, padding: '0.32rem 0.7rem',
      fontSize: '0.74rem', fontWeight: 700, cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
    }}
  >
    ✦ Reviewer Analysis
  </button>
)}
```

- [ ] **Step 4: Add the drawer shell (overlay + panel)**

Just before the final closing `</div>` of the page's returned `fade-in` root (after the `students.length === 0 ? ... : (...)` block, ~line 951), add:

```jsx
{drawerOpen && (
  <>
    <div
      onClick={() => setDrawerOpen(false)}
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,20,30,0.28)', zIndex: 40 }}
    />
    <div style={{
      position: 'fixed', top: 0, right: 0, height: '100%', width: 360,
      background: 'var(--card-bg)', boxShadow: '-6px 0 20px rgba(0,0,0,0.16)',
      zIndex: 50, overflowY: 'auto',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.5rem',
        padding: '0.65rem 0.85rem', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-subtle)', position: 'sticky', top: 0,
      }}>
        <span style={{ color: '#8b5cf6' }}>✦</span>
        <span style={{ fontWeight: 700, fontSize: '0.84rem' }}>Reviewer Analysis</span>
        <span style={{
          fontSize: '0.58rem', background: 'var(--bg-subtle)', color: 'var(--text-muted)',
          borderRadius: 5, padding: '1px 5px', fontWeight: 600,
        }}>not student-facing</span>
        <button
          onClick={() => setDrawerOpen(false)}
          aria-label="Close Reviewer Analysis"
          style={{
            marginLeft: 'auto', cursor: 'pointer', color: 'var(--text-muted)',
            fontSize: '1.05rem', lineHeight: 1, border: 'none', background: 'none',
          }}
        >✕</button>
      </div>
      <ReviewerAnalysisBody
        topics={topics}
        feedbackRows={Object.values(feedbackByStudent)}
        analysis={analysis?.analysis_parsed || null}
      />
    </div>
  </>
)}
```

- [ ] **Step 5: Add a placeholder `ReviewerAnalysisBody` component**

Above `export default function AssessmentSummaryPage()` (~line 745), add a stub (filled in Task 6.3):

```jsx
function ReviewerAnalysisBody({ topics, feedbackRows, analysis }) {
  return <div style={{ padding: '0.8rem' }} />;
}
```

- [ ] **Step 6: Run the tests + full suite**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment): Reviewer Analysis button + drawer shell"
```

### Task 6.3: Drawer contents — proposed distribution + noticings

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (`ReviewerAnalysisBody`, imports)

- [ ] **Step 1: Write the failing tests**

Add to the `describe('AssessmentSummaryPage — header + Reviewer Analysis (Slice 6)'...)` block:

```jsx
it('shows the proposed distribution computed from feedback and the noticings', async () => {
  const data = makeData();
  getMasteryForAssignment.mockResolvedValue(data);
  getFeedbackForAssignment.mockResolvedValue({
    1: { feedback_parsed: { rubric_scores: { X1: 'ED' } } },
    2: { feedback_parsed: { rubric_scores: { X1: 'EX' } } },
  });
  getAssessmentAnalysis.mockResolvedValue({
    analysis_parsed: {
      noticings: [{ title: 'AI tool use', body: 'Half the class used AI.' }],
      moderation_note: 'Worth a spot-check.',
    },
  });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: /reviewer analysis/i }));

  expect(screen.getByText(/From the reviewer's suggested grades/)).toBeInTheDocument();
  // Distribution segments labelled with counts for Topic 1: 1 ED, 1 EX.
  expect(screen.getByText(/1 ED/)).toBeInTheDocument();
  // Noticings + moderation note.
  expect(screen.getByText('AI tool use')).toBeInTheDocument();
  expect(screen.getByText('Half the class used AI.')).toBeInTheDocument();
  expect(screen.getByText(/Worth a spot-check/)).toBeInTheDocument();
});
```

> Note: the two-student distribution needs `feedbackByStudent` to contain both rows. The page keys by `student.id`; only student `id:1` is in `makeData().students`, but the distribution aggregates over **all** feedback rows (`Object.values(feedbackByStudent)`), independent of the roster — so both rows count. This matches the spec: the distribution is computed from the loaded feedback, not the visible roster.

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "proposed distribution"`
Expected: FAIL — `ReviewerAnalysisBody` is an empty stub.

- [ ] **Step 3: Import the distribution helper**

Extend the `rubricSuggestions` import (~line 5) to:

```jsx
import { resolveRubricScores, distributionByTopic } from '../lib/rubricSuggestions.js';
```

- [ ] **Step 4: Implement `ReviewerAnalysisBody`**

Replace the stub with:

```jsx
function ReviewerAnalysisBody({ topics, feedbackRows, analysis }) {
  const dist = distributionByTopic(feedbackRows, topics);
  const noticings = analysis?.noticings || [];
  const moderationNote = analysis?.moderation_note || null;

  return (
    <div style={{ padding: '0.8rem' }}>
      {/* Proposed score distribution */}
      <div style={{ marginBottom: '0.9rem' }}>
        <div style={{
          fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em',
          color: 'var(--text-muted)', fontWeight: 700, marginBottom: '0.15rem',
        }}>
          ✦ Proposed score distribution
        </div>
        <div style={{ fontSize: '0.6rem', color: '#9a90b8', marginBottom: '0.4rem' }}>
          From the reviewer's suggested grades — not final entered scores.
        </div>
        {topics.map(t => {
          const counts = dist[t.id] || { ED: 0, EX: 0, D: 0, EM: 0, IE: 0 };
          const total = LEVELS.reduce((sum, l) => sum + counts[l], 0);
          return (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.35rem' }}>
              <div style={{ width: 70, fontSize: '0.64rem', fontWeight: 600, flexShrink: 0 }}>{t.title}</div>
              <div style={{
                flex: 1, display: 'flex', height: 18, borderRadius: 4,
                overflow: 'hidden', border: '1px solid var(--border)',
                background: 'var(--bg-subtle)',
              }}>
                {total > 0 && LEVELS.filter(l => counts[l] > 0).map(l => (
                  <div key={l} style={{
                    flex: counts[l], display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.56rem', fontWeight: 700, color: CELL_TEXT,
                    background: CELL_COLORS[l].headerFill,
                  }}>
                    {counts[l]} {l}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {moderationNote && (
          <div style={{
            fontSize: '0.62rem', color: '#92740f', background: '#fffbef',
            border: '1px solid #f0dea8', borderRadius: 6, padding: '0.35rem 0.5rem',
            marginTop: '0.45rem', lineHeight: 1.35,
          }}>
            ⚖️ {moderationNote}
          </div>
        )}
      </div>

      {/* Noticings */}
      {noticings.length > 0 && (
        <div>
          <div style={{
            fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em',
            color: 'var(--text-muted)', fontWeight: 700, marginBottom: '0.45rem',
          }}>
            Noticings
          </div>
          {noticings.map((n, i) => (
            <div key={i} style={{ marginBottom: '0.55rem' }}>
              <div style={{ fontWeight: 700, fontSize: '0.68rem', marginBottom: '0.12rem' }}>{n.title}</div>
              <div style={{ fontSize: '0.66rem', lineHeight: 1.4, color: 'var(--text)' }}>{n.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests + full suite**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(assessment): Reviewer Analysis drawer contents"
```

---

# Final verification (spec §10)

- [ ] **Step 1: Full client build**

Run: `cd client && npx vite build`
Expected: build succeeds.

- [ ] **Step 2: Full server test suite**

Run: `npx vitest run server/`
Expected: all server suites pass (including the new `server/routes/feedback.test.js`).

- [ ] **Step 3: Full client test suite**

Run: `cd client && npx vitest run`
Expected: all client suites pass (page + `rubricSuggestions` lib).

- [ ] **Step 4: Manual check against the mockups**

Seed a draft `feedback` row (with `narrative_feedback`, `rubric_scores`, `reviewer_flags`) and an `assessment_analysis` record for an assignment, then open `/assessment/:id` and confirm:
- cell language matches mockup 01 (header tints, final/draft families, black text, clean corners);
- the agree-case shows solid final border + nested dashed violet ring + ✦ with no violet wash;
- clicking a drafted cell clears it; clicking a synced final stages removal (red dashed + ✕); Update Schoology clears that score;
- reviewer-flags strip (collapsed), hero comment, control band (eye toggle, trash discard, violet ↑ Use suggestion), and the unbranded suggested-feedback box match mockup 02;
- the sticky header has no legend; `✦ Reviewer Analysis` appears only when an analysis exists and opens the drawer with the proposed distribution + noticings (mockups 03/04).

Compare each against the local mockups in `docs/ui-design/PrisMCP-update/mockups/`.

---

## Self-review notes (coverage map vs spec)

- §1 colour system → Task 1.1 (`CELL_COLORS`, `SUGGEST`, `CELL_TEXT`), 1.2 (header), 1.3 (cells).
- §2 cell language incl. coexistence → Task 1.3 (composition) + 4.3 (agree-case tests).
- §3 interaction (clear-draft, stage-removal, no Accept button) → Tasks 2.1, 2.2.
- §4 per-student card (flags strip, hero, control band, suggestion box, Use suggestion) → Slice 5.
- §5 data model + endpoints + rubric_scores mapping → Slice 3 + Task 4.1 (resolver).
- §6 Reviewer Analysis drawer (sticky header, legend removal, conditional button, distribution, noticings) → Slice 6.
- §7 two-way flow → no new UI (symmetric by construction; satisfied by the suggestion-render path).
- §8 status lifecycle → server filters `approved` (Task 3.2); accept/Use suggestion arm pending via existing `hasPendingChanges`; the `teacher_modified`/`approved` flip on Update Schoology is the existing mastery-write + feedback-status path (no UI change here — note: flipping the feedback row's status on write is part of Project B's write path / existing `PUT /api/feedback/:id`; this UI surfaces only `draft`/`teacher_modified` rows and the server filter prevents `approved` re-surfacing).
- §9 testing → server tests (Slice 3), client tests across Slices 1–6.
- §10 verification → Final verification section.

**Out of scope (confirmed not planned):** PrisMCP server / ingestion beyond the read contract; final-grade distribution + unified Analysis drawer (#78); descriptor text replacing level codes; bulk accept-all.
