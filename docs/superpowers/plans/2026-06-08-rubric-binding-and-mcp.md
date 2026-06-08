# Rubric Binding UX, Grid Polish & Rubric MCP Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the rubric-descriptors follow-ups — interactive criterion→topic mapping, a tabbed "Manage rubrics" modal (attach existing / upload / export / delete), keyboard-accessible reorder, light-touch title matching, 1:1 mapping enforcement, IE/key polish — and add the `list_rubrics` / `read_rubric` / `write_rubric` MCP tools.

**Architecture:** No schema changes. Phase 1 hardens the server services/routes. Phase 2 builds a reusable `ReorderableList`, a `RubricManagerModal` (the single rubric-editing hub: Attach · Map criteria · Row order), simplifies `RubricDescriptorGrid` to grading-only, and rewires `AssessmentSummaryPage`. Phase 3 adds the three rubric MCP tools in `mcp/`, reusing `rubricStore.js`.

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest (server + MCP), React + Vite + React Testing Library (client), `@modelcontextprotocol/sdk` + zod (MCP).

**Spec:** `docs/superpowers/specs/2026-06-08-rubric-binding-and-mcp-design.md`

**Conventions observed:**
- Server/MCP tests run with `npx vitest run <path>` from the repo root (`npm run test:server` runs all). Client tests run with `cd client && npx vitest run <path>`.
- Server service tests open a fresh `new Database(':memory:')`, `db.pragma('foreign_keys = ON')`, `migrate(db)` per `beforeEach` (see `server/services/rubricStore.test.js`).
- Route tests set `process.env.DB_PATH=':memory:'` via `vi.hoisted` and use a `call()` helper (see `server/routes/rubrics.test.js`).
- MCP tests drive the real client/server over `InMemoryTransport` (see `mcp/server.test.js`).
- Client components use CSS vars (`var(--accent)`, `var(--border)`, `var(--card-bg)`, `var(--text-muted)`, `var(--bg-subtle)`, `var(--ai-suggest)`), `.ghost`/`.secondary`/`.primary`/`.filter-btn` button classes, and `toLocaleDateString('en-GB')` for dates. Never hardcode hex except the rubric level palette.

---

## Phase 1 — Server foundations

### Task 1: Expand `normalizeTitle` framings (item 3, light touch)

**Files:**
- Modify: `server/services/rubricMatch.js:1-7`
- Test: `server/services/rubricMatch.test.js`

- [ ] **Step 1: Add failing tests** for the new framings. Append inside the `describe('rubricMatch', …)` block in `server/services/rubricMatch.test.js`:

```js
  test('normalizeTitle strips a bare "Standard N:" prefix (no "Anchor")', () => {
    expect(normalizeTitle('Standard 2: Develop and refine artistic techniques and work for presentation'))
      .toBe(normalizeTitle('Develop and refine artistic techniques and work for presentation'));
  });

  test('normalizeTitle strips a framework code prefix like "VA:Cr1.1"', () => {
    expect(normalizeTitle('VA:Cr1.1 Generate and conceptualize artistic ideas'))
      .toBe(normalizeTitle('Generate and conceptualize artistic ideas'));
  });

  test('normalizeTitle strips leading list numbering "1." and "1)"', () => {
    const target = normalizeTitle('Select, analyze, and interpret artistic work for presentation');
    expect(normalizeTitle('1. Select, analyze, and interpret artistic work for presentation')).toBe(target);
    expect(normalizeTitle('1) Select, analyze, and interpret artistic work for presentation')).toBe(target);
  });

  test('normalizeTitle does not strip a plain "Word: phrase" with no code digit', () => {
    // "Critique:" is not a framework code — must survive (only its punctuation collapses)
    expect(normalizeTitle('Critique: respond to art')).toBe('critique respond to art');
  });
```

- [ ] **Step 2: Run the tests, verify the new ones fail**

Run: `npx vitest run server/services/rubricMatch.test.js`
Expected: the four new tests FAIL (current `normalizeTitle` only strips `Anchor Standard N:`); the existing three PASS.

- [ ] **Step 3: Implement the expanded `normalizeTitle`.** Replace the body in `server/services/rubricMatch.js`:

```js
export function normalizeTitle(s) {
  return (s || '')
    .toLowerCase()
    // "Anchor Standard 4:" / "Standard 2:" — the "anchor" word is optional
    .replace(/^\s*(anchor\s+)?standard\s*\d+\s*:\s*/i, '')
    // framework code prefix, e.g. "VA:Cr1.1" / "MA:Pr5.1" — letters, colon, then an
    // alnum/dot token that CONTAINS a digit (so plain "Word:" phrases are left alone)
    .replace(/^\s*[a-z]{1,5}:[a-z]*\d[a-z0-9.]*\s*[-–:.)]?\s*/i, '')
    // leading list numbering: "1." / "1)" / "1 -"
    .replace(/^\s*\d+\s*[.)\-]\s*/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Run the full file, verify green**

Run: `npx vitest run server/services/rubricMatch.test.js`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/rubricMatch.js server/services/rubricMatch.test.js
git commit -m "feat(rubrics): widen normalizeTitle framings (Standard N:, framework codes, list numbering)"
```

---

### Task 2: `setMapping` 1:1 move-semantics + unmap (items 1a/4)

**Files:**
- Modify: `server/services/rubricAttach.js:50-56`
- Test: `server/services/rubricAttach.test.js`

- [ ] **Step 1: Add failing tests.** Append inside `describe('rubricAttach', …)` in `server/services/rubricAttach.test.js`:

```js
  test('setMapping moves a topic off the criterion that previously held it (1:1)', () => {
    attachRubric(db, { rubricId, courseId: 4, assignmentId: '800' });
    const att = getAttachmentForAssignment(db, '800');
    const [c1, c2] = att.rubric.criteria;            // c1→t1, c2→t2 from auto-match
    setMapping(db, att.id, c2.id, 't1');             // give t1 (held by c1) to c2
    const map = getAttachmentForAssignment(db, '800').topicByCriterion;
    expect(map.find(m => m.criterion_id === c2.id).topic_id).toBe('t1');
    expect(map.find(m => m.criterion_id === c1.id)).toBeUndefined(); // c1 freed
  });

  test('setMapping with a null topic unmaps the criterion', () => {
    attachRubric(db, { rubricId, courseId: 4, assignmentId: '800' });
    const att = getAttachmentForAssignment(db, '800');
    const [c1] = att.rubric.criteria;
    setMapping(db, att.id, c1.id, null);
    expect(getAttachmentForAssignment(db, '800').topicByCriterion
      .find(m => m.criterion_id === c1.id)).toBeUndefined();
  });
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run server/services/rubricAttach.test.js`
Expected: the two new tests FAIL (current `setMapping` upserts without freeing the other criterion and throws on a null topic via the NOT NULL `topic_id`).

- [ ] **Step 3: Implement move-semantics + unmap.** Replace `setMapping` in `server/services/rubricAttach.js`:

```js
export function setMapping(db = getDb(), attachmentId, criterionId, topicId) {
  // Unmap: a null/empty topic removes this criterion's binding.
  if (topicId == null || topicId === '') {
    db.prepare(`DELETE FROM rubric_attachment_topics WHERE attachment_id = ? AND criterion_id = ?`)
      .run(attachmentId, criterionId);
    return;
  }
  // 1:1 move-semantics: free this topic from any OTHER criterion first, then bind it here.
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM rubric_attachment_topics WHERE attachment_id = ? AND topic_id = ? AND criterion_id != ?`
    ).run(attachmentId, topicId, criterionId);
    db.prepare(
      `INSERT INTO rubric_attachment_topics (attachment_id, criterion_id, topic_id)
       VALUES (?, ?, ?)
       ON CONFLICT(attachment_id, criterion_id) DO UPDATE SET topic_id = excluded.topic_id`
    ).run(attachmentId, criterionId, topicId);
  });
  txn();
}
```

- [ ] **Step 4: Run, verify green** (including the existing `setMapping upserts…` test which still holds — moving a topic that no other criterion holds is a plain upsert)

Run: `npx vitest run server/services/rubricAttach.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/rubricAttach.js server/services/rubricAttach.test.js
git commit -m "feat(rubrics): enforce 1:1 criterion↔topic in setMapping + support unmap"
```

---

### Task 3: `listRubrics` reports `attachment_count`

**Files:**
- Modify: `server/services/rubricStore.js:64-70`
- Test: `server/services/rubricStore.test.js`

- [ ] **Step 1: Add a failing test.** Append inside `describe('rubricStore', …)` in `server/services/rubricStore.test.js`:

```js
  test('listRubrics reports how many assignments each rubric is attached to', () => {
    const id = saveRubric(db, CONTENT);
    db.prepare(
      `INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at)
       VALUES (?, '800', NULL, '2026-01-01')`
    ).run(id);
    expect(listRubrics(db)[0]).toMatchObject({ id, attachment_count: 1, criteria_count: 2 });
  });
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run server/services/rubricStore.test.js`
Expected: new test FAILS (`attachment_count` is `undefined`).

- [ ] **Step 3: Implement.** Replace `listRubrics` in `server/services/rubricStore.js`:

```js
export function listRubrics(db = getDb()) {
  return db.prepare(
    `SELECT r.id, r.name, r.source, r.updated_at,
            (SELECT COUNT(*) FROM rubric_criteria c WHERE c.rubric_id = r.id) AS criteria_count,
            (SELECT COUNT(*) FROM rubric_attachments a WHERE a.rubric_id = r.id) AS attachment_count
     FROM rubrics r ORDER BY r.updated_at DESC, r.id DESC`
  ).all();
}
```

- [ ] **Step 4: Run, verify green** (existing `listRubrics returns summaries` test uses `objectContaining`, so the extra column is fine)

Run: `npx vitest run server/services/rubricStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/rubricStore.js server/services/rubricStore.test.js
git commit -m "feat(rubrics): surface attachment_count in listRubrics for delete-safety UI"
```

---

### Task 4: `DELETE /api/rubrics/:id` route + client method

**Files:**
- Modify: `server/routes/rubrics.js:5` (import) and `:72-75` (add route near the other delete)
- Modify: `client/src/services/api.js:171` (add `deleteRubric`)
- Test: `server/routes/rubrics.test.js`

- [ ] **Step 1: Add a failing route test.** In `server/routes/rubrics.test.js`, add the store import at the top (after the existing imports):

```js
import { saveRubric } from '../services/rubricStore.js';
```

Then append inside `describe('rubrics route', …)`:

```js
  test('DELETE /:id removes the rubric and cascades to its attachments', async () => {
    const id = saveRubric(getDb(), { name: 'Doomed', source: 'csv', criteria: [] });
    // FK cascade relies on getDb() setting PRAGMA foreign_keys = ON (server/db/index.js:150).
    getDb().prepare(
      `INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at)
       VALUES (?, '800', NULL, '2026-01-01')`
    ).run(id);
    const del = await call('DELETE', `/api/rubrics/${id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });
    expect((await call('GET', '/api/rubrics')).body).toEqual([]);
    expect(getDb().prepare(`SELECT COUNT(*) c FROM rubric_attachments`).get().c).toBe(0);
  });
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run server/routes/rubrics.test.js`
Expected: new test FAILS (404 — no `DELETE /:id` route).

- [ ] **Step 3a: Implement the route.** In `server/routes/rubrics.js`, add `deleteRubric` to the rubricStore import (line 5):

```js
import { listRubrics, saveRubric, getRubric, deleteRubric } from '../services/rubricStore.js';
```

Then add the route just below the existing `DELETE /attachment/:attachmentId` handler (a single-segment `/:id` cannot shadow the two-segment attachment route):

```js
router.delete('/:id', (req, res) => {
  deleteRubric(getDb(), Number(req.params.id));
  res.json({ ok: true });
});
```

- [ ] **Step 3b: Add the client method.** In `client/src/services/api.js`, just after `rubricExportUrl` (line ~172) add:

```js
export const deleteRubric = (id) => request(`/rubrics/${id}`, { method: 'DELETE' });
```

- [ ] **Step 4: Run, verify green**

Run: `npx vitest run server/routes/rubrics.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/rubrics.js server/routes/rubrics.test.js client/src/services/api.js
git commit -m "feat(rubrics): add DELETE /api/rubrics/:id route + client deleteRubric"
```

---

## Phase 2 — Client modal, grid & page

### Task 5: `ReorderableList` reusable component (item 2 a11y core)

**Files:**
- Create: `client/src/components/ReorderableList.jsx`
- Test: `client/src/components/ReorderableList.test.jsx`

- [ ] **Step 1: Write the failing test.** Create `client/src/components/ReorderableList.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReorderableList from './ReorderableList.jsx';

function setup(onReorder = vi.fn()) {
  const items = [
    { id: 'a', label: 'Alpha', content: 'Alpha' },
    { id: 'b', label: 'Bravo', content: 'Bravo' },
    { id: 'c', label: 'Charlie', content: 'Charlie' },
  ];
  render(<ReorderableList items={items} onReorder={onReorder} />);
  return onReorder;
}

describe('ReorderableList', () => {
  it('moves an item down via its ▼ button', () => {
    const onReorder = setup();
    fireEvent.click(screen.getByLabelText('Move Alpha down'));
    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('moves a focused item up with the ArrowUp key', () => {
    const onReorder = setup();
    fireEvent.keyDown(screen.getByText('Charlie').closest('li'), { key: 'ArrowUp' });
    expect(onReorder).toHaveBeenCalledWith(['a', 'c', 'b']);
  });

  it('reorders on drag and drop', () => {
    const onReorder = setup();
    const rows = screen.getAllByRole('listitem');
    fireEvent.dragStart(rows[2]);  // Charlie
    fireEvent.dragOver(rows[0]);   // over Alpha
    fireEvent.drop(rows[0]);
    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b']);
  });

  it('highlights the drop target during a drag', () => {
    setup();
    const rows = screen.getAllByRole('listitem');
    fireEvent.dragStart(rows[2]);
    fireEvent.dragOver(rows[0]);
    expect(rows[0]).toHaveStyle({ boxShadow: 'inset 0 2px 0 0 var(--accent)' });
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd client && npx vitest run src/components/ReorderableList.test.jsx`
Expected: FAIL — "Failed to resolve import './ReorderableList.jsx'".

- [ ] **Step 3: Implement the component.** Create `client/src/components/ReorderableList.jsx`:

```jsx
import { useRef, useState } from 'react';

// Generic keyboard- and pointer-accessible reorderable list.
// items: [{ id, label, content }] — label is the plain-text a11y name, content the node.
// onReorder(orderedIds) fires on every committed move; the parent owns persistence.
export default function ReorderableList({ items, onReorder }) {
  const dragFrom = useRef(null);
  const [overId, setOverId] = useState(null);
  const ids = items.map((i) => i.id);

  function dropMove(fromId, toId) {
    if (fromId == null || toId == null || fromId === toId) return;
    const next = ids.slice();
    next.splice(next.indexOf(fromId), 1);
    next.splice(next.indexOf(toId), 0, fromId);
    onReorder(next);
  }
  function nudge(id, dir) {
    const idx = ids.indexOf(id);
    const swap = idx + dir;
    if (swap < 0 || swap >= ids.length) return;
    const next = ids.slice();
    [next[idx], next[swap]] = [next[swap], next[idx]];
    onReorder(next);
  }

  return (
    <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {items.map((item) => (
        <li
          key={item.id}
          tabIndex={0}
          draggable
          onDragStart={() => { dragFrom.current = item.id; }}
          onDragOver={(e) => { e.preventDefault(); setOverId(item.id); }}
          onDragLeave={() => setOverId((o) => (o === item.id ? null : o))}
          onDrop={() => { dropMove(dragFrom.current, item.id); dragFrom.current = null; setOverId(null); }}
          onDragEnd={() => { dragFrom.current = null; setOverId(null); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') { e.preventDefault(); nudge(item.id, -1); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(item.id, +1); }
          }}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.35rem 0.5rem', marginBottom: 4,
            border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card-bg)',
            boxShadow: overId === item.id ? 'inset 0 2px 0 0 var(--accent)' : 'none',
          }}
        >
          <span aria-hidden="true" style={{ cursor: 'grab', color: 'var(--text-muted)', userSelect: 'none' }}>⠿</span>
          <span style={{ flex: 1 }}>{item.content}</span>
          <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 0.7 }}>
            <button type="button" className="ghost" aria-label={`Move ${item.label} up`}
              style={{ padding: '0 5px', fontSize: '0.7rem' }} onClick={() => nudge(item.id, -1)}>▲</button>
            <button type="button" className="ghost" aria-label={`Move ${item.label} down`}
              style={{ padding: '0 5px', fontSize: '0.7rem' }} onClick={() => nudge(item.id, +1)}>▼</button>
          </span>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Run, verify green**

Run: `cd client && npx vitest run src/components/ReorderableList.test.jsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ReorderableList.jsx client/src/components/ReorderableList.test.jsx
git commit -m "feat(rubrics): add keyboard- and drag-accessible ReorderableList"
```

---

### Task 6: Simplify `RubricDescriptorGrid` (remove reorder; fix IE + key)

**Files:**
- Modify: `client/src/components/RubricDescriptorGrid.jsx`
- Test: `client/src/components/RubricDescriptorGrid.test.jsx`

- [ ] **Step 1: Update the tests.** In `client/src/components/RubricDescriptorGrid.test.jsx`, **delete** the entire `it('calls onReorder with the new criterion order after a drag', …)` test (lines ~46-58). Then append a new test inside the `describe`:

```jsx
  it('renders "Insufficient Evidence" in an uncovered topic\'s IE cell', () => {
    const uncovered = [{ topic: { id: 't9', title: 'Orphan topic', category_title: 'Produce', external_id: 'X9' }, criterion: null }];
    render(<RubricDescriptorGrid rows={uncovered} levels={LEVELS} cellState={() => ({})}
      onSelect={() => {}} palette={palette} levelHeaderColors={headerColors} levelBorderColors={borderColors} />);
    // header IE + the uncovered row's IE cell both read "Insufficient Evidence"
    expect(screen.getAllByText('Insufficient Evidence')).toHaveLength(2);
  });
```

- [ ] **Step 2: Run, verify failure**

Run: `cd client && npx vitest run src/components/RubricDescriptorGrid.test.jsx`
Expected: the new IE test FAILS (uncovered IE cell currently renders blank → only the header matches, length 1).

- [ ] **Step 3: Rewrite the component.** Replace the whole of `client/src/components/RubricDescriptorGrid.jsx` with the reorder-free version (drops `onReorder`, `dragFrom`, `ids`, `handleDrop`, the `draggable`/drag handlers and the grip span; composite row key; IE default for uncovered topics):

```jsx
import AiSparkle from './AiSparkle.jsx';
import { categoryColor } from '../lib/rubricColors.js';

const LEVEL_LABELS = {
  ED: 'Exhibiting Depth', EX: 'Exhibiting', D: 'Developing', EM: 'Emerging', IE: 'Insufficient Evidence',
};

export default function RubricDescriptorGrid({
  rows, levels, cellState, onSelect, palette, levelHeaderColors, levelBorderColors,
}) {
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' }}>
      <thead>
        <tr>
          <th style={{ padding: '0.3rem 0.6rem', textAlign: 'left', background: 'var(--bg-subtle)',
            border: '1px solid var(--border)', fontWeight: 600, fontSize: '0.75rem',
            color: 'var(--text-muted)', minWidth: 180 }}>Measurement Topic</th>
          {levels.map(l => (
            <th key={l} style={{ padding: '0.3rem 0.5rem', textAlign: 'center', width: '15%',
              background: levelHeaderColors[l], color: '#1a1a1a', border: '1px solid var(--border)',
              fontWeight: 700, fontSize: '0.72rem' }}>{LEVEL_LABELS[l]}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ topic, criterion }) => (
          <tr key={`${topic.id}-${criterion?.id ?? 'none'}`}>
            <td style={{ padding: '0.3rem 0.6rem', border: '1px solid var(--border)', color: '#202020',
              background: categoryColor(topic.category_title, palette), verticalAlign: 'top' }}>
              {criterion?.criterion_name && (
                <div style={{ fontWeight: 700, fontSize: '0.82rem' }}>{criterion.criterion_name}</div>)}
              <div style={{ fontSize: '0.72rem', fontWeight: 600 }}>{topic.title}</div>
              <div style={{ fontSize: '0.62rem', color: '#3a3a3a' }}>
                {topic.category_title} · {topic.external_id}</div>
            </td>
            {levels.map(l => {
              const st = cellState(topic.id, l) || {};
              const raw = criterion?.descriptors?.[l] ?? '';
              // Uncovered topics (no criterion) still name the IE floor explicitly.
              const text = (l === 'IE' && !raw) ? 'Insufficient Evidence' : raw;
              const base = {
                padding: '0.35rem 0.45rem', border: '1px solid var(--border)', verticalAlign: 'top',
                background: '#fff', color: '#1a1a1a', cursor: 'pointer', position: 'relative',
                lineHeight: 1.32, fontSize: '0.74rem',
              };
              if (st.final) Object.assign(base, {
                boxShadow: `inset 0 0 0 2px ${levelBorderColors[l]}`, background: levelHeaderColors[l], fontWeight: 600 });
              else if (st.draft) Object.assign(base, {
                outline: `2px dashed ${levelBorderColors[l]}`, outlineOffset: '-1px', background: 'var(--bg-subtle)' });
              else if (st.staged) Object.assign(base, {
                outline: '2px dotted #ef4444', outlineOffset: '-1px', background: '#fff' });
              else if (st.suggested) base.background = 'var(--ai-suggest-wash)';
              return (
                <td key={l} style={base} onClick={() => onSelect(topic.id, l)}
                    title={`Set ${topic.title} to ${LEVEL_LABELS[l]}`}>
                  {text && (l === 'IE'
                    ? <span style={{ color: '#999', fontStyle: 'italic' }}>{text}</span>
                    : text)}
                  {st.suggested && (
                    <AiSparkle size={17} style={{ position: 'absolute', top: 4, right: 5, color: 'var(--ai-suggest)' }} />)}
                  {st.staged && (
                    <span style={{ position: 'absolute', top: 2, right: 5, color: '#ef4444',
                      fontWeight: 800, fontSize: 21, lineHeight: 1 }}>×</span>)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Run, verify green**

Run: `cd client && npx vitest run src/components/RubricDescriptorGrid.test.jsx`
Expected: PASS (the drag test is gone; the IE test passes; the other four still pass).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/RubricDescriptorGrid.jsx client/src/components/RubricDescriptorGrid.test.jsx
git commit -m "refactor(rubrics): grading-only descriptor grid (drop reorder; IE floor + composite key)"
```

---

### Task 7: `RubricManagerModal` — Attach · Map criteria · Row order (items 1a/1b/2)

**Files:**
- Create: `client/src/components/RubricManagerModal.jsx`
- Test: `client/src/components/RubricManagerModal.test.jsx`

The modal reads `attachment` (the page's `rubricData` = `{ id, rubric: { id, name, criteria:[{id,position,criterion_name,standard_title,descriptors}] }, topicByCriterion:[{criterion_id, topic_id}] }` or `null`), `topics` (aligned topics `[{id,title,...}]`), `courseId`, `assignmentId`, and calls `onChanged()` after any mutation so the page reloads. It calls the api directly.

- [ ] **Step 1: Write the failing test.** Create `client/src/components/RubricManagerModal.test.jsx`:

```jsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RubricManagerModal from './RubricManagerModal.jsx';
import { listRubrics, attachRubric, deleteRubric, setRubricMapping, reorderRubricCriteria, rubricExportUrl } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  listRubrics: vi.fn(),
  attachRubric: vi.fn().mockResolvedValue({ unmatched: [] }),
  deleteRubric: vi.fn().mockResolvedValue({ ok: true }),
  setRubricMapping: vi.fn().mockResolvedValue({ ok: true }),
  reorderRubricCriteria: vi.fn().mockResolvedValue({ ok: true }),
  uploadRubricCsv: vi.fn().mockResolvedValue({ id: 7 }),
  rubricTemplateUrl: vi.fn(() => '/api/rubrics/template'),
  rubricExportUrl: vi.fn((id) => `/api/rubrics/${id}/export`),
}));

const TOPICS = [
  { id: 't1', title: 'Visual design', category_title: 'Produce', external_id: 'X1' },
  { id: 't2', title: 'Programming', category_title: 'Produce', external_id: 'X2' },
  { id: 't3', title: 'Critique', category_title: 'Respond', external_id: 'X3' },
];
const ATTACHMENT = {
  id: 55,
  rubric: { id: 9, name: 'AIML U2', criteria: [
    { id: 'c1', position: 1, criterion_name: 'UI/UX', standard_title: 'Visual design', descriptors: { ED: 'Polished' } },
    { id: 'c2', position: 2, criterion_name: 'Code', standard_title: 'Programming', descriptors: { ED: 'Clean' } },
  ] },
  topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }],   // c2 is unmapped
};

function open(props = {}) {
  return render(<RubricManagerModal open onClose={() => {}} courseId="4" assignmentId="8"
    topics={TOPICS} attachment={null} onChanged={vi.fn()} {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  listRubrics.mockResolvedValue([
    { id: 9, name: 'AIML U2', source: 'csv', criteria_count: 2, attachment_count: 1, updated_at: '2026-06-02T00:00:00Z' },
    { id: 3, name: 'Old draft', source: 'csv', criteria_count: 4, attachment_count: 0, updated_at: '2026-05-01T00:00:00Z' },
  ]);
});

describe('RubricManagerModal', () => {
  it('lists library rubrics on the Attach tab and attaches one', async () => {
    const onChanged = vi.fn();
    open({ onChanged });
    expect(await screen.findByText('AIML U2')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Attach' })[1]); // "Old draft"
    await waitFor(() => expect(attachRubric).toHaveBeenCalledWith({ rubricId: 3, courseId: '4', assignmentId: '8' }));
    expect(onChanged).toHaveBeenCalled();
  });

  it('confirms in place before deleting an attached rubric', async () => {
    open();
    await screen.findByText('AIML U2');
    const del = screen.getAllByRole('button', { name: /Delete/ })[0]; // AIML U2, attachment_count 1
    fireEvent.click(del);                       // first click → confirm, no API call
    expect(deleteRubric).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Click to confirm/ }));
    await waitFor(() => expect(deleteRubric).toHaveBeenCalledWith(9));
  });

  it('Map criteria tab persists a topic pick and excludes taken topics', async () => {
    open({ attachment: ATTACHMENT });
    fireEvent.click(screen.getByRole('tab', { name: /Map criteria/ }));
    // c2 (unmapped) select should NOT offer t1 (taken by c1) but should offer t2 & t3
    const select = screen.getByLabelText('Topic for Code');
    const optionValues = [...select.querySelectorAll('option')].map(o => o.value);
    expect(optionValues).toEqual(['', 't2', 't3']);   // "— none —" + unmapped only
    fireEvent.change(select, { target: { value: 't2' } });
    await waitFor(() => expect(setRubricMapping).toHaveBeenCalledWith(55, 'c2', 't2'));
  });

  it('Row order tab reorders criteria', async () => {
    open({ attachment: ATTACHMENT });
    fireEvent.click(screen.getByRole('tab', { name: /Row order/ }));
    fireEvent.click(screen.getByLabelText('Move UI/UX down'));
    await waitFor(() => expect(reorderRubricCriteria).toHaveBeenCalledWith(9, ['c2', 'c1']));
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd client && npx vitest run src/components/RubricManagerModal.test.jsx`
Expected: FAIL — cannot resolve `./RubricManagerModal.jsx`.

- [ ] **Step 3: Implement the modal.** Create `client/src/components/RubricManagerModal.jsx`:

```jsx
import { useEffect, useRef, useState } from 'react';
import ReorderableList from './ReorderableList.jsx';
import {
  listRubrics, attachRubric, deleteRubric, setRubricMapping, reorderRubricCriteria,
  uploadRubricCsv, rubricTemplateUrl, rubricExportUrl,
} from '../services/api.js';

const fmtDate = (s) => (s ? new Date(s).toLocaleDateString('en-GB') : '');

export default function RubricManagerModal({ open, onClose, courseId, assignmentId, topics, attachment, onChanged }) {
  const [tab, setTab] = useState('attach');
  const [rubrics, setRubrics] = useState([]);
  const [confirmId, setConfirmId] = useState(null);
  const [msg, setMsg] = useState('');
  const fileRef = useRef(null);
  const hasAttachment = !!attachment;

  async function refresh() { setRubrics(await listRubrics()); }
  useEffect(() => { if (open) { refresh(); setTab(hasAttachment ? tab : 'attach'); } }, [open]); // eslint-disable-line

  if (!open) return null;

  async function doAttach(rubricId) {
    setMsg('');
    try { await attachRubric({ rubricId, courseId, assignmentId }); await onChanged(); await refresh(); }
    catch (e) { setMsg(`Attach failed: ${e.message}`); }
  }
  async function doDelete(r) {
    if (confirmId !== r.id && r.attachment_count > 0) { setConfirmId(r.id); return; }
    await deleteRubric(r.id); setConfirmId(null); await onChanged(); await refresh();
  }
  async function doUpload(file) {
    setMsg('');
    try { const { id } = await uploadRubricCsv(file.name.replace(/\.csv$/i, ''), file); await doAttach(id); }
    catch (e) { setMsg(`Upload failed: ${e.message}`); }
  }
  async function doMap(criterionId, topicId) {
    await setRubricMapping(attachment.id, criterionId, topicId || null); await onChanged();
  }
  async function doReorder(orderedIds) { await reorderRubricCriteria(attachment.rubric.id, orderedIds); await onChanged(); }

  const Tab = ({ id, label, disabled }) => (
    <button role="tab" aria-selected={tab === id} disabled={disabled}
      className={`filter-btn${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{label}</button>
  );

  return (
    <div role="dialog" aria-label="Manage rubrics" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex',
      alignItems: 'flex-start', justifyContent: 'center', zIndex: 100, paddingTop: '6vh' }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 540, maxWidth: '92vw', maxHeight: '84vh', overflow: 'auto', background: 'var(--card-bg)',
        border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '0.7rem 1rem', borderBottom: '1px solid var(--border)' }}>
          <strong>Manage rubrics</strong>
          <button className="ghost" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <div role="tablist" style={{ display: 'flex', gap: '0.3rem', padding: '0.6rem 1rem 0' }}>
          <Tab id="attach" label="Attach" />
          <Tab id="map" label="Map criteria" disabled={!hasAttachment} />
          <Tab id="order" label="Row order" disabled={!hasAttachment} />
        </div>

        <div style={{ padding: '0.8rem 1rem' }}>
          {tab === 'attach' && (
            <div>
              {rubrics.map((r) => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.45rem 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ flex: 1 }}>
                    {attachment?.rubric?.id === r.id && <span style={{ color: 'var(--success)' }}>✓ </span>}
                    <strong>{r.name}</strong>
                    <span className="text-muted" style={{ fontSize: '0.72rem', marginLeft: 6 }}>
                      {r.criteria_count} criteria · {fmtDate(r.updated_at)}
                      {r.attachment_count > 0 ? ` · attached to ${r.attachment_count}` : ''}
                    </span>
                  </span>
                  <button className="secondary" onClick={() => doAttach(r.id)}>Attach</button>
                  <a className="ghost" href={rubricExportUrl(r.id)} download>⬇ CSV</a>
                  <button className="ghost danger" onClick={() => doDelete(r)}
                    aria-label={confirmId === r.id ? `Click to confirm delete ${r.name}` : `Delete ${r.name}`}>
                    {confirmId === r.id ? 'Click to confirm' : '🗑'}
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginTop: '0.8rem' }}>
                <button className="secondary" onClick={() => fileRef.current?.click()}>⬆ Upload CSV</button>
                <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f); e.target.value = ''; }} />
                <a className="ghost" href={rubricTemplateUrl()} download style={{ fontSize: '0.8rem' }}>⬇ Download template</a>
              </div>
              {msg && <p className="text-muted" style={{ fontSize: '0.75rem', marginTop: 6 }}>{msg}</p>}
            </div>
          )}

          {tab === 'map' && hasAttachment && (
            <MapTab attachment={attachment} topics={topics} onMap={doMap} />
          )}

          {tab === 'order' && hasAttachment && (
            <ReorderableList
              items={[...attachment.rubric.criteria].sort((a, b) => a.position - b.position).map((c) => ({
                id: c.id, label: c.criterion_name,
                content: (
                  <span>
                    <strong>{c.criterion_name}</strong>
                    <span className="text-muted" style={{ fontSize: '0.72rem' }}>
                      {' '}→ {topicTitle(topics, mappedTopic(attachment, c.id))}
                    </span>
                    {c.descriptors?.ED && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{c.descriptors.ED}</div>}
                  </span>
                ),
              }))}
              onReorder={doReorder}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function mappedTopic(attachment, criterionId) {
  return attachment.topicByCriterion.find((m) => m.criterion_id === criterionId)?.topic_id ?? '';
}
function topicTitle(topics, topicId) {
  return topics.find((t) => t.id === topicId)?.title ?? '— unmapped —';
}

function MapTab({ attachment, topics, onMap }) {
  const taken = new Set(attachment.topicByCriterion.map((m) => m.topic_id));
  const ordered = [...attachment.rubric.criteria].sort((a, b) => a.position - b.position);
  return (
    <div>
      {ordered.map((c) => {
        const current = mappedTopic(attachment, c.id);
        const options = topics.filter((t) => !taken.has(t.id) || t.id === current);
        return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0',
            borderBottom: '1px solid var(--border)' }}>
            <span style={{ flex: 1 }}>
              <span style={{ color: current ? 'var(--success)' : 'var(--warning)' }}>{current ? '✓' : '⚠'}</span>{' '}
              <strong>{c.criterion_name}</strong>
              <span className="text-muted" style={{ fontSize: '0.72rem' }}> expects “{c.standard_title}”</span>
            </span>
            <select aria-label={`Topic for ${c.criterion_name}`} value={current}
              onChange={(e) => onMap(c.id, e.target.value)}>
              <option value="">— none —</option>
              {options.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run, verify green**

Run: `cd client && npx vitest run src/components/RubricManagerModal.test.jsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/RubricManagerModal.jsx client/src/components/RubricManagerModal.test.jsx
git commit -m "feat(rubrics): tabbed Manage-rubrics modal (attach/map/reorder/delete/export)"
```

---

### Task 8: Wire the modal into `AssessmentSummaryPage`; remove the old toolbar + reorder hack

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (import line 3; `StudentRubricCard` signature line 124 + grid usage line 754; toolbar lines ~1374-1398; card render lines ~1441-1444; add modal state + render)
- Test: `client/src/pages/AssessmentSummaryPage.test.jsx` (extend the `vi.mock` block)

- [ ] **Step 1: Add a failing test.** In `client/src/pages/AssessmentSummaryPage.test.jsx`, first extend the `vi.mock('../services/api.js', …)` object (lines 8-23) with the methods the modal imports — add these entries:

```js
  listRubrics: vi.fn().mockResolvedValue([]),
  deleteRubric: vi.fn().mockResolvedValue({ ok: true }),
  setRubricMapping: vi.fn().mockResolvedValue({ ok: true }),
  reorderRubricCriteria: vi.fn().mockResolvedValue({ ok: true }),
  rubricExportUrl: vi.fn((id) => `/api/rubrics/${id}/export`),
```

Then append a new describe block at the end of the file:

```jsx
describe('AssessmentSummaryPage — Manage rubrics modal', () => {
  // Mirror the existing "header + Reviewer Analysis" renderPage: real route
  // (/course/:id/assessment/:assignmentId → courseId from useParams) + full mastery shape.
  function makeData() {
    return {
      assignment: { id: 50, schoology_assignment_id: '8', title: 'Quiz', mastery_grading_period_id: 1, mastery_grading_category_id: 2 },
      topics: [{ id: 't1', title: 'Topic 1', category_title: 'Cat', external_id: 'X1' }],
      students: [{ ...makeStudent(), id: 1, schoology_uid: 'uid-1', enrollment_id: 'enr-1', scores: {} }],
    };
  }
  function renderPage() {
    getMasteryForAssignment.mockResolvedValue(makeData());
    return render(
      <MemoryRouter initialEntries={['/course/4/assessment/8']}>
        <Routes>
          <Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('opens the Manage rubrics modal from the toolbar button', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage rubrics…' }));
    expect(await screen.findByRole('dialog', { name: 'Manage rubrics' })).toBeInTheDocument();
    expect(listRubrics).toHaveBeenCalled();
  });

  it('no longer renders the old inline "Upload rubric CSV" label', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Manage rubrics…' });
    expect(screen.queryByText('Upload rubric CSV')).not.toBeInTheDocument();
  });
});
```

(Import `listRubrics` in the test's destructured api import at the top so the assertion can reference it.)

- [ ] **Step 2: Run, verify failure**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: the two new tests FAIL (no "Manage rubrics…" button yet; the old "Upload rubric CSV" label still present).

- [ ] **Step 3a: Update imports.** In `client/src/pages/AssessmentSummaryPage.jsx` line 3, change the api import to drop `rubricTemplateUrl, uploadRubricCsv, attachRubric, reorderRubricCriteria` (now owned by the modal) and keep the rest; add the modal import after the `RubricDescriptorGrid` import (line 7):

```js
import { getMasteryForAssignment, getFeedbackForAssignment, getAssessmentAnalysis, syncMasteryForAssignment, writeMasteryScores, writeMasteryComment, sendAllGrades, createFlag, deleteFlag, getRubricForAssignment, getRubricConfig } from '../services/api.js';
```
```js
import RubricManagerModal from '../components/RubricManagerModal.jsx';
```

- [ ] **Step 3b: Drop `onReorder` from `StudentRubricCard`.** In the `StudentRubricCard({ … })` destructure (line 124) remove the trailing `, onReorder`. In its `<RubricDescriptorGrid … />` usage (around line 745-754) remove the `onReorder={onReorder}` prop line.

- [ ] **Step 3c: Add modal state + reload helper.** In the `AssessmentSummaryPage` component body, beside the other rubric state (near line 1155), add:

```js
  const [rubricModalOpen, setRubricModalOpen] = useState(false);
  const reloadRubric = async () => setRubricData(await getRubricForAssignment(assignmentId));
```

- [ ] **Step 3d: Replace the toolbar block.** Replace the toolbar affordances (the `Download template` `<a>`, the `Upload rubric CSV` `<label>`+input, and the `rubricMsg` span — lines ~1374-1398) with a single button:

```jsx
          {/* Single entry point to the rubric hub (attach existing / upload / map / reorder / delete). */}
          <button className="secondary" style={{ fontSize: '0.78rem' }}
            onClick={() => setRubricModalOpen(true)}>Manage rubrics…</button>
```

(The `rubricMsg` state at line 1155 is now unused — remove its `useState` declaration too.)

- [ ] **Step 3e: Drop the first-card reorder hack.** In the `<StudentRubricCard … />` render (lines ~1441-1444) remove the entire `onReorder={idx === 0 && rubricData ? … : undefined}` prop.

- [ ] **Step 3f: Render the modal.** Just before the closing of the page's top-level fragment (after the students map / command bar, near line 1446+), add:

```jsx
      <RubricManagerModal
        open={rubricModalOpen}
        onClose={() => setRubricModalOpen(false)}
        courseId={courseId}
        assignmentId={assignmentId}
        topics={alignedTopics}
        attachment={rubricData}
        onChanged={reloadRubric}
      />
```

- [ ] **Step 4: Run the page test, then the whole client suite, verify green**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS (new modal tests pass; existing tests unaffected — none exercised the removed toolbar upload).

Run: `cd client && npx vitest run`
Expected: PASS (whole client suite green).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(rubrics): route rubric management through the modal; drop inline upload + first-card reorder"
```

---

## Phase 3 — Rubric MCP tools (Project B)

### Task 9: `getRubricByName` + `upsertRubricByName` in the store

**Files:**
- Modify: `server/services/rubricStore.js` (add two exports)
- Test: `server/services/rubricStore.test.js`

- [ ] **Step 1: Add failing tests.** Append inside `describe('rubricStore', …)` in `server/services/rubricStore.test.js` (add `getRubricByName, upsertRubricByName` to the import at line 4):

```js
  test('upsertRubricByName creates when absent and replaces (same id) when present', () => {
    const id1 = upsertRubricByName(db, CONTENT);
    const id2 = upsertRubricByName(db, { ...CONTENT, criteria: [CONTENT.criteria[0]] });
    expect(id2).toBe(id1);                                  // replaced, not duplicated
    expect(listRubrics(db)).toHaveLength(1);
    expect(getRubric(db, id1).criteria).toHaveLength(1);
  });

  test('getRubricByName returns the rubric content by name', () => {
    saveRubric(db, CONTENT);
    const r = getRubricByName(db, 'MAD Dev');
    expect(r.criteria.map((c) => c.criterion_name)).toEqual(['UI/UX', 'Functionality']);
    expect(getRubricByName(db, 'nope')).toBeNull();
  });
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run server/services/rubricStore.test.js`
Expected: new tests FAIL (`upsertRubricByName`/`getRubricByName` undefined).

- [ ] **Step 3: Implement.** Add to `server/services/rubricStore.js` (after `getRubric`):

```js
export function getRubricByName(db = getDb(), name) {
  const row = db.prepare(`SELECT id FROM rubrics WHERE name = ? ORDER BY updated_at DESC, id DESC LIMIT 1`).get(name);
  return row ? getRubric(db, row.id) : null;
}

// Upsert by name: replace the newest rubric with this name, else create. Keeps the
// library free of re-push duplicates (the MCP write contract, spec §6).
export function upsertRubricByName(db = getDb(), content) {
  const row = db.prepare(`SELECT id FROM rubrics WHERE name = ? ORDER BY updated_at DESC, id DESC LIMIT 1`).get(content.name);
  return saveRubric(db, content, row?.id ?? null);
}
```

- [ ] **Step 4: Run, verify green**

Run: `npx vitest run server/services/rubricStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/rubricStore.js server/services/rubricStore.test.js
git commit -m "feat(rubrics): add getRubricByName + upsertRubricByName store helpers"
```

---

### Task 10: MCP handlers — `listRubricsTool` / `readRubric` / `writeRubric`

**Files:**
- Modify: `mcp/handlers.js` (add three handlers + a portable-shape helper)
- Test: covered by Task 11's MCP-client tests (handlers are exercised through the server, matching the repo's existing pattern).

- [ ] **Step 1: Implement the handlers.** Append to `mcp/handlers.js` (add the store import at the top of the file):

```js
import { listRubrics, getRubricByName, upsertRubricByName } from '../server/services/rubricStore.js';

const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];

// Portable rubric shape — ordered criteria, per-level descriptors, NO Prism ids
// (the JSON twin of exportRubricCsv; spec §6).
function toPortable(rubric) {
  return {
    name: rubric.name,
    criteria: rubric.criteria.map((c) => ({
      criterion_name: c.criterion_name,
      standard_title: c.standard_title,
      reporting_category: c.reporting_category,
      descriptors: Object.fromEntries(
        LEVELS.map((l) => [l, c.descriptors?.[l] ?? (l === 'IE' ? 'Insufficient Evidence' : null)])
      ),
    })),
  };
}

export function listRubricsTool(db) {
  // Name is the agent's handle — drop the local id.
  return listRubrics(db).map(({ name, source, criteria_count, updated_at }) =>
    ({ name, source, criteria_count, updated_at }));
}

export function readRubric(db, { name }) {
  const r = getRubricByName(db, name);
  return r ? toPortable(r) : null;
}

export function writeRubric(db, { name, criteria }) {
  const content = { name, source: 'mcp', criteria: criteria.map((c, i) => ({ position: i + 1, ...c })) };
  upsertRubricByName(db, content);
  return { name, criteria_count: getRubricByName(db, name).criteria.length };
}
```

- [ ] **Step 2: No standalone run** — these pure handlers are verified via the MCP client tests in Task 11 (the existing `mcp/server.test.js` pattern). Proceed to Task 11; do not commit yet (commit handlers + tool registration together in Task 11).

---

### Task 11: Register the three rubric tools + MCP-client tests

**Files:**
- Modify: `mcp/server.js` (import the new handlers; register 3 tools)
- Test: `mcp/server.test.js` (extend the `beforeEach` cleanup; add a describe block)

- [ ] **Step 1: Write failing tests.** In `mcp/server.test.js`, extend the `beforeEach` `db.exec(...)` cleanup string to also clear the rubric tables (append before the closing quote):

```js
    'DELETE FROM rubric_attachment_topics; DELETE FROM rubric_attachments; ' +
    'DELETE FROM rubric_descriptors; DELETE FROM rubric_criteria; DELETE FROM rubrics; ' +
```

(Place these in the existing concatenated string so all rubric rows are reset between tests.)

Then add a new describe block:

```js
describe('PrisMCP rubric tools', () => {
  const CRITERIA = [
    { criterion_name: 'UI/UX', standard_title: 'Visual design', reporting_category: 'Produce',
      descriptors: { ED: 'Polished', EX: 'Clear', D: 'Rough', EM: 'Weak' } },
    { criterion_name: 'Code', standard_title: 'Programming', reporting_category: 'Produce',
      descriptors: { ED: 'Clean', EX: 'Works', D: 'Messy', EM: 'Broken' } },
  ];

  test('write_rubric then read_rubric round-trips ordered criteria with no Prism ids', async () => {
    const client = await connect();
    await client.callTool({ name: 'write_rubric', arguments: { name: 'AIML U2', criteria: CRITERIA } });
    const res = await client.callTool({ name: 'read_rubric', arguments: { name: 'AIML U2' } });
    const r = JSON.parse(res.content[0].text);
    expect(r.name).toBe('AIML U2');
    expect(r.criteria.map((c) => c.criterion_name)).toEqual(['UI/UX', 'Code']); // order preserved
    expect(r.criteria[0].descriptors.IE).toBe('Insufficient Evidence');         // IE defaulted
    expect(JSON.stringify(r)).not.toMatch(/"id"/);                               // no ids leak
  });

  test('write_rubric upserts by name (no duplicate)', async () => {
    const client = await connect();
    await client.callTool({ name: 'write_rubric', arguments: { name: 'Dupe', criteria: CRITERIA } });
    await client.callTool({ name: 'write_rubric', arguments: { name: 'Dupe', criteria: [CRITERIA[0]] } });
    const list = JSON.parse((await client.callTool({ name: 'list_rubrics', arguments: {} })).content[0].text);
    expect(list.filter((r) => r.name === 'Dupe')).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('id');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run mcp/server.test.js`
Expected: new tests FAIL — "Tool write_rubric not found" (tools not registered yet).

- [ ] **Step 3: Register the tools.** In `mcp/server.js`, extend the handlers import (line 8):

```js
import { listCourses, listAssignments, listRubricsTool, readRubric, writeRubric } from './handlers.js';
```

Then register the three tools inside `createServer()` (after `write_assessment_analysis`, before the resources section):

```js
  server.registerTool(
    'list_rubrics',
    { description: 'List the reusable rubric library (name, source, criteria count, last updated) so an agent can pick or update a rubric by name.' },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(listRubricsTool(getDb())) }] })
  );

  server.registerTool(
    'read_rubric',
    {
      description: 'Read a rubric by name in portable form — ordered criteria with per-level descriptors and no Prism ids (the JSON twin of the CSV export).',
      inputSchema: { name: z.string().describe('Rubric name (as shown by list_rubrics)') },
    },
    async ({ name }) => ({ content: [{ type: 'text', text: JSON.stringify(readRubric(getDb(), { name })) }] })
  );

  server.registerTool(
    'write_rubric',
    {
      description: 'Create or replace a rubric by name (upsert — re-using a name replaces it, never duplicates). Criteria are an ordered array; array order becomes row order. No Prism ids required.',
      inputSchema: {
        name: z.string().describe('Rubric name — the stable handle; re-using it replaces the rubric'),
        criteria: z.array(z.object({
          criterion_name: z.string().describe('Friendly label, e.g. "UI/UX"'),
          standard_title: z.string().optional().describe('Measurement-topic title as written by the author'),
          reporting_category: z.string().optional().describe('e.g. "Produce" / "Create"'),
          descriptors: z.object({
            ED: z.string().optional(), EX: z.string().optional(), D: z.string().optional(),
            EM: z.string().optional(), IE: z.string().optional(),
          }).describe('Per-level descriptor prose; IE defaults to "Insufficient Evidence" when omitted'),
        })).describe('Ordered criteria — the array order is the row order'),
      },
    },
    async ({ name, criteria }) => ({ content: [{ type: 'text', text: JSON.stringify(writeRubric(getDb(), { name, criteria })) }] })
  );
```

- [ ] **Step 4: Run the MCP suite, verify green**

Run: `npx vitest run mcp/server.test.js`
Expected: PASS (new rubric-tool tests pass; existing MCP tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add mcp/handlers.js mcp/server.js mcp/server.test.js
git commit -m "feat(mcp): add list_rubrics / read_rubric / write_rubric tools (portable, upsert-by-name)"
```

---

## Phase 4 — Docs & full verification

### Task 12: Log the visual language; run the whole suite

**Files:**
- Modify: `docs/design-language.md`

- [ ] **Step 1: Append to `docs/design-language.md`** (under the existing "Rubric-descriptor visual language" section) a short subsection capturing the new patterns:

```markdown
### Rubric management modal + reorder (June 2026, branch `feat/rubric-binding-and-mcp`)

- **Single rubric-editing hub.** All rubric editing for an assignment lives in one
  tabbed modal — **Attach · Map criteria · Row order** (`RubricManagerModal.jsx`),
  opened by a single "Manage rubrics…" toolbar button. The grading grid stays
  grading-only (no edit affordances). Map/Row-order tabs enable only when a rubric
  is attached.
- **Destructive delete confirms in place.** Deleting a rubric attached to N
  assignments shows "attached to N", and the 🗑 turns into "Click to confirm" on
  first click (second click deletes) — per the existing confirm-in-place principle.
- **`ReorderableList` (reusable).** Grip + ↑/↓ buttons (keyboard: ArrowUp/ArrowDown
  on a focused row) + a `box-shadow: inset 0 2px 0 0 var(--accent)` top drop-target
  highlight during drag. Use this for any future reorderable list rather than
  re-inlining drag handlers.
- Dates render `toLocaleDateString('en-GB')` (DD/MM/YYYY), per the date convention.
```

- [ ] **Step 2: Run the entire test suite (server + MCP, then client)**

Run: `npm run test:server`
Expected: PASS (all server + MCP tests green).

Run: `cd client && npx vitest run`
Expected: PASS (all client tests green).

- [ ] **Step 3: Commit**

```bash
git add docs/design-language.md
git commit -m "docs(rubrics): log the manage-rubrics modal + ReorderableList visual language (#80)"
```

---

## Self-review notes (coverage check vs spec)

- **§4.1 delete + attachment_count** → Tasks 3 (count), 4 (route + client), 7 (confirm-in-place UI).
- **§4.2 1:1 + unmap** → Task 2 (server), Task 7 (Map tab excludes taken topics, "— none —" unmap).
- **§4.3 normalizeTitle** → Task 1.
- **§5.1 modal (Attach/Map/Row order)** → Task 7; wired in Task 8.
- **§5.2 ReorderableList** → Task 5.
- **§5.3 grid simplify (key, IE)** → Task 6.
- **§5.4 page wiring (remove toolbar + first-card hack)** → Task 8.
- **§6 MCP tools (upsert-by-name, portable shape)** → Tasks 9-11.
- **§8 design-language log** → Task 12.

Manual smoke (optional, after green): `npm run dev`, open an assessment page → Manage rubrics… → upload a CSV / attach an existing rubric / map an unmatched criterion / reorder rows / delete a rubric; then `npm run mcp` and exercise `write_rubric`→`read_rubric` from a connected client.
```
