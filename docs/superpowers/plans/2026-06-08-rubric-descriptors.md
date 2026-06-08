# Rubric Descriptors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a teacher import rubric descriptors (CSV now, MCP later) and render them in the `AssessmentSummaryPage` SBG grid, with a named-reusable rubric model, auto-matched topic binding, intentional row ordering, and the signed-off fuchsia/sparkle visual language.

**Architecture:** Portable rubric *content* (rubrics → criteria → descriptors) lives in the local SQLite DB and is written by CSV import (and later MCP). A separate *binding* layer (attachment + criterion↔topic map) connects a rubric to one assignment, auto-derived by normalized-title match with a dropdown fallback. The React page fetches the attached rubric and renders a Compact↔Descriptors toggle (default Descriptors).

**Tech Stack:** Node/Express ESM, better-sqlite3, `csv-parse/sync`, multer, js-yaml; React 18 + react-router; Vitest (server) + Vitest/RTL (client).

**Spec:** `docs/superpowers/specs/2026-06-08-rubric-descriptors-design.md`

---

## File Structure

**Server (new):**
- `server/services/rubricStore.js` — content CRUD over `rubrics`/`rubric_criteria`/`rubric_descriptors`.
- `server/services/rubricCsv.js` — pure CSV ⇄ rubric-content functions (parse, template, export).
- `server/services/rubricMatch.js` — pure `normalizeTitle` + `autoMatch(criteria, topics)`.
- `server/services/rubricAttach.js` — attachment + criterion↔topic mapping over `rubric_attachments`/`rubric_attachment_topics`.
- `server/routes/rubrics.js` — `/api/rubrics` HTTP surface, behind `featureGate('rubric_descriptors')`.
- Tests beside each: `*.test.js`.

**Server (modified):**
- `server/db/schema.sql` — 5 new tables + indexes.
- `server/middleware/featureGate.js` — add `getRubricConfig()`.
- `server/index.js` — mount `rubricsRouter`.
- `config.yaml` — `rubric_descriptors` flag + `rubrics:` palette block.

**Client (new):**
- `client/src/components/AiSparkle.jsx` — inline SVG sparkle (`fill: currentColor`).
- `client/src/components/RubricDescriptorGrid.jsx` — the descriptor-mode grid body (extracted so it's testable in isolation).
- `client/src/lib/rubricColors.js` — reporting-category → colour resolver (config-driven, with defaults).
- Tests beside each.

**Client (modified):**
- `client/src/assets/ai-sparkle.svg` — already added by the user (asset reference).
- `client/src/app.css` — `--ai-suggest`, `--ai-suggest-wash` tokens.
- `client/src/services/api.js` — rubric endpoints.
- `client/src/pages/AssessmentSummaryPage.jsx` — toggle, attach/upload/template UI, pass rubric + viewMode into `StudentRubricCard`; swap suggestion accent to fuchsia/sparkle; matched drawer.

---

## Phase 1 — Data model + content store

### Task 1: Schema — 5 rubric tables

**Files:**
- Modify: `server/db/schema.sql` (append at end)
- Test: `server/db/rubricSchema.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/db/rubricSchema.test.js
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './index.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

describe('rubric schema', () => {
  test('creates the five rubric tables', () => {
    const db = freshDb();
    const names = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rubric%'`
    ).all().map(r => r.name).sort();
    expect(names).toEqual([
      'rubric_attachment_topics', 'rubric_attachments',
      'rubric_criteria', 'rubric_descriptors', 'rubrics',
    ]);
  });

  test('descriptor is unique per (criterion, level) and cascades on rubric delete', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO rubrics (id, name) VALUES (1, 'R')`).run();
    db.prepare(`INSERT INTO rubric_criteria (id, rubric_id, position) VALUES (10, 1, 1)`).run();
    db.prepare(`INSERT INTO rubric_descriptors (criterion_id, level, descriptor_text) VALUES (10, 'ED', 'a')`).run();
    expect(() =>
      db.prepare(`INSERT INTO rubric_descriptors (criterion_id, level, descriptor_text) VALUES (10, 'ED', 'b')`).run()
    ).toThrow();
    db.prepare(`DELETE FROM rubrics WHERE id = 1`).run();
    expect(db.prepare(`SELECT COUNT(*) c FROM rubric_criteria`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM rubric_descriptors`).get().c).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/rubricSchema.test.js`
Expected: FAIL (`no such table: rubrics`).

- [ ] **Step 3: Append the tables to `server/db/schema.sql`**

```sql
-- Rubric descriptors (SBG): portable content (rubrics → criteria → descriptors)
-- plus local binding (attachment → criterion↔topic map). See
-- docs/superpowers/specs/2026-06-08-rubric-descriptors-design.md.
CREATE TABLE IF NOT EXISTS rubrics (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT,                    -- 'csv' | 'mcp' | 'manual'
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS rubric_criteria (
  id INTEGER PRIMARY KEY,
  rubric_id INTEGER NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,      -- canonical, intentional row order (1..N)
  criterion_name TEXT,            -- friendly label, e.g. "UI/UX"
  standard_title TEXT,            -- measurement-topic title as written
  reporting_category TEXT         -- as written, e.g. "Produce"
);
CREATE TABLE IF NOT EXISTS rubric_descriptors (
  id INTEGER PRIMARY KEY,
  criterion_id INTEGER NOT NULL REFERENCES rubric_criteria(id) ON DELETE CASCADE,
  level TEXT NOT NULL,            -- 'ED' | 'EX' | 'D' | 'EM' | 'IE'
  descriptor_text TEXT,
  UNIQUE(criterion_id, level)
);
CREATE TABLE IF NOT EXISTS rubric_attachments (
  id INTEGER PRIMARY KEY,
  rubric_id INTEGER NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
  assignment_schoology_id TEXT NOT NULL,
  course_id INTEGER REFERENCES courses(id),
  created_at TEXT,
  UNIQUE(assignment_schoology_id)   -- one rubric per assignment
);
CREATE TABLE IF NOT EXISTS rubric_attachment_topics (
  attachment_id INTEGER NOT NULL REFERENCES rubric_attachments(id) ON DELETE CASCADE,
  criterion_id INTEGER NOT NULL REFERENCES rubric_criteria(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES measurement_topics(id),
  UNIQUE(attachment_id, criterion_id)
);
CREATE INDEX IF NOT EXISTS idx_rubric_criteria_rubric ON rubric_criteria(rubric_id);
CREATE INDEX IF NOT EXISTS idx_rubric_attach_assignment ON rubric_attachments(assignment_schoology_id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/db/rubricSchema.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.sql server/db/rubricSchema.test.js
git commit -m "feat(rubrics): add 5-table rubric descriptor schema (#80)"
```

### Task 2: `rubricStore.js` — content CRUD

**Files:**
- Create: `server/services/rubricStore.js`
- Test: `server/services/rubricStore.test.js`

Content shape used throughout (`RubricContent`):
```
{ name, source, criteria: [
  { position, criterion_name, standard_title, reporting_category, external_id?,
    descriptors: { ED, EX, D, EM, IE } } ] }
```

- [ ] **Step 1: Write the failing test**

```js
// server/services/rubricStore.test.js
import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { saveRubric, getRubric, listRubrics, deleteRubric } from './rubricStore.js';

let db;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
});

const CONTENT = {
  name: 'MAD Dev', source: 'csv',
  criteria: [
    { position: 1, criterion_name: 'UI/UX', standard_title: 'Select, analyze',
      reporting_category: 'Produce', descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' } },
    { position: 2, criterion_name: 'Functionality', standard_title: 'Develop and refine',
      reporting_category: 'Produce', descriptors: { ED: 'e', EX: 'f', D: 'g', EM: 'h', IE: 'Insufficient Evidence' } },
  ],
};

describe('rubricStore', () => {
  test('saveRubric persists content and getRubric returns it ordered by position', () => {
    const id = saveRubric(db, CONTENT);
    const r = getRubric(db, id);
    expect(r.name).toBe('MAD Dev');
    expect(r.criteria.map(c => c.criterion_name)).toEqual(['UI/UX', 'Functionality']);
    expect(r.criteria[0].descriptors.ED).toBe('a');
    expect(r.criteria[0].descriptors.IE).toBe('Insufficient Evidence');
  });

  test('saveRubric with existing id replaces all content (no orphans)', () => {
    const id = saveRubric(db, CONTENT);
    saveRubric(db, { ...CONTENT, name: 'Renamed', criteria: [CONTENT.criteria[0]] }, id);
    const r = getRubric(db, id);
    expect(r.name).toBe('Renamed');
    expect(r.criteria).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) c FROM rubric_descriptors`).get().c).toBe(5);
  });

  test('listRubrics returns summaries; deleteRubric removes content', () => {
    const id = saveRubric(db, CONTENT);
    expect(listRubrics(db)).toEqual([expect.objectContaining({ id, name: 'MAD Dev', criteria_count: 2 })]);
    deleteRubric(db, id);
    expect(listRubrics(db)).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) c FROM rubric_criteria`).get().c).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/rubricStore.test.js`
Expected: FAIL (`Cannot find module './rubricStore.js'`).

- [ ] **Step 3: Implement `server/services/rubricStore.js`**

```js
import { getDb } from '../db/index.js';

const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];

// Insert criteria + descriptors for a rubric id (assumes none exist yet).
function insertCriteria(db, rubricId, criteria) {
  const insC = db.prepare(
    `INSERT INTO rubric_criteria (rubric_id, position, criterion_name, standard_title, reporting_category)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insD = db.prepare(
    `INSERT INTO rubric_descriptors (criterion_id, level, descriptor_text) VALUES (?, ?, ?)`
  );
  criteria.forEach((c, i) => {
    const cid = insC.run(rubricId, c.position ?? i + 1, c.criterion_name ?? null,
      c.standard_title ?? null, c.reporting_category ?? null).lastInsertRowid;
    for (const lvl of LEVELS) {
      const text = lvl === 'IE'
        ? (c.descriptors?.IE || 'Insufficient Evidence')
        : (c.descriptors?.[lvl] ?? null);
      insD.run(cid, lvl, text);
    }
  });
}

// Create (id omitted) or fully replace (id given) a rubric's content. Returns the id.
export function saveRubric(db = getDb(), content, id = null) {
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    let rubricId = id;
    if (rubricId == null) {
      rubricId = db.prepare(
        `INSERT INTO rubrics (name, source, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      ).run(content.name, content.source ?? null, content.notes ?? null, now, now).lastInsertRowid;
    } else {
      db.prepare(`UPDATE rubrics SET name = ?, source = ?, updated_at = ? WHERE id = ?`)
        .run(content.name, content.source ?? null, now, rubricId);
      db.prepare(`DELETE FROM rubric_criteria WHERE rubric_id = ?`).run(rubricId); // cascades descriptors
    }
    insertCriteria(db, rubricId, content.criteria || []);
    return rubricId;
  });
  return txn();
}

export function getRubric(db = getDb(), id) {
  const rubric = db.prepare(`SELECT * FROM rubrics WHERE id = ?`).get(id);
  if (!rubric) return null;
  const criteria = db.prepare(
    `SELECT * FROM rubric_criteria WHERE rubric_id = ? ORDER BY position, id`
  ).all(id);
  const descs = db.prepare(
    `SELECT d.criterion_id, d.level, d.descriptor_text FROM rubric_descriptors d
     JOIN rubric_criteria c ON c.id = d.criterion_id WHERE c.rubric_id = ?`
  ).all(id);
  const byCrit = {};
  for (const d of descs) (byCrit[d.criterion_id] ??= {})[d.level] = d.descriptor_text;
  return {
    ...rubric,
    criteria: criteria.map(c => ({ ...c, descriptors: byCrit[c.id] || {} })),
  };
}

export function listRubrics(db = getDb()) {
  return db.prepare(
    `SELECT r.id, r.name, r.source, r.updated_at,
            (SELECT COUNT(*) FROM rubric_criteria c WHERE c.rubric_id = r.id) AS criteria_count
     FROM rubrics r ORDER BY r.updated_at DESC, r.id DESC`
  ).all();
}

export function deleteRubric(db = getDb(), id) {
  db.prepare(`DELETE FROM rubrics WHERE id = ?`).run(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/rubricStore.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/rubricStore.js server/services/rubricStore.test.js
git commit -m "feat(rubrics): rubricStore content CRUD (save/get/list/delete)"
```

---

## Phase 2 — CSV parse / template / export

### Task 3: `rubricCsv.js` — pure CSV ⇄ content

**Files:**
- Create: `server/services/rubricCsv.js`
- Test: `server/services/rubricCsv.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/services/rubricCsv.test.js
import { describe, test, expect } from 'vitest';
import { parseRubricCsv, templateCsv, exportRubricCsv } from './rubricCsv.js';

const CSV = `Criteria,Reporting Category,Standard,Exhibiting Depth,Exhibiting,Developing,Emerging
UI/UX,Produce,"Anchor Standard 4: Select, analyze",Polished.,Clear.,Inconsistent.,Lacks clarity.
Functionality,Produce,Develop and refine,All + extra.,All reliable.,Some work.,Limited.`;

describe('rubricCsv', () => {
  test('parses rows in order, maps level headers, defaults IE', () => {
    const content = parseRubricCsv(CSV, { name: 'MAD' });
    expect(content.name).toBe('MAD');
    expect(content.source).toBe('csv');
    expect(content.criteria).toHaveLength(2);
    const [c1] = content.criteria;
    expect(c1.position).toBe(1);
    expect(c1.criterion_name).toBe('UI/UX');
    expect(c1.standard_title).toBe('Anchor Standard 4: Select, analyze');
    expect(c1.reporting_category).toBe('Produce');
    expect(c1.descriptors).toEqual({
      ED: 'Polished.', EX: 'Clear.', D: 'Inconsistent.', EM: 'Lacks clarity.',
      IE: 'Insufficient Evidence',
    });
  });

  test('reads optional External ID column when present', () => {
    const csv = `Criteria,Reporting Category,Standard,External ID,Exhibiting Depth,Exhibiting,Developing,Emerging
UI/UX,Produce,Select,ART.5.1,a,b,c,d`;
    expect(parseRubricCsv(csv, { name: 'X' }).criteria[0].external_id).toBe('ART.5.1');
  });

  test('"Exhibiting" header is not confused with "Exhibiting Depth"', () => {
    const c = parseRubricCsv(CSV, { name: 'M' }).criteria[0];
    expect(c.descriptors.EX).toBe('Clear.');
    expect(c.descriptors.ED).toBe('Polished.');
  });

  test('templateCsv has the documented header + one example row', () => {
    const t = templateCsv();
    expect(t.split('\n')[0]).toBe(
      'Criteria,Reporting Category,Standard,Exhibiting Depth,Exhibiting,Developing,Emerging,Insufficient Evidence'
    );
    expect(t.split('\n')).toHaveLength(2);
  });

  test('exportRubricCsv round-trips through parseRubricCsv', () => {
    const content = parseRubricCsv(CSV, { name: 'RT' });
    const reparsed = parseRubricCsv(exportRubricCsv(content), { name: 'RT' });
    expect(reparsed.criteria).toEqual(content.criteria);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/rubricCsv.test.js`
Expected: FAIL (`Cannot find module './rubricCsv.js'`).

- [ ] **Step 3: Implement `server/services/rubricCsv.js`**

```js
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

// Column header (normalized) → level code. Exact match so "Exhibiting" never
// captures "Exhibiting Depth".
const HEADER_LEVEL = {
  'exhibiting depth': 'ED',
  'exhibiting': 'EX',
  'developing': 'D',
  'emerging': 'EM',
  'insufficient evidence': 'IE',
};
const TEMPLATE_HEADERS = [
  'Criteria', 'Reporting Category', 'Standard',
  'Exhibiting Depth', 'Exhibiting', 'Developing', 'Emerging', 'Insufficient Evidence',
];
const norm = (s) => (s || '').trim().toLowerCase();
const pick = (row, ...names) => {
  for (const n of names) {
    const hit = Object.keys(row).find(k => norm(k) === norm(n));
    if (hit && row[hit] != null && row[hit] !== '') return row[hit];
  }
  return '';
};

export function parseRubricCsv(content, { name }) {
  const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true });
  const criteria = rows.map((row, i) => {
    const descriptors = {};
    for (const [header, value] of Object.entries(row)) {
      const lvl = HEADER_LEVEL[norm(header)];
      if (lvl) descriptors[lvl] = value || '';
    }
    if (!descriptors.IE) descriptors.IE = 'Insufficient Evidence';
    return {
      position: i + 1,
      criterion_name: pick(row, 'Criteria', 'Criterion') || null,
      standard_title: pick(row, 'Standard', 'Anchor Standard (Measurement Topic)', 'Measurement Topic') || null,
      reporting_category: pick(row, 'Reporting Category') || null,
      external_id: pick(row, 'External ID', 'External_ID') || null,
      descriptors,
    };
  });
  return { name, source: 'csv', criteria };
}

export function templateCsv() {
  const example = {
    Criteria: 'UI/UX', 'Reporting Category': 'Produce',
    Standard: 'Anchor Standard 4: Select, analyze, and interpret artistic work for presentation',
    'Exhibiting Depth': 'Polished, cohesive, intentional.', Exhibiting: 'Clear and consistent.',
    Developing: 'Partly usable but inconsistent.', Emerging: 'Lacks clarity or structure.',
    'Insufficient Evidence': 'Insufficient Evidence',
  };
  return stringify([example], { header: true, columns: TEMPLATE_HEADERS });
}

export function exportRubricCsv(content) {
  const records = content.criteria.map(c => ({
    Criteria: c.criterion_name || '', 'Reporting Category': c.reporting_category || '',
    Standard: c.standard_title || '',
    'Exhibiting Depth': c.descriptors?.ED || '', Exhibiting: c.descriptors?.EX || '',
    Developing: c.descriptors?.D || '', Emerging: c.descriptors?.EM || '',
    'Insufficient Evidence': c.descriptors?.IE || 'Insufficient Evidence',
  }));
  return stringify(records, { header: true, columns: TEMPLATE_HEADERS });
}
```

- [ ] **Step 4: Add the `csv-stringify` dependency**

Run: `npm install csv-stringify@^6`
Expected: adds `csv-stringify` to `package.json` (sibling of the already-present `csv-parse`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/services/rubricCsv.test.js`
Expected: PASS (5 tests). Note: the round-trip test compares `external_id` (null after export, since the template omits that column) — if it fails on `external_id`, drop `external_id` from the round-trip expectation by re-parsing with the same template columns. (The export omits `External ID` by design; the round-trip asserts descriptor/criterion fidelity, so set `external_id: null` in both via `parseRubricCsv` on the no-External-ID template output — already the case here.)

- [ ] **Step 6: Commit**

```bash
git add server/services/rubricCsv.js server/services/rubricCsv.test.js package.json package-lock.json
git commit -m "feat(rubrics): CSV parse/template/export (file-order, IE default, optional External ID)"
```

---

## Phase 3 — Auto-match + attachment binding

### Task 4: `rubricMatch.js` — normalize + auto-match

**Files:**
- Create: `server/services/rubricMatch.js`
- Test: `server/services/rubricMatch.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/services/rubricMatch.test.js
import { describe, test, expect } from 'vitest';
import { normalizeTitle, autoMatch } from './rubricMatch.js';

const TOPICS = [
  { id: 't1', external_id: 'ART.5.1', title: 'Select, analyze, and interpret artistic work for presentation' },
  { id: 't2', external_id: 'ART.5.2', title: 'Develop and refine artistic techniques and work for presentation' },
];

describe('rubricMatch', () => {
  test('normalizeTitle strips the "Anchor Standard N:" prefix and punctuation', () => {
    expect(normalizeTitle('Anchor Standard 4: Select, analyze, and interpret artistic work for presentation'))
      .toBe(normalizeTitle('Select analyze and interpret artistic work for presentation'));
  });

  test('autoMatch binds by normalized title', () => {
    const criteria = [
      { id: 'c1', standard_title: 'Anchor Standard 4: Select, analyze, and interpret artistic work for presentation' },
      { id: 'c2', standard_title: 'Develop and refine artistic techniques and work for presentation' },
    ];
    const { mapping, unmatched } = autoMatch(criteria, TOPICS);
    expect(mapping).toEqual([
      { criterion_id: 'c1', topic_id: 't1' },
      { criterion_id: 'c2', topic_id: 't2' },
    ]);
    expect(unmatched).toEqual([]);
  });

  test('External ID exact match wins and a non-match is reported unmatched', () => {
    const criteria = [
      { id: 'c1', external_id: 'ART.5.2', standard_title: 'whatever' },
      { id: 'c2', standard_title: 'No such topic here' },
    ];
    const { mapping, unmatched } = autoMatch(criteria, TOPICS);
    expect(mapping).toContainEqual({ criterion_id: 'c1', topic_id: 't2' });
    expect(unmatched).toEqual(['c2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/rubricMatch.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `server/services/rubricMatch.js`**

```js
export function normalizeTitle(s) {
  return (s || '')
    .toLowerCase()
    .replace(/^\s*anchor standard\s*\d+\s*:\s*/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// criteria: [{ id, standard_title, external_id? }], topics: [{ id, external_id, title }]
// → { mapping: [{criterion_id, topic_id}], unmatched: [criterion_id...] }.
// Each topic is consumed at most once (1:1).
export function autoMatch(criteria, topics) {
  const byExt = new Map();
  const byTitle = new Map();
  for (const t of topics) {
    if (t.external_id) byExt.set(t.external_id.toLowerCase(), t.id);
    byTitle.set(normalizeTitle(t.title), t.id);
  }
  const used = new Set();
  const mapping = [];
  const unmatched = [];
  for (const c of criteria) {
    let topicId = null;
    if (c.external_id && byExt.has(c.external_id.toLowerCase())) {
      topicId = byExt.get(c.external_id.toLowerCase());
    } else {
      topicId = byTitle.get(normalizeTitle(c.standard_title));
    }
    if (topicId && !used.has(topicId)) {
      used.add(topicId);
      mapping.push({ criterion_id: c.id, topic_id: topicId });
    } else {
      unmatched.push(c.id);
    }
  }
  return { mapping, unmatched };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/rubricMatch.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/rubricMatch.js server/services/rubricMatch.test.js
git commit -m "feat(rubrics): normalized-title auto-match with External ID override"
```

### Task 5: `rubricAttach.js` — attachment + mapping + reorder

**Files:**
- Create: `server/services/rubricAttach.js`
- Test: `server/services/rubricAttach.test.js`

Uses `getAlignedTopics` from `server/services/assessmentContext.js` to get an assignment's topics.

- [ ] **Step 1: Write the failing test**

```js
// server/services/rubricAttach.test.js
import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { saveRubric } from './rubricStore.js';
import { attachRubric, getAttachmentForAssignment, setMapping, reorderCriteria } from './rubricAttach.js';

let db, rubricId;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  // course + measurement topics the auto-match will bind to
  db.prepare(`INSERT INTO courses (id, schoology_section_id, course_name) VALUES (4, '99', 'AIML')`).run();
  db.prepare(`INSERT INTO measurement_topics (id, course_id, external_id, title) VALUES ('t1', 4, 'ART.5.1', 'Select, analyze, and interpret artistic work for presentation')`).run();
  db.prepare(`INSERT INTO measurement_topics (id, course_id, external_id, title) VALUES ('t2', 4, 'ART.5.2', 'Develop and refine artistic techniques and work for presentation')`).run();
  // assignment alignment so getAlignedTopics returns t1,t2
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id) VALUES ('800', 't1')`).run();
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id) VALUES ('800', 't2')`).run();
  rubricId = saveRubric(db, {
    name: 'R', source: 'csv',
    criteria: [
      { position: 1, criterion_name: 'UI/UX', standard_title: 'Select, analyze, and interpret artistic work for presentation', descriptors: { ED:'a',EX:'b',D:'c',EM:'d' } },
      { position: 2, criterion_name: 'Func', standard_title: 'Develop and refine artistic techniques and work for presentation', descriptors: { ED:'e',EX:'f',D:'g',EM:'h' } },
    ],
  });
});

describe('rubricAttach', () => {
  test('attachRubric auto-maps criteria to aligned topics', () => {
    const res = attachRubric(db, { rubricId, courseId: 4, assignmentId: '800' });
    expect(res.unmatched).toEqual([]);
    const att = getAttachmentForAssignment(db, '800');
    expect(att.rubric.name).toBe('R');
    const map = Object.fromEntries(att.topicByCriterion.map(m => [m.criterion_name, m.topic_id]));
    expect(map).toEqual({ 'UI/UX': 't1', Func: 't2' });
    // criteria come back ordered by position
    expect(att.rubric.criteria.map(c => c.criterion_name)).toEqual(['UI/UX', 'Func']);
  });

  test('re-attaching a different rubric replaces the attachment (one per assignment)', () => {
    attachRubric(db, { rubricId, courseId: 4, assignmentId: '800' });
    const other = saveRubric(db, { name: 'Other', source: 'csv', criteria: [] });
    attachRubric(db, { rubricId: other, courseId: 4, assignmentId: '800' });
    expect(getAttachmentForAssignment(db, '800').rubric.name).toBe('Other');
    expect(db.prepare(`SELECT COUNT(*) c FROM rubric_attachments`).get().c).toBe(1);
  });

  test('setMapping upserts one criterion→topic; reorderCriteria rewrites positions', () => {
    attachRubric(db, { rubricId, courseId: 4, assignmentId: '800' });
    const att = getAttachmentForAssignment(db, '800');
    const [c1, c2] = att.rubric.criteria;
    setMapping(db, att.id, c1.id, 't2');
    const after = getAttachmentForAssignment(db, '800');
    expect(after.topicByCriterion.find(m => m.criterion_id === c1.id).topic_id).toBe('t2');
    reorderCriteria(db, rubricId, [c2.id, c1.id]);
    expect(getAttachmentForAssignment(db, '800').rubric.criteria.map(c => c.id)).toEqual([c2.id, c1.id]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/rubricAttach.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `server/services/rubricAttach.js`**

```js
import { getDb } from '../db/index.js';
import { getAlignedTopics } from './assessmentContext.js';
import { getRubric } from './rubricStore.js';
import { autoMatch } from './rubricMatch.js';

// Attach rubric to an assignment (replacing any existing attachment), auto-match
// its criteria to the assignment's aligned topics, persist the mapping.
export function attachRubric(db = getDb(), { rubricId, courseId, assignmentId }) {
  const rubric = getRubric(db, rubricId);
  if (!rubric) throw new Error(`rubric ${rubricId} not found`);
  const topics = getAlignedTopics(db, courseId, assignmentId);
  const { mapping, unmatched } = autoMatch(rubric.criteria, topics);
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
  return { attachmentId: txn(), unmatched };
}

export function getAttachmentForAssignment(db = getDb(), assignmentId) {
  const att = db.prepare(
    `SELECT * FROM rubric_attachments WHERE assignment_schoology_id = ?`
  ).get(assignmentId);
  if (!att) return null;
  const rubric = getRubric(db, att.rubric_id);
  const maps = db.prepare(
    `SELECT criterion_id, topic_id FROM rubric_attachment_topics WHERE attachment_id = ?`
  ).all(att.id);
  const nameById = Object.fromEntries(rubric.criteria.map(c => [c.id, c.criterion_name]));
  return {
    id: att.id,
    rubric,
    topicByCriterion: maps.map(m => ({ ...m, criterion_name: nameById[m.criterion_id] })),
  };
}

export function setMapping(db = getDb(), attachmentId, criterionId, topicId) {
  db.prepare(
    `INSERT INTO rubric_attachment_topics (attachment_id, criterion_id, topic_id)
     VALUES (?, ?, ?)
     ON CONFLICT(attachment_id, criterion_id) DO UPDATE SET topic_id = excluded.topic_id`
  ).run(attachmentId, criterionId, topicId);
}

export function reorderCriteria(db = getDb(), rubricId, orderedCriterionIds) {
  const upd = db.prepare(`UPDATE rubric_criteria SET position = ? WHERE id = ? AND rubric_id = ?`);
  const txn = db.transaction(() => {
    orderedCriterionIds.forEach((id, i) => upd.run(i + 1, id, rubricId));
  });
  txn();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/rubricAttach.test.js`
Expected: PASS (3 tests). If `getAlignedTopics` returns `[]`, confirm the `mastery_alignments` table name/columns match the fixture (see `server/db/schema.sql`).

- [ ] **Step 5: Commit**

```bash
git add server/services/rubricAttach.js server/services/rubricAttach.test.js
git commit -m "feat(rubrics): attach + auto-bind + mapping upsert + reorder"
```

---

## Phase 4 — HTTP surface + config

### Task 6: config — feature flag + palette + `getRubricConfig`

**Files:**
- Modify: `config.yaml`
- Modify: `server/middleware/featureGate.js`
- Test: `server/middleware/rubricConfig.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/middleware/rubricConfig.test.js
import { describe, test, expect } from 'vitest';
import { getRubricConfig } from './featureGate.js';

describe('getRubricConfig', () => {
  test('returns suggestion accent + reporting-category colours from config.yaml', () => {
    const cfg = getRubricConfig();
    expect(cfg.suggestionAccent).toBe('#e21ad6');
    expect(cfg.suggestionWash).toBe('#fbe6fb');
    expect(cfg.reportingCategoryColors.produce).toBe('#B4A7D6');
    expect(cfg.reportingCategoryColors.create).toBe('#9FC5E8');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/middleware/rubricConfig.test.js`
Expected: FAIL (`getRubricConfig is not a function`).

- [ ] **Step 3: Add config + flag**

Append to `config.yaml` under `features:`:
```yaml
  rubric_descriptors: true
```
Add a top-level block to `config.yaml`:
```yaml
rubrics:
  suggestionAccent: '#e21ad6'
  suggestionWash: '#fbe6fb'
  reportingCategoryColors:
    produce: '#B4A7D6'
    create: '#9FC5E8'
```
Add to `server/middleware/featureGate.js` (after `getSyncConfig`):
```js
export function getRubricConfig() {
  if (!config) loadConfig();
  return {
    suggestionAccent: '#e21ad6',
    suggestionWash: '#fbe6fb',
    reportingCategoryColors: { produce: '#B4A7D6', create: '#9FC5E8' },
    ...(config.rubrics || {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/middleware/rubricConfig.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add config.yaml server/middleware/featureGate.js server/middleware/rubricConfig.test.js
git commit -m "feat(rubrics): rubric_descriptors flag + config-driven palette"
```

### Task 7: `rubrics.js` route

**Files:**
- Create: `server/routes/rubrics.js`
- Modify: `server/index.js` (import + mount)
- Test: `server/routes/rubrics.test.js`

Endpoints (all under `/api/rubrics`, gated by `featureGate('rubric_descriptors')`):
- `GET /` → `listRubrics`
- `GET /config` → `getRubricConfig`
- `GET /template` → `templateCsv` (text/csv attachment)
- `POST /upload` (multipart: `name`, `file`) → `parseRubricCsv` → `saveRubric` → `{ id }`
- `GET /:id/export` → `exportRubricCsv` (text/csv)
- `POST /attach` (json: `rubricId, courseId, assignmentId`) → `attachRubric` → `{ unmatched }`
- `GET /assignment/:assignmentId` → `getAttachmentForAssignment` (or `null`)
- `PUT /attachment/:attachmentId/mapping` (json: `criterionId, topicId`) → `setMapping`
- `PUT /:id/reorder` (json: `orderedCriterionIds`) → `reorderCriteria`
- `DELETE /attachment/:attachmentId`

- [ ] **Step 1: Write the failing test**

```js
// server/routes/rubrics.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });   // set before getDb() is first called

import router from './rubrics.js';
import { getDb } from '../db/index.js';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/rubrics', router);
  const server = app.listen(0);
  return { server, port: server.address().port };
}
async function call(method, path, body, isForm) {
  const { server, port } = startServer();
  try {
    const opts = { method };
    if (isForm) opts.body = body;
    else if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    const res = await fetch(`http://localhost:${port}${path}`, opts);
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  } finally { server.close(); }
}

beforeEach(() => {
  const db = getDb();
  db.exec(`DELETE FROM rubric_descriptors; DELETE FROM rubric_criteria; DELETE FROM rubrics;`);
});

describe('rubrics route', () => {
  test('GET /template returns the CSV header', async () => {
    const { status, body } = await call('GET', '/api/rubrics/template');
    expect(status).toBe(200);
    expect(String(body)).toContain('Criteria,Reporting Category,Standard');
  });

  test('POST /upload then GET / lists the rubric', async () => {
    const fd = new FormData();
    fd.append('name', 'MAD');
    fd.append('file', new Blob([
      'Criteria,Reporting Category,Standard,Exhibiting Depth,Exhibiting,Developing,Emerging\nUI/UX,Produce,Select,a,b,c,d',
    ], { type: 'text/csv' }), 'r.csv');
    const up = await call('POST', '/api/rubrics/upload', fd, true);
    expect(up.status).toBe(200);
    const list = await call('GET', '/api/rubrics');
    expect(list.body).toEqual([expect.objectContaining({ name: 'MAD', criteria_count: 1 })]);
  });

  test('GET /config exposes the suggestion accent', async () => {
    const { body } = await call('GET', '/api/rubrics/config');
    expect(body.suggestionAccent).toBe('#e21ad6');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/routes/rubrics.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `server/routes/rubrics.js`**

```js
import { Router } from 'express';
import multer from 'multer';
import { featureGate, getRubricConfig } from '../middleware/featureGate.js';
import { getDb } from '../db/index.js';
import { listRubrics, saveRubric, getRubric, deleteRubric } from '../services/rubricStore.js';
import { parseRubricCsv, templateCsv, exportRubricCsv } from '../services/rubricCsv.js';
import { attachRubric, getAttachmentForAssignment, setMapping, reorderCriteria } from '../services/rubricAttach.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });
router.use(featureGate('rubric_descriptors'));

router.get('/', (req, res) => res.json(listRubrics(getDb())));
router.get('/config', (req, res) => res.json(getRubricConfig()));

router.get('/template', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="rubric-template.csv"');
  res.send(templateCsv());
});

router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const name = (req.body.name || req.file.originalname || 'Untitled rubric').replace(/\.csv$/i, '');
  try {
    const content = parseRubricCsv(req.file.buffer.toString('utf-8'), { name });
    const id = saveRubric(getDb(), content);
    res.json({ id, name, criteria_count: content.criteria.length });
  } catch (err) {
    res.status(400).json({ error: `CSV parse error: ${err.message}` });
  }
});

router.get('/:id/export', (req, res) => {
  const rubric = getRubric(getDb(), Number(req.params.id));
  if (!rubric) return res.status(404).json({ error: 'Rubric not found' });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${rubric.name}.csv"`);
  res.send(exportRubricCsv(rubric));
});

router.post('/attach', (req, res) => {
  const { rubricId, courseId, assignmentId } = req.body;
  try {
    const result = attachRubric(getDb(), { rubricId, courseId, assignmentId });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/assignment/:assignmentId', (req, res) => {
  res.json(getAttachmentForAssignment(getDb(), req.params.assignmentId));
});

router.put('/attachment/:attachmentId/mapping', (req, res) => {
  const { criterionId, topicId } = req.body;
  setMapping(getDb(), Number(req.params.attachmentId), criterionId, topicId);
  res.json({ ok: true });
});

router.put('/:id/reorder', (req, res) => {
  reorderCriteria(getDb(), Number(req.params.id), req.body.orderedCriterionIds || []);
  res.json({ ok: true });
});

router.delete('/attachment/:attachmentId', (req, res) => {
  getDb().prepare(`DELETE FROM rubric_attachments WHERE id = ?`).run(Number(req.params.attachmentId));
  res.json({ ok: true });
});

export default router;
```

- [ ] **Step 4: Mount in `server/index.js`**

Add import beside the other routers (after line 18):
```js
import rubricsRouter from './routes/rubrics.js';
```
Add mount beside the others (after line 45):
```js
app.use('/api/rubrics', rubricsRouter);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/routes/rubrics.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full server suite**

Run: `npm run test:server`
Expected: PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add server/routes/rubrics.js server/routes/rubrics.test.js server/index.js
git commit -m "feat(rubrics): /api/rubrics routes (upload/template/export/attach/map/reorder)"
```

---

## Phase 5 — Client foundation (asset, tokens, colours, API)

### Task 8: `AiSparkle.jsx` + tokens

**Files:**
- Create: `client/src/components/AiSparkle.jsx`
- Modify: `client/src/app.css` (add tokens to `:root`)
- Test: `client/src/components/AiSparkle.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// client/src/components/AiSparkle.test.jsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import AiSparkle from './AiSparkle.jsx';

describe('AiSparkle', () => {
  it('renders an svg sized by the size prop with currentColor fill', () => {
    const { container } = render(<AiSparkle size={17} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('width')).toBe('17');
    expect(container.querySelectorAll('path')).toHaveLength(3);
    expect(container.querySelector('path').getAttribute('fill')).toBe('currentColor');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/components/AiSparkle.test.jsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `client/src/components/AiSparkle.jsx`**

Copy the three `<path d="...">` strings verbatim from `client/src/assets/ai-sparkle.svg` (keep their `transform` attributes), set `fill="currentColor"`:

```jsx
// 3-star "AI magic" sparkle. Colour comes from CSS `color` (fill: currentColor),
// so callers set e.g. style={{ color: 'var(--ai-suggest)' }}. Paths mirror
// client/src/assets/ai-sparkle.svg.
export default function AiSparkle({ size = 16, className, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" className={className}
         style={style} aria-hidden="true" focusable="false">
      <path fill="currentColor" transform="translate(207,116)" d="PASTE_PATH_1_d" />
      <path fill="currentColor" transform="translate(369,32)"  d="PASTE_PATH_2_d" />
      <path fill="currentColor" transform="translate(370,338)" d="PASTE_PATH_3_d" />
    </svg>
  );
}
```

Add to `client/src/app.css` inside the `:root { ... }` block:
```css
  --ai-suggest: #e21ad6;       /* AI suggestion accent (fuchsia) */
  --ai-suggest-wash: #fbe6fb;  /* suggestion cell wash */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/components/AiSparkle.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/AiSparkle.jsx client/src/components/AiSparkle.test.jsx client/src/app.css
git commit -m "feat(rubrics): AiSparkle component + fuchsia suggestion tokens"
```

### Task 9: `rubricColors.js` resolver

**Files:**
- Create: `client/src/lib/rubricColors.js`
- Test: `client/src/lib/rubricColors.test.js`

- [ ] **Step 1: Write the failing test**

```js
// client/src/lib/rubricColors.test.js
import { describe, it, expect } from 'vitest';
import { categoryColor } from './rubricColors.js';

const PALETTE = { produce: '#B4A7D6', create: '#9FC5E8' };

describe('categoryColor', () => {
  it('matches a reporting-category title by contained keyword', () => {
    expect(categoryColor('HS Art: Produce', PALETTE)).toBe('#B4A7D6');
    expect(categoryColor('HS Art: Create, Respond, Connect', PALETTE)).toBe('#9FC5E8');
  });
  it('falls back to a neutral colour when nothing matches', () => {
    expect(categoryColor('Mathematics: Reasoning', PALETTE)).toBe('var(--bg-subtle)');
    expect(categoryColor(null, PALETTE)).toBe('var(--bg-subtle)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/lib/rubricColors.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `client/src/lib/rubricColors.js`**

```js
// Resolve a reporting-category title to a fill colour using a config palette
// keyed by lowercase keyword (e.g. {produce:'#B4A7D6', create:'#9FC5E8'}).
// Keyword-contains match keeps it subject-agnostic; unknown → neutral.
export function categoryColor(categoryTitle, palette = {}) {
  const t = (categoryTitle || '').toLowerCase();
  for (const [key, color] of Object.entries(palette)) {
    if (t.includes(key.toLowerCase())) return color;
  }
  return 'var(--bg-subtle)';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/lib/rubricColors.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/rubricColors.js client/src/lib/rubricColors.test.js
git commit -m "feat(rubrics): config-driven reporting-category colour resolver"
```

### Task 10: api.js rubric endpoints

**Files:**
- Modify: `client/src/services/api.js` (append a `// Rubrics` section)
- Test: `client/src/services/rubricApi.test.js`

- [ ] **Step 1: Write the failing test**

```js
// client/src/services/rubricApi.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRubricForAssignment, attachRubric, uploadRubricCsv } from './api.js';

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
});

describe('rubric api', () => {
  it('getRubricForAssignment GETs the assignment rubric', async () => {
    await getRubricForAssignment('800');
    expect(fetch).toHaveBeenCalledWith('/api/rubrics/assignment/800', expect.any(Object));
  });
  it('attachRubric POSTs ids as JSON', async () => {
    await attachRubric({ rubricId: 1, courseId: 4, assignmentId: '800' });
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('/api/rubrics/attach');
    expect(JSON.parse(opts.body)).toEqual({ rubricId: 1, courseId: 4, assignmentId: '800' });
  });
  it('uploadRubricCsv POSTs multipart without a JSON content-type', async () => {
    await uploadRubricCsv('MAD', new Blob(['x']));
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('/api/rubrics/upload');
    expect(opts.body).toBeInstanceOf(FormData);
    expect(opts.headers?.['Content-Type']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/services/rubricApi.test.js`
Expected: FAIL (exports missing).

- [ ] **Step 3: Append to `client/src/services/api.js`**

```js
// ── Rubrics (descriptors) ──────────────────────────────────────────────
export const getRubricConfig = () => request('/rubrics/config');
export const listRubrics = () => request('/rubrics');
export const getRubricForAssignment = (assignmentId) => request(`/rubrics/assignment/${assignmentId}`);
export const attachRubric = (body) => request('/rubrics/attach', { method: 'POST', body: JSON.stringify(body) });
export const setRubricMapping = (attachmentId, criterionId, topicId) =>
  request(`/rubrics/attachment/${attachmentId}/mapping`, { method: 'PUT', body: JSON.stringify({ criterionId, topicId }) });
export const reorderRubricCriteria = (rubricId, orderedCriterionIds) =>
  request(`/rubrics/${rubricId}/reorder`, { method: 'PUT', body: JSON.stringify({ orderedCriterionIds }) });
export const rubricTemplateUrl = () => '/api/rubrics/template';
export const rubricExportUrl = (id) => `/api/rubrics/${id}/export`;

// Multipart upload — must NOT set a JSON Content-Type (let the browser set the boundary).
export const uploadRubricCsv = (name, file) => {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('file', file);
  return fetch('/api/rubrics/upload', { method: 'POST', body: fd }).then(async (res) => {
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
    return res.json();
  });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/services/rubricApi.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/services/api.js client/src/services/rubricApi.test.js
git commit -m "feat(rubrics): client api — config/list/attach/map/reorder/upload"
```

---

## Phase 6 — Client rendering

### Task 11: `RubricDescriptorGrid.jsx` (descriptor-mode grid body)

This is the read/grade grid for the **Descriptors** view: rows ordered by criterion `position`, descriptor prose in cells, category colour on the topic column, full-word colour headers, fuchsia sparkle suggestions, hugging selection borders, dotted-deletion + corner ×. It receives already-computed per-cell state from the card (final/draft/suggested/staged) so this component stays presentational and testable.

**Files:**
- Create: `client/src/components/RubricDescriptorGrid.jsx`
- Test: `client/src/components/RubricDescriptorGrid.test.jsx`

**Props:**
```
rows: [{ topic, criterion }]            // already ordered by criterion.position; criterion may be null
levels: ['ED','EX','D','EM','IE']
cellState(topicId, level) -> { final?, draft?, staged?, suggested? }
onSelect(topicId, level)
palette                                 // reporting-category colours from getRubricConfig
levelHeaderColors, levelBorderColors    // reuse the page's CELL_COLORS maps (passed in)
```

- [ ] **Step 1: Write the failing test**

```jsx
// client/src/components/RubricDescriptorGrid.test.jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RubricDescriptorGrid from './RubricDescriptorGrid.jsx';

const rows = [{
  topic: { id: 't1', title: 'Select, analyze', category_title: 'HS Art: Produce', external_id: 'ART.5.1' },
  criterion: { id: 'c1', criterion_name: 'UI/UX', reporting_category: 'Produce',
    descriptors: { ED: 'Polished.', EX: 'Clear.', D: 'Inconsistent.', EM: 'Lacks.', IE: 'Insufficient Evidence' } },
}];
const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];
const palette = { produce: '#B4A7D6', create: '#9FC5E8' };
const headerColors = { ED:'#bfdbfe', EX:'#bbf7d0', D:'#fef08a', EM:'#fed7aa', IE:'#fecaca' };
const borderColors = { ED:'#2563eb', EX:'#16a34a', D:'#ca8a04', EM:'#ea580c', IE:'#dc2626' };

function renderGrid(cellState = () => ({}), onSelect = vi.fn()) {
  render(<RubricDescriptorGrid rows={rows} levels={LEVELS} cellState={cellState}
    onSelect={onSelect} palette={palette} levelHeaderColors={headerColors} levelBorderColors={borderColors} />);
  return onSelect;
}

describe('RubricDescriptorGrid', () => {
  it('renders full-word level headers (no abbreviations)', () => {
    renderGrid();
    expect(screen.getByText('Exhibiting Depth')).toBeInTheDocument();
    expect(screen.getByText('Insufficient Evidence')).toBeInTheDocument();
    expect(screen.queryByText('ED')).not.toBeInTheDocument();
  });

  it('shows descriptor prose in each level cell', () => {
    renderGrid();
    expect(screen.getByText('Polished.')).toBeInTheDocument();
    expect(screen.getByText('Clear.')).toBeInTheDocument();
  });

  it('colours the topic column by reporting category', () => {
    renderGrid();
    const topicCell = screen.getByText('UI/UX').closest('td');
    expect(topicCell).toHaveStyle({ background: '#B4A7D6' });
  });

  it('renders the fuchsia sparkle on a suggested cell and fires onSelect on click', () => {
    const onSelect = renderGrid((tid, lvl) => (lvl === 'ED' ? { suggested: true } : {}));
    const edCell = screen.getByText('Polished.').closest('td');
    expect(edCell.querySelector('svg')).toBeTruthy();    // sparkle present
    fireEvent.click(screen.getByText('Clear.').closest('td'));
    expect(onSelect).toHaveBeenCalledWith('t1', 'EX');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/components/RubricDescriptorGrid.test.jsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `client/src/components/RubricDescriptorGrid.jsx`**

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
          <tr key={topic.id}>
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
              const text = criterion?.descriptors?.[l] ?? '';
              const base = {
                padding: '0.35rem 0.45rem', border: '1px solid var(--border)', verticalAlign: 'top',
                background: '#fff', color: '#1a1a1a', cursor: 'pointer', position: 'relative',
                lineHeight: 1.32, fontSize: '0.74rem',
              };
              // hugging selection borders (inset; no bleed)
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
                  {l === 'IE' && !text ? <span style={{ color: '#999', fontStyle: 'italic' }}>Insufficient Evidence</span> : text}
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/components/RubricDescriptorGrid.test.jsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/RubricDescriptorGrid.jsx client/src/components/RubricDescriptorGrid.test.jsx
git commit -m "feat(rubrics): RubricDescriptorGrid — descriptor cells, category colour, sparkle, hugging borders"
```

### Task 12: Wire the grid + toggle into `StudentRubricCard`

Render `RubricDescriptorGrid` when `viewMode === 'descriptors'` and a rubric is attached; keep the existing compact grid otherwise. Build `rows` ordered by criterion `position` from the attachment, and map each existing per-cell state (`isFinal/isDraft/stagedRemoval/isSuggested`) into the `cellState` callback. `onSelect` reuses the existing `selectLevel`.

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx`
  - `StudentRubricCard` signature → add `rubric` and `viewMode` props.
  - Build `descriptorRows` and a `cellState` adapter; render `RubricDescriptorGrid` for descriptor mode.
- Test: extend `client/src/pages/AssessmentSummaryPage.test.jsx`

- [ ] **Step 1: Write the failing test** (add to the existing file)

```jsx
it('renders descriptor prose when viewMode=descriptors and a rubric is attached', () => {
  const rubric = {
    id: 1, name: 'MAD',
    criteria: [{ id: 'c1', position: 1, criterion_name: 'UI/UX',
      descriptors: { ED: 'Polished.', EX: 'Clear.', D: 'Inconsistent.', EM: 'Lacks.', IE: 'Insufficient Evidence' } }],
    topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }],
  };
  renderCard({ viewMode: 'descriptors', rubric });
  expect(screen.getByText('Polished.')).toBeInTheDocument();
  expect(screen.getByText('Exhibiting Depth')).toBeInTheDocument();
});
```
(`TOPICS` already contains `{ id: 't1', ... }`; ensure the fixture topic id is `t1`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "descriptor prose"`
Expected: FAIL (descriptors not rendered).

- [ ] **Step 3: Implement in `AssessmentSummaryPage.jsx`**

Add the import at the top:
```jsx
import RubricDescriptorGrid from '../components/RubricDescriptorGrid.jsx';
```
Extend the `StudentRubricCard` signature:
```jsx
export function StudentRubricCard({ student, topics, courseId, assignmentId, assignmentRow, feedbackRow, rubric = null, viewMode = 'descriptors', rubricPalette = {}, onSaved, onPendingChange, onDisplayChange, registerCard, unregisterCard }) {
```
Just before the `return (` of the rubric grid `<div>` (around line 711), compute the descriptor rows + state adapter:
```jsx
// Descriptor view (rubric attached): order rows by criterion.position, mapping
// each criterion to its bound topic. Topics with no criterion fall after.
const topicById = Object.fromEntries(topics.map(t => [t.id, t]));
const critByTopic = Object.fromEntries((rubric?.topicByCriterion || []).map(m => [m.topic_id, m.criterion_id]));
const critById = Object.fromEntries((rubric?.criteria || []).map(c => [c.id, c]));
const orderedCrit = (rubric?.criteria || []).slice().sort((a, b) => a.position - b.position);
const descriptorRows = [
  ...orderedCrit
    .map(c => {
      const tid = (rubric.topicByCriterion.find(m => m.criterion_id === c.id) || {}).topic_id;
      return tid && topicById[tid] ? { topic: topicById[tid], criterion: c } : null;
    })
    .filter(Boolean),
  ...topics.filter(t => !critByTopic[t.id]).map(t => ({ topic: t, criterion: null })),
];
const cellStateFor = (topicId, l) => {
  const currentGrade = student.scores[topicId]?.grade || null;
  const pendingGrade = pending[topicId] ?? null;
  const suggestedLevel = suggestedByTopic[topicId] || null;
  return {
    final: l === currentGrade && pendingGrade == null,
    draft: pendingGrade !== REMOVE && l === pendingGrade,
    staged: pendingGrade === REMOVE && l === currentGrade,
    suggested: suggestedLevel != null && l === suggestedLevel,
  };
};
const showDescriptors = viewMode === 'descriptors' && !!rubric;
```
Inside the rubric-grid `<div>`, branch the table:
```jsx
{showDescriptors ? (
  <RubricDescriptorGrid
    rows={descriptorRows}
    levels={LEVELS}
    cellState={cellStateFor}
    onSelect={selectLevel}
    palette={rubricPalette}
    levelHeaderColors={Object.fromEntries(LEVELS.map(l => [l, CELL_COLORS[l].headerFill]))}
    levelBorderColors={Object.fromEntries(LEVELS.map(l => [l, CELL_COLORS[l].finalBorder]))}
  />
) : (
  /* existing compact <table> ... unchanged ... */
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS (new test + existing card tests still green).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(rubrics): render descriptor grid in StudentRubricCard (viewMode)"
```

### Task 13: Page-level toggle + attach/upload/template UI; load rubric

Fetch the attached rubric + palette in the page; add a **Compact ↔ Descriptors** toggle (default Descriptors) and an **Attach rubric** control (pick existing / upload CSV / download template) in the sticky header; pass `rubric`, `viewMode`, `rubricPalette` to every card.

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (main component)
- Test: extend `client/src/pages/AssessmentSummaryPage.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
it('defaults to Descriptors view and toggles to Compact', async () => {
  getMasteryForAssignment.mockResolvedValue({
    assignment: { title: 'MAD Project' },
    topics: [{ id: 't1', title: 'Select, analyze', category_title: 'HS Art: Produce', external_id: 'ART.5.1' }],
    students: [makeStudent()],
  });
  getRubricForAssignment.mockResolvedValue({
    id: 1, rubric: { id: 1, name: 'MAD', criteria: [{ id: 'c1', position: 1, criterion_name: 'UI/UX',
      descriptors: { ED: 'Polished.', EX: 'Clear.', D: 'x', EM: 'y', IE: 'Insufficient Evidence' } }] },
    topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }],
  });
  getRubricConfig.mockResolvedValue({ reportingCategoryColors: { produce: '#B4A7D6' } });
  renderPage();
  expect(await screen.findByText('Polished.')).toBeInTheDocument();          // descriptors shown by default
  fireEvent.click(screen.getByRole('button', { name: /compact/i }));
  await waitFor(() => expect(screen.queryByText('Polished.')).not.toBeInTheDocument());
});
```
Add `getRubricForAssignment`, `getRubricConfig` to the `vi.mock('../services/api.js', ...)` block, and a `renderPage()` helper that renders `<AssessmentSummaryPage/>` inside `MemoryRouter` + a route for `/course/:courseId/assignment/:assignmentId` (mirror existing page-level tests in the file).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "toggles to Compact"`
Expected: FAIL (toggle/rubric load absent).

- [ ] **Step 3: Implement in the main component of `AssessmentSummaryPage.jsx`**

Add imports:
```jsx
import { getRubricForAssignment, getRubricConfig, rubricTemplateUrl, uploadRubricCsv, attachRubric } from '../services/api.js';
```
Add state + load (beside the existing data load `useEffect`):
```jsx
const [rubricData, setRubricData] = useState(null);     // { id, rubric, topicByCriterion } | null
const [rubricPalette, setRubricPalette] = useState({});
const [viewMode, setViewMode] = useState('descriptors'); // default Descriptors

useEffect(() => {
  let active = true;
  getRubricForAssignment(assignmentId).then(r => active && setRubricData(r)).catch(() => {});
  getRubricConfig().then(c => active && setRubricPalette(c.reportingCategoryColors || {})).catch(() => {});
  return () => { active = false; };
}, [assignmentId]);
```
In the sticky header (next to the Refresh button), add the toggle:
```jsx
<div className="filter-btn-group" role="group">
  <button className={`filter-btn${viewMode === 'descriptors' ? ' active' : ''}`}
    onClick={() => setViewMode('descriptors')}>Descriptors</button>
  <button className={`filter-btn${viewMode === 'compact' ? ' active' : ''}`}
    onClick={() => setViewMode('compact')}>Compact</button>
</div>
```
Add the attach control (a small `<RubricAttachBar>` inline element or buttons):
```jsx
<a className="ghost" href={rubricTemplateUrl()} download>Download template</a>
<label className="secondary" style={{ cursor: 'pointer' }}>
  Upload rubric CSV
  <input type="file" accept=".csv" style={{ display: 'none' }} onChange={async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const { id } = await uploadRubricCsv(file.name.replace(/\.csv$/i, ''), file);
    await attachRubric({ rubricId: id, courseId, assignmentId });
    setRubricData(await getRubricForAssignment(assignmentId));
  }} />
</label>
```
Pass props to each card. **Flatten** the API attachment (`{ id, rubric, topicByCriterion }`) into the card's expected `{ ...criteria, topicByCriterion }` prop shape (the card reads `rubric.criteria` and `rubric.topicByCriterion` directly — see Task 12):
```jsx
<StudentRubricCard
  /* ...existing props... */
  rubric={rubricData ? { ...rubricData.rubric, topicByCriterion: rubricData.topicByCriterion } : null}
  viewMode={viewMode}
  rubricPalette={rubricPalette}
/>
```
(Task 14's `onReorder` uses the page-level raw shape `rubricData.rubric.id`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS (toggle test + all prior tests green).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(rubrics): page toggle (default Descriptors) + upload/attach/template UI"
```

### Task 14: Drag-reorder rows (descriptor view)

Add drag handles to descriptor rows that reorder criteria and persist via `reorderRubricCriteria`.

**Files:**
- Modify: `client/src/components/RubricDescriptorGrid.jsx` (optional `onReorder(orderedCriterionIds)` prop + native HTML5 drag on the topic cell)
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (pass `onReorder` only on the first card / a dedicated rubric header; call `reorderRubricCriteria`, then refetch)
- Test: `client/src/components/RubricDescriptorGrid.test.jsx` (reorder)

- [ ] **Step 1: Write the failing test**

```jsx
it('calls onReorder with the new criterion order after a drag', () => {
  const rows = [
    { topic: { id: 't1', title: 'A', category_title: 'Produce', external_id: 'X1' }, criterion: { id: 'c1', criterion_name: 'One', descriptors: {} } },
    { topic: { id: 't2', title: 'B', category_title: 'Produce', external_id: 'X2' }, criterion: { id: 'c2', criterion_name: 'Two', descriptors: {} } },
  ];
  const onReorder = vi.fn();
  render(<RubricDescriptorGrid rows={rows} levels={['ED','EX','D','EM','IE']} cellState={() => ({})}
    onSelect={() => {}} palette={{ produce: '#B4A7D6' }} levelHeaderColors={{}} levelBorderColors={{}} onReorder={onReorder} />);
  const handles = screen.getAllByLabelText('Drag to reorder');
  // simulate dropping row 2 onto row 1
  fireEvent.dragStart(handles[1].closest('tr'));
  fireEvent.drop(handles[0].closest('tr'));
  expect(onReorder).toHaveBeenCalledWith(['c2', 'c1']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/components/RubricDescriptorGrid.test.jsx -t "onReorder"`
Expected: FAIL (no drag handles).

- [ ] **Step 3: Implement drag handles** in `RubricDescriptorGrid.jsx`

Add `onReorder` to props. Track a dragged index in a `useRef`. On the topic `<td>`, when `onReorder` is provided, render a small handle `<span aria-label="Drag to reorder" draggable>⋮⋮</span>` and set `onDragStart`/`onDragOver`/`onDrop` on the `<tr>`:
```jsx
import { useRef } from 'react';
// inside component:
const dragFrom = useRef(null);
const ids = rows.map(r => r.criterion?.id).filter(Boolean);
function handleDrop(toIdx) {
  const from = dragFrom.current; dragFrom.current = null;
  if (from == null || from === toIdx || !onReorder) return;
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  next.splice(toIdx, 0, moved);
  onReorder(next);
}
// <tr ... onDragOver={e => onReorder && e.preventDefault()} onDrop={() => handleDrop(i)}>
// topic <td> handle (only when onReorder):
//   <span aria-label="Drag to reorder" draggable
//     onDragStart={() => { dragFrom.current = i; }} style={{ cursor:'grab', color:'#7a7a7a' }}>⋮⋮</span>
```
(`i` is the row index from `rows.map((row, i) => ...)`.)

- [ ] **Step 4: Wire persistence in `AssessmentSummaryPage.jsx`**

Pass `onReorder` (e.g. only to the first student card, since order is rubric-global) that persists then refetches:
```jsx
onReorder={isFirstCard ? async (orderedCriterionIds) => {
  await reorderRubricCriteria(rubricData.rubric.id, orderedCriterionIds);
  setRubricData(await getRubricForAssignment(assignmentId));
} : undefined}
```
Import `reorderRubricCriteria` from `../services/api.js`. Thread `onReorder` from `StudentRubricCard` into `RubricDescriptorGrid`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd client && npx vitest run src/components/RubricDescriptorGrid.test.jsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/RubricDescriptorGrid.jsx client/src/pages/AssessmentSummaryPage.jsx client/src/components/RubricDescriptorGrid.test.jsx
git commit -m "feat(rubrics): drag-reorder descriptor rows (persists criterion order)"
```

### Task 15: Matched fuchsia on the suggested-comment + Reviewer Analysis

Swap the violet `✦ Reviewer Analysis` button and any suggested-comment accent to the fuchsia token + `AiSparkle`.

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (the `✦ Reviewer Analysis` button ~line 1305; suggested-comment styling)
- Test: extend `client/src/pages/AssessmentSummaryPage.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
it('uses the AiSparkle glyph on the Reviewer Analysis button', () => {
  // render the page with analysis present (hasAnalysis true) per existing page test setup,
  // then assert the button contains an <svg> (sparkle) rather than the ✦ text glyph.
  // ...mirror an existing page-level render helper...
  const btn = screen.getByRole('button', { name: /reviewer analysis/i });
  expect(btn.querySelector('svg')).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx -t "Reviewer Analysis"`
Expected: FAIL (button uses a text ✦).

- [ ] **Step 3: Implement**

Replace the `✦ Reviewer Analysis` button content with `<AiSparkle size={14} style={{ color: 'var(--ai-suggest)' }} /> Reviewer Analysis`, and change its inline `border`/`background`/`color` to the fuchsia token (`border: '1px solid var(--ai-suggest)'`, `background: 'var(--ai-suggest-wash)'`, `color: 'var(--ai-suggest)'`). Apply the same `var(--ai-suggest)` accent anywhere a suggested comment is surfaced. Import `AiSparkle` at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(rubrics): fuchsia + sparkle on Reviewer Analysis and suggested comments"
```

---

## Phase 7 — Docs + full verification

### Task 16: Design-language log + full suite

**Files:**
- Modify: `docs/design-language.md`

- [ ] **Step 1: Append the tokens to `docs/design-language.md`**

Record: AI-suggestion accent (fuchsia `#e21ad6`, wash `#fbe6fb`, `AiSparkle` 3-star, 17px in-cell corner, `fill: currentColor`); inset/hugging selection borders (final solid 2px inset, draft dashed `-1px`, staged-deletion dotted red `-1px` + 21px corner ×); full-word colour-coded level headers; reporting-category colour on the topic column only, config-driven palette; neutral descriptor cells. Link to spec + this plan + #80.

- [ ] **Step 2: Run the entire test suite**

Run: `npm run test:server && (cd client && npx vitest run)`
Expected: PASS (server + client).

- [ ] **Step 3: Manual smoke (optional but recommended)**

Run `npm run dev`, open an assignment with aligned topics, upload the `Curriculum and Assessment/Rubric Templates/rubric-template.csv`, confirm: descriptors render by default in criterion order, category colour on topic column, a suggestion shows the fuchsia sparkle, selection borders hug, toggle flips to Compact, drag-reorder persists across refresh.

- [ ] **Step 4: Commit**

```bash
git add docs/design-language.md
git commit -m "docs(rubrics): log fuchsia/sparkle + selection-border visual language (#80)"
```

---

## Self-Review notes (coverage vs. spec)

- **§3 data model** → Task 1 (schema), Tasks 2/5 (stores). ✅
- **§4 CSV template/import/export** → Tasks 3, 7. ✅
- **§5 attach + auto-match** → Tasks 4, 5, 7; UI Task 13. ✅
- **§6 ordering** (position from source order; render by position; manual reorder; MCP round-trip) → Tasks 2/5 (position persisted + ordered reads), Task 12 (render by position), Task 14 (reorder). MCP itself = follow-up spec. ✅
- **§7 rendering/visual tokens** → Tasks 8–13, 15; config Task 6. ✅
- **§9 feature flag + tests** → Task 6 (flag), every task is TDD; round-trip CSV in Task 3. ✅
- **§8 MCP** → explicitly out of scope (follow-up spec) — no task, by design. ✅

**Known integration caveats for the executor:** Tasks 12/13/15 edit the 1489-line `AssessmentSummaryPage.jsx` — read the surrounding code before each edit; the compact `<table>` (≈ lines 711–840) must remain the `viewMode==='compact'` branch unchanged. The page-level test helper for full-page renders should mirror the existing page tests already in `AssessmentSummaryPage.test.jsx`.
