# Feedback Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An unaligned (score-scale) task can carry an attached rubric as Prism-only feedback rows, marked in the usual grid, with the rubric average staged as the overall level.

**Architecture:** A rubric attached to a score-scale task is read as feedback rows (no mode column). Row finals live in a new Prism-only table, `rubric_row_levels`, keyed by criterion name. The client turns the rows into pseudo-topics with ids `row:<criterion name>`, so the existing grid, draft, suggestion and distribution code works unchanged; Save carries `rowLevels` beside the existing scale-grade write and mirrors them only after Schoology accepts it.

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest (server at the repo root, client in `client/`), React + React Testing Library, the PrisMCP server (`mcp/`, zod schemas).

**Spec:** `docs/superpowers/specs/2026-10-13-feedback-rows-design.md`

## Global Constraints

- Row levels never reach Schoology. Only the overall scale points and the comment go through `pushGradeComments`, as now.
- Row finals are written only after `putSucceeded(result)` when a Schoology write happens in the same request.
- A rows-only save makes no Schoology call (no `getSectionGrades`, no `pushGradeComments`).
- Levels are `ED`, `EX`, `D`, `EM`, `IE` (`LEVELS` from `server/lib/proficiencyScale.js`).
- Draft keys: a row is `row:<criterion name>`; the overall pick is `__scale__`; a staged removal is `__remove__`.
- The rubric average: mean of the scale's level points, read with the scale's cutoffs (`levelForScore`); any IE row gives no level; any unmarked row gives no level.
- The average is staged automatically only while the student has no published overall level.
- UI copy, exactly: "Feedback rows: kept in Prism, not sent to Schoology"; "Overall: {scale name}, sent to Schoology"; "Average of the rubric rows: {label}"; "Use the rubric average ({label})"; "A row is Insufficient Evidence: choose the overall level"; "On an unaligned task, every criterion is a feedback row".
- No em dashes in UI copy (a guard test enforces it). Colours only through CSS custom properties.
- New columns on existing tables would need `MIGRATIONS`; this plan adds a new table only, which `schema.sql` creates on every `migrate()`.
- Run server tests with `npx vitest run <path>` from the repo root; client tests with `cd client && npx vitest run <path>`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A rubric re-saved with `write_rubric` `update` after marking:** criterion ids change; finals keyed by name must still show. Test in Task 1 (`getRowLevels` reads by name) and Task 3 (re-attach keeps finals, counts only missing names as hidden).
2. **A Schoology write that fails:** no row finals may be written. Test in Task 6 (`write-comment` 502 leaves `rubric_row_levels` empty).
3. **A rows-only Send all batch:** must not call Schoology at all. Test in Task 6.
4. **A published student whose rows change:** the overall must not be re-staged by itself; the button appears instead. Test in Task 9.
5. **An agent keying `rubric_scores` by the standard text, or in another case:** stored under the exact criterion name so the card resolves it. Test in Task 4.

---

### Task 1: Row-level table and the feedback-rows service

**Files:**
- Modify: `server/db/schema.sql` (after the `rubric_attachment_topics` table, about line 567)
- Create: `server/services/feedbackRows.js`
- Test: `server/services/feedbackRows.test.js`

**Interfaces:**
- Produces:
  - `ROW_PREFIX = 'row:'`
  - `getFeedbackRows(db, assignmentSchoologyId, scoreScale)` → `null` when `scoreScale` is null; else `{ rubric: { id, name } | null, rows: [{ criterion, standard, category, descriptors: { ED, EX, D, EM, IE } }] }` in rubric order.
  - `getRowLevels(db, assignmentSchoologyId)` → `{ [student_uid]: { [criterion]: level } }`
  - `rowLevelsError(rows, rowLevels)` → error string or `null`. Accepts a plain object; each key must be a row's criterion; each value a level or `null`.
  - `saveRowLevels(db, { assignmentSchoologyId, studentUid, rowLevels })` → void; `null` deletes that row's final.
  - `resolveRowKey(rows, key)` → criterion name or `null` (criterion name, then standard text, case-insensitive, trimmed).
  - `hiddenRowLevelCount(db, assignmentSchoologyId, rowNames)` → number of stored finals whose name is not in `rowNames`.
  - `orderedRowLevels(rowNames, levelsByName)` → `[{ criterion, level }]`, rows in `rowNames` order, then any other stored names alphabetically.

- [ ] **Step 1: Add the table to `server/db/schema.sql`**

```sql
-- Feedback rows (2026-10-13): the teacher's published row levels for a rubric
-- attached to an UNALIGNED (score-scale) task. Prism-only: never synced, never
-- sent to Schoology. Keyed by criterion name, because write_rubric "update"
-- re-inserts criteria with new ids.
CREATE TABLE IF NOT EXISTS rubric_row_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_schoology_id TEXT NOT NULL,
  student_uid TEXT NOT NULL,
  criterion_name TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('ED','EX','D','EM','IE')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (assignment_schoology_id, student_uid, criterion_name)
);
CREATE INDEX IF NOT EXISTS idx_rubric_row_levels_student ON rubric_row_levels(student_uid);
```

- [ ] **Step 2: Write the failing tests** in `server/services/feedbackRows.test.js`

```js
import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { saveRubric } from './rubricStore.js';
import {
  getFeedbackRows, getRowLevels, saveRowLevels, rowLevelsError, resolveRowKey,
  hiddenRowLevelCount, orderedRowLevels,
} from './feedbackRows.js';

const GAS = { name: 'General Academic Scale (Unaligned)', levels: [
  { code: 'ED', label: 'Exhibiting Depth', points: 100, cutoff: 87.5 },
  { code: 'EX', label: 'Exhibiting', points: 75, cutoff: 62.5 },
  { code: 'D', label: 'Developing', points: 50, cutoff: 37.5 },
  { code: 'EM', label: 'Emerging', points: 25, cutoff: 12.5 },
  { code: 'IE', label: 'Insufficient Evidence', points: 0, cutoff: 0 },
] };

let db, rubricId;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  rubricId = saveRubric(db, { name: 'Flappy', source: 'csv', criteria: [
    { position: 1, criterion_name: 'Features and Code', standard_title: 'Anchor Standard 5: Develop', reporting_category: 'PRODUCE', descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd' } },
    { position: 2, criterion_name: 'Playtesting', standard_title: 'Anchor Standard 3: Refine', reporting_category: 'CREATE, RESPOND, CONNECT', descriptors: { ED: 'e', EX: 'f', D: 'g', EM: 'h' } },
  ] });
});

const attach = () => db.prepare(
  `INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-F', 1, 'now')`
).run(rubricId);

describe('rubric_row_levels table', () => {
  test('rejects a level outside ED..IE and a duplicate row', () => {
    const ins = db.prepare(`INSERT INTO rubric_row_levels (assignment_schoology_id, student_uid, criterion_name, level) VALUES (?, ?, ?, ?)`);
    ins.run('sa-F', 'u1', 'Playtesting', 'EX');
    expect(() => ins.run('sa-F', 'u1', 'Playtesting', 'D')).toThrow(/UNIQUE/);
    expect(() => ins.run('sa-F', 'u2', 'Playtesting', 'A')).toThrow(/CHECK/);
  });

  test('migrate() adds the table to a database created before it existed', () => {
    const old = new Database(':memory:');
    migrate(old);
    old.exec('DROP TABLE rubric_row_levels');
    migrate(old);
    expect(old.prepare(`SELECT name FROM sqlite_master WHERE name = 'rubric_row_levels'`).get()).toBeTruthy();
  });
});

describe('getFeedbackRows', () => {
  test('null for a task that is not on a score scale', () => {
    attach();
    expect(getFeedbackRows(db, 'sa-F', null)).toBeNull();
  });

  test('no rubric attached: rubric null, no rows', () => {
    expect(getFeedbackRows(db, 'sa-F', GAS)).toEqual({ rubric: null, rows: [] });
  });

  test('every criterion is a row, in rubric order, IE defaulted', () => {
    attach();
    const fr = getFeedbackRows(db, 'sa-F', GAS);
    expect(fr.rubric).toEqual({ id: rubricId, name: 'Flappy' });
    expect(fr.rows.map(r => r.criterion)).toEqual(['Features and Code', 'Playtesting']);
    expect(fr.rows[0]).toMatchObject({ standard: 'Anchor Standard 5: Develop', category: 'PRODUCE' });
    expect(fr.rows[0].descriptors).toEqual({ ED: 'a', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' });
  });
});

describe('row levels', () => {
  test('save, read back by name, and null deletes', () => {
    saveRowLevels(db, { assignmentSchoologyId: 'sa-F', studentUid: 'u1', rowLevels: { 'Features and Code': 'EX', Playtesting: 'D' } });
    saveRowLevels(db, { assignmentSchoologyId: 'sa-F', studentUid: 'u1', rowLevels: { Playtesting: 'ED' } });
    expect(getRowLevels(db, 'sa-F')).toEqual({ u1: { 'Features and Code': 'EX', Playtesting: 'ED' } });
    saveRowLevels(db, { assignmentSchoologyId: 'sa-F', studentUid: 'u1', rowLevels: { Playtesting: null } });
    expect(getRowLevels(db, 'sa-F')).toEqual({ u1: { 'Features and Code': 'EX' } });
  });

  test('rowLevelsError refuses unknown rows, bad levels and non-objects', () => {
    attach();
    const { rows } = getFeedbackRows(db, 'sa-F', GAS);
    expect(rowLevelsError(rows, { Playtesting: 'EX', 'Features and Code': null })).toBeNull();
    expect(rowLevelsError(rows, { Evaluation: 'EX' })).toMatch(/Evaluation/);
    expect(rowLevelsError(rows, { Playtesting: 'A' })).toMatch(/level/);
    expect(rowLevelsError(rows, ['EX'])).toMatch(/object/);
    expect(rowLevelsError([], { Playtesting: 'EX' })).toMatch(/feedback rows/);
  });

  test('resolveRowKey matches criterion name, then standard text, ignoring case', () => {
    attach();
    const { rows } = getFeedbackRows(db, 'sa-F', GAS);
    expect(resolveRowKey(rows, ' playtesting ')).toBe('Playtesting');
    expect(resolveRowKey(rows, 'anchor standard 5: develop')).toBe('Features and Code');
    expect(resolveRowKey(rows, 'Evaluation')).toBeNull();
  });

  test('hiddenRowLevelCount counts finals whose names are not rows', () => {
    saveRowLevels(db, { assignmentSchoologyId: 'sa-F', studentUid: 'u1', rowLevels: { Aesthetic: 'EX', Playtesting: 'D' } });
    expect(hiddenRowLevelCount(db, 'sa-F', ['Features and Code', 'Playtesting'])).toBe(1);
  });

  test('orderedRowLevels follows the rubric order, extras last', () => {
    expect(orderedRowLevels(['B', 'A'], { A: 'EX', Z: 'D', B: 'ED' }))
      .toEqual([{ criterion: 'B', level: 'ED' }, { criterion: 'A', level: 'EX' }, { criterion: 'Z', level: 'D' }]);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run server/services/feedbackRows.test.js`
Expected: FAIL, `Failed to load url ./feedbackRows.js`.

- [ ] **Step 4: Implement `server/services/feedbackRows.js`**

```js
// Feedback rows (spec 2026-10-13): a rubric attached to an UNALIGNED
// (score-scale) task. Every criterion is a row the teacher marks in Prism; the
// row levels are Prism-only feedback data and never reach Schoology. Only the
// overall scale level is published. Row finals live in rubric_row_levels,
// keyed by criterion name.
import { getRubric } from './rubricStore.js';
import { LEVELS } from '../lib/proficiencyScale.js';

export const ROW_PREFIX = 'row:';

// The task's feedback rows, or null when it is not graded on a score scale.
// The caller passes the scale (scoreScaleFor) so this module needs no topic reads.
export function getFeedbackRows(db, assignmentSchoologyId, scoreScale) {
  if (!scoreScale) return null;
  const att = db.prepare('SELECT rubric_id FROM rubric_attachments WHERE assignment_schoology_id = ?')
    .get(String(assignmentSchoologyId));
  const rubric = att ? getRubric(db, att.rubric_id) : null;
  if (!rubric) return { rubric: null, rows: [] };
  return {
    rubric: { id: rubric.id, name: rubric.name },
    rows: rubric.criteria.map((c) => ({
      criterion: c.criterion_name,
      standard: c.standard_title ?? null,
      category: c.reporting_category ?? null,
      descriptors: Object.fromEntries(
        LEVELS.map((l) => [l, c.descriptors?.[l] ?? (l === 'IE' ? 'Insufficient Evidence' : null)])
      ),
    })),
  };
}

export function getRowLevels(db, assignmentSchoologyId) {
  const out = {};
  const rows = db.prepare(
    'SELECT student_uid, criterion_name, level FROM rubric_row_levels WHERE assignment_schoology_id = ?'
  ).all(String(assignmentSchoologyId));
  for (const r of rows) (out[r.student_uid] ||= {})[r.criterion_name] = r.level;
  return out;
}

export function rowLevelsError(rows, rowLevels) {
  if (!rowLevels || typeof rowLevels !== 'object' || Array.isArray(rowLevels)) return 'rowLevels must be an object of { criterion: level }';
  if (!rows?.length) return 'This assignment has no feedback rows: attach a rubric to it first';
  const names = new Set(rows.map((r) => r.criterion));
  for (const [name, level] of Object.entries(rowLevels)) {
    if (!names.has(name)) return `"${name}" is not a row of the attached rubric`;
    if (level !== null && !LEVELS.includes(level)) return `${JSON.stringify(level)} is not a level (${LEVELS.join(', ')})`;
  }
  return null;
}

export function saveRowLevels(db, { assignmentSchoologyId, studentUid, rowLevels }) {
  const upsert = db.prepare(`
    INSERT INTO rubric_row_levels (assignment_schoology_id, student_uid, criterion_name, level, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (assignment_schoology_id, student_uid, criterion_name)
    DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at
  `);
  const del = db.prepare(
    'DELETE FROM rubric_row_levels WHERE assignment_schoology_id = ? AND student_uid = ? AND criterion_name = ?'
  );
  db.transaction(() => {
    for (const [name, level] of Object.entries(rowLevels || {})) {
      if (level == null) del.run(String(assignmentSchoologyId), String(studentUid), name);
      else upsert.run(String(assignmentSchoologyId), String(studentUid), name, level);
    }
  })();
}

export function resolveRowKey(rows, key) {
  const k = String(key ?? '').trim().toLowerCase();
  if (!k) return null;
  const byName = rows.find((r) => String(r.criterion ?? '').trim().toLowerCase() === k);
  if (byName) return byName.criterion;
  const byStandard = rows.find((r) => String(r.standard ?? '').trim().toLowerCase() === k);
  return byStandard ? byStandard.criterion : null;
}

export function hiddenRowLevelCount(db, assignmentSchoologyId, rowNames) {
  const names = new Set(rowNames);
  return db.prepare('SELECT criterion_name FROM rubric_row_levels WHERE assignment_schoology_id = ?')
    .all(String(assignmentSchoologyId))
    .filter((r) => !names.has(r.criterion_name)).length;
}

export function orderedRowLevels(rowNames, levelsByName) {
  const levels = levelsByName || {};
  const known = rowNames.filter((n) => levels[n] != null).map((n) => ({ criterion: n, level: levels[n] }));
  const extra = Object.keys(levels).filter((n) => !rowNames.includes(n)).sort()
    .map((n) => ({ criterion: n, level: levels[n] }));
  return [...known, ...extra];
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run server/services/feedbackRows.test.js server/db/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.sql server/services/feedbackRows.js server/services/feedbackRows.test.js
git commit -m "feat(feedback-rows): row-level table and feedback-rows service

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The rubric average, server and client copies

**Files:**
- Create: `server/lib/rubricAverage.js`, `client/src/lib/rubricAverage.js`
- Create: `client/src/lib/rubricAverage.cases.json` (shared case table)
- Test: `server/lib/rubricAverage.test.js`, `client/src/lib/rubricAverage.test.js`

**Interfaces:**
- Produces: `rubricAverage(scale, rowNames, levelsByName)` → `{ level: code|null, reason: null | 'incomplete' | 'insufficient_evidence' }`, identical in both copies. `scale` is the config scale with `levels[].points` and `levels[].cutoff`.

- [ ] **Step 1: Write the shared cases** in `client/src/lib/rubricAverage.cases.json`

```json
{
  "scale": { "name": "General Academic Scale (Unaligned)", "levels": [
    { "code": "ED", "label": "Exhibiting Depth", "points": 100, "cutoff": 87.5 },
    { "code": "EX", "label": "Exhibiting", "points": 75, "cutoff": 62.5 },
    { "code": "D", "label": "Developing", "points": 50, "cutoff": 37.5 },
    { "code": "EM", "label": "Emerging", "points": 25, "cutoff": 12.5 },
    { "code": "IE", "label": "Insufficient Evidence", "points": 0, "cutoff": 0 }
  ] },
  "cases": [
    { "name": "all the same", "levels": ["EX", "EX", "EX", "EX"], "expect": { "level": "EX", "reason": null } },
    { "name": "a tie rounds up", "levels": ["EX", "EX", "D", "D"], "expect": { "level": "EX", "reason": null } },
    { "name": "nearest level", "levels": ["EX", "D", "D"], "expect": { "level": "D", "reason": null } },
    { "name": "ED and EX tie rounds up", "levels": ["ED", "EX"], "expect": { "level": "ED", "reason": null } },
    { "name": "EM and D tie rounds up", "levels": ["EM", "D"], "expect": { "level": "D", "reason": null } },
    { "name": "any IE stops the average", "levels": ["ED", "ED", "IE", "ED"], "expect": { "level": null, "reason": "insufficient_evidence" } },
    { "name": "IE wins over an unmarked row", "levels": ["IE", null], "expect": { "level": null, "reason": "insufficient_evidence" } },
    { "name": "an unmarked row", "levels": ["EX", null, "EX"], "expect": { "level": null, "reason": "incomplete" } },
    { "name": "no rows", "levels": [], "expect": { "level": null, "reason": "incomplete" } }
  ]
}
```

- [ ] **Step 2: Write the failing server test** `server/lib/rubricAverage.test.js`

```js
import { describe, test, expect } from 'vitest';
import { rubricAverage } from './rubricAverage.js';
import shared from '../../client/src/lib/rubricAverage.cases.json';

describe('rubricAverage (server copy)', () => {
  for (const c of shared.cases) {
    test(c.name, () => {
      const names = c.levels.map((_, i) => `r${i}`);
      const levels = Object.fromEntries(c.levels.map((l, i) => [`r${i}`, l]).filter(([, l]) => l != null));
      expect(rubricAverage(shared.scale, names, levels)).toEqual(c.expect);
    });
  }
  test('no scale gives no level', () => {
    expect(rubricAverage(null, ['a'], { a: 'EX' })).toEqual({ level: null, reason: 'incomplete' });
  });
});
```

- [ ] **Step 3: Write the failing client test** `client/src/lib/rubricAverage.test.js` (the same body, importing `./rubricAverage.js` and `./rubricAverage.cases.json`, `describe('rubricAverage (client copy)', …)`).

- [ ] **Step 4: Run both to verify they fail**

Run: `npx vitest run server/lib/rubricAverage.test.js` and `cd client && npx vitest run src/lib/rubricAverage.test.js`
Expected: FAIL, module not found.

- [ ] **Step 5: Implement `server/lib/rubricAverage.js`**

```js
// The rubric average for feedback rows (spec 2026-10-13 §2). The mean of the
// rows' level points, read with the scale's own cutoffs. The GAS cutoffs are
// the midpoints, so this is the nearest level with a tie rounding up. Any IE
// row stops it (missing evidence is not low evidence); so does an unmarked row.
// client/src/lib/rubricAverage.js is a copy: keep both in step
// (rubricAverage.cases.json runs against each).
import { levelForScore } from './scoreScales.js';

export function rubricAverage(scale, rowNames, levelsByName) {
  if (!scale || !rowNames?.length) return { level: null, reason: 'incomplete' };
  const values = rowNames.map((n) => levelsByName?.[n] ?? null);
  if (values.includes('IE')) return { level: null, reason: 'insufficient_evidence' };
  const points = values.map((v) => (v == null ? null : scale.levels.find((l) => l.code === v)?.points ?? null));
  if (points.some((p) => p == null)) return { level: null, reason: 'incomplete' };
  const mean = points.reduce((a, b) => a + b, 0) / points.length;
  return { level: levelForScore(scale, mean), reason: null };
}
```

- [ ] **Step 6: Implement `client/src/lib/rubricAverage.js`**

```js
// Copy of server/lib/rubricAverage.js (the client cannot import server code).
// rubricAverage.cases.json runs against both copies: keep them in step.
export function rubricAverage(scale, rowNames, levelsByName) {
  if (!scale || !rowNames?.length) return { level: null, reason: 'incomplete' };
  const values = rowNames.map((n) => levelsByName?.[n] ?? null);
  if (values.includes('IE')) return { level: null, reason: 'insufficient_evidence' };
  const points = values.map((v) => (v == null ? null : scale.levels.find((l) => l.code === v)?.points ?? null));
  if (points.some((p) => p == null)) return { level: null, reason: 'incomplete' };
  const mean = points.reduce((a, b) => a + b, 0) / points.length;
  const byCutoff = [...scale.levels].sort((a, b) => b.cutoff - a.cutoff);
  return { level: byCutoff.find((l) => mean >= l.cutoff)?.code ?? null, reason: null };
}
```

- [ ] **Step 7: Run both to verify they pass** (same commands). Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/lib/rubricAverage.js server/lib/rubricAverage.test.js client/src/lib/rubricAverage.js client/src/lib/rubricAverage.test.js client/src/lib/rubricAverage.cases.json
git commit -m "feat(feedback-rows): rubric average with one case table for both copies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Attaching a rubric as feedback rows

**Files:**
- Modify: `server/services/rubricAttach.js` (`attachRubric`)
- Modify: `mcp/handlers.js` (`attachRubricTool`, about line 238)
- Modify: `mcp/server.js` (`attach_rubric` registration, about line 299)
- Test: `server/services/rubricAttach.test.js`, `mcp/handlers.test.js`

**Interfaces:**
- Consumes: `getFeedbackRows`, `hiddenRowLevelCount` (Task 1); `scoreScaleFor` from `assessmentContext.js`; `resolveAssignmentId` from `idResolvers.js`.
- Produces: `attachRubric(db, { rubricId, courseId, assignmentId })` returns `{ attachmentId, unmatched, mode: 'topics' | 'feedback_rows', rows?: string[], hiddenRowLevels?: number, scaleName?: string }`. The HTTP route `POST /api/rubrics/attach` passes this through unchanged.
- `attachRubricTool` on a feedback-row task returns `{ attached_to, rubric, mode: 'feedback_rows', score_scale, rows, hidden_row_levels }`; on an aligned task the old shape `{ attached_to, rubric, unmatched_criteria }`.

- [ ] **Step 1: Write the failing service tests** (append to `server/services/rubricAttach.test.js`)

```js
import { saveRowLevels } from './feedbackRows.js';

describe('rubricAttach on an unaligned score-scale task (feedback rows)', () => {
  beforeEach(() => {
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (4, '900', 'Flappy (F)', '23495360')`).run();
  });

  test('attaches every criterion as a row, reports none unmatched', () => {
    const res = attachRubric(db, { rubricId, courseId: 4, assignmentId: '900' });
    expect(res).toMatchObject({ mode: 'feedback_rows', unmatched: [], rows: ['UI/UX', 'Func'], hiddenRowLevels: 0, scaleName: 'General Academic Scale (Unaligned)' });
    expect(db.prepare(`SELECT COUNT(*) c FROM rubric_attachment_topics`).get().c).toBe(0);
    expect(getAttachmentForAssignment(db, '900').rubric.name).toBe('R');
  });

  test('re-attaching keeps finals and counts the ones that no longer match a row', () => {
    saveRowLevels(db, { assignmentSchoologyId: '900', studentUid: 'u1', rowLevels: { 'UI/UX': 'EX', Aesthetic: 'D' } });
    const res = attachRubric(db, { rubricId, courseId: 4, assignmentId: '900' });
    expect(res.hiddenRowLevels).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) c FROM rubric_row_levels`).get().c).toBe(2);
  });

  test('an aligned task keeps topic matching (mode topics)', () => {
    expect(attachRubric(db, { rubricId, courseId: 4, assignmentId: '800' }).mode).toBe('topics');
  });
});
```

Note: the test file's `beforeEach` creates course 4; the GAS scale id `23495360` comes from the repo's `config.yaml`.

- [ ] **Step 2: Write the failing MCP tests** (append inside `describe('attachRubricTool', …)` in `mcp/handlers.test.js`)

```js
  test('accepts the Schoology assignment id as well as the local id', () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1','AIML')`).run().lastInsertRowid;
    const asgId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, '8590105935', 'Project')`).run(courseId).lastInsertRowid;
    saveRubric(db, { name: 'Design', source: 'csv', criteria: [
      { position: 1, criterion_name: 'UI/UX', standard_title: 'Visual design', reporting_category: 'Produce', descriptors: { ED: 'a' } },
    ] });
    expect(attachRubricTool(db, { rubric_name: 'Design', assignment_id: '8590105935' }).attached_to).toBe(asgId);
  });

  test('on an unaligned GAS task it attaches feedback rows, not unmatched criteria', () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1','MGD')`).run().lastInsertRowid;
    const asgId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-F', 'Flappy Bird (F)', '23495360')`).run(courseId).lastInsertRowid;
    saveRubric(db, { name: 'Flappy', source: 'mcp', criteria: [
      { position: 1, criterion_name: 'Features and Code', standard_title: 'Anchor Standard 5', reporting_category: 'PRODUCE', descriptors: { ED: 'a' } },
      { position: 2, criterion_name: 'Playtesting', standard_title: 'Anchor Standard 3', reporting_category: 'CREATE', descriptors: { ED: 'b' } },
    ] });
    expect(attachRubricTool(db, { rubric_name: 'Flappy', assignment_id: 'sa-F' })).toEqual({
      attached_to: asgId, rubric: 'Flappy', mode: 'feedback_rows',
      score_scale: 'General Academic Scale (Unaligned)',
      rows: ['Features and Code', 'Playtesting'], hidden_row_levels: 0,
    });
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run server/services/rubricAttach.test.js mcp/handlers.test.js -t "attach"`
Expected: FAIL (`mode` undefined; Schoology id not found).

- [ ] **Step 4: Implement in `server/services/rubricAttach.js`**

Replace `attachRubric` with:

```js
import { getAlignedTopics, scoreScaleFor } from './assessmentContext.js';
import { hiddenRowLevelCount } from './feedbackRows.js';

// Attach rubric to an assignment (replacing any existing attachment). On an
// aligned task, auto-match its criteria to the aligned topics and persist the
// mapping. On an UNALIGNED score-scale task, every criterion is a feedback row
// (spec 2026-10-13): no topic mapping, and stored row finals are kept.
export function attachRubric(db = getDb(), { rubricId, courseId, assignmentId }) {
  const rubric = getRubric(db, rubricId);
  if (!rubric) throw new Error(`rubric ${rubricId} not found`);
  const topics = getAlignedTopics(db, courseId, assignmentId);
  const assignmentRow = db.prepare('SELECT grading_scale_id FROM assignments WHERE schoology_assignment_id = ?')
    .get(String(assignmentId));
  const scale = scoreScaleFor(assignmentRow, topics.length);
  const { mapping, unmatched } = scale ? { mapping: [], unmatched: [] } : autoMatch(rubric.criteria, topics);
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM rubric_attachments WHERE assignment_schoology_id = ?`).run(assignmentId);
    const attachmentId = db.prepare(
      `INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(rubricId, assignmentId, courseId, now).lastInsertRowid;
    const insM = db.prepare(
      `INSERT INTO rubric_attachment_topics (attachment_id, criterion_id, topic_id) VALUES (?, ?, ?)`
    );
    for (const m of mapping) insM.run(attachmentId, m.criterion_id, m.topic_id);
    return attachmentId;
  });
  const attachmentId = txn();
  if (!scale) return { attachmentId, unmatched, mode: 'topics' };
  const rows = rubric.criteria.map((c) => c.criterion_name);
  return { attachmentId, unmatched: [], mode: 'feedback_rows', rows, hiddenRowLevels: hiddenRowLevelCount(db, assignmentId, rows), scaleName: scale.name };
}
```

Check: `assessmentContext.js` imports neither `rubricAttach.js` nor `feedbackRows.js` at this point, so the import graph stays acyclic.

- [ ] **Step 5: Implement in `mcp/handlers.js`**

```js
import { resolveAssignmentId } from '../server/services/idResolvers.js';

// Bind a library rubric (by name) to an assignment. On an aligned task the
// criteria are auto-matched to measurement topics; unmatched ones are finished
// in Prism's Map-criteria tab. On an unaligned score-scale task every criterion
// becomes a feedback row (Prism-only; only the overall level is published).
export function attachRubricTool(db, { rubric_name, assignment_id }) {
  const rubric = getRubricByName(db, rubric_name);
  if (!rubric) return { error: `rubric "${rubric_name}" not found` };
  const localId = resolveAssignmentId(db, assignment_id);
  const asg = localId ? db.prepare(`SELECT schoology_assignment_id, course_id FROM assignments WHERE id = ?`).get(localId) : null;
  if (!asg) return { error: `assignment ${assignment_id} not found` };
  const res = attachRubric(db, { rubricId: rubric.id, courseId: asg.course_id, assignmentId: asg.schoology_assignment_id });
  if (res.mode === 'feedback_rows') {
    return { attached_to: localId, rubric: rubric_name, mode: 'feedback_rows', score_scale: res.scaleName, rows: res.rows, hidden_row_levels: res.hiddenRowLevels };
  }
  const nameById = Object.fromEntries(rubric.criteria.map((c) => [c.id, c.criterion_name]));
  return { attached_to: localId, rubric: rubric_name, unmatched_criteria: res.unmatched.map((id) => nameById[id] ?? `<criterion id=${id}>`) };
}
```

(Skip the `resolveAssignmentId` import line if `handlers.js` already imports it; check with `grep -n resolveAssignmentId mcp/handlers.js`.)

- [ ] **Step 6: Update the `attach_rubric` registration in `mcp/server.js`**

```js
      description: "Attach a library rubric (by name) to an assignment. On an aligned assignment its criteria are auto-matched to the measurement topics; returns { attached_to, rubric, unmatched_criteria }: finish any unmatched criteria in Prism's Map-criteria tab. On an unaligned assignment graded on a score scale (e.g. General Academic Scale (Unaligned)), every criterion becomes a feedback row: rows are marked in Prism and never sent to Schoology, and only the overall scale level is published. Returns { attached_to, rubric, mode: 'feedback_rows', score_scale, rows, hidden_row_levels } (hidden_row_levels counts stored row levels whose names are not rows of the new rubric).",
      inputSchema: {
        rubric_name: z.string().describe('Rubric name (as shown by list_rubrics)'),
        assignment_id: z.union([z.number(), z.string()]).describe('Schoology or local assignment id'),
      },
```

- [ ] **Step 7: Run to verify they pass**

Run: `npx vitest run server/services/rubricAttach.test.js mcp/ server/routes/`
Expected: PASS (the old `attachRubricTool` test still matches the aligned shape).

- [ ] **Step 8: Commit**

```bash
git add server/services/rubricAttach.js server/services/rubricAttach.test.js mcp/handlers.js mcp/handlers.test.js mcp/server.js
git commit -m "feat(feedback-rows): attach a rubric to an unaligned task as feedback rows

attach_rubric also accepts a Schoology assignment id.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Row suggestions in write_student_suggestions

**Files:**
- Modify: `server/services/suggestions.js` (`upsertStudentSuggestion`)
- Modify: `mcp/server.js` (`write_student_suggestions` description and the `rubric_scores` / `scale_level` field descriptions, about lines 106-125)
- Test: `server/services/suggestions.test.js`

**Interfaces:**
- Consumes: `getFeedbackRows`, `resolveRowKey` (Task 1).
- Produces: on a feedback-row task, `feedback_json.rubric_scores` is `{ [exact criterion name]: level }`; the result carries `unresolved_rows: string[]` for unknown keys, with a message listing the valid row names.

- [ ] **Step 1: Write the failing tests** (append to `server/services/suggestions.test.js`; add `DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM rubrics;` to the file's `beforeEach` exec string)

```js
import { saveRubric } from './rubricStore.js';

describe('row suggestions on a task with feedback rows', () => {
  function seedRows(db) {
    const { courseId } = seed(db);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-F', 'Flappy (F)', '23495360')`).run(courseId);
    const rubricId = saveRubric(db, { name: 'Flappy', source: 'mcp', criteria: [
      { position: 1, criterion_name: 'Features and Code', standard_title: 'Anchor Standard 5: Develop', reporting_category: 'PRODUCE' },
      { position: 2, criterion_name: 'Playtesting', standard_title: 'Anchor Standard 3: Refine', reporting_category: 'CREATE' },
    ] });
    db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-F', ?, 'now')`).run(rubricId, courseId);
  }
  const fj = (db, id) => JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(id).feedback_json);

  test('stores row levels under the exact criterion name, from a name in any case or the standard text', () => {
    const db = getDb();
    seedRows(db);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-F', student: 'uid-1',
      rubric_scores: { 'features and code': 'Exhibiting', 'Anchor Standard 3: Refine': 'ED' } });
    expect(r.unresolved_rows).toBeUndefined();
    expect(fj(db, r.feedback_id).rubric_scores).toEqual({ 'Features and Code': 'EX', Playtesting: 'ED' });
  });

  test('reports an unknown row with the valid names, keeps the rest, and stores an optional scale_level', () => {
    const db = getDb();
    seedRows(db);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-F', student: 'uid-1',
      rubric_scores: { Evaluation: 'EX', Playtesting: 'IE' }, scale_level: 'Developing' });
    expect(r.unresolved_rows).toEqual(['Evaluation']);
    expect(r.message).toMatch(/Features and Code, Playtesting/);
    expect(fj(db, r.feedback_id)).toMatchObject({ rubric_scores: { Playtesting: 'IE' }, scale_level: 'D' });
  });

  test('a score-scale task with no rubric states that one must be attached', () => {
    const db = getDb();
    const { courseId } = seed(db);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-G', 'Plain (F)', '23495360')`).run(courseId);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-G', student: 'uid-1', rubric_scores: { Playtesting: 'EX' } });
    expect(r.unresolved_topics).toEqual(['Playtesting']);
    expect(r.message).toMatch(/attach a rubric/i);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run server/services/suggestions.test.js`
Expected: FAIL on the three new tests.

- [ ] **Step 3: Implement in `server/services/suggestions.js`**

Add the import `import { getFeedbackRows, resolveRowKey } from './feedbackRows.js';`. After `scoreScale` is computed, add `const feedbackRows = getFeedbackRows(db, assignmentRow.schoology_assignment_id, scoreScale);`. Replace the `byKey` loop body so a key resolves against the rows when the task has them:

```js
  const rows = feedbackRows?.rows ?? [];
  const storedScores = {};
  const unresolvedTopics = [];
  const unresolvedRows = [];
  const invalidLevels = {};
  const numericLevels = [];
  for (const [key, rawLevel] of Object.entries(rubric_scores || {})) {
    // Feedback rows: store under the exact criterion name so the card and the
    // image skill read one spelling. Aligned topics: stored as sent (unchanged).
    let storeKey = key;
    if (rows.length) {
      storeKey = resolveRowKey(rows, key);
      if (!storeKey) { unresolvedRows.push(key); continue; }
    } else if (!byKey.has(String(key).toLowerCase())) { unresolvedTopics.push(key); continue; }
    const code = normalizeLevel(rawLevel);
    if (!code) {
      if (/^\s*\d+(\.\d+)?\s*$/.test(String(rawLevel))) numericLevels.push(key);
      else invalidLevels[key] = rawLevel;
      continue;
    }
    storedScores[storeKey] = code;
  }
```

And in the result block:

```js
  if (unresolvedTopics.length) result.unresolved_topics = unresolvedTopics;
  if (unresolvedRows.length) result.unresolved_rows = unresolvedRows;
  const notes = [];
  if (unresolvedRows.length) notes.push(`Unknown row(s) ${unresolvedRows.join(', ')}: the rows of "${feedbackRows.rubric.name}" are ${rows.map(r => r.criterion).join(', ')}.`);
  if (scoreScale && !rows.length && unresolvedTopics.length) notes.push(`This assignment is graded on ${scoreScale.name} with no rubric: attach a rubric (attach_rubric) to send row levels, or send scale_level only.`);
```

(Keep the existing numeric, invalid-level and scale notes after these.)

- [ ] **Step 4: Update the descriptions in `mcp/server.js`**

`write_student_suggestions` description, replacing the score-scale sentence:

```
For an assignment with a `score_scale` (Completion, General Academic Scale (Unaligned), Approaches to Learning) and no `rubric`, send `scale_level` instead of rubric_scores, e.g. after checking a third-party platform, "Completed" plus an `evidence` note saying what you checked. When get_assignment_context also returns a `rubric` (feedback rows), send each row's level in `rubric_scores` keyed by the row's `criterion`; Prism stages the rubric average as the overall level, so send `scale_level` only when your judgment differs from that average or a row is Insufficient Evidence.
```

`rubric_scores` field: `'{ topic external_id|title, or a feedback row\'s criterion: proficiency level code or name }: levels only; Prism owns the points conversion'`.
`scale_level` field: `'Score-scale assignments only: a level code or label from get_assignment_context score_scale, e.g. "Completed". With feedback rows, only when it differs from the rubric average or a row is IE'`.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run server/services/suggestions.test.js mcp/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/suggestions.js server/services/suggestions.test.js mcp/server.js
git commit -m "feat(feedback-rows): agents suggest row levels keyed by criterion

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: get_assignment_context and list_assignments

**Files:**
- Modify: `server/services/assessmentContext.js` (`buildDraftFeedback`, `getAssessmentContext`)
- Modify: `mcp/handlers.js` (`listAssignments`, about line 126)
- Modify: `mcp/server.js` (`get_assignment_context` description; the grading prompt's "Scale assignments" bullet, about line 649)
- Test: `server/services/assessmentContext.test.js`, `mcp/handlers.test.js`

**Interfaces:**
- Consumes: `getFeedbackRows`, `getRowLevels`, `ROW_PREFIX` (Task 1); `rubricAverage` (Task 2, server copy).
- Produces (context, feedback-row task): top-level `rubric: { name, rows } | null` (key absent on an aligned task); per student `current_row_levels`; `draft_feedback.row_levels`, `draft_feedback.removed_rows`, `draft_feedback.scale_level`, `draft_feedback.scale_level_source: 'teacher' | 'rubric_average' | null`. `draft_feedback.rubric_scores` never carries `__scale__` or `row:` keys. `list_assignments` rows gain `feedback_rubric: string | null`.

- [ ] **Step 1: Write the failing context tests** (append to `server/services/assessmentContext.test.js`, following that file's seed helpers; read its top first for the `getDb` / `migrate` pattern and the student/enrolment seed)

```js
import { saveRubric } from './rubricStore.js';
import { saveRowLevels } from './feedbackRows.js';

describe('feedback rows on an unaligned GAS task', () => {
  // A course, a GAS (Unaligned) assignment 'sa-F' with the Flappy rubric attached,
  // and two enrolled students: uid-1 (published EX overall, with row finals) and uid-2 (ungraded).
  function seedRows(db) {
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-F', 'MGD')`).run().lastInsertRowid;
    const asg = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-F', 'Flappy (F)', '23495360')`).run(courseId).lastInsertRowid;
    const s1 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`).run().lastInsertRowid;
    const s2 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-2', 'Alan', 'Turing')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-1'), (?, ?, 'enr-2')`).run(s1, courseId, s2, courseId);
    const rubricId = saveRubric(db, { name: 'Flappy', source: 'mcp', criteria: [
      { position: 1, criterion_name: 'Features and Code', standard_title: 'AS5', reporting_category: 'PRODUCE', descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd' } },
      { position: 2, criterion_name: 'Playtesting', standard_title: 'AS3', reporting_category: 'CREATE', descriptors: { ED: 'e', EX: 'f', D: 'g', EM: 'h' } },
    ] });
    db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-F', ?, 'now')`).run(rubricId, courseId);
    db.prepare(`INSERT INTO grades (student_id, assignment_id, score, grade_comment, exception, comment_status) VALUES (?, ?, 75, 'Well done', 0, 1)`).run(s1, asg);
    saveRowLevels(db, { assignmentSchoologyId: 'sa-F', studentUid: 'uid-1', rowLevels: { 'Features and Code': 'EX', Playtesting: 'ED' } });
    return { courseId, asg, s1, s2 };
  }

  test('returns the rubric rows, finals, suggestions and an empty topic set', () => {
    const db = getDb();
    seedRows(db);
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-F' });
    expect(ctx.topics).toEqual([]);
    expect(ctx.rubric.name).toBe('Flappy');
    expect(ctx.rubric.rows[0]).toEqual({ criterion: 'Features and Code', standard: 'AS5', category: 'PRODUCE',
      descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' } });
    const s1 = ctx.students.find(s => s.schoology_uid === 'uid-1');
    expect(s1).toMatchObject({ current_scale_level: 'EX', current_scores: {}, grade_comment: 'Well done', display_to_student: true,
      current_row_levels: { 'Features and Code': 'EX', Playtesting: 'ED' } });
    expect(ctx.students.find(s => s.schoology_uid === 'uid-2').current_row_levels).toEqual({});
  });

  test('draft_feedback separates row picks and the overall, with its source', () => {
    const db = getDb();
    seedRows(db);
    const uid2 = db.prepare(`SELECT id FROM students WHERE schoology_uid = 'uid-2'`).get().id;
    const asg = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = 'sa-F'`).get().id;
    const put = (studentId, pending) => db.prepare(
      `INSERT OR REPLACE INTO assessment_drafts (assignment_id, student_id, draft_json, updated_at) VALUES (?, ?, ?, datetime('now'))`
    ).run(asg, studentId, JSON.stringify({ pending, comment: 'x', display: true }));

    put(uid2, { 'row:Features and Code': 'EX', 'row:Playtesting': 'D' });
    let d = getAssessmentContext(db, { assignmentId: 'sa-F' }).students.find(s => s.id === uid2).draft_feedback;
    expect(d).toMatchObject({ rubric_scores: {}, row_levels: { 'Features and Code': 'EX', Playtesting: 'D' }, scale_level: 'EX', scale_level_source: 'rubric_average' });

    put(uid2, { 'row:Features and Code': 'EX', 'row:Playtesting': 'D', __scale__: 'D' });
    d = getAssessmentContext(db, { assignmentId: 'sa-F' }).students.find(s => s.id === uid2).draft_feedback;
    expect(d).toMatchObject({ scale_level: 'D', scale_level_source: 'teacher' });
    expect(d.rubric_scores).toEqual({});
  });

  test('a published student is never given a rubric_average overall', () => {
    const db = getDb();
    seedRows(db);
    const uid1 = db.prepare(`SELECT id FROM students WHERE schoology_uid = 'uid-1'`).get().id;
    const asg = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = 'sa-F'`).get().id;
    db.prepare(`INSERT INTO assessment_drafts (assignment_id, student_id, draft_json, updated_at) VALUES (?, ?, ?, datetime('now'))`)
      .run(asg, uid1, JSON.stringify({ pending: { 'row:Playtesting': 'D' } }));
    const d = getAssessmentContext(db, { assignmentId: 'sa-F' }).students.find(s => s.id === uid1).draft_feedback;
    expect(d).toMatchObject({ scale_level: null, scale_level_source: null });
  });

  test('a scale task without a rubric returns rubric null; __scale__ never leaks into rubric_scores', () => {
    const db = getDb();
    const { courseId, s2 } = seedRows(db);
    const asgG = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-G', 'Plain (F)', '23495360')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO assessment_drafts (assignment_id, student_id, draft_json, updated_at) VALUES (?, ?, ?, datetime('now'))`)
      .run(asgG, s2, JSON.stringify({ pending: { __scale__: 'EX' } }));
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-G' });
    expect(ctx.rubric).toBeNull();
    const d = ctx.students.find(s => s.id === s2).draft_feedback;
    expect(d.rubric_scores).toEqual({});
    expect(d).toMatchObject({ scale_level: 'EX', scale_level_source: 'teacher' });
  });

  test('an aligned task has no rubric key', () => {
    const db = getDb();
    seedContext(db);
    expect('rubric' in getAssessmentContext(db, { assignmentId: 'sa-1' })).toBe(false);
  });
});
```

Add `DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM rubric_criteria; DELETE FROM rubrics;` to the front of the file's `beforeEach` exec string.

- [ ] **Step 2: Write the failing `list_assignments` test** (in `mcp/handlers.test.js`)

```js
describe('listAssignments feedback_rubric', () => {
  test('names the rubric attached to an unaligned task, null otherwise', () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1','MGD')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-F', 'Flappy (F)', '23495360')`).run(courseId);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-G', 'Plain (F)', '23495360')`).run(courseId);
    const rubricId = saveRubric(db, { name: 'Flappy', source: 'mcp', criteria: [{ position: 1, criterion_name: 'Playtesting' }] });
    db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-F', ?, 'now')`).run(rubricId, courseId);
    const byId = Object.fromEntries(listAssignments(db, { course_id: courseId }).map(a => [a.schoology_assignment_id, a]));
    expect(byId['sa-F'].feedback_rubric).toBe('Flappy');
    expect(byId['sa-G'].feedback_rubric).toBeNull();
  });
});
```

Check `listAssignments`'s argument shape at the top of `mcp/handlers.js` (`{ course_id }` is expected) and the file's `beforeEach` clean-up list; add `rubric_attachments` and `rubrics` to it if missing.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run server/services/assessmentContext.test.js mcp/handlers.test.js`
Expected: FAIL.

- [ ] **Step 4: Implement `buildDraftFeedback` in `assessmentContext.js`**

```js
// Project a stored draft into the agent-facing shape. Topic picks go to
// rubric_scores and staged removals to removed_topics; feedback-row picks
// ('row:<criterion>') to row_levels / removed_rows; the overall pick
// ('__scale__') to scale_level. With feedback rows and no published overall,
// the rubric average of the effective rows (staged over finals) is the
// overall the teacher would publish: scale_level_source 'rubric_average'.
function buildDraftFeedback(draft, { scoreScale = null, rowNames = [], finals = {}, publishedLevel = null } = {}) {
  const pending = draft.pending || {};
  const rubric_scores = {};
  const removed_topics = [];
  const row_levels = {};
  const removed_rows = [];
  let pick = null;
  for (const [key, level] of Object.entries(pending)) {
    if (key === '__scale__') { pick = level; continue; }
    if (key.startsWith(ROW_PREFIX)) {
      const name = key.slice(ROW_PREFIX.length);
      if (level === '__remove__') removed_rows.push(name); else row_levels[name] = level;
      continue;
    }
    if (level === '__remove__') removed_topics.push(key);
    else rubric_scores[key] = level;
  }
  let scale_level = pick;
  let scale_level_source = pick ? 'teacher' : null;
  if (!pick && scoreScale && rowNames.length && publishedLevel == null) {
    const effective = { ...finals, ...row_levels };
    for (const n of removed_rows) delete effective[n];
    const avg = rubricAverage(scoreScale, rowNames, effective);
    if (avg.level) { scale_level = avg.level; scale_level_source = 'rubric_average'; }
  }
  // displayTouched and base are UI-only draft state; intentionally omitted here.
  return {
    updated_at: draft.updated_at ?? null,
    rubric_scores,
    removed_topics,
    ...(scoreScale ? { row_levels, removed_rows, scale_level, scale_level_source } : {}),
    comment: draft.comment ?? '',
    display_to_student: Boolean(draft.display),
  };
}
```

Imports to add: `import { getFeedbackRows, getRowLevels, ROW_PREFIX } from './feedbackRows.js';` and `import { rubricAverage } from '../lib/rubricAverage.js';`. `feedbackRows.js` imports only `rubricStore.js` and `proficiencyScale.js`, so there is no cycle.

- [ ] **Step 5: Wire it into `getAssessmentContext`**

After `const scoreScale = …`:

```js
  const feedbackRows = getFeedbackRows(db, schoolyId, scoreScale);
  const rowNames = (feedbackRows?.rows ?? []).map((r) => r.criterion);
  const rowLevelsByUid = feedbackRows ? getRowLevels(db, schoolyId) : {};
```

In each student object, beside `current_scale_level`:

```js
      ...(scoreScale ? {
        // The teacher's published row levels (feedback rows): Prism-only, for the rows of the attached rubric.
        current_row_levels: Object.fromEntries(Object.entries(rowLevelsByUid[st.schoology_uid] || {}).filter(([n]) => rowNames.includes(n))),
      } : {}),
```

and replace `draft_feedback: draft ? buildDraftFeedback(draft) : null` with:

```js
      draft_feedback: draft ? buildDraftFeedback(draft, {
        scoreScale, rowNames,
        finals: rowLevelsByUid[st.schoology_uid] || {},
        publishedLevel: scoreScale ? levelForScore(scoreScale, meta.score) : null,
      }) : null,
```

In the return object, after `score_scale`:

```js
    // Feedback rows (spec 2026-10-13): the attached rubric's criteria, marked in
    // Prism only. null on a score-scale task with no rubric; absent when aligned.
    ...(scoreScale ? { rubric: feedbackRows.rubric ? { name: feedbackRows.rubric.name, rows: feedbackRows.rows } : null } : {}),
```

- [ ] **Step 6: `list_assignments` in `mcp/handlers.js`**

In the `rows.map`, compute the scale once and add the rubric name:

```js
  return rows.map(({ latest_submitted_at, course_id: _c, is_lti_submission, grading_scale_id, ...r }) => {
    const scale = scoreScaleFor({ grading_scale_id }, r.has_aligned_topics ? 1 : 0);
    return {
      ...r,
      has_aligned_topics: !!r.has_aligned_topics,
      score_scale: scale?.name ?? null,
      // The rubric attached as feedback rows (spec 2026-10-13), or null.
      feedback_rubric: getFeedbackRows(db, r.schoology_assignment_id, scale)?.rubric?.name ?? null,
      latest_submission_at: latest_submitted_at > 0 ? new Date(latest_submitted_at * 1000).toISOString() : null,
      ...assignmentCounts(db, { id: r.id, schoology_assignment_id: r.schoology_assignment_id, course_id: _c, is_lti_submission }),
    };
  });
```

Keep the existing comments above each field.

- [ ] **Step 7: Update `mcp/server.js` text**

`get_assignment_context` description: after "each student's `current_scale_level`;" insert: "when that assignment has a rubric attached, also `rubric` { name, rows: [{ criterion, standard, category, descriptors }] } and each student's `current_row_levels` { criterion: level } (the teacher's published row levels; feedback rows are Prism-only and never sent to Schoology), with draft_feedback.row_levels and draft_feedback.scale_level (scale_level_source: teacher | rubric_average);".

`list_assignments` description: append "`feedback_rubric` names the rubric attached to an unaligned assignment as feedback rows (null otherwise)."

Grading prompt bullet (about line 649), replacing the "Scale assignments" bullet:

```js
              `- **Scale assignments:** if \`get_assignment_context\` returns a \`score_scale\` (Completion, General ` +
              `Academic Scale (Unaligned), Approaches to Learning) and no \`rubric\`, grade with \`scale_level\` (a level from ` +
              `\`score_scale.levels\`) plus an \`evidence\` note saying what you checked, instead of \`rubric_scores\`. If it ` +
              `also returns a \`rubric\` (feedback rows), send each row's level in \`rubric_scores\` keyed by \`criterion\`; ` +
              `Prism stages the rubric average as the overall level, so add \`scale_level\` only when your judgment differs ` +
              `from that average or a row is Insufficient Evidence.\n` +
```

- [ ] **Step 8: Run to verify they pass**

Run: `npx vitest run server/services/ mcp/`
Expected: PASS. If an existing test asserts the old `draft_feedback` shape on a score-scale task with `toEqual`, update it to the new shape (the `__scale__` key moves from `rubric_scores` to `scale_level`): that is the fixed bug.

- [ ] **Step 9: Commit**

```bash
git add server/services/assessmentContext.js server/services/assessmentContext.test.js mcp/handlers.js mcp/handlers.test.js mcp/server.js
git commit -m "feat(feedback-rows): rows, row finals and the staged overall in get_assignment_context

draft_feedback no longer leaks the card's __scale__ key into rubric_scores.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Publish path and the rows-only route

**Files:**
- Modify: `server/routes/mastery.js` (GET `/:courseId/assignment/:assignmentId` about line 575; `write-comment` about line 681; `send-all` about line 922)
- Modify: `server/routes/rubrics.js` (new `PUT /row-levels/:assignmentSchoologyId/:studentUid`)
- Test: `server/routes/mastery.test.js`, `server/routes/rubrics.test.js` (create if absent, following `mastery.test.js`'s `startServer` / fetch helpers)

**Interfaces:**
- Consumes: `getFeedbackRows`, `getRowLevels`, `rowLevelsError`, `saveRowLevels` (Task 1); `scoreScaleFor`, `getAlignedTopics` (already imported in `mastery.js`).
- Produces:
  - GET assessment: each student gains `row_levels: { [criterion]: level }` (`{}` when none).
  - `POST write-comment` accepts optional `rowLevels`; validated before any Schoology call; written after `putSucceeded`.
  - `POST send-all` entries accept optional `rowLevels`; an entry may carry only `rowLevels` (no `scores`, `grade` or `comment`).
  - `PUT /api/rubrics/row-levels/:assignmentSchoologyId/:studentUid` body `{ rowLevels }` → `{ ok: true, row_levels }`; 400 on a validation error.

- [ ] **Step 1: Write the failing route tests** (append inside the `#41` score-scale describe block in `mastery.test.js`, which seeds `sec-S`, `uid-A`/`eA`, `uid-B`/`eB`)

```js
  describe('feedback rows (spec 2026-10-13)', () => {
    beforeEach(() => {
      const db = getDb();
      db.exec('DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM rubrics;');
      db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-F', 'Flappy (F)', '23495360')`).run(courseId);
      const rubricId = db.prepare(`INSERT INTO rubrics (name, source, created_at, updated_at) VALUES ('Flappy', 'mcp', 'now', 'now')`).run().lastInsertRowid;
      db.prepare(`INSERT INTO rubric_criteria (rubric_id, position, criterion_name) VALUES (?, 1, 'Features and Code'), (?, 2, 'Playtesting')`).run(rubricId, rubricId);
      db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-F', ?, 'now')`).run(rubricId, courseId);
      vi.mocked(getSectionGrades).mockResolvedValue([{ assignment_id: 'sa-F', enrollment_id: 'eB', grade: null, exception: 0, timestamp: '0' }]);
      vi.mocked(pushGradeComments).mockResolvedValue({ status: 207 });
    });
    const rowsOf = (uid) => Object.fromEntries(getDb().prepare(
      `SELECT criterion_name, level FROM rubric_row_levels WHERE assignment_schoology_id = 'sa-F' AND student_uid = ?`).all(uid).map(r => [r.criterion_name, r.level]));

    test('GET returns each student\'s row levels', async () => {
      getDb().prepare(`INSERT INTO rubric_row_levels (assignment_schoology_id, student_uid, criterion_name, level) VALUES ('sa-F', 'uid-B', 'Playtesting', 'ED')`).run();
      const { body } = await get(`/api/mastery/${courseId}/assignment/sa-F`);
      const byUid = Object.fromEntries(body.students.map(s => [s.schoology_uid, s]));
      expect(byUid['uid-B'].row_levels).toEqual({ Playtesting: 'ED' });
      expect(byUid['uid-A'].row_levels).toEqual({});
    });

    test('write-comment sends only the overall to Schoology and then stores the rows', async () => {
      const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-F', points: 75, comment: 'Good', commentStatus: true,
        rowLevels: { 'Features and Code': 'EX', Playtesting: 'D' },
      });
      expect(status).toBe(200);
      const sent = vi.mocked(pushGradeComments).mock.calls[0][1][0];
      expect(sent).toEqual({ assignment_id: 'sa-F', enrollment_id: 'eB', comment: 'Good', comment_status: 1, grade: '75', exception: 0 });
      expect(rowsOf('uid-B')).toEqual({ 'Features and Code': 'EX', Playtesting: 'D' });
    });

    test('write-comment stores no rows when Schoology rejects the write', async () => {
      vi.mocked(pushGradeComments).mockResolvedValue({ status: 500, data: {} });
      const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-F', points: 75, comment: '', commentStatus: true, rowLevels: { Playtesting: 'D' },
      });
      expect(status).toBe(502);
      expect(rowsOf('uid-B')).toEqual({});
    });

    test('write-comment refuses an unknown row before any Schoology call', async () => {
      const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-F', points: 75, comment: '', rowLevels: { Evaluation: 'EX' },
      });
      expect(status).toBe(400);
      expect(getSectionGrades).not.toHaveBeenCalled();
      expect(pushGradeComments).not.toHaveBeenCalled();
    });

    test('send-all with only row changes makes no Schoology call and stores the rows', async () => {
      const { status } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-B', enrollmentId: 'eB', assignmentId: 'sa-F', scores: null, grade: null, comment: null, rowLevels: { Playtesting: 'EX' } }],
      });
      expect(status).toBe(200);
      expect(getSectionGrades).not.toHaveBeenCalled();
      expect(pushGradeComments).not.toHaveBeenCalled();
      expect(rowsOf('uid-B')).toEqual({ Playtesting: 'EX' });
    });

    test('send-all stores rows only after the comment PUT succeeds', async () => {
      vi.mocked(pushGradeComments).mockResolvedValue({ status: 500, data: {} });
      await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-B', enrollmentId: 'eB', assignmentId: 'sa-F', scores: null,
          grade: { points: 75 }, comment: { comment: 'Good', commentStatus: true }, rowLevels: { Playtesting: 'EX' } }],
      });
      expect(rowsOf('uid-B')).toEqual({});
    });
  });
```

Check: `mastery.test.js` clears mocks between tests (`vi.clearAllMocks` in a `beforeEach`/`afterEach`); if not, add `vi.mocked(getSectionGrades).mockClear(); vi.mocked(pushGradeComments).mockClear();` to this block's `beforeEach`.

- [ ] **Step 2: Write the failing rows-only route test** (append to `server/routes/rubrics.test.js`, which already has the `call(method, path, body)` helper; `rubric_descriptors` is on in `config.yaml`, so the feature gate passes)

```js
test('PUT /row-levels saves Prism-only row levels and validates them', async () => {
  const db = getDb();
  db.exec('DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM assignments; DELETE FROM courses;');
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-F', 'MGD')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-F', 'Flappy (F)', '23495360')`).run(courseId);
  const rubricId = saveRubric(db, { name: 'Flappy', source: 'mcp', criteria: [{ position: 1, criterion_name: 'Playtesting' }] });
  db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-F', ?, 'now')`).run(rubricId, courseId);
  const put = (path, body) => call('PUT', path, body);
  const ok = await put('/api/rubrics/row-levels/sa-F/uid-B', { rowLevels: { Playtesting: 'EX' } });
  expect(ok.status).toBe(200);
  expect(ok.body).toEqual({ ok: true, row_levels: { Playtesting: 'EX' } });
  const bad = await put('/api/rubrics/row-levels/sa-F/uid-B', { rowLevels: { Evaluation: 'EX' } });
  expect(bad.status).toBe(400);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run server/routes/mastery.test.js server/routes/rubrics.test.js`
Expected: FAIL.

- [ ] **Step 4: Add a shared helper in `mastery.js`**

```js
import { getFeedbackRows, getRowLevels, rowLevelsError, saveRowLevels } from '../services/feedbackRows.js';

// The feedback rows (spec 2026-10-13) of an assignment in this course, or [].
function feedbackRowsFor(db, courseId, assignmentId) {
  const row = db.prepare('SELECT * FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?')
    .get(String(assignmentId), courseId);
  if (!row) return [];
  const scale = scoreScaleFor(row, getAlignedTopics(db, row.course_id, row.schoology_assignment_id).length);
  return getFeedbackRows(db, row.schoology_assignment_id, scale)?.rows ?? [];
}

// The student's schoology_uid for an enrolment id, or null.
function uidForEnrolment(db, enrollmentId) {
  return db.prepare(`SELECT s.schoology_uid FROM students s JOIN enrolments e ON e.student_id = s.id
    WHERE e.schoology_enrolment_id = ?`).get(String(enrollmentId))?.schoology_uid ?? null;
}
```

- [ ] **Step 5: GET assessment.** After `const scoreScale = scoreScaleFor(...)`: `const rowLevelsByUid = scoreScale ? getRowLevels(db, assignmentId) : {};` and in each student: `row_levels: rowLevelsByUid[s.schoology_uid] || {},` (beside `scale_level`).

- [ ] **Step 6: write-comment.** Read `rowLevels` from `req.body`. After the `hasPoints` scale check:

```js
  // Feedback rows (spec 2026-10-13): Prism-only. Validated before any Schoology
  // call; written only after Schoology accepts the overall write below.
  const hasRowLevels = rowLevels != null;
  if (hasRowLevels) {
    const rowError = rowLevelsError(feedbackRowsFor(db, courseId, assignmentId), rowLevels);
    if (rowError) return res.status(400).json({ error: rowError });
  }
```

After the `putSucceeded` check passes, inside the `if (studentRow && assignmentRow)` block, before `captureFeedbackSnapshots`:

```js
        if (hasRowLevels) {
          const uid = uidForEnrolment(db, enrollmentId);
          if (uid) saveRowLevels(db, { assignmentSchoologyId: String(assignmentId), studentUid: uid, rowLevels });
        }
```

- [ ] **Step 7: send-all.** After the scale-grade validation loop:

```js
  // Feedback rows: validate every entry's rows before any write.
  for (const e of entries.filter(x => x.rowLevels != null)) {
    const rowError = rowLevelsError(feedbackRowsFor(db, courseId, e.assignmentId), e.rowLevels);
    if (rowError) return res.status(400).json({ error: rowError, results: entries.map(x => ({ uid: x.uid, ok: false })) });
  }
```

In step 3 (the local mirror), after the `commentEntries` loop:

```js
    // Feedback rows: Prism-only, mirrored now that every Schoology write succeeded
    // (a rows-only entry made no Schoology call at all).
    for (const e of entries.filter(x => x.rowLevels != null)) {
      const uid = uidForEnrolment(db, e.enrollmentId);
      if (uid) saveRowLevels(db, { assignmentSchoologyId: String(e.assignmentId), studentUid: uid, rowLevels: e.rowLevels });
    }
```

Check the response: a rows-only entry has no `pairByUid` entry, so its result is `{ uid, ok: true, resubmissionFields: null }`; that is correct.

- [ ] **Step 8: Rows-only route in `server/routes/rubrics.js`**

```js
import { getFeedbackRows, rowLevelsError, saveRowLevels, getRowLevels } from '../services/feedbackRows.js';
import { getAlignedTopics, scoreScaleFor } from '../services/assessmentContext.js';

// Save a student's feedback-row levels without touching Schoology (spec
// 2026-10-13 §5): the card's Save when only rows changed.
router.put('/row-levels/:assignmentSchoologyId/:studentUid', (req, res) => {
  const db = getDb();
  const { assignmentSchoologyId, studentUid } = req.params;
  const row = db.prepare('SELECT * FROM assignments WHERE schoology_assignment_id = ?').get(String(assignmentSchoologyId));
  const scale = row ? scoreScaleFor(row, getAlignedTopics(db, row.course_id, row.schoology_assignment_id).length) : null;
  const rows = getFeedbackRows(db, assignmentSchoologyId, scale)?.rows ?? [];
  const error = rowLevelsError(rows, req.body?.rowLevels);
  if (error) return res.status(400).json({ error });
  saveRowLevels(db, { assignmentSchoologyId, studentUid, rowLevels: req.body.rowLevels });
  res.json({ ok: true, row_levels: getRowLevels(db, assignmentSchoologyId)[studentUid] || {} });
});
```

Place it before `router.patch('/:id', …)` so `/row-levels/...` is not read as an id.

- [ ] **Step 9: Run to verify they pass**

Run: `npx vitest run server/`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/routes/mastery.js server/routes/mastery.test.js server/routes/rubrics.js server/routes/rubrics.test.js
git commit -m "feat(feedback-rows): store row levels with the publish, or alone without Schoology

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Row finals in get_student_history

**Files:**
- Modify: `server/services/studentHistory.js` (`courseAssessments`, about lines 202-279)
- Test: `server/services/studentHistory.test.js`

**Interfaces:**
- Consumes: `orderedRowLevels`, `ROW_PREFIX` (Task 1).
- Produces: a history item with row finals carries `rubric_rows: [{ criterion, level }]`; compact output omits it; `teacher_draft` gains `row_levels` and `scale_level`, and `topic_levels` excludes `row:` and `__scale__` keys.

- [ ] **Step 1: Write the failing tests** (follow the file's existing seed for a student with a graded course)

```js
describe('feedback rows in the history', () => {
  // Molly's AIML course (ids.aiml) gains a GAS (Unaligned) formative with the Flappy rubric attached.
  function seedRows(db) {
    const asg = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, grading_scale_id, grading_category_id, published)
      VALUES (?, 'a-aiml-rows', 'AIML Flappy (F)', '2025-09-01 15:00:00', 'GAS', 'form', 1)`).run(ids.aiml).lastInsertRowid;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, score, max_score, grade_comment, comment_status, exception, late) VALUES (?, ?, 75, 100, 'Good', 1, 0, 0)`).run(ids.molly, asg);
    const rubricId = db.prepare(`INSERT INTO rubrics (name, source, created_at, updated_at) VALUES ('Flappy', 'mcp', 'now', 'now')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO rubric_criteria (rubric_id, position, criterion_name) VALUES (?, 1, 'Features and Code'), (?, 2, 'Playtesting')`).run(rubricId, rubricId);
    db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'a-aiml-rows', ?, 'now')`).run(rubricId, ids.aiml);
    db.prepare(`INSERT INTO rubric_row_levels (assignment_schoology_id, student_uid, criterion_name, level) VALUES ('a-aiml-rows', 'uid-molly', 'Playtesting', 'ED'), ('a-aiml-rows', 'uid-molly', 'Features and Code', 'EX')`).run();
    return asg;
  }
  const find = (h, title) => h.courses.flatMap((c) => c.assessments).find((a) => a.title === title);

  test('a formative with feedback rows lists its row finals in rubric order (full detail only)', () => {
    const db = getDb();
    seedRows(db);
    const full = getStudentHistory(db, { student: ids.molly, include_formative: true });
    expect(find(full, 'AIML Flappy (F)').rubric_rows).toEqual([{ criterion: 'Features and Code', level: 'EX' }, { criterion: 'Playtesting', level: 'ED' }]);
    const compact = getStudentHistory(db, { student: ids.molly, include_formative: true, detail: 'compact' });
    expect(find(compact, 'AIML Flappy (F)').rubric_rows).toBeUndefined();
  });

  test('teacher_draft separates row and overall picks from topic levels', () => {
    const db = getDb();
    const asg = seedRows(db);
    db.prepare(`INSERT INTO assessment_drafts (assignment_id, student_id, draft_json) VALUES (?, ?, ?)`)
      .run(asg, ids.molly, JSON.stringify({ pending: { 'row:Playtesting': 'D', __scale__: 'EX', t51: 'ED' } }));
    const h = getStudentHistory(db, { student: ids.molly, include_formative: true, include_teacher_drafts: true });
    const d = find(h, 'AIML Flappy (F)').teacher_draft;
    expect(d.topic_levels).toEqual({ t51: 'ED' });
    expect(d.row_levels).toEqual({ Playtesting: 'D' });
    expect(d.scale_level).toBe('EX');
  });
});
```

Add `DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM rubric_criteria; DELETE FROM rubrics;` to the front of the file's `beforeEach` exec string.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run server/services/studentHistory.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `courseAssessments`, after `topicsBy` is built:

```js
  // Feedback rows (spec 2026-10-13): the teacher's published row levels on
  // unaligned tasks, ordered by the attached rubric. Prism-only data.
  const rowsBy = {};
  for (const r of db.prepare(
    'SELECT assignment_schoology_id, criterion_name, level FROM rubric_row_levels WHERE student_uid = ?'
  ).all(String(student.schoology_uid))) (rowsBy[r.assignment_schoology_id] ||= {})[r.criterion_name] = r.level;
  const rowOrder = (asgSchoologyId) => db.prepare(`
    SELECT c.criterion_name FROM rubric_attachments a JOIN rubric_criteria c ON c.rubric_id = a.rubric_id
    WHERE a.assignment_schoology_id = ? ORDER BY c.position, c.id
  `).all(String(asgSchoologyId)).map((c) => c.criterion_name);
```

In the loop, after `topics`:

```js
    const rubricRows = rowsBy[a.schoology_assignment_id]
      ? orderedRowLevels(rowOrder(a.schoology_assignment_id), rowsBy[a.schoology_assignment_id]) : [];
```

Extend `assessed` with `|| rubricRows.length > 0`, add `...(rubricRows.length ? { rubric_rows: rubricRows } : {}),` after `topics` in `item`, and replace the `teacher_draft` levels:

```js
      const pending = parsed.pending || {};
      item.teacher_draft = {
        status: 'teacher_draft_unpublished',
        updated_at: draft.updated_at,
        comment: parsed.comment ?? null,
        topic_levels: Object.fromEntries(Object.entries(pending)
          .filter(([k, v]) => v !== '__remove__' && k !== '__scale__' && !k.startsWith(ROW_PREFIX))),
        row_levels: Object.fromEntries(Object.entries(pending)
          .filter(([k, v]) => v !== '__remove__' && k.startsWith(ROW_PREFIX)).map(([k, v]) => [k.slice(ROW_PREFIX.length), v])),
        scale_level: pending.__scale__ ?? null,
      };
```

`shape(a)` (about line 337) already lists the compact fields explicitly, so `rubric_rows` is left out of compact output with no change there.

- [ ] **Step 4: Update the `get_student_history` description in `mcp/server.js`** (about line 556): add "A formative with feedback rows (a rubric on an unaligned task) also lists `rubric_rows` [{ criterion, level }], the teacher's published row levels (full detail only)."

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run server/services/studentHistory.test.js mcp/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/studentHistory.js server/services/studentHistory.test.js mcp/server.js
git commit -m "feat(feedback-rows): row finals in student history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The card grid for feedback rows, Save and Send all

**Files:**
- Modify: `client/src/services/api.js` (add `saveRowLevels`)
- Modify: `client/src/lib/assessmentDraft.js` (`draftBaseline` third argument)
- Create: `client/src/lib/feedbackRows.js` (row pseudo-topics)
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (page: build rows; card: grid, Save, Send all)
- Test: `client/src/lib/feedbackRows.test.js`, `client/src/lib/assessmentDraft.test.js`, `client/src/pages/AssessmentSummaryPage.test.jsx`

**Interfaces:**
- Consumes: GET assessment `students[].row_levels` and `scoreScale` (Task 6); `GET /api/rubrics/assignment/:id` → `{ id, rubric: { criteria: [{ id, position, criterion_name, standard_title, reporting_category, descriptors }] }, topicByCriterion }`.
- Produces:
  - `api.saveRowLevels(assignmentSchoologyId, studentUid, rowLevels)` → PUT `/rubrics/row-levels/...`.
  - `feedbackRowTopics(criteria)` → `[{ id: 'row:<name>', external_id: null, title: name, category_title, criterion }]`, by `position`.
  - `rowScores(rowLevels)` → `{ 'row:<name>': { grade: level } }`.
  - `rowTopicMapping(rowTopics)` → `[{ criterion_id, topic_id }]`.
  - `draftBaseline(student, topics, { includeScore } = {})`: `includeScore` defaults to `topics.length === 0`.
  - The card treats `scoreScale && topics.length > 0` as a feedback-row task.

- [ ] **Step 1: Write the failing lib tests**

`client/src/lib/feedbackRows.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { feedbackRowTopics, rowScores, rowTopicMapping } from './feedbackRows.js';

const criteria = [
  { id: 12, position: 2, criterion_name: 'Playtesting', reporting_category: 'CREATE' },
  { id: 11, position: 1, criterion_name: 'Features and Code', reporting_category: 'PRODUCE' },
];

describe('feedback rows as pseudo-topics', () => {
  it('orders rows by position with row: ids', () => {
    expect(feedbackRowTopics(criteria).map(t => [t.id, t.title, t.category_title])).toEqual([
      ['row:Features and Code', 'Features and Code', 'PRODUCE'], ['row:Playtesting', 'Playtesting', 'CREATE'],
    ]);
  });
  it('maps row levels to card scores and criteria to rows', () => {
    expect(rowScores({ Playtesting: 'ED' })).toEqual({ 'row:Playtesting': { grade: 'ED' } });
    expect(rowTopicMapping(feedbackRowTopics(criteria))).toEqual([
      { criterion_id: 11, topic_id: 'row:Features and Code' }, { criterion_id: 12, topic_id: 'row:Playtesting' },
    ]);
  });
});
```

Append to `assessmentDraft.test.js`:

```js
  it('includes the score when asked, even with topics (feedback rows)', () => {
    const s = { grade_comment: '', comment_status: 0, exception: null, scores: {}, score: 75 };
    expect(draftBaseline(s, topics, { includeScore: true })).not.toBe(draftBaseline({ ...s, score: 50 }, topics, { includeScore: true }));
    expect(draftBaseline(s, topics)).toBe(draftBaseline({ ...s, score: 50 }, topics));
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd client && npx vitest run src/lib/feedbackRows.test.js src/lib/assessmentDraft.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`client/src/lib/feedbackRows.js`:

```js
// Feedback rows (spec 2026-10-13): a rubric attached to an unaligned task. The
// card shows each criterion as a pseudo-topic with id 'row:<criterion name>',
// so the grid, drafts, suggestions and class distribution work unchanged. Row
// levels stay in Prism; only the overall scale level is published.
export const ROW_PREFIX = 'row:';
export const rowKey = (name) => `${ROW_PREFIX}${name}`;
export const isRowKey = (key) => String(key).startsWith(ROW_PREFIX);
export const rowName = (key) => String(key).slice(ROW_PREFIX.length);

export function feedbackRowTopics(criteria) {
  return (criteria || []).slice().sort((a, b) => a.position - b.position).map((c) => ({
    id: rowKey(c.criterion_name), external_id: null, title: c.criterion_name,
    category_title: c.reporting_category ?? null, criterion: c,
  }));
}

export function rowScores(rowLevels) {
  return Object.fromEntries(Object.entries(rowLevels || {}).map(([n, level]) => [rowKey(n), { grade: level }]));
}

export function rowTopicMapping(rowTopics) {
  return rowTopics.map((t) => ({ criterion_id: t.criterion.id, topic_id: t.id }));
}
```

`assessmentDraft.js`: change the signature to `draftBaseline(student, topics, { includeScore = topics.length === 0 } = {})` and the spread to `...(includeScore ? { score: student.score ?? null } : {})`. Update its comment: "the plain score is part of the baseline on any score-scale task (#41), including one with feedback rows".

`api.js`: `export const saveRowLevels = (assignmentId, studentUid, rowLevels) => request(\`/rubrics/row-levels/${assignmentId}/${studentUid}\`, { method: 'PUT', body: JSON.stringify({ rowLevels }) });`

- [ ] **Step 4: Run lib tests to verify they pass.** Expected: PASS.

- [ ] **Step 5: Write the failing card tests** (append to `AssessmentSummaryPage.test.jsx`; add `saveRowLevels: vi.fn().mockResolvedValue({ ok: true, row_levels: {} })` to the `api.js` mock and import it)

```js
describe('StudentRubricCard - feedback rows on an unaligned task', () => {
  const GAS = { name: 'General Academic Scale (Unaligned)', levels: [
    { code: 'ED', label: 'Exhibiting Depth', points: 100, cutoff: 87.5 },
    { code: 'EX', label: 'Exhibiting', points: 75, cutoff: 62.5 },
    { code: 'D', label: 'Developing', points: 50, cutoff: 37.5 },
    { code: 'EM', label: 'Emerging', points: 25, cutoff: 12.5 },
    { code: 'IE', label: 'Insufficient Evidence', points: 0, cutoff: 0 },
  ] };
  const CRITERIA = [
    { id: 11, position: 1, criterion_name: 'Features and Code', reporting_category: 'PRODUCE', descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' } },
    { id: 12, position: 2, criterion_name: 'Playtesting', reporting_category: 'CREATE', descriptors: { ED: 'e', EX: 'f', D: 'g', EM: 'h', IE: 'Insufficient Evidence' } },
  ];
  const ROWS = feedbackRowTopics(CRITERIA);
  const rubric = { criteria: CRITERIA, topicByCriterion: rowTopicMapping(ROWS) };
  const ROW = { id: 50, mastery_grading_period_id: 1, mastery_grading_category_id: 2 };
  const card = (extra = {}) => renderCard({ topics: ROWS, scoreScale: GAS, rubric, assignmentRow: ROW, ...extra });

  it('shows the rows grid with its label and the overall picker', () => {
    card();
    expect(screen.getByText('Feedback rows: kept in Prism, not sent to Schoology')).toBeInTheDocument();
    expect(screen.getByText('Features and Code')).toBeInTheDocument();
    expect(screen.getByText('Overall: General Academic Scale (Unaligned), sent to Schoology')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'General Academic Scale (Unaligned)' })).toBeInTheDocument();
  });

  it('Save publishes the overall and carries the rows', async () => {
    card();
    fireEvent.click(screen.getByTitle('Set Features and Code to Exhibiting'));
    fireEvent.click(screen.getByTitle('Set Playtesting to Exhibiting'));
    // Pick the overall explicitly: the automatic rubric average arrives in Task 9.
    fireEvent.click(screen.getByRole('button', { name: /^exhibiting$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish to Schoology' }));
    await waitFor(() => expect(writeMasteryComment).toHaveBeenCalledTimes(1));
    expect(writeMasteryComment).toHaveBeenCalledWith('4', expect.objectContaining({
      points: 75, rowLevels: { 'Features and Code': 'EX', Playtesting: 'EX' },
    }));
    expect(writeMasteryScores).not.toHaveBeenCalled();
  });

  it('a rows-only change on a published student saves in Prism only', async () => {
    card({ student: { ...makeStudent(), score: 75, scale_level: 'EX', grade_comment: 'Hi', comment_status: 1,
      scores: rowScores({ 'Features and Code': 'EX', Playtesting: 'EX' }) } });
    fireEvent.click(screen.getByTitle('Set Playtesting to Developing'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish to Schoology' }));
    await waitFor(() => expect(saveRowLevels).toHaveBeenCalledWith('8', 'uid-1', { Playtesting: 'D' }));
    expect(writeMasteryComment).not.toHaveBeenCalled();
  });
});
```

Import `feedbackRowTopics`, `rowScores`, `rowTopicMapping` from `../lib/feedbackRows.js` at the top of the test file. The grid cell `title` is `Set {row} to {level label}` (`RubricDescriptorGrid.jsx` line 52); the card renders the grid because a `rubric` is passed and `viewMode` defaults to `'descriptors'`.

- [ ] **Step 6: Run to verify they fail**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "feedback rows"`
Expected: FAIL.

- [ ] **Step 7: Page wiring in `AssessmentSummaryPage` (the page component, about line 2060)**

```js
  // Feedback rows (spec 2026-10-13): a rubric attached to a score-scale task.
  const feedbackRowList = scoreScale && rubricData?.rubric ? feedbackRowTopics(rubricData.rubric.criteria) : null;
  const cardTopics = feedbackRowList ?? topics;
  const cardRubric = rubricData
    ? { ...rubricData.rubric, topicByCriterion: feedbackRowList ? rowTopicMapping(feedbackRowList) : rubricData.topicByCriterion }
    : null;
  const cardStudent = (s) => (feedbackRowList ? { ...s, scores: rowScores(s.row_levels) } : s);
```

Pass `student={cardStudent(student)}`, `topics={cardTopics}`, `rubric={cardRubric}` to `StudentRubricCard`, and `cardTopics` wherever the page passes `topics` for the class distribution (the `distributionByTopic` call near line 1632) and the header topic count. Keep `alignedTopics` for `passesFilters`. Pass `unaligned={!!scoreScale}` to the `RubricManagerModal` (Task 9 uses it).

In `handleCardSaved`, a patch carrying `row_levels` replaces the student's `row_levels`; check the function merges unknown keys into the student (it patches by spread; confirm by reading it).

- [ ] **Step 8: Card changes in `StudentRubricCard`**

```js
  const hasFeedbackRows = !!scoreScale && topics.length > 0;
  const currentBaseline = draftBaseline(student, topics, { includeScore: !!scoreScale });
```

Rendering (about line 1092): replace the `scoreScale ? (...) : showDescriptors ? ... : ...` chain so a feedback-row task renders, in order: the label `<div className="feedback-rows-label">Feedback rows: kept in Prism, not sent to Schoology</div>`, the existing grid branch (`showDescriptors ? <RubricDescriptorGrid …/> : <compact table/>`), then `<div className="feedback-rows-overall-label">Overall: {scoreScale.name}, sent to Schoology</div>` and the existing `ScaleLevelPicker` block (with its evidence line). A score-scale task with no rows renders the picker alone, as now. Add the two classes to `client/src/app.css` beside the existing assessment-card rules, using `var(--text-muted)`, `font-size: 0.75rem`, and `margin: 0.4rem 0`.

Show the Descriptors/Compact toggle (page, about line 2128) when `!scoreScale || feedbackRowList`.

Row pending helpers:

```js
  // Feedback rows: row picks in `pending` → { criterion: level | null } (null = clear a final).
  function rowLevelsToSave() {
    const keys = Object.keys(pending).filter(isRowKey);
    if (!hasFeedbackRows || keys.length === 0) return null;
    return Object.fromEntries(keys.map((k) => [rowName(k), pending[k] === REMOVE ? null : pending[k]]));
  }
  function savedRowLevels(rowLevels) {
    const out = {};
    for (const t of topics) { const g = student.scores?.[t.id]?.grade; if (g) out[rowName(t.id)] = g; }
    for (const [n, l] of Object.entries(rowLevels || {})) { if (l == null) delete out[n]; else out[n] = l; }
    return out;
  }
```

`handleSave`, score-scale branch: use `stagedScale` (defined in Task 9; until then `pending[SCALE] ?? null`) as `scaleCode`, then:

```js
      if (scoreScale) {
        const rowLevels = rowLevelsToSave();
        const overallChanged = scaleCode != null || hasCommentChange || hasDisplayChange;
        let saved = null;
        if (overallChanged) {
          saved = await writeMasteryComment(courseId, {
            enrollmentId: student.enrollment_id, assignmentId, comment, commentStatus: display,
            ...(scaleCode ? { points: scalePointsFor(scaleCode) } : {}),
            ...(rowLevels ? { rowLevels } : {}),
            ...statusLineFields(),
          });
        } else if (rowLevels) {
          await saveRowLevels(assignmentId, student.schoology_uid, rowLevels);
        }
        setSaveResult('saved');
        setPending({});
        setInsertedLine(null);
        saverRef.current.remove({ immediate: true });
        onSaved?.(student.schoology_uid, {
          ...(scaleCode ? { score: scalePointsFor(scaleCode), scale_level: scaleCode } : {}),
          ...(rowLevels ? { row_levels: savedRowLevels(rowLevels) } : {}),
          ...(overallChanged ? {
            grade_comment: comment, comment_status: display ? 1 : null,
            ...resubmissionFieldsPatch(saved?.resubmissionFields), ...statusLinePatch(),
          } : {}),
        });
        if (overallChanged) setNotesCollapsed(true);
        return true;
      }
```

Check the existing test `'publishes the level as a grade + comment in one write'` still passes: with no rows, `rowLevels` is null and the call body is unchanged.

`buildSendEntry`, score-scale branch:

```js
    if (scoreScale) {
      const rowLevels = rowLevelsToSave();
      const overallChanged = scaleCode != null || hasCommentChange || hasDisplayChange;
      if (!overallChanged && !rowLevels) return null;
      return {
        entry: {
          uid: student.schoology_uid, enrollmentId: student.enrollment_id, assignmentId, scores: null,
          grade: scaleCode ? { points: scalePointsFor(scaleCode) } : null,
          // One PUT carries grade + comment + visibility, so the comment rides along; a rows-only entry sends nothing to Schoology.
          comment: overallChanged ? { comment, commentStatus: display, ...statusLineFields() } : null,
          ...(rowLevels ? { rowLevels } : {}),
        },
        patch: {
          ...(scaleCode ? { score: scalePointsFor(scaleCode), scale_level: scaleCode } : {}),
          ...(rowLevels ? { row_levels: savedRowLevels(rowLevels) } : {}),
          ...(overallChanged ? { grade_comment: comment, comment_status: display ? 1 : null, ...statusLinePatch() } : {}),
        },
      };
    }
```

Move the early `return null` guard so it reads `if (!hasScoreChanges && !scaleCode && !hasCommentChange && !hasDisplayChange && !rowLevelsToSave()) return null;`.

Imports to add: `feedbackRowTopics, rowScores, rowTopicMapping, isRowKey, rowName` from `../lib/feedbackRows.js`; `saveRowLevels` from `../services/api.js`.

- [ ] **Step 9: Run to verify they pass**

Run: `cd client && npx vitest run`
Expected: PASS (all client tests, so the existing score-scale and aligned tests confirm nothing regressed).

- [ ] **Step 10: Commit**

```bash
git add client/src/lib/feedbackRows.js client/src/lib/feedbackRows.test.js client/src/lib/assessmentDraft.js client/src/lib/assessmentDraft.test.js client/src/services/api.js client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx client/src/app.css
git commit -m "feat(feedback-rows): mark rows in the card grid; save them with the overall or alone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The rubric average on the overall picker, Accept all, Manage rubrics

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (card: staged overall, hint, reset; accept all; page: open-suggestion count)
- Modify: `client/src/components/RubricManagerModal.jsx` (Map tab on unaligned tasks)
- Modify: `docs/design-language.md`
- Test: `client/src/pages/AssessmentSummaryPage.test.jsx`, `client/src/components/RubricManagerModal.test.jsx`

**Interfaces:**
- Consumes: `rubricAverage` (Task 2, client copy); row helpers (Task 8).
- Produces: card values `average` (`{ level, reason }`), `autoScale`, `stagedScale`; the card's registered `acceptScaleSuggestion()` also stages row suggestions.

- [ ] **Step 1: Write the failing tests** (in the Task 8 describe block)

```js
  it('stages the rubric average when every row is marked and nothing is published', async () => {
    card();
    fireEvent.click(screen.getByTitle('Set Features and Code to Exhibiting'));
    fireEvent.click(screen.getByTitle('Set Playtesting to Developing'));
    expect(screen.getByText('Average of the rubric rows: Exhibiting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^exhibiting$/i, pressed: true })).toBeInTheDocument(); // the picker's EX, staged
  });

  it('a different pick shows the reset button, which restores the average', async () => {
    card();
    fireEvent.click(screen.getByTitle('Set Features and Code to Exhibiting'));
    fireEvent.click(screen.getByTitle('Set Playtesting to Exhibiting'));
    fireEvent.click(screen.getByRole('button', { name: /^developing$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Use the rubric average (Exhibiting)' }));
    expect(screen.getByText('Average of the rubric rows: Exhibiting')).toBeInTheDocument();
  });

  it('an IE row stages nothing and asks for the overall', () => {
    card({ student: { ...makeStudent(), scores: rowScores({ 'Features and Code': 'EX', Playtesting: 'IE' }) } });
    expect(screen.getByText('A row is Insufficient Evidence: choose the overall level')).toBeInTheDocument();
  });

  it('a published student is never re-staged; the button appears when the rows differ', () => {
    card({ student: { ...makeStudent(), score: 75, scale_level: 'EX', grade_comment: 'Hi', comment_status: 1,
      scores: rowScores({ 'Features and Code': 'D', Playtesting: 'D' }) } });
    expect(screen.queryByText(/Average of the rubric rows/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use the rubric average (Developing)' })).toBeInTheDocument();
    expect(screen.queryByText(/pending change/i)).not.toBeInTheDocument();
  });

  it('Accept all suggestions stages the row suggestions', async () => {
    getMasteryForAssignment.mockResolvedValue({
      assignment: { id: 50, schoology_assignment_id: '8', title: 'Flappy (F)', mastery_grading_period_id: 1, mastery_grading_category_id: 2 },
      topics: [], scoreScale: GAS,
      students: [{ ...makeStudent(), row_levels: {} }],
    });
    getRubricForAssignment.mockResolvedValue({ id: 1, rubric: { id: 7, name: 'Flappy', criteria: CRITERIA }, topicByCriterion: [] });
    getFeedbackForAssignment.mockResolvedValue({ 1: { feedback_parsed: { rubric_scores: { Playtesting: 'ED' } } } });
    render(
      <MemoryRouter initialEntries={['/course/4/assessment/8']}>
        <Routes><Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} /></Routes>
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: /accept all suggestions \(1\)/i }));
    expect(screen.getByText('1 pending change')).toBeInTheDocument();
  });
```

For the modal, append to `RubricManagerModal.test.jsx`, using its `open(props)` helper, which forwards extra props to the modal:

```js
  it('disables Map criteria on an unaligned task and states why', () => {
    open({ attachment: { id: 1, rubric: { id: 7, name: 'Flappy', criteria: [] }, topicByCriterion: [] }, unaligned: true });
    expect(screen.getByRole('tab', { name: 'Map criteria' })).toBeDisabled();
    expect(screen.getByText('On an unaligned task, every criterion is a feedback row')).toBeInTheDocument();
  });
```


- [ ] **Step 2: Run to verify they fail**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx src/components/RubricManagerModal.test.jsx`
Expected: FAIL.

- [ ] **Step 3: Card: the average and the staged overall**

```js
  // The rubric average of the effective rows (staged over final). Staged as the
  // overall by itself only while nothing is published (spec 2026-10-13 §4).
  const effectiveRows = {};
  if (hasFeedbackRows) {
    for (const t of topics) {
      const v = (t.id in pending) ? pending[t.id] : student.scores?.[t.id]?.grade;
      if (v && v !== REMOVE) effectiveRows[rowName(t.id)] = v;
    }
  }
  const average = hasFeedbackRows ? rubricAverage(scoreScale, topics.map((t) => rowName(t.id)), effectiveRows) : { level: null, reason: null };
  const autoScale = hasFeedbackRows && student.scale_level == null && pending[SCALE] == null ? average.level : null;
  const stagedScale = scoreScale ? (pending[SCALE] ?? autoScale) : null;
  const averageLabel = average.level ? scoreScale.levels.find((l) => l.code === average.level)?.label : null;
  const currentOverall = pending[SCALE] ?? autoScale ?? student.scale_level ?? null;
  function useRubricAverage() {
    flushNextRef.current = true;
    setPending((p) => {
      const n = { ...p };
      if (average.level === student.scale_level || student.scale_level == null) delete n[SCALE];
      else n[SCALE] = average.level;
      return n;
    });
  }
```

Use `stagedScale` as `scaleCode` in `handleSave` and `buildSendEntry`. Add `(autoScale ? 1 : 0)` to `pendingCount`. Pass `pendingCode={stagedScale}` to `ScaleLevelPicker`.

Under the picker, for a feedback-row task:

```jsx
            {hasFeedbackRows && (
              <div className="feedback-rows-average">
                {average.reason === 'insufficient_evidence' && pending[SCALE] == null
                  ? 'A row is Insufficient Evidence: choose the overall level'
                  : average.level && currentOverall === average.level && student.scale_level == null
                    ? `Average of the rubric rows: ${averageLabel}`
                    : average.level && currentOverall !== average.level
                      ? <button className="ghost accent" onClick={useRubricAverage}>{`Use the rubric average (${averageLabel})`}</button>
                      : null}
              </div>
            )}
```

Add `.feedback-rows-average { margin-top: 0.4rem; font-size: 0.75rem; color: var(--text-muted); }` to `app.css`.

`selectScaleLevel`: when the clicked code equals `autoScale` and nothing is published, it deletes `pending[SCALE]` (already the behaviour, because it compares with `pending[SCALE]` and `student.scale_level`); clicking another level sets `pending[SCALE]`. No change needed beyond confirming the test passes.

- [ ] **Step 4: Card: Accept all suggestions also stages rows**

Replace `acceptScaleSuggestion`:

```js
  function acceptScaleSuggestion() {
    if (isRubricLocked) return false;
    let staged = false;
    if (hasFeedbackRows) {
      const updates = {};
      for (const [topicId, level] of Object.entries(suggestedByTopic)) {
        if (topicId in pending || student.scores?.[topicId]?.grade === level) continue;
        updates[topicId] = level;
      }
      if (Object.keys(updates).length) { flushNextRef.current = true; setPending((p) => ({ ...p, ...updates })); staged = true; }
    }
    if (suggestedScaleLabel && suggestedScale !== student.scale_level && pending[SCALE] == null) {
      selectScaleLevel(suggestedScale);
      staged = true;
    }
    return staged;
  }
```

Page: `openScaleSuggestions` also counts a student whose `feedback_parsed.rubric_scores` resolves (with `resolveRubricScores(…, cardTopics)`) to a row level that differs from the student's row final, when `feedbackRowList` is set.

- [ ] **Step 5: RubricManagerModal**

Add an `unaligned = false` prop. The Map tab: `disabled={!hasAttachment || unaligned}`. When `unaligned && hasAttachment`, render `<p className="alert alert-info">On an unaligned task, every criterion is a feedback row</p>` under the tab bar. Check the existing alert classes in `app.css` (`grep -n "\.alert-" client/src/app.css`) and use the informational one that exists.

- [ ] **Step 6: Run to verify they pass**

Run: `cd client && npx vitest run`
Expected: PASS, including the no-em-dash guard test.

- [ ] **Step 7: Record the design decision** in `docs/design-language.md` (append, following its entry format):

```markdown
## Feedback rows on an unaligned task (2026-10-13)

- **Layout:** the rubric grid first, labeled "Feedback rows: kept in Prism, not sent to Schoology"; the overall scale picker under it, labeled "Overall: {scale}, sent to Schoology". The grid is the aligned-task grid, unchanged.
- **The rubric average:** staged on the overall picker by itself only while nothing is published, with the hint "Average of the rubric rows: {level}". A different pick turns the hint into the button "Use the rubric average ({level})". No override badge: one element carries the state.
- **Insufficient Evidence:** stops the average; the hint asks the teacher to choose the overall level.
```

- [ ] **Step 8: Commit**

```bash
git add client/src docs/design-language.md
git commit -m "feat(feedback-rows): rubric average on the overall picker, accept row suggestions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, full verification, merge and push

**Files:**
- Modify: `CONTEXT.md`, `.claude/build-progress.md`, `docs/superpowers/specs/2026-10-13-feedback-rows-design.md` (status line)

- [ ] **Step 1: `CONTEXT.md`.** Under "Valid feedback scales", add:

```markdown
- **Feedback rows**: a rubric attached to a General Academic Scale (Unaligned) task (or any
  score-scale task). Each criterion is a row the teacher marks in Prism; row levels are
  Prism-only feedback data (`rubric_row_levels`) and never reach Schoology. Only the overall
  scale level is published. Prism stages the rubric average as the overall level (ties round
  up; an Insufficient Evidence row stops it) until a level is published.
```

- [ ] **Step 2: `.claude/build-progress.md`.** Add a dated entry (2026-10-13): feedback rows on unaligned tasks, the spec and plan paths, the new table, the MCP fields (`rubric`, `current_row_levels`, `draft_feedback.row_levels` / `scale_level_source`, `feedback_rubric`, `rubric_rows` in history), and the two fixed bugs (`attach_rubric` Schoology id; `__scale__` in `draft_feedback`).

- [ ] **Step 3: Spec status line:** "Status: **design agreed with the teacher (2026-10-13); built on main (2026-10-13).**"

- [ ] **Step 4: Full verification**

Run: `npx vitest run` (repo root) and `cd client && npx vitest run` and `npm run build`
Expected: all PASS; the build completes.

- [ ] **Step 5: Commit, merge to main, push** (the repo's workflow: merge into `main` and push `main`; CI deploys prod when green)

```bash
git add CONTEXT.md .claude/build-progress.md docs/superpowers/specs/2026-10-13-feedback-rows-design.md
git commit -m "docs(feedback-rows): vocabulary, build log, spec status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C ~/repos/prism pull --ff-only
git -C ~/repos/prism merge --ff-only worktree-bridge-cse_01RCi5khQXnDS4VQjd4GXMTD
git -C ~/repos/prism push origin main
```

If the fast-forward fails because `main` moved, rebase this branch on `origin/main`, rerun Step 4, then merge.

- [ ] **Step 6: Confirm the deploy** with `gh run list --branch main --limit 1` until the run is green, then check prod's health as `docs/deploy.md` describes.

---

### Task 11: First real use on prod (Prism only, after the deploy)

Nothing here writes to Schoology. PrisMCP must point at prod's database (`docs/prismcp-install-and-verify.md`).

- [ ] **Step 1: Import Flappy Bird** with `write_rubric`, name "MGD Flappy Bird Rubric 2026-27", from `~/Library/CloudStorage/OneDrive-HongKongInternationalSchool/Courses/Mobile Game Development/Projects/MGD Project Rubrics 2026-27/MGD Flappy Bird Rubric 2026-27.csv`. Criteria in file order: `criterion_name` = Criteria, `reporting_category` = Reporting Category, `standard_title` = Measurement Topic, descriptors ED, EX, D, EM from the four level columns. Parse the CSV with Python's `csv` module (quoted cells contain commas and doubled quotes).
- [ ] **Step 2: Import Sprite Invaders** with `write_rubric`, name "MGD Sprite Invaders Rubric 2024-25", from the sheet "Basic Project For Slides" in `.../Projects/Project Rubrics 2024-25.xlsx` (columns: Reporting Category, Measurement Topic, Criteria, then ED, EX, D, EM). Strip the trailing newline in "3. Refine and complete artistic work.\n". IE takes the default text.
- [ ] **Step 3: Attach** with `attach_rubric`: Flappy Bird to `8590105935`, Sprite Invaders to `8532617388`. Each reply must show `mode: "feedback_rows"` and four rows.
- [ ] **Step 4: Check** `get_assignment_context` for Flappy Bird (course 0 resolves by assignment id): `rubric.rows` lists Features and Code, Player Experience, Playtesting, Evaluation; Victor's existing draft comment is still in `draft_feedback`. Show the teacher one student's entry.
