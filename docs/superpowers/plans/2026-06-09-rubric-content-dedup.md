# Rubric content-dedup + agent attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect content-identical rubrics on write/upload and reuse the existing one instead of duplicating; stop `write_rubric` silently overwriting a same-named-but-different rubric; give the MCP agent an `attach_rubric` tool.

**Architecture:** A pure `hashRubricContent` (sha256 of the normalized portable shape) + a compute-on-read `findRubricByContentHash` store lookup. `write_rubric` branches on exact-content match → reuse, same-name-different-content → conflict prompt (resolved via `on_name_conflict`), else create. A new `attach_rubric` tool binds a named rubric to an assignment. The CSV-upload route reuses on exact match; the modal reports it.

**Tech Stack:** Node ESM, better-sqlite3, `node:crypto`, Express, `@modelcontextprotocol/sdk`, Vitest (+ React Testing Library on the client). Spec: `docs/superpowers/specs/2026-06-09-rubric-content-dedup-design.md`.

All server/MCP test commands run from the repo root: `npx vitest run <path>`. Client tests: `cd client && npx vitest run <path>`.

---

### Task 1: Content fingerprint — `rubricHash.js`

**Files:**
- Create: `server/services/rubricHash.js`
- Test: `server/services/rubricHash.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/rubricHash.test.js`:

```js
import { describe, test, expect } from 'vitest';
import { hashRubricContent } from './rubricHash.js';

const crit = (over = {}) => ({
  criterion_name: 'UI/UX', standard_title: 'Visual design', reporting_category: 'Produce',
  descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' }, ...over,
});

describe('hashRubricContent', () => {
  test('is name-independent — identical criteria hash the same regardless of name/source', () => {
    expect(hashRubricContent({ name: 'Design', source: 'csv', criteria: [crit()] }))
      .toBe(hashRubricContent({ name: 'Weather Design', source: 'mcp', criteria: [crit()] }));
  });

  test('a changed descriptor changes the hash', () => {
    expect(hashRubricContent({ criteria: [crit()] }))
      .not.toBe(hashRubricContent({ criteria: [crit({ descriptors: { ED: 'CHANGED', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' } })] }));
  });

  test('omitted IE and explicit "Insufficient Evidence" hash the same (IE defaulted)', () => {
    expect(hashRubricContent({ criteria: [crit({ descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd' } })] }))
      .toBe(hashRubricContent({ criteria: [crit()] }));
  });

  test('null and "" collapse; extra keys (external_id, position) are ignored', () => {
    const a = hashRubricContent({ criteria: [crit({ standard_title: null })] });
    const b = hashRubricContent({ criteria: [crit({ standard_title: '', external_id: 'X1', position: 7 })] });
    expect(a).toBe(b);
  });

  test('criterion order is significant — reordering changes the hash', () => {
    const one = crit({ criterion_name: 'A' });
    const two = crit({ criterion_name: 'B' });
    expect(hashRubricContent({ criteria: [one, two] }))
      .not.toBe(hashRubricContent({ criteria: [two, one] }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/rubricHash.test.js`
Expected: FAIL — `Failed to resolve import "./rubricHash.js"` / `hashRubricContent is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `server/services/rubricHash.js`:

```js
import { createHash } from 'node:crypto';

const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];
const norm = (s) => String(s ?? '').trim();

// Canonical, name-independent representation of a rubric's content: ordered
// criteria → fixed-key fields + per-level descriptors (IE defaulted). Excludes
// name/source/ids/position/external_id, and collapses null/'' + trims, so
// identical content under different names hashes the same. Order is significant.
export function canonicalRubric(content) {
  return (content.criteria || []).map((c) => ({
    criterion_name: norm(c.criterion_name),
    standard_title: norm(c.standard_title),
    reporting_category: norm(c.reporting_category),
    descriptors: Object.fromEntries(LEVELS.map((l) => [
      l, l === 'IE' ? (norm(c.descriptors?.IE) || 'Insufficient Evidence') : norm(c.descriptors?.[l]),
    ])),
  }));
}

export function hashRubricContent(content) {
  return createHash('sha256').update(JSON.stringify(canonicalRubric(content))).digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/rubricHash.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/rubricHash.js server/services/rubricHash.test.js
git commit -m "feat(rubrics): content fingerprint helper (hashRubricContent) (#110)"
```

---

### Task 2: `findRubricByContentHash` (compute-on-read)

**Files:**
- Modify: `server/services/rubricStore.js`
- Test: `server/services/rubricStore.test.js`

- [ ] **Step 1: Write the failing test**

Add to `server/services/rubricStore.test.js` — first extend the import line and add a static import of the hash helper:

```js
import { saveRubric, getRubric, listRubrics, deleteRubric, getRubricByName, upsertRubricByName, renameRubric, findRubricByContentHash } from './rubricStore.js';
import { hashRubricContent } from './rubricHash.js';
```

Then add inside `describe('rubricStore', ...)`:

```js
  test('findRubricByContentHash finds a rubric with identical content under a different name', () => {
    const id = saveRubric(db, CONTENT);                       // name 'MAD Dev'
    const hash = hashRubricContent(getRubric(db, id));
    expect(findRubricByContentHash(db, hash)).toEqual({ id, name: 'MAD Dev' });
    expect(findRubricByContentHash(db, 'deadbeef')).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/services/rubricStore.test.js`
Expected: FAIL — `findRubricByContentHash is not a function` (import resolves to undefined).

- [ ] **Step 3: Write minimal implementation**

In `server/services/rubricStore.js`, add the import at the top (after the existing `getDb` import):

```js
import { hashRubricContent } from './rubricHash.js';
```

Add at the end of the file:

```js
// Compute-on-read content dedup: hash each library rubric and return the first
// (newest, per listRubrics order) whose content matches. A teacher's library is
// tens of rubrics, so the O(n) getRubric sweep is negligible (spec §3, #110).
export function findRubricByContentHash(db = getDb(), hash) {
  for (const { id } of listRubrics(db)) {
    const r = getRubric(db, id);
    if (hashRubricContent(r) === hash) return { id: r.id, name: r.name };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/services/rubricStore.test.js`
Expected: PASS (all rubricStore tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/rubricStore.js server/services/rubricStore.test.js
git commit -m "feat(rubrics): findRubricByContentHash compute-on-read lookup (#110)"
```

---

### Task 3: `write_rubric` dedup + name-conflict prompt

**Files:**
- Modify: `mcp/handlers.js` (replace `writeRubric`)
- Modify: `mcp/server.js` (`write_rubric` registration: `on_name_conflict` + description)
- Test: `mcp/handlers.test.js` (new unit tests), `mcp/server.test.js` (rewrite the stale "upsert" test)

- [ ] **Step 1: Write the failing tests (handlers unit)**

In `mcp/handlers.test.js`, extend the imports:

```js
import { listCourses, listAssignments, writeRubric } from './handlers.js';
import { saveRubric, listRubrics, getRubricByName } from '../server/services/rubricStore.js';
```

Replace the existing `beforeEach` block with one that also clears the rubric + reporting-category tables (children before parents):

```js
beforeEach(() => {
  getDb().exec(
    'DELETE FROM rubric_attachment_topics; DELETE FROM rubric_attachments; ' +
    'DELETE FROM rubric_descriptors; DELETE FROM rubric_criteria; DELETE FROM rubrics; ' +
    'DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
    'DELETE FROM grades; DELETE FROM assignments; ' +
    'DELETE FROM students; DELETE FROM courses;'
  );
});
```

Append a new describe block:

```js
const C = (over = {}) => ({ criterion_name: 'UI/UX', standard_title: 'Visual', reporting_category: 'Produce', descriptors: { ED: 'a' }, ...over });

describe('writeRubric (dedup + conflict)', () => {
  test('reuses an existing rubric with identical content under a different name — no copy', () => {
    const db = getDb();
    saveRubric(db, { name: 'Design', source: 'csv', criteria: [{ position: 1, ...C() }] });
    const res = writeRubric(db, { name: 'Weather App Design', criteria: [C()] });
    expect(res).toEqual({ reused_existing: 'Design', match: 'exact', criteria_count: 1 });
    expect(listRubrics(db)).toHaveLength(1);
  });

  test('prompts (conflict, no overwrite) on a same-name different-content write', () => {
    const db = getDb();
    saveRubric(db, { name: 'Design', source: 'csv', criteria: [{ position: 1, ...C({ descriptors: { ED: 'a' } }) }] });
    const res = writeRubric(db, { name: 'Design', criteria: [C({ descriptors: { ED: 'CHANGED' } })] });
    expect(res.conflict).toBe('name');
    expect(res.existing).toBe('Design');
    expect(listRubrics(db)).toHaveLength(1);
    expect(getRubricByName(db, 'Design').criteria[0].descriptors.ED).toBe('a'); // unchanged
  });

  test("on_name_conflict:'update' replaces the existing rubric in place", () => {
    const db = getDb();
    saveRubric(db, { name: 'Design', source: 'csv', criteria: [{ position: 1, ...C({ descriptors: { ED: 'a' } }) }] });
    const res = writeRubric(db, { name: 'Design', on_name_conflict: 'update', criteria: [C({ descriptors: { ED: 'NEW' } })] });
    expect(res).toMatchObject({ name: 'Design', match: 'updated' });
    expect(listRubrics(db)).toHaveLength(1);
    expect(getRubricByName(db, 'Design').criteria[0].descriptors.ED).toBe('NEW');
  });

  test("on_name_conflict:'new' saves a separate same-name copy", () => {
    const db = getDb();
    saveRubric(db, { name: 'Design', source: 'csv', criteria: [{ position: 1, ...C({ descriptors: { ED: 'a' } }) }] });
    const res = writeRubric(db, { name: 'Design', on_name_conflict: 'new', criteria: [C({ descriptors: { ED: 'b' } })] });
    expect(res).toMatchObject({ name: 'Design', match: 'created_new' });
    expect(listRubrics(db).filter((r) => r.name === 'Design')).toHaveLength(2);
  });

  test('creates a new rubric when nothing matches', () => {
    const db = getDb();
    const res = writeRubric(db, { name: 'Fresh', criteria: [C()] });
    expect(res).toMatchObject({ name: 'Fresh', match: 'created', criteria_count: 1 });
    expect(listRubrics(db)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run mcp/handlers.test.js`
Expected: FAIL — the new `writeRubric` behaviour (exact reuse, conflict shape, `match` values) doesn't exist yet; current `writeRubric` returns `{ name, criteria_count }` and blind-upserts.

- [ ] **Step 3: Write the implementation**

In `mcp/handlers.js`, change the rubric-store import line and add the hash import:

```js
import { listRubrics, getRubricByName, saveRubric, findRubricByContentHash } from '../server/services/rubricStore.js';
import { hashRubricContent } from '../server/services/rubricHash.js';
```

Replace the whole existing `writeRubric` function with:

```js
export function writeRubric(db, { name, criteria, on_name_conflict = 'prompt' }) {
  const content = { name, source: 'mcp', criteria: criteria.map((c, i) => ({ ...c, position: i + 1 })) };
  const criteria_count = criteria.length;

  const exact = findRubricByContentHash(db, hashRubricContent(content));
  if (exact) return { reused_existing: exact.name, match: 'exact', criteria_count };

  const named = getRubricByName(db, name);
  if (named) {
    if (on_name_conflict === 'update') { saveRubric(db, content, named.id); return { name, match: 'updated', criteria_count }; }
    if (on_name_conflict === 'new')    { saveRubric(db, content);          return { name, match: 'created_new', criteria_count }; }
    return {
      conflict: 'name',
      existing: name,
      existing_criteria_count: named.criteria.length,
      message: `A different rubric named "${name}" already exists. Re-call with on_name_conflict:"update" to replace it, or "new" to save a separate copy.`,
    };
  }

  saveRubric(db, content);
  return { name, match: 'created', criteria_count };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run mcp/handlers.test.js`
Expected: PASS (existing + 5 new writeRubric tests).

- [ ] **Step 5: Update the MCP tool registration**

In `mcp/server.js`, replace the `write_rubric` `registerTool` block with one that adds `on_name_conflict` and documents the new behaviour:

```js
  server.registerTool(
    'write_rubric',
    {
      description: 'Create or update a rubric by name. Dedup: if a rubric with identical content already exists (any name), it is reused (no copy) and the result reports { reused_existing, match: "exact" }. If a DIFFERENT rubric already has this name, the write is held back and returns { conflict: "name", ... } — ask the teacher, then re-call with on_name_conflict:"update" (replace it) or "new" (save a separate copy). Criteria are an ordered array (array order = row order). No Prism ids required.',
      inputSchema: {
        name: z.string().describe('Rubric name — the stable handle'),
        on_name_conflict: z.enum(['prompt', 'update', 'new']).optional()
          .describe('How to resolve a same-name-different-content collision: "prompt" (default, return a conflict), "update" (replace the existing), or "new" (save a separate copy)'),
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
    async ({ name, criteria, on_name_conflict }) => ({ content: [{ type: 'text', text: JSON.stringify(writeRubric(getDb(), { name, criteria, on_name_conflict })) }] })
  );
```

- [ ] **Step 6: Rewrite the stale end-to-end test**

In `mcp/server.test.js`, inside `describe('PrisMCP rubric tools', ...)`, **replace** the existing `test('write_rubric upserts by name (no duplicate)', ...)` with:

```js
  test('write_rubric does NOT overwrite a same-name different-content rubric — returns a conflict', async () => {
    const client = await connect();
    await client.callTool({ name: 'write_rubric', arguments: { name: 'Dupe', criteria: CRITERIA } });
    const res = await client.callTool({ name: 'write_rubric', arguments: { name: 'Dupe', criteria: [CRITERIA[0]] } });
    expect(JSON.parse(res.content[0].text).conflict).toBe('name');
    const list = JSON.parse((await client.callTool({ name: 'list_rubrics', arguments: {} })).content[0].text);
    expect(list.filter((r) => r.name === 'Dupe')).toHaveLength(1); // not duplicated, not replaced
  });

  test('write_rubric reuses an existing rubric with identical content under a different name', async () => {
    const client = await connect();
    await client.callTool({ name: 'write_rubric', arguments: { name: 'Design', criteria: CRITERIA } });
    const res = await client.callTool({ name: 'write_rubric', arguments: { name: 'Weather Design', criteria: CRITERIA } });
    expect(JSON.parse(res.content[0].text)).toMatchObject({ reused_existing: 'Design', match: 'exact' });
    const list = JSON.parse((await client.callTool({ name: 'list_rubrics', arguments: {} })).content[0].text);
    expect(list).toHaveLength(1); // no copy created
  });
```

- [ ] **Step 7: Run the MCP suites**

Run: `npx vitest run mcp/handlers.test.js mcp/server.test.js`
Expected: PASS (the rewritten + new tests; the round-trip test at line 193 still passes — a fresh name+content writes normally).

- [ ] **Step 8: Commit**

```bash
git add mcp/handlers.js mcp/server.js mcp/handlers.test.js mcp/server.test.js
git commit -m "feat(mcp): write_rubric content-dedup + same-name conflict prompt (#110)"
```

---

### Task 4: `attach_rubric` MCP tool

**Files:**
- Modify: `mcp/handlers.js` (add `attachRubricTool`)
- Modify: `mcp/server.js` (register `attach_rubric`)
- Test: `mcp/handlers.test.js` (unit), `mcp/server.test.js` (end-to-end)

- [ ] **Step 1: Write the failing unit test**

In `mcp/handlers.test.js`, extend the handlers import to include `attachRubricTool`:

```js
import { listCourses, listAssignments, writeRubric, attachRubricTool } from './handlers.js';
```

Append:

```js
describe('attachRubricTool', () => {
  test('attaches a library rubric to an assignment and reports unmatched criteria by name', () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1','AIML')`).run().lastInsertRowid;
    const asgId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-9', 'Project')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('rc1', ?, 'ART.5', 'Presenting')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1','rc1',?, 'ART.5.1','Visual design')`).run(courseId);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-9','t1',?)`).run(courseId);
    saveRubric(db, { name: 'Design', source: 'csv', criteria: [
      { position: 1, criterion_name: 'UI/UX', standard_title: 'Visual design', reporting_category: 'Produce', descriptors: { ED: 'a' } },
      { position: 2, criterion_name: 'Code', standard_title: 'Programming', reporting_category: 'Produce', descriptors: { ED: 'b' } },
    ] });

    const res = attachRubricTool(db, { rubric_name: 'Design', assignment_id: asgId });
    expect(res).toEqual({ attached_to: asgId, rubric: 'Design', unmatched_criteria: ['Code'] });
  });

  test('returns an error object when the rubric name is unknown', () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1','AIML')`).run().lastInsertRowid;
    const asgId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-9', 'Project')`).run(courseId).lastInsertRowid;
    expect(attachRubricTool(db, { rubric_name: 'Nope', assignment_id: asgId }).error).toMatch(/not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run mcp/handlers.test.js`
Expected: FAIL — `attachRubricTool is not a function`.

- [ ] **Step 3: Write the implementation**

In `mcp/handlers.js`, add the attach import (next to the rubric-store import):

```js
import { attachRubric } from '../server/services/rubricAttach.js';
```

Add the handler (after `writeRubric`):

```js
// Bind a library rubric (by name) to an assignment, auto-matching criteria to the
// assignment's measurement topics (the same path the modal uses). Reports the
// criteria that still need a topic so the agent can point the teacher at the
// Map-criteria tab (there is no topic-mapping MCP tool).
export function attachRubricTool(db, { rubric_name, assignment_id }) {
  const rubric = getRubricByName(db, rubric_name);
  if (!rubric) return { error: `rubric "${rubric_name}" not found` };
  const asg = db.prepare(`SELECT schoology_assignment_id, course_id FROM assignments WHERE id = ?`).get(Number(assignment_id));
  if (!asg) return { error: `assignment ${assignment_id} not found` };
  const { unmatched } = attachRubric(db, { rubricId: rubric.id, courseId: asg.course_id, assignmentId: asg.schoology_assignment_id });
  const nameById = Object.fromEntries(rubric.criteria.map((c) => [c.id, c.criterion_name]));
  return { attached_to: Number(assignment_id), rubric: rubric_name, unmatched_criteria: unmatched.map((id) => nameById[id]) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run mcp/handlers.test.js`
Expected: PASS (both attach tests + the writeRubric block).

- [ ] **Step 5: Register the tool + add an end-to-end test**

In `mcp/server.js`, add `attachRubricTool` to the handlers import:

```js
import { listCourses, listAssignments, listRubricsTool, readRubric, writeRubric, attachRubricTool } from './handlers.js';
```

Register it immediately after the `write_rubric` block:

```js
  server.registerTool(
    'attach_rubric',
    {
      description: "Attach a library rubric (by name) to an assignment, auto-matching its criteria to the assignment's measurement topics. Returns { attached_to, rubric, unmatched_criteria } — finish any unmatched criteria in Prism's Map-criteria tab.",
      inputSchema: {
        rubric_name: z.string().describe('Rubric name (as shown by list_rubrics)'),
        assignment_id: z.union([z.number(), z.string()]).describe('Local Prism assignment id (from list_assignments)'),
      },
    },
    async ({ rubric_name, assignment_id }) => ({ content: [{ type: 'text', text: JSON.stringify(attachRubricTool(getDb(), { rubric_name, assignment_id })) }] })
  );
```

In `mcp/server.test.js`, append inside `describe('PrisMCP rubric tools', ...)`:

```js
  test('attach_rubric binds a written rubric to an assignment', async () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1','AIML')`).run().lastInsertRowid;
    const asgId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-7', 'Project')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('rc1', ?, 'ART.5', 'Presenting')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1','rc1',?, 'ART.5.1','Visual design')`).run(courseId);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-7','t1',?)`).run(courseId);
    const client = await connect();
    await client.callTool({ name: 'write_rubric', arguments: { name: 'Design', criteria: [
      { criterion_name: 'UI/UX', standard_title: 'Visual design', reporting_category: 'Produce', descriptors: { ED: 'a' } },
    ] } });
    const res = await client.callTool({ name: 'attach_rubric', arguments: { rubric_name: 'Design', assignment_id: asgId } });
    expect(JSON.parse(res.content[0].text)).toMatchObject({ attached_to: asgId, rubric: 'Design', unmatched_criteria: [] });
  });
```

- [ ] **Step 6: Run the MCP suites**

Run: `npx vitest run mcp/handlers.test.js mcp/server.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add mcp/handlers.js mcp/server.js mcp/handlers.test.js mcp/server.test.js
git commit -m "feat(mcp): attach_rubric tool — bind a library rubric to an assignment (#110)"
```

---

### Task 5: CSV upload — reuse on exact content match

**Files:**
- Modify: `server/routes/rubrics.js` (`POST /upload`)
- Test: `server/routes/rubrics.test.js`

- [ ] **Step 1: Write the failing tests**

In `server/routes/rubrics.test.js`, add inside `describe('rubrics route', ...)`:

```js
  test('POST /upload reuses an existing rubric on identical content (no new row)', async () => {
    saveRubric(getDb(), { name: 'Existing', source: 'csv', criteria: [
      { position: 1, criterion_name: 'UI/UX', standard_title: 'Select', reporting_category: 'Produce',
        descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' } },
    ] });
    const fd = new FormData();
    fd.append('name', 'Re-upload');
    fd.append('file', new Blob([
      'Criteria,Reporting Category,Standard,Exhibiting Depth,Exhibiting,Developing,Emerging\nUI/UX,Produce,Select,a,b,c,d',
    ], { type: 'text/csv' }), 'dupe.csv');
    const up = await call('POST', '/api/rubrics/upload', fd, true);
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ reused: true, match: 'exact', name: 'Existing' });
    expect((await call('GET', '/api/rubrics')).body).toHaveLength(1); // no duplicate created
  });

  test('POST /upload creates a new rubric when content does not match (reused:false)', async () => {
    const fd = new FormData();
    fd.append('name', 'Novel');
    fd.append('file', new Blob([
      'Criteria,Reporting Category,Standard,Exhibiting Depth,Exhibiting,Developing,Emerging\nNovel,Produce,Brand new,z,y,x,w',
    ], { type: 'text/csv' }), 'novel.csv');
    const up = await call('POST', '/api/rubrics/upload', fd, true);
    expect(up.body).toMatchObject({ reused: false });
    expect((await call('GET', '/api/rubrics')).body).toHaveLength(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/routes/rubrics.test.js`
Expected: FAIL — the reuse test gets a freshly-created id with no `reused`/`match` keys, and `GET /` returns 2 rows (a duplicate was created).

- [ ] **Step 3: Write the implementation**

In `server/routes/rubrics.js`, extend the store import and add the hash import:

```js
import { listRubrics, saveRubric, getRubric, deleteRubric, renameRubric, findRubricByContentHash } from '../services/rubricStore.js';
import { hashRubricContent } from '../services/rubricHash.js';
```

Replace the body of the `router.post('/upload', ...)` handler's `try` block with:

```js
  try {
    const content = parseRubricCsv(req.file.buffer.toString('utf-8'), { name });
    const existing = findRubricByContentHash(getDb(), hashRubricContent(content));
    if (existing) {
      return res.json({ id: existing.id, name: existing.name, criteria_count: content.criteria.length, reused: true, match: 'exact' });
    }
    const id = saveRubric(getDb(), content);
    res.json({ id, name, criteria_count: content.criteria.length, reused: false });
  } catch (err) {
    res.status(400).json({ error: `CSV parse error: ${err.message}` });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/routes/rubrics.test.js`
Expected: PASS (existing route tests + 2 new). The existing `POST /upload then GET / lists the rubric` test still passes (its content is novel → created).

- [ ] **Step 5: Commit**

```bash
git add server/routes/rubrics.js server/routes/rubrics.test.js
git commit -m "feat(rubrics): CSV upload reuses an existing rubric on exact content match (#110)"
```

---

### Task 6: Modal — surface the reuse on upload

**Files:**
- Modify: `client/src/components/RubricManagerModal.jsx` (`doAttach` accepts an info note; `doUpload` passes the reuse message)
- Test: `client/src/components/RubricManagerModal.test.jsx`

- [ ] **Step 1: Write the failing test**

In `client/src/components/RubricManagerModal.test.jsx`, add inside `describe('RubricManagerModal', ...)`:

```js
  it('reuses an existing rubric on an identical CSV upload and says so', async () => {
    uploadRubricCsv.mockResolvedValueOnce({ id: 9, reused: true, name: 'AIML U2' });
    open();
    await screen.findByText('AIML U2');
    const fileInput = document.querySelector('input[type="file"]');
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'dupe.csv', { type: 'text/csv' })] } });
    expect(await screen.findByText((t) => t.includes('Identical to existing') && t.includes('AIML U2'))).toBeInTheDocument();
  });
```

Note: `uploadRubricCsv` is already in the `vi.mock('../services/api.js', …)` factory; add it to the destructured import at the top of the file if not present:

```js
import { listRubrics, attachRubric, deleteRubric, setRubricMapping, reorderRubricCriteria, renameRubric, uploadRubricCsv, rubricExportUrl } from '../services/api.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/components/RubricManagerModal.test.jsx`
Expected: FAIL — no "Identical to existing" text appears (the message isn't emitted yet).

- [ ] **Step 3: Write the implementation**

In `client/src/components/RubricManagerModal.jsx`, replace `doAttach` and `doUpload` with:

```js
  async function doAttach(rubricId, info) {
    setMsg('');
    try {
      const { unmatched } = await attachRubric({ rubricId, courseId, assignmentId });
      await onChanged(); await refresh();
      const notes = [];
      if (info) notes.push(info);
      if (unmatched?.length) {
        setTab('map');
        notes.push(`${unmatched.length} ${unmatched.length === 1 ? 'criterion' : 'criteria'} couldn’t be auto-matched — pick a topic below.`);
      }
      if (notes.length) setMsg(notes.join(' '));
    } catch (e) { setMsg(`Attach failed: ${e.message}`); }
  }
  async function doUpload(file) {
    setMsg('');
    try {
      const { id, reused, name } = await uploadRubricCsv(file.name.replace(/\.csv$/i, ''), file);
      await doAttach(id, reused ? `Identical to existing “${name}” — attached it, no copy created.` : undefined);
    } catch (e) { setMsg(`Upload failed: ${e.message}`); }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/components/RubricManagerModal.test.jsx`
Expected: PASS — including the existing `jumps to Map criteria and warns…` test (the unmatched note still renders via the `notes` array).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/RubricManagerModal.jsx client/src/components/RubricManagerModal.test.jsx
git commit -m "feat(rubrics): modal reports rubric reuse on identical CSV upload (#110)"
```

---

### Task 7: Full-suite verification

- [ ] **Step 1: Run the whole server + MCP suite**

Run: `npx vitest run`
Expected: PASS — all server + MCP test files (was 285 before #110; +~14 new).

- [ ] **Step 2: Run the whole client suite**

Run: `cd client && npx vitest run`
Expected: PASS — all client test files (was 265; +1 new).

- [ ] **Step 3: Update the design-language log + close out**

No new visual primitive was introduced (the reuse note reuses the existing `msg` banner), so `docs/design-language.md` needs no entry. Confirm `git status` is clean and the six feature commits are present.

---

## Notes for the implementer

- **`getRubricByName` returns full content** (via `getRubric`), so `named.id` and `named.criteria.length` are available — no extra query needed.
- **`attachRubric` already replaces** any existing attachment for an assignment (`DELETE … WHERE assignment_schoology_id = ?` first), so `attach_rubric` re-attaching is safe (resolves the spec §9 "re-attach" risk: it's replace, not error).
- **`unmatched` from `attachRubric` is an array of criterion ids**; `attachRubricTool` maps them to criterion names for the agent.
- **Hash equivalence across surfaces:** `saveRubric` stores all five descriptor levels (IE defaulted, missing levels `null`); `parseRubricCsv` and the MCP content both default IE and may omit levels. `canonicalRubric` trims + collapses `null`/`''` and defaults IE, so the stored form and the incoming form hash identically. The route test in Task 5 exercises exactly this CSV-vs-stored equivalence.
- **`upsertRubricByName` stays in `rubricStore.js`** (and keeps its test) per CLAUDE.md "preserve verified intel" — it's simply no longer called by `write_rubric`.
