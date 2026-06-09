# Proficiency-Scale Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Prism the single, configurable owner of the proficiency-level↔gradebook-score mapping so neither the MCP caller nor the teacher ever sees or infers a number.

**Architecture:** One `grading.proficiencyScale` block in `config.yaml` is the source of truth for the numeric mapping. A pure server module (`server/lib/proficiencyScale.js`) derives every helper from it; a `GET /api/proficiency-scale` endpoint + `useProficiencyScale()` hook feed the client, whose numeric helpers live in `client/src/lib/masteryLevels.js`. All ~8 scattered `LEVEL_*` / `points` / `grade_scaled` / `21337256` copies collapse onto these. The MCP write tool drops the caller-supplied `score`; `get_assignment_context` stops exposing bare `points`.

**Tech Stack:** Node ESM, Express, better-sqlite3, `js-yaml`, Vitest (server + client), React + Vite + React Testing Library, Zod (MCP schemas), `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-06-09-proficiency-scale-ownership-design.md`

**Test commands:** server — `npx vitest run <path>` from repo root; client — `cd client && npx vitest run <path>`.

**Branch:** `feat/proficiency-scale-ownership` (already created; spec committed).

> **Spec refinement (locked here):** the client SSOT lives in the existing `client/src/lib/masteryLevels.js`, not a new `proficiencyScale.js`. Config owns the *numeric* mapping (points / gradeScaled / schoologyScaleId — the part that leaked and that schools re-weight). Level *identity* (codes, labels, order, colors) is stable and lives as constants in the server module + `masteryLevels.js`, with a drift test pinning client labels == server defaults.

---

## Phase 1 — Server SSOT, proven by parity

### Task 1: Add the proficiency scale to config + loader

**Files:**
- Modify: `config.yaml`
- Modify: `server/middleware/featureGate.js`
- Test: `server/middleware/featureGate.test.js`

- [ ] **Step 1: Write the failing test**

Add to `server/middleware/featureGate.test.js`:

```js
import { getProficiencyScale } from './featureGate.js';

describe('getProficiencyScale', () => {
  test('returns the HKIS General Academic Scale with all five levels', () => {
    const scale = getProficiencyScale();
    expect(scale.schoologyScaleId).toBe(21337256);
    expect(scale.levels.map((l) => l.code)).toEqual(['ED', 'EX', 'D', 'EM', 'IE']);
    const ed = scale.levels.find((l) => l.code === 'ED');
    expect(ed).toMatchObject({ label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' });
    const ie = scale.levels.find((l) => l.code === 'IE');
    expect(ie).toMatchObject({ label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/middleware/featureGate.test.js`
Expected: FAIL — `getProficiencyScale is not a function`.

- [ ] **Step 3: Add the config block**

Append to `config.yaml`:

```yaml
grading:
  proficiencyScale:
    name: HKIS General Academic Scale
    schoologyScaleId: 21337256
    levels:                                   # ordered best → worst
      - { code: ED, label: Exhibiting Depth,      points: 100, gradeScaled: '87.50' }
      - { code: EX, label: Exhibiting,            points: 75,  gradeScaled: '62.50' }
      - { code: D,  label: Developing,            points: 50,  gradeScaled: '37.50' }
      - { code: EM, label: Emerging,              points: 25,  gradeScaled: '12.50' }
      - { code: IE, label: Insufficient Evidence, points: 0,   gradeScaled: '0.00'  }
```

- [ ] **Step 4: Implement the loader with a built-in default**

In `server/middleware/featureGate.js`, add after `getRubricConfig`:

```js
const DEFAULT_PROFICIENCY_SCALE = {
  name: 'HKIS General Academic Scale',
  schoologyScaleId: 21337256,
  levels: [
    { code: 'ED', label: 'Exhibiting Depth',      points: 100, gradeScaled: '87.50' },
    { code: 'EX', label: 'Exhibiting',            points: 75,  gradeScaled: '62.50' },
    { code: 'D',  label: 'Developing',            points: 50,  gradeScaled: '37.50' },
    { code: 'EM', label: 'Emerging',              points: 25,  gradeScaled: '12.50' },
    { code: 'IE', label: 'Insufficient Evidence', points: 0,   gradeScaled: '0.00'  },
  ],
};

export function getProficiencyScale() {
  if (!config) loadConfig();
  return { ...DEFAULT_PROFICIENCY_SCALE, ...(config.grading?.proficiencyScale || {}) };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/middleware/featureGate.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config.yaml server/middleware/featureGate.js server/middleware/featureGate.test.js
git commit -m "feat(grading): add configurable proficiencyScale + loader"
```

---

### Task 2: The server derivation module

**Files:**
- Create: `server/lib/proficiencyScale.js`
- Test: `server/lib/proficiencyScale.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/lib/proficiencyScale.test.js`:

```js
import {
  LEVELS, normalizeLevel, pointsToLevel, levelToPoints,
  levelToGradeScaled, gradeScaledValues, levelToLabel, schoologyScaleId, getScaleTable,
} from './proficiencyScale.js';

describe('proficiencyScale', () => {
  test('LEVELS is ordered best→worst', () => {
    expect(LEVELS).toEqual(['ED', 'EX', 'D', 'EM', 'IE']);
  });

  test('normalizeLevel accepts names and codes, case-insensitively', () => {
    expect(normalizeLevel('Exhibiting Depth')).toBe('ED');
    expect(normalizeLevel('  ed ')).toBe('ED');
    expect(normalizeLevel('IE')).toBe('IE');
  });

  test('normalizeLevel rejects numerics and unknowns', () => {
    expect(normalizeLevel('75')).toBeNull();
    expect(normalizeLevel(75)).toBeNull();
    expect(normalizeLevel('A+')).toBeNull();
  });

  test('pointsToLevel bands on the gradeScaled cutoffs', () => {
    expect(pointsToLevel(100)).toBe('ED');
    expect(pointsToLevel(87.5)).toBe('ED');
    expect(pointsToLevel(87.49)).toBe('EX');
    expect(pointsToLevel(80)).toBe('EX');
    expect(pointsToLevel(62.5)).toBe('EX');
    expect(pointsToLevel(12.5)).toBe('EM');
    expect(pointsToLevel(12.49)).toBe('IE');
    expect(pointsToLevel(0)).toBe('IE');
    expect(pointsToLevel(null)).toBeNull();
  });

  test('forward maps', () => {
    expect(levelToPoints('EX')).toBe(75);
    expect(levelToGradeScaled('EX')).toBe('62.50');
    expect(levelToLabel('EX')).toBe('Exhibiting');
    expect(schoologyScaleId()).toBe(21337256);
  });

  test('gradeScaledValues is the valid override set', () => {
    expect([...gradeScaledValues()].sort()).toEqual(['0.00', '12.50', '37.50', '62.50', '87.50']);
  });

  test('getScaleTable returns the ordered bundle', () => {
    expect(getScaleTable().map((l) => l.code)).toEqual(LEVELS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/lib/proficiencyScale.test.js`
Expected: FAIL — cannot find module `./proficiencyScale.js`.

- [ ] **Step 3: Implement the module**

Create `server/lib/proficiencyScale.js`:

```js
// Single source of truth for the proficiency level↔gradebook-score mapping.
// Reads the configurable scale (server/middleware/featureGate.getProficiencyScale)
// and derives every helper the codebase used to re-implement. Banding cutoffs are
// the gradeScaled values, so pointsToLevel is "highest level whose gradeScaled ≤ n".
import { getProficiencyScale } from '../middleware/featureGate.js';

const table = () => getProficiencyScale().levels;

export const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];

export function getScaleTable() {
  return table();
}

export function normalizeLevel(raw) {
  if (raw == null || typeof raw === 'number') return null;
  const s = String(raw).trim().toLowerCase();
  for (const l of table()) {
    if (s === l.code.toLowerCase() || s === l.label.toLowerCase()) return l.code;
  }
  return null;
}

// Highest level whose gradeScaled ≤ n (IE is the floor). Works for an exact
// Schoology rollup (62.50→EX) and a rounded 0–100 mean/mode (80→EX).
export function pointsToLevel(n) {
  if (n == null) return null;
  let best = table()[table().length - 1].code; // IE floor
  for (const l of table()) {
    if (n >= Number(l.gradeScaled)) return l.code;
  }
  return best;
}

const find = (code) => table().find((l) => l.code === code) || null;

export function levelToPoints(code) {
  const l = find(code);
  return l ? l.points : null;
}

export function levelToGradeScaled(code) {
  const l = find(code);
  return l ? l.gradeScaled : null;
}

export function levelToLabel(code) {
  const l = find(code);
  return l ? l.label : null;
}

export function gradeScaledValues() {
  return new Set(table().map((l) => l.gradeScaled));
}

export function schoologyScaleId() {
  return getProficiencyScale().schoologyScaleId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/lib/proficiencyScale.test.js`
Expected: PASS (note `pointsToLevel`'s loop returns the first level with `gradeScaled ≤ n`; since the table is ordered ED→IE, the first match is the highest level — verify `87.49→EX` and `12.49→IE` pass).

- [ ] **Step 5: Commit**

```bash
git add server/lib/proficiencyScale.js server/lib/proficiencyScale.test.js
git commit -m "feat(grading): proficiencyScale derivation module (SSOT)"
```

---

### Task 3: Parity test — new module == old hardcoded maps

**Files:**
- Test: `server/lib/proficiencyScale.parity.test.js`

- [ ] **Step 1: Write the parity test**

Create `server/lib/proficiencyScale.parity.test.js`. This pins the refactor: the new helpers must reproduce the exact values currently hardcoded across the codebase, so later deletions provably preserve behaviour.

```js
import { pointsToLevel, levelToPoints, levelToGradeScaled, levelToLabel, schoologyScaleId } from './proficiencyScale.js';

// The values as hardcoded TODAY (masterySync POINTS_TO_GRADE / GRADE_TO_LABEL /
// GRADING_SCALE_ID, AssessmentSummaryPage LEVEL_POINTS, OverridePopup SCALED_FOR_LEVEL).
const OLD_POINTS_TO_GRADE = { 100: 'ED', 75: 'EX', 50: 'D', 25: 'EM', 0: 'IE' };
const OLD_GRADE_TO_LABEL = { ED: 'Exhibiting Depth', EX: 'Exhibiting', D: 'Developing', EM: 'Emerging', IE: 'Insufficient Evidence' };
const OLD_LEVEL_POINTS = { ED: 100, EX: 75, D: 50, EM: 25, IE: 0 };
const OLD_SCALED_FOR_LEVEL = { ED: '87.50', EX: '62.50', D: '37.50', EM: '12.50', IE: '0.00' };

test('pointsToLevel matches old POINTS_TO_GRADE on the clean anchors', () => {
  for (const [points, code] of Object.entries(OLD_POINTS_TO_GRADE)) {
    expect(pointsToLevel(Number(points))).toBe(code);
  }
});

test('levelToPoints matches old LEVEL_POINTS', () => {
  for (const [code, points] of Object.entries(OLD_LEVEL_POINTS)) {
    expect(levelToPoints(code)).toBe(points);
  }
});

test('levelToGradeScaled matches old SCALED_FOR_LEVEL', () => {
  for (const [code, scaled] of Object.entries(OLD_SCALED_FOR_LEVEL)) {
    expect(levelToGradeScaled(code)).toBe(scaled);
  }
});

test('levelToLabel matches old GRADE_TO_LABEL', () => {
  for (const [code, label] of Object.entries(OLD_GRADE_TO_LABEL)) {
    expect(levelToLabel(code)).toBe(label);
  }
});

test('schoologyScaleId matches old GRADING_SCALE_ID', () => {
  expect(schoologyScaleId()).toBe(21337256);
});
```

- [ ] **Step 2: Run to verify it passes (parity holds before any refactor)**

Run: `npx vitest run server/lib/proficiencyScale.parity.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/lib/proficiencyScale.parity.test.js
git commit -m "test(grading): parity — proficiencyScale reproduces hardcoded maps"
```

---

## Phase 2 — Repoint server consumers onto the SSOT

### Task 4: suggestions.js uses shared normalizeLevel

**Files:**
- Modify: `server/services/suggestions.js:10-22`
- Test: `server/services/suggestions.test.js` (existing — must stay green)

- [ ] **Step 1: Run the existing suite (baseline green)**

Run: `npx vitest run server/services/suggestions.test.js`
Expected: PASS.

- [ ] **Step 2: Replace the local LEVEL_CODES with the shared import**

In `server/services/suggestions.js`, delete the `LEVEL_CODES` object and local `normalizeLevel` (lines 10-22) and import instead:

```js
import { normalizeLevel } from '../lib/proficiencyScale.js';
```

Keep the re-export if other modules import it from here (`export { normalizeLevel };`). Leave `upsertStudentSuggestion`'s use of `normalizeLevel(rawLevel)` unchanged.

- [ ] **Step 3: Run the suite (still green)**

Run: `npx vitest run server/services/suggestions.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/services/suggestions.js
git commit -m "refactor(suggestions): normalizeLevel from proficiencyScale SSOT"
```

---

### Task 5: masterySync.js uses shared helpers

**Files:**
- Modify: `server/services/masterySync.js:30,40-47,481,697,998`
- Test: `server/routes/mastery.test.js`, `server/services/*` (existing — stay green)

- [ ] **Step 1: Baseline green**

Run: `npx vitest run server/routes/mastery.test.js`
Expected: PASS.

- [ ] **Step 2: Replace constants with imports**

In `server/services/masterySync.js`:
- Delete `const GRADING_SCALE_ID = 21337256;` (line 30), `const POINTS_TO_GRADE = {...}` (line 40), `const GRADE_TO_LABEL = {...}` (lines 41-47), and the `export { POINTS_TO_GRADE, GRADE_TO_LABEL, GRADING_SCALE_ID };` (line 998 — these are imported nowhere else, confirmed).
- Add import: `import { pointsToLevel, levelToLabel, schoologyScaleId } from '../lib/proficiencyScale.js';`
- Replace both `const grade = points !== null ? (POINTS_TO_GRADE[points] ?? null) : null;` (lines 481, 697) with `const grade = points !== null ? pointsToLevel(points) : null;`
- Replace the `gradingScaleId = GRADING_SCALE_ID` default in `writeMasteryOverride` (line ~574) with `gradingScaleId = schoologyScaleId()`.
- If `GRADE_TO_LABEL` is referenced internally, swap each use for `levelToLabel(code)`.

- [ ] **Step 3: Run the suite (still green)**

Run: `npx vitest run server/routes/mastery.test.js server/lib/proficiencyScale.parity.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/services/masterySync.js
git commit -m "refactor(mastery): points↔level/label/scaleId from SSOT"
```

---

### Task 6: Server LEVELS consumers use the shared constant

**Files:**
- Modify: `mcp/handlers.js:46`, `server/services/rubricStore.js:4`, `server/services/rubricHash.js:3`
- Test: existing `mcp/*.test.js`, `server/services/rubricStore.test.js` (stay green)

- [ ] **Step 1: Baseline green**

Run: `npx vitest run server/services/rubricStore.test.js`
Expected: PASS.

- [ ] **Step 2: Replace each `const LEVELS = ['ED',...]` with the import**

In each of the three files, delete the local `const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];` and add:

```js
import { LEVELS } from '../lib/proficiencyScale.js';   // adjust relative path: mcp/handlers.js → '../server/lib/proficiencyScale.js'
```

(`mcp/handlers.js` is outside `server/`, so its path is `'../server/lib/proficiencyScale.js'`.)

- [ ] **Step 3: Run the suites (green)**

Run: `npx vitest run server/services/rubricStore.test.js mcp`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add mcp/handlers.js server/services/rubricStore.js server/services/rubricHash.js
git commit -m "refactor: LEVELS from proficiencyScale SSOT (server + mcp)"
```

---

## Phase 3 — Close the write leak (levels-only)

### Task 7: Drop `score` from the MCP write schema

**Files:**
- Modify: `mcp/server.js:78-90`
- Test: `mcp/server.test.js` (or the existing MCP write test)

- [ ] **Step 1: Write the failing test**

Add to the MCP write test (find the file exercising `write_student_suggestions`):

```js
test('write_student_suggestions schema has no score field', () => {
  // Build the server and introspect the registered tool's input schema.
  const server = createServer();
  const tool = server._registeredTools?.write_student_suggestions
    ?? server.registeredTools?.write_student_suggestions;
  const studentShape = tool.inputSchema.shape.students.element.shape;
  expect(studentShape).not.toHaveProperty('score');
  expect(studentShape).toHaveProperty('rubric_scores');
});
```

(If the SDK doesn't expose the registry that way, assert behaviourally instead: call the tool with a `score` and assert it is not written — see Task 8.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run mcp/server.test.js`
Expected: FAIL — `score` still present.

- [ ] **Step 3: Remove `score` and sharpen the description**

In `mcp/server.js`, in the `write_student_suggestions` per-student `z.object`, delete `score: z.number().optional(),` and change the `rubric_scores` description to:

```js
rubric_scores: z.record(z.string(), z.string()).optional()
  .describe('{ topic external_id|title: proficiency level code or name } — levels only; Prism owns the points conversion'),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run mcp/server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/server.js
git commit -m "feat(mcp): write_student_suggestions is levels-only (drop score)"
```

---

### Task 8: suggestions.js ignores caller score + rejects numerics instructively

**Files:**
- Modify: `server/services/suggestions.js:29-99`
- Test: `server/services/suggestions.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `server/services/suggestions.test.js`:

```js
test('caller-supplied score is ignored (not written to feedback.score)', () => {
  const res = upsertStudentSuggestion(db, {
    assignmentId: ASSIGN, student: STUDENT, rubric_scores: { [TOPIC]: 'ED' }, score: 92,
  });
  expect(res.status).toBe('written');
  const row = db.prepare('SELECT score FROM feedback WHERE id = ?').get(res.feedback_id);
  expect(row.score).toBeNull();
});

test('numeric rubric_scores value is rejected with an instructive message', () => {
  const res = upsertStudentSuggestion(db, {
    assignmentId: ASSIGN, student: STUDENT, rubric_scores: { [TOPIC]: '75' },
  });
  expect(res.message).toMatch(/emit proficiency levels/i);
  const row = db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(res.feedback_id);
  expect(JSON.parse(row.feedback_json).rubric_scores).toEqual({});
});
```

(Use the suite's existing seed for `ASSIGN`/`STUDENT`/`TOPIC`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/services/suggestions.test.js`
Expected: FAIL — `score` is written; message lacks the phrase.

- [ ] **Step 3: Implement**

In `server/services/suggestions.js` `upsertStudentSuggestion`:
- Remove `score` from the destructured params; the INSERT/UPDATE pass `null` for the score column (replace `score ?? null` with `null` in both the UPDATE and INSERT).
- In the rubric_scores loop, distinguish numeric values for a sharper message:

```js
const numericLevels = [];
for (const [key, rawLevel] of Object.entries(rubric_scores || {})) {
  if (!byKey.has(String(key).toLowerCase())) { unresolvedTopics.push(key); continue; }
  const code = normalizeLevel(rawLevel);
  if (!code) {
    if (/^\s*\d+(\.\d+)?\s*$/.test(String(rawLevel))) numericLevels.push(key);
    else invalidLevels[key] = rawLevel;
    continue;
  }
  storedScores[key] = code;
}
```

- After the write, assemble the message:

```js
const notes = [];
if (numericLevels.length) notes.push(`Ignored numeric value(s) for ${numericLevels.join(', ')} — emit proficiency levels; Prism owns the points conversion.`);
if (Object.keys(invalidLevels).length) notes.push(`Ignored out-of-vocabulary levels: ${JSON.stringify(invalidLevels)}`);
if (notes.length) result.message = notes.join(' ');
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/services/suggestions.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/suggestions.js
git commit -m "feat(suggestions): ignore caller score; reject numeric levels with guidance"
```

---

## Phase 4 — Close the read leak

### Task 9: get_assignment_context exposes `level`, not bare `points`

**Files:**
- Modify: `server/services/assessmentContext.js:138`
- Test: `server/services/assessmentContext.test.js` (create if absent)

- [ ] **Step 1: Write the failing test**

Add (or create the file with) a test driving `getAssessmentContext` against the seeded db:

```js
import { getAssessmentContext } from './assessmentContext.js';

test('current_scores exposes level only — no bare points', () => {
  const ctx = getAssessmentContext(db, { assignmentId: ASSIGN });
  const scored = ctx.students.find((s) => Object.keys(s.current_scores).length);
  const entry = Object.values(scored.current_scores)[0];
  expect(entry).toHaveProperty('level');
  expect(entry).not.toHaveProperty('points');
  expect(entry).not.toHaveProperty('grade');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/services/assessmentContext.test.js`
Expected: FAIL — entry has `points`/`grade`.

- [ ] **Step 3: Project to level-only in the student mapping**

In `server/services/assessmentContext.js`, replace `current_scores: scoreMap[st.schoology_uid] || {},` (line 138) with a level-only projection (leave `getScoreMap` untouched — the Express grid still needs points):

```js
current_scores: Object.fromEntries(
  Object.entries(scoreMap[st.schoology_uid] || {}).map(([topicId, sc]) => [topicId, { level: sc.grade }])
),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/services/assessmentContext.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/assessmentContext.js server/services/assessmentContext.test.js
git commit -m "feat(mcp): get_assignment_context returns level, not bare points"
```

---

## Phase 5 — Schoology override path via SSOT

### Task 10: Override route accepts a level, derives grade_scaled

**Files:**
- Modify: `server/routes/mastery.js:263-281`
- Test: `server/routes/mastery.test.js`

- [ ] **Step 1: Write the failing test**

Add to `server/routes/mastery.test.js` (mirroring the existing override-route test; stub `writeMasteryOverride` as that suite already does):

```js
test('override route maps a level to grade_scaled', async () => {
  const res = await request(app)
    .post(`/api/mastery/${COURSE}/override`)
    .send({ studentUid: UID, objectiveId: OBJ, level: 'EX' });
  expect(res.status).toBe(200);
  expect(writeMasteryOverrideMock).toHaveBeenCalledWith(
    expect.objectContaining({ gradeScaled: '62.50' })
  );
});

test('override route rejects an out-of-scale value', async () => {
  const res = await request(app)
    .post(`/api/mastery/${COURSE}/override`)
    .send({ studentUid: UID, objectiveId: OBJ, gradeScaled: '50.00' });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/routes/mastery.test.js`
Expected: FAIL — route doesn't accept `level`.

- [ ] **Step 3: Implement the derivation**

In `server/routes/mastery.js`, import the SSOT and rewrite the override handler's input handling:

```js
import { levelToGradeScaled, gradeScaledValues } from '../lib/proficiencyScale.js';
// ...
const { studentUid, objectiveId, level, gradeScaled: rawScaled } = req.body;
if (!studentUid || !objectiveId) {
  return res.status(400).json({ error: 'studentUid and objectiveId are required' });
}
// Prefer a level (Prism owns the conversion); accept a raw gradeScaled transitionally.
let gradeScaled = level != null ? levelToGradeScaled(level)
  : (rawScaled != null ? String(rawScaled) : null);
const valid = gradeScaledValues();
if (gradeScaled != null && !valid.has(gradeScaled)) {
  return res.status(400).json({ error: `Unknown level/grade — expected one of ${[...valid].join(', ')} or a level code` });
}
```

Pass `gradeScaled` into `writeMasteryOverride` as before.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/routes/mastery.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/mastery.js
git commit -m "feat(mastery): override route accepts a level, derives grade_scaled via SSOT"
```

---

## Phase 6 — Server→client sharing

### Task 11: `GET /api/proficiency-scale` endpoint

**Files:**
- Modify: `server/index.js:54-58`
- Test: `server/index.test.js` or a small route test (match how `/api/grading-scales` is tested, if at all; otherwise a focused supertest)

- [ ] **Step 1: Write the failing test**

```js
test('GET /api/proficiency-scale returns the scale table + scaleId', async () => {
  const res = await request(app).get('/api/proficiency-scale');
  expect(res.status).toBe(200);
  expect(res.body.schoologyScaleId).toBe(21337256);
  expect(res.body.levels.map((l) => l.code)).toEqual(['ED', 'EX', 'D', 'EM', 'IE']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/index.test.js`
Expected: FAIL — 404.

- [ ] **Step 3: Add the endpoint**

In `server/index.js`, beside the `/api/grading-scales` handler:

```js
import { getScaleTable, schoologyScaleId } from './lib/proficiencyScale.js';
// ...
app.get('/api/proficiency-scale', (req, res) => {
  res.json({ levels: getScaleTable(), schoologyScaleId: schoologyScaleId() });
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/index.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/index.test.js
git commit -m "feat(api): GET /api/proficiency-scale"
```

---

### Task 12: Client api + `useProficiencyScale` hook

**Files:**
- Modify: `client/src/services/api.js`
- Create: `client/src/hooks/useProficiencyScale.js`
- Test: `client/src/hooks/useProficiencyScale.test.js`

- [ ] **Step 1: Write the failing test**

Create `client/src/hooks/useProficiencyScale.test.js` (mirror `useFeatureFlags`/`useImportRunner` test style; mock `getProficiencyScale`):

```js
import { renderHook, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { useProficiencyScale } from './useProficiencyScale.js';
import * as api from '../services/api.js';

test('loads and binds the scale', async () => {
  vi.spyOn(api, 'getProficiencyScale').mockResolvedValue({
    schoologyScaleId: 21337256,
    levels: [
      { code: 'ED', label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' },
      { code: 'EX', label: 'Exhibiting', points: 75, gradeScaled: '62.50' },
      { code: 'IE', label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' },
    ],
  });
  const { result } = renderHook(() => useProficiencyScale());
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.pointsToLevel(80)).toBe('EX');
  expect(result.current.levelToPoints('EX')).toBe(75);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/hooks/useProficiencyScale.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement api + hook**

In `client/src/services/api.js` add:

```js
export const getProficiencyScale = () => request('/proficiency-scale');
```

Create `client/src/hooks/useProficiencyScale.js`:

```js
import { useState, useEffect } from 'react';
import { getProficiencyScale } from '../services/api.js';
import { makeScaleHelpers } from '../lib/masteryLevels.js';

// Fetches the config-derived proficiency scale and returns helpers bound to it.
// Until loaded, `ready` is false and helpers return null — components guard on `ready`.
export function useProficiencyScale() {
  const [scale, setScale] = useState(null);
  useEffect(() => {
    getProficiencyScale().then(setScale).catch(console.error);
  }, []);
  return { ready: !!scale, ...makeScaleHelpers(scale?.levels || []), schoologyScaleId: scale?.schoologyScaleId };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && npx vitest run src/hooks/useProficiencyScale.test.js`
Expected: PASS (depends on Task 13's `makeScaleHelpers` — implement that first if running standalone, or co-commit).

- [ ] **Step 5: Commit**

```bash
git add client/src/services/api.js client/src/hooks/useProficiencyScale.js client/src/hooks/useProficiencyScale.test.js
git commit -m "feat(client): getProficiencyScale + useProficiencyScale hook"
```

---

### Task 13: Extend `masteryLevels.js` with helpers + canonical colors

**Files:**
- Modify: `client/src/lib/masteryLevels.js`
- Test: `client/src/lib/masteryLevels.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/masteryLevels.test.js`:

```js
import { makeScaleHelpers, LEVELS, LEVEL_COLORS, LEVEL_LABELS, masteryCodeForLevel } from './masteryLevels.js';

const TABLE = [
  { code: 'ED', label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' },
  { code: 'EX', label: 'Exhibiting', points: 75, gradeScaled: '62.50' },
  { code: 'D', label: 'Developing', points: 50, gradeScaled: '37.50' },
  { code: 'EM', label: 'Emerging', points: 25, gradeScaled: '12.50' },
  { code: 'IE', label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' },
];

test('static exports', () => {
  expect(LEVELS).toEqual(['ED', 'EX', 'D', 'EM', 'IE']);
  expect(LEVEL_COLORS.ED.headerFill).toBe('#bfdbfe');
  expect(LEVEL_LABELS.EX).toBe('Exhibiting');
  expect(masteryCodeForLevel('Exhibiting')).toBe('EX');
});

test('makeScaleHelpers binds the table', () => {
  const h = makeScaleHelpers(TABLE);
  expect(h.pointsToLevel(80)).toBe('EX');
  expect(h.pointsToLevel(12.49)).toBe('IE');
  expect(h.levelToPoints('EX')).toBe(75);
  expect(h.levelToGradeScaled('EX')).toBe('62.50');
  expect(h.computeLetterGrade(['ED', 'ED'])).toBe('A');
});

test('client LEVEL_LABELS matches the canonical labels (drift guard)', () => {
  expect(TABLE.map((l) => LEVEL_LABELS[l.code])).toEqual(TABLE.map((l) => l.label));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/lib/masteryLevels.test.js`
Expected: FAIL — exports missing.

- [ ] **Step 3: Extend the module**

Add to `client/src/lib/masteryLevels.js` (keep the existing `FULL_TO_CODE` / `masteryCodeForLevel`):

```js
export const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];

export const LEVEL_LABELS = {
  ED: 'Exhibiting Depth', EX: 'Exhibiting', D: 'Developing', EM: 'Emerging', IE: 'Insufficient Evidence',
};

// Canonical 5-level palette — sourced from AssessmentSummaryPage (see
// docs/design-language.md "Level headers"). All level-colored UI imports this.
export const CELL_TEXT = '#1a1a1a';
export const LEVEL_COLORS = {
  ED: { headerFill: '#bfdbfe', draftFill: '#eff6ff', finalBorder: '#2563eb', draftBorder: '#93c5fd' },
  EX: { headerFill: '#bbf7d0', draftFill: '#f0fdf4', finalBorder: '#16a34a', draftBorder: '#86efac' },
  D:  { headerFill: '#fef08a', draftFill: '#fefce8', finalBorder: '#ca8a04', draftBorder: '#fcd34d' },
  EM: { headerFill: '#fed7aa', draftFill: '#fff7ed', finalBorder: '#ea580c', draftBorder: '#fdba74' },
  IE: { headerFill: '#fecaca', draftFill: '#fef2f2', finalBorder: '#dc2626', draftBorder: '#fca5a5' },
};

const LEVEL_POINTS_FOR_LETTER = { ED: 100, EX: 75, D: 50, EM: 25, IE: 0 };

// Returns numeric helpers bound to a fetched scale table (ordered ED→IE).
export function makeScaleHelpers(levels) {
  const byCode = Object.fromEntries(levels.map((l) => [l.code, l]));
  return {
    table: levels,
    pointsToLevel(n) {
      if (n == null) return null;
      for (const l of levels) if (n >= Number(l.gradeScaled)) return l.code;
      return levels.length ? levels[levels.length - 1].code : null;
    },
    levelToPoints: (code) => byCode[code]?.points ?? null,
    levelToGradeScaled: (code) => byCode[code]?.gradeScaled ?? null,
    levelLabel: (code) => byCode[code]?.label ?? LEVEL_LABELS[code] ?? null,
    computeLetterGrade: (categoryLevels) => computeLetterGrade(categoryLevels),
  };
}

// Approximate HKIS letter grade from per-category levels. Moved verbatim from
// MasteryPerformanceSummary (single home now). See the letter-grade popup for
// the authoritative combination table.
export function computeLetterGrade(categoryLevels) {
  if (!categoryLevels.length || categoryLevels.some((l) => l == null)) return null;
  if (categoryLevels.includes('IE')) return 'F';
  const n = categoryLevels.length;
  const pts = categoryLevels.map((l) => LEVEL_POINTS_FOR_LETTER[l] || 0);
  const avg = pts.reduce((a, b) => a + b, 0) / n;
  if (n === 2) {
    const sorted = [...categoryLevels].sort().join('+');
    return ({
      'ED+ED': 'A', 'ED+EX': 'A-', 'EX+EX': 'B+', 'D+ED': 'B+',
      'D+EX': 'B', 'ED+EM': 'B', 'D+D': 'B-', 'EM+EX': 'B-',
      'D+EM': 'C+', 'EM+EM': 'C',
    })[sorted] || 'D';
  }
  const scaled = avg / 25;
  if (scaled >= 3.75) return 'A';
  if (scaled >= 3.25) return 'A-';
  if (scaled >= 2.83) return 'B+';
  if (scaled >= 2.33) return 'B';
  if (scaled >= 2.0) return 'B-';
  if (scaled >= 1.75) return 'C+';
  if (scaled >= 1.25) return 'C';
  if (scaled >= 1.0) return 'D';
  return 'F';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && npx vitest run src/lib/masteryLevels.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/masteryLevels.js client/src/lib/masteryLevels.test.js
git commit -m "feat(client): masteryLevels SSOT — helpers + canonical LEVEL_COLORS"
```

---

## Phase 7 — Repoint client consumers, delete duplicates, unify colors

> For each task: run the page's existing tests first (baseline green), refactor, re-run (green). The visual color shift to the canonical palette is intended (spec §9).

### Task 14: MasteryPerformanceSummary uses the shared lib

**Files:**
- Modify: `client/src/components/MasteryPerformanceSummary.jsx:8-91`
- Test: existing client tests touching this component (stay green)

- [ ] **Step 1: Baseline green**

Run: `cd client && npx vitest run src/pages/CoursePage.test.jsx`
Expected: PASS.

- [ ] **Step 2: Refactor**

In `MasteryPerformanceSummary.jsx`:
- Delete local `LEVELS`, `LEVEL_LABELS`, `LEVEL_POINTS`, `LEVEL_COLORS`, `pointsToLevel`, and `computeLetterGrade`.
- Keep `LetterGradePopup`, `LETTER_GRADE_COLORS`, `modeOf`, `average`, `sentenceCase`.
- Import: `import { LEVELS, LEVEL_LABELS, LEVEL_COLORS, computeLetterGrade } from '../lib/masteryLevels.js';` and re-export `computeLetterGrade` (CoursePage imports it from here today): `export { computeLetterGrade };`
- Get the scale: `const scale = useProficiencyScale();` and replace `pointsToLevel(x)` calls with `scale.pointsToLevel(x)` (guard renders on `scale.ready`).
- Map old color fields: `LEVEL_COLORS[c].bg → .headerFill`, `.text → CELL_TEXT`, `.border → .finalBorder`. Import `CELL_TEXT` too.

- [ ] **Step 3: Re-run (green)**

Run: `cd client && npx vitest run src/pages/CoursePage.test.jsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/MasteryPerformanceSummary.jsx
git commit -m "refactor(client): MasteryPerformanceSummary on masteryLevels SSOT"
```

---

### Task 15: CoursePage uses the shared lib

**Files:**
- Modify: `client/src/pages/CoursePage.jsx:6,18-25,329-378`
- Test: `client/src/pages/CoursePage.test.jsx`

- [ ] **Step 1: Baseline green**

Run: `cd client && npx vitest run src/pages/CoursePage.test.jsx`
Expected: PASS.

- [ ] **Step 2: Refactor**

In `CoursePage.jsx`:
- Delete the local `pointsToLevel` (lines 18-25).
- Change the MasteryPerformanceSummary import to keep `LetterGradePopup, LETTER_GRADE_COLORS` from it, and import `computeLetterGrade` from `'../lib/masteryLevels.js'` instead.
- Add `const scale = useProficiencyScale();` (import the hook) and replace `pointsToLevel(...)` with `scale.pointsToLevel(...)`; guard the mastery view on `scale.ready`.

- [ ] **Step 3: Re-run (green)**

Run: `cd client && npx vitest run src/pages/CoursePage.test.jsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/CoursePage.jsx
git commit -m "refactor(client): CoursePage on masteryLevels SSOT"
```

---

### Task 16: AssessmentSummaryPage uses the shared lib (incl. /observations write)

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx:11-34,354-376`
- Test: existing AssessmentSummaryPage tests (stay green)

- [ ] **Step 1: Baseline green**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS (or note no such test; rely on the page's component tests).

- [ ] **Step 2: Refactor**

In `AssessmentSummaryPage.jsx`:
- Delete local `LEVELS`, `LEVEL_LABELS`, `LEVEL_POINTS`, `LEVEL_COLORS`, `CELL_TEXT`.
- Import: `import { LEVELS, LEVEL_LABELS, LEVEL_COLORS, CELL_TEXT } from '../lib/masteryLevels.js';` and `import { useProficiencyScale } from '../hooks/useProficiencyScale.js';`
- `const scale = useProficiencyScale();` then in `buildGradeInfo` and `buildSavedScores` replace `LEVEL_POINTS[level]` with `scale.levelToPoints(level)` and `gradingScaleId: 21337256` with `gradingScaleId: scale.schoologyScaleId`. Guard the save controls on `scale.ready`.

- [ ] **Step 3: Re-run (green)**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx
git commit -m "refactor(client): AssessmentSummaryPage on SSOT (points + scaleId)"
```

---

### Task 17: OverridePopup sends a level; drop SCALED_FOR_LEVEL + local colors

**Files:**
- Modify: `client/src/components/OverridePopup.jsx:3-12,31-34`
- Test: existing OverridePopup tests (stay green)

- [ ] **Step 1: Baseline green**

Run: `cd client && npx vitest run src/components/OverridePopup.test.jsx`
Expected: PASS (or rely on StudentPage/CoursePage tests if none).

- [ ] **Step 2: Refactor**

In `OverridePopup.jsx`:
- Delete local `LEVELS`, `LEVEL_LABELS`, `LEVEL_COLORS`, `SCALED_FOR_LEVEL`.
- Import: `import { LEVELS, LEVEL_LABELS, LEVEL_COLORS, CELL_TEXT } from '../lib/masteryLevels.js';`
- In `save(...)`, send the level (the route now derives grade_scaled): call `writeMasteryOverride(courseId, { studentUid, objectiveId, level })` instead of passing `gradeScaled`. Update the `writeMasteryOverride` api wrapper if it names the field.
- Map old color fields (`bg→headerFill`, `text→CELL_TEXT`, `border→finalBorder`).

- [ ] **Step 3: Re-run (green)**

Run: `cd client && npx vitest run src/components/OverridePopup.test.jsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/OverridePopup.jsx client/src/services/api.js
git commit -m "refactor(client): OverridePopup emits level; colors from SSOT"
```

---

### Task 18: StudentPage imports colors from the SSOT

**Files:**
- Modify: `client/src/pages/StudentPage.jsx:10,170`
- Test: `client/src/pages/StudentPage.test.jsx` (if present; else CoursePage suite)

- [ ] **Step 1: Baseline green**

Run: `cd client && npx vitest run src/pages/StudentPage.test.jsx`
Expected: PASS (or skip if absent).

- [ ] **Step 2: Refactor**

In `StudentPage.jsx`:
- Change `import { LEVEL_COLORS } from '../components/OverridePopup.jsx';` to `import { LEVEL_COLORS, CELL_TEXT } from '../lib/masteryLevels.js';`
- At the usage (line ~170) map the old `{bg,text,border}` style object to the new palette (`headerFill` background, `CELL_TEXT` text, `finalBorder` border).

- [ ] **Step 3: Re-run (green)**

Run: `cd client && npx vitest run src/pages/StudentPage.test.jsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/StudentPage.jsx
git commit -m "refactor(client): StudentPage level colors from SSOT"
```

---

### Task 19: Rubric components use shared LEVELS/labels

**Files:**
- Modify: `client/src/components/CompactRubric.jsx:3`, `client/src/components/RubricDescriptorGrid.jsx:4`
- Test: existing rubric component tests (stay green)

- [ ] **Step 1: Baseline green**

Run: `cd client && npx vitest run src/components/RubricDescriptorGrid.test.jsx`
Expected: PASS.

- [ ] **Step 2: Refactor**

- `CompactRubric.jsx`: delete local `const LEVELS = [...]`; `import { LEVELS } from '../lib/masteryLevels.js';`
- `RubricDescriptorGrid.jsx`: delete local `LEVEL_LABELS`; `import { LEVEL_LABELS } from '../lib/masteryLevels.js';`
- `client/src/components/RubricDescriptorGrid.test.jsx:10` may keep its own local `LEVELS` (test fixture) — leave it.

- [ ] **Step 3: Re-run (green)**

Run: `cd client && npx vitest run src/components/RubricDescriptorGrid.test.jsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/CompactRubric.jsx client/src/components/RubricDescriptorGrid.jsx
git commit -m "refactor(client): rubric components on LEVELS/LABELS SSOT"
```

---

### Task 20: Full-suite gate (no drift left)

**Files:** none (verification only)

- [ ] **Step 1: Grep for any remaining hardcoded copies**

Run:
```bash
grep -rn "21337256" client/src server mcp --include=*.js --include=*.jsx | grep -v "featureGate.js\|proficiencyScale\|\.test\."
grep -rn "POINTS_TO_GRADE\|SCALED_FOR_LEVEL\|const LEVEL_POINTS\|const LEVEL_COLORS" client/src server mcp
```
Expected: no production hits (only the SSOT module / config / tests).

- [ ] **Step 2: Run both full suites**

Run: `npx vitest run` (repo root) and `cd client && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit (if grep prompted any cleanup)**

```bash
git commit -am "chore: remove last hardcoded proficiency-scale copies" || echo "nothing to clean"
```

---

## Phase 8 — Documentation

### Task 21: ADR, CONTEXT, design-language, README, product-spec, dovetail

**Files:**
- Create: `docs/adr/0001-prism-owns-proficiency-gradebook-mapping.md`
- Modify: `CONTEXT.md` (ubiquitous-language section), `docs/design-language.md` ("Level headers" + "Source of truth"), `README.md`, `product-spec.md:50-70`, `docs/superpowers/specs/2026-06-06-prismcp-server.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0001-prism-owns-proficiency-gradebook-mapping.md`:

```markdown
# ADR 0001: Prism owns the proficiency↔gradebook-score mapping

**Status:** Accepted (2026-06-09)

## Context
Grading callers (the assessment-grader plugin) emit proficiency levels
(ED/EX/D/EM/IE) only. A real run reverse-engineered the level→points scale from
bare numbers Prism exposed. Three numeric encodings exist for the same levels:
per-assignment `points` (0–100), Schoology rollup/override `grade_scaled`
(0–87.5), and the banding cutoffs (= the grade_scaled values).

## Decision
The numeric mapping is owned by Prism, configured once in
`config.yaml` (`grading.proficiencyScale`) and derived through
`server/lib/proficiencyScale.js` (server) and `client/src/lib/masteryLevels.js`
(client, via `GET /api/proficiency-scale`). The MCP write contract is
levels-only: `write_student_suggestions` rejects caller numbers;
`get_assignment_context` returns `level`, never bare `points`.

## Consequences
- Schools re-weight by editing config, not code.
- Callers and teachers never see or infer a gradebook number.
- All former hardcoded copies were consolidated onto the SSOT.
```

- [ ] **Step 2: Update CONTEXT.md**

Under "Ubiquitous language", add a "Proficiency levels" subsection listing the five
levels + codes and the sentence: *"Callers emit levels; teachers review/publish in
levels; the gradebook number is derived downstream by Prism and is never a caller
or teacher input."*

- [ ] **Step 3: Update design-language.md**

Extend the "Level headers — full wording, colour-coded" entry (and the "Source of
truth" section) to record: the canonical 5-level palette (`LEVEL_COLORS` +
`CELL_TEXT`) now lives in `client/src/lib/masteryLevels.js`, sourced from
AssessmentSummaryPage; all level-colored UI imports it. Note the deferred
migration to CSS custom properties per the theming rule.

- [ ] **Step 4: Update README.md + product-spec.md + dovetail spec**

- README standards-based-grading note: add the levels-only contract sentence.
- `product-spec.md:50-70`: change `rubric_scores: { criterion_name: "number" }` to
  `{ criterion_name: "<level code|name>" }` and note Prism derives the number.
- `docs/superpowers/specs/2026-06-06-prismcp-server.md`: update the
  `get_assignment_context` (`current_scores: { topic_id: { level } }`) and
  `write_student_suggestions` (no `score`) shapes.

- [ ] **Step 5: Commit**

```bash
git add docs/adr CONTEXT.md docs/design-language.md README.md product-spec.md docs/superpowers/specs/2026-06-06-prismcp-server.md
git commit -m "docs: record levels-only contract + proficiency-scale SSOT (ADR, CONTEXT, design-language)"
```

---

## Self-review notes (author)

- **Spec coverage:** §1–3 → Tasks 7–9 (contract); §4 → Tasks 1–2, 11–13; §5 drift
  inventory → Tasks 4–6, 14–19 (+ Task 20 gate); §6 → Tasks 7–8; §7 → Task 9; §8 →
  Tasks 10, 16; §9 colors → Tasks 13–18; §10 docs → Task 21; §11 tests → embedded
  per task + Task 3 parity. All sections covered.
- **Ordering:** SSOT + parity (Phase 1) lands before any deletion, so every later
  refactor is guarded by green tests. Client helper (Task 13) lands before its
  consumers (14–19) and is co-required by the hook (Task 12).
- **Type/name consistency:** `pointsToLevel`, `levelToPoints`, `levelToGradeScaled`,
  `levelToLabel`, `gradeScaledValues`, `schoologyScaleId`, `getScaleTable`,
  `normalizeLevel`, `makeScaleHelpers`, `LEVEL_COLORS`, `CELL_TEXT` used identically
  across server module, client lib, and consumers.
```
