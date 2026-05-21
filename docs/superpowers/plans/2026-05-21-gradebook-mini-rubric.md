# Gradebook Mini Rubric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the numeric score in each aligned-summative gradebook cell with a color-coded segmented strip of the student's per-measurement-topic proficiency, clickable to open a modal showing the full rubric + comment.

**Architecture:** Reuse the course mastery data CoursePage already fetches (`GET /api/mastery/:courseId`), extended to also return `alignments`. A pure client lib turns that payload into per-cell rubric data. `GradebookView` renders a `MiniRubricStrip` in aligned cells and a `RubricModal` (reusing the shared `CompactRubric` component) on click.

**Tech Stack:** Node/Express + better-sqlite3 backend, React 18 + Vite frontend, Vitest for tests. ESM throughout.

Spec: `docs/superpowers/specs/2026-05-21-gradebook-mini-rubric-design.md`.

---

### Task 1: Add `alignments` to the course mastery API

The `GET /api/mastery/:courseId` route returns `{ categories, topics, scores, rollups }`. Add an `alignments` array (assignment→topic pairs with topic/category metadata) so the client knows the full aligned-topic set for each assignment, including topics no student has been scored on yet.

**Files:**
- Modify: `server/routes/mastery.js` — the `router.get('/:courseId', ...)` handler (currently around lines 66-81)
- Test: `server/routes/mastery.test.js` — add a new `describe` block at the end of the file

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `server/routes/mastery.test.js` (after the last block, before end of file):

```js
describe('GET /api/mastery/:courseId — alignments (#32)', () => {
  let courseId;

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM mastery_alignments; DELETE FROM mastery_scores; ' +
      'DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
      'DELETE FROM assignments; DELETE FROM courses;'
    );
    getMasteryForCourse.mockReturnValue({ categories: [], topics: [], scores: [] });
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-32', 'Course')`
    ).run().lastInsertRowid;
    db.prepare(
      `INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'RC.1', 'Creating')`
    ).run(courseId);
    db.prepare(
      `INSERT INTO measurement_topics (id, category_id, course_id, external_id, title)
       VALUES ('topic-1', 'cat-1', ?, 'RC.1.1', 'Generates media')`
    ).run(courseId);
    db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'sa-1', 'Project', 1)`
    ).run(courseId);
  });

  test('returns an empty alignments array when none exist', async () => {
    const { status, body } = await get(`/api/mastery/${courseId}`);
    expect(status).toBe(200);
    expect(body.alignments).toEqual([]);
  });

  test('returns alignment rows with topic and category metadata', async () => {
    getDb().prepare(
      `INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id)
       VALUES ('sa-1', 'topic-1', ?)`
    ).run(courseId);
    const { body } = await get(`/api/mastery/${courseId}`);
    expect(body.alignments).toEqual([{
      assignment_schoology_id: 'sa-1',
      topic_id: 'topic-1',
      topic_title: 'Generates media',
      topic_external_id: 'RC.1.1',
      category_id: 'cat-1',
      category_title: 'Creating',
      category_external_id: 'RC.1',
    }]);
  });

  test('excludes alignments for unpublished assignments', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'sa-2', 'Draft', 0)`
    ).run(courseId);
    db.prepare(
      `INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-2', 'topic-1', ?)`
    ).run(courseId);
    const { body } = await get(`/api/mastery/${courseId}`);
    expect(body.alignments).toEqual([]);
  });
});
```

Also add this import near the top of `server/routes/mastery.test.js`, directly below the existing `import { getDb } from '../db/index.js';` line:

```js
import { getMasteryForCourse } from '../services/masterySync.js';
```

(`getMasteryForCourse` is already mocked by the existing `vi.mock('../services/masterySync.js', ...)` factory — this import binds the mock fn so the test can set its return value.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/routes/mastery.test.js -t "alignments"`
Expected: FAIL — `body.alignments` is `undefined` (route does not return the field yet).

- [ ] **Step 3: Add the alignments query to the route**

In `server/routes/mastery.js`, replace the existing `GET /:courseId` handler:

```js
// GET /api/mastery/:courseId — all mastery data for a course (from local DB)
router.get('/:courseId', (req, res) => {
  const { courseId } = req.params;
  try {
    const data = getMasteryForCourse(courseId);
    const db = getDb();
    const rollups = db.prepare(`
      SELECT student_uid, objective_id, is_category, grade_percentage, grade_scaled_rounded, override_value
      FROM mastery_rollups
      WHERE course_id = ?
    `).all(courseId);
    res.json({ ...data, rollups });
  } catch (err) {
    console.error('[mastery] Error fetching mastery data:', err);
    res.status(500).json({ error: err.message });
  }
});
```

with:

```js
// GET /api/mastery/:courseId — all mastery data for a course (from local DB)
router.get('/:courseId', (req, res) => {
  const { courseId } = req.params;
  try {
    const data = getMasteryForCourse(courseId);
    const db = getDb();
    const rollups = db.prepare(`
      SELECT student_uid, objective_id, is_category, grade_percentage, grade_scaled_rounded, override_value
      FROM mastery_rollups
      WHERE course_id = ?
    `).all(courseId);
    // Authoritative assignment↔topic alignments, with topic/category metadata
    // so the gradebook can render a mini rubric per cell (#32). Published
    // assignments only — mirrors every other mastery query.
    const alignments = db.prepare(`
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
    `).all(courseId);
    res.json({ ...data, rollups, alignments });
  } catch (err) {
    console.error('[mastery] Error fetching mastery data:', err);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/routes/mastery.test.js`
Expected: PASS — all blocks in the file, including the 3 new alignments tests.

- [ ] **Step 5: Commit**

```bash
git add server/routes/mastery.js server/routes/mastery.test.js
git commit -m "$(cat <<'EOF'
feat(#32): return assignment alignments from course mastery API

GET /api/mastery/:courseId now includes an `alignments` array (assignment
to measurement-topic, with topic + category metadata) so the gradebook
can render a per-cell mini rubric covering every aligned topic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Client lib — `gradebookMastery.js`

Two pure functions that turn the `/api/mastery/:courseId` payload into per-cell rubric data. All real logic lives here so it can be unit-tested; the React components are dumb renderers.

**Files:**
- Create: `client/src/lib/gradebookMastery.js`
- Test: `client/src/lib/gradebookMastery.test.js`

- [ ] **Step 1: Write the failing tests**

Create `client/src/lib/gradebookMastery.test.js`:

```js
import { describe, test, expect } from 'vitest';
import { indexMastery, buildAssignmentRubric } from './gradebookMastery.js';

// A course-mastery payload shaped like GET /api/mastery/:courseId returns.
const mastery = {
  categories: [
    { id: 'cat-1', external_id: 'RC.1', title: 'Creating' },
    { id: 'cat-2', external_id: 'RC.2', title: 'Responding' },
  ],
  topics: [
    { id: 't1', category_id: 'cat-1', external_id: 'RC.1.1', title: 'Generates media' },
    { id: 't2', category_id: 'cat-1', external_id: 'RC.1.2', title: 'Refines work' },
    { id: 't3', category_id: 'cat-2', external_id: 'RC.2.1', title: 'Evaluates ethics' },
  ],
  alignments: [
    { assignment_schoology_id: 'sa-1', topic_id: 't2', topic_title: 'Refines work',
      topic_external_id: 'RC.1.2', category_id: 'cat-1', category_title: 'Creating',
      category_external_id: 'RC.1' },
    { assignment_schoology_id: 'sa-1', topic_id: 't1', topic_title: 'Generates media',
      topic_external_id: 'RC.1.1', category_id: 'cat-1', category_title: 'Creating',
      category_external_id: 'RC.1' },
    { assignment_schoology_id: 'sa-1', topic_id: 't3', topic_title: 'Evaluates ethics',
      topic_external_id: 'RC.2.1', category_id: 'cat-2', category_title: 'Responding',
      category_external_id: 'RC.2' },
  ],
  scores: [
    { student_uid: 'uid-1', assignment_schoology_id: 'sa-1', topic_id: 't1', points: 100, grade: 'ED' },
    { student_uid: 'uid-1', assignment_schoology_id: 'sa-1', topic_id: 't2', points: 75, grade: 'EX' },
    // uid-1 has no score on t3 for sa-1.
  ],
};

describe('indexMastery', () => {
  test('topicsByAssignment lists aligned topics ordered by category then topic external_id', () => {
    const idx = indexMastery(mastery);
    expect(idx.topicsByAssignment['sa-1']).toEqual(['t1', 't2', 't3']);
  });

  test('topicMeta carries title, external_id and category_title per topic', () => {
    const idx = indexMastery(mastery);
    expect(idx.topicMeta['t3']).toMatchObject({
      title: 'Evaluates ethics', external_id: 'RC.2.1', category_title: 'Responding',
    });
  });

  test('gradeLookup maps student → assignment → topic → grade', () => {
    const idx = indexMastery(mastery);
    expect(idx.gradeLookup['uid-1']['sa-1']['t1']).toBe('ED');
    expect(idx.gradeLookup['uid-1']['sa-1']['t2']).toBe('EX');
  });

  test('falls back to score-derived topics when an assignment has no alignment rows', () => {
    const noAlign = {
      ...mastery,
      alignments: [],
      scores: [
        { student_uid: 'uid-1', assignment_schoology_id: 'sa-9', topic_id: 't3', points: 50, grade: 'D' },
        { student_uid: 'uid-1', assignment_schoology_id: 'sa-9', topic_id: 't1', points: 100, grade: 'ED' },
      ],
    };
    const idx = indexMastery(noAlign);
    expect(idx.topicsByAssignment['sa-9']).toEqual(['t1', 't3']);
  });

  test('handles a null mastery payload without throwing', () => {
    const idx = indexMastery(null);
    expect(idx.topicsByAssignment).toEqual({});
    expect(idx.gradeLookup).toEqual({});
  });
});

describe('buildAssignmentRubric', () => {
  test('returns ordered topics with the student grade, null where ungraded', () => {
    const idx = indexMastery(mastery);
    const rubric = buildAssignmentRubric('sa-1', 'uid-1', idx);
    expect(rubric).toEqual([
      { topic_id: 't1', title: 'Generates media', external_id: 'RC.1.1', category_title: 'Creating', grade: 'ED' },
      { topic_id: 't2', title: 'Refines work',    external_id: 'RC.1.2', category_title: 'Creating', grade: 'EX' },
      { topic_id: 't3', title: 'Evaluates ethics', external_id: 'RC.2.1', category_title: 'Responding', grade: null },
    ]);
  });

  test('a student with no scores gets all-null grades but the full topic list', () => {
    const idx = indexMastery(mastery);
    const rubric = buildAssignmentRubric('sa-1', 'uid-unknown', idx);
    expect(rubric.map(t => t.topic_id)).toEqual(['t1', 't2', 't3']);
    expect(rubric.every(t => t.grade === null)).toBe(true);
  });

  test('an unknown assignment yields an empty list', () => {
    const idx = indexMastery(mastery);
    expect(buildAssignmentRubric('sa-nope', 'uid-1', idx)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && npx vitest run src/lib/gradebookMastery.test.js`
Expected: FAIL — `gradebookMastery.js` does not exist.

- [ ] **Step 3: Implement `gradebookMastery.js`**

Create `client/src/lib/gradebookMastery.js`:

```js
// Turns the GET /api/mastery/:courseId payload into per-cell rubric data for
// the course gradebook (#32). Pure functions — all the logic the dumb React
// renderers depend on lives here and is unit-tested.

// Order topics by category external_id, then topic external_id — the same
// ordering the mastery summary and assessment pages use.
function compareTopicMeta(a, b) {
  const byCat = String(a.category_external_id ?? '').localeCompare(String(b.category_external_id ?? ''));
  if (byCat !== 0) return byCat;
  return String(a.external_id ?? '').localeCompare(String(b.external_id ?? ''));
}

// Build { topicMeta, topicsByAssignment, gradeLookup } from the payload.
export function indexMastery(mastery) {
  const categories = mastery?.categories ?? [];
  const topics = mastery?.topics ?? [];
  const scores = mastery?.scores ?? [];
  const alignments = mastery?.alignments ?? [];

  const categoryById = {};
  for (const c of categories) categoryById[c.id] = c;

  // topicMeta: topic id → display metadata. Seed from `topics` (joined to
  // `categories`), then let `alignments` rows — which carry their own
  // metadata — overwrite as the authoritative source.
  const topicMeta = {};
  for (const t of topics) {
    const cat = categoryById[t.category_id];
    topicMeta[t.id] = {
      title: t.title,
      external_id: t.external_id,
      category_title: cat?.title ?? null,
      category_external_id: cat?.external_id ?? null,
    };
  }
  for (const a of alignments) {
    topicMeta[a.topic_id] = {
      title: a.topic_title,
      external_id: a.topic_external_id,
      category_title: a.category_title ?? null,
      category_external_id: a.category_external_id ?? null,
    };
  }

  // topicsByAssignment: assignment → ordered topic ids. Alignments are
  // authoritative; for an assignment with no alignment rows, fall back to the
  // union of topics that have a score for it.
  const alignedAssignments = new Set(alignments.map(a => a.assignment_schoology_id));
  const topicSetByAssignment = {};
  for (const a of alignments) {
    (topicSetByAssignment[a.assignment_schoology_id] ??= new Set()).add(a.topic_id);
  }
  for (const s of scores) {
    if (alignedAssignments.has(s.assignment_schoology_id)) continue;
    (topicSetByAssignment[s.assignment_schoology_id] ??= new Set()).add(s.topic_id);
  }
  const topicsByAssignment = {};
  for (const [aid, set] of Object.entries(topicSetByAssignment)) {
    topicsByAssignment[aid] = [...set].sort((x, y) =>
      compareTopicMeta(topicMeta[x] ?? {}, topicMeta[y] ?? {})
    );
  }

  // gradeLookup: student uid → assignment → topic → letter grade.
  const gradeLookup = {};
  for (const s of scores) {
    const uid = String(s.student_uid);
    ((gradeLookup[uid] ??= {})[s.assignment_schoology_id] ??= {})[s.topic_id] = s.grade ?? null;
  }

  return { topicMeta, topicsByAssignment, gradeLookup };
}

// Ordered [{ topic_id, title, external_id, category_title, grade }] for one
// (assignment, student) gradebook cell. `grade` is null for ungraded topics.
export function buildAssignmentRubric(assignmentSchoologyId, studentUid, indexed) {
  const topicIds = indexed.topicsByAssignment[assignmentSchoologyId] ?? [];
  const grades = indexed.gradeLookup[String(studentUid)]?.[assignmentSchoologyId] ?? {};
  return topicIds.map(topicId => {
    const meta = indexed.topicMeta[topicId] ?? {};
    return {
      topic_id: topicId,
      title: meta.title ?? '',
      external_id: meta.external_id ?? '',
      category_title: meta.category_title ?? null,
      grade: grades[topicId] ?? null,
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && npx vitest run src/lib/gradebookMastery.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/gradebookMastery.js client/src/lib/gradebookMastery.test.js
git commit -m "$(cat <<'EOF'
feat(#32): gradebookMastery lib — per-cell rubric data

indexMastery() + buildAssignmentRubric() turn the course mastery payload
into ordered per-(assignment, student) topic+grade lists for the gradebook
mini rubric. Pure, unit-tested.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extract `CompactRubric` into a shared component

`CompactRubric` is currently a private function inside `StudentPage.jsx`. Move it to its own file so the new `RubricModal` and the `/student/` page render the exact same component. Pure extraction — no behavior change.

**Files:**
- Create: `client/src/components/CompactRubric.jsx`
- Modify: `client/src/pages/StudentPage.jsx`

- [ ] **Step 1: Create the shared component**

Create `client/src/components/CompactRubric.jsx`:

```jsx
import { LEVEL_COLORS } from './OverridePopup.jsx';

const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];

// Compact rubric shown in place of the score column for aligned assignments.
// One row per measurement topic, one column per level. The student's current
// level is filled solid green (matching the AssessmentSummaryPage rubric).
export default function CompactRubric({ topics }) {
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: '0.7rem', lineHeight: 1.2, width: '100%', tableLayout: 'fixed' }}>
      <thead>
        <tr>
          <th style={{
            padding: '0.2rem 0.45rem', textAlign: 'left',
            background: 'var(--bg-subtle)', border: '1px solid var(--border)',
            fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.65rem',
            width: 'auto',
          }}>Measurement Topic</th>
          {LEVELS.map(l => (
            <th key={l} style={{
              padding: '0.15rem 0.3rem', textAlign: 'center',
              background: LEVEL_COLORS[l].bg, color: LEVEL_COLORS[l].text,
              border: '1px solid var(--border)', fontWeight: 700,
              fontSize: '0.68rem', width: '7%',
            }}>{l}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {topics.map(t => (
          <tr key={t.topic_id}>
            <td style={{
              padding: '0.2rem 0.45rem', border: '1px solid var(--border)',
              fontSize: '0.7rem', color: 'var(--text)',
              whiteSpace: 'normal', wordBreak: 'break-word',
            }}>
              <div style={{ fontWeight: 600 }}>{t.title}</div>
              {(t.external_id || t.category_title) && (
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                  {t.external_id}{t.external_id && t.category_title ? ' · ' : ''}{t.category_title || ''}
                </div>
              )}
            </td>
            {LEVELS.map(l => {
              const isCurrent = t.grade === l;
              const c = LEVEL_COLORS[l];
              return (
                <td key={l} style={{
                  border: `1px solid ${isCurrent ? c.text : 'var(--border)'}`,
                  textAlign: 'center',
                  padding: '0.2rem 0.3rem',
                  background: isCurrent ? c.bg : 'var(--card-bg)',
                  color: isCurrent ? c.text : 'var(--text-muted)',
                  fontWeight: isCurrent ? 700 : 400,
                  fontSize: '0.7rem',
                }}>{isCurrent ? l : ''}</td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Remove the local copy from StudentPage and import the shared one**

In `client/src/pages/StudentPage.jsx`:

1. Delete this line (currently line 12):

```jsx
const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];
```

2. Delete the entire local `CompactRubric` function — the comment block and function spanning (currently) lines 14-73, starting at `// Compact rubric shown in place of the score column` and ending at the `}` that closes `function CompactRubric({ topics }) { ... }`.

3. Add this import alongside the other component imports near the top (e.g. directly below `import MasteryPerformanceSummary from '../components/MasteryPerformanceSummary.jsx';`):

```jsx
import CompactRubric from '../components/CompactRubric.jsx';
```

Leave the existing `import { LEVEL_COLORS } from '../components/OverridePopup.jsx';` line — `LEVEL_COLORS` is still used elsewhere in `StudentPage.jsx`. Leave the `<CompactRubric topics={g.mastery.topics} />` usage unchanged.

- [ ] **Step 3: Verify the StudentPage tests still pass**

Run: `cd client && npx vitest run src/pages/StudentPage.test.jsx`
Expected: PASS — extraction is behavior-preserving.

- [ ] **Step 4: Verify the build compiles**

Run: `cd client && npx vite build`
Expected: builds with no errors (no unresolved import, no unused-binding failure).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/CompactRubric.jsx client/src/pages/StudentPage.jsx
git commit -m "$(cat <<'EOF'
refactor(#32): extract CompactRubric into a shared component

Moves CompactRubric out of StudentPage into its own file so the gradebook
rubric modal and the /student/ page render the same component.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Mini rubric strip + modal in the gradebook

Render a `MiniRubricStrip` in aligned-summative gradebook cells instead of the numeric score, and a `RubricModal` (reusing `CompactRubric`) when a strip is clicked.

**Files:**
- Modify: `client/src/pages/CoursePage.jsx` — imports, the `<GradebookView .../>` render, and the `GradebookView` component (signature, cell logic, return); add two new local components.

- [ ] **Step 1: Update imports and pass `mastery` to GradebookView**

In `client/src/pages/CoursePage.jsx`:

1. Change the React import (currently line 1) from:

```jsx
import { useState, useEffect } from 'react';
```

to:

```jsx
import { useState, useEffect, useMemo } from 'react';
```

2. Add these two imports next to the other lib/component imports near the top of the file (e.g. below `import { groupAssignmentsByFolder } from '../lib/assessmentGroups.js';`):

```jsx
import { indexMastery, buildAssignmentRubric } from '../lib/gradebookMastery.js';
import CompactRubric from '../components/CompactRubric.jsx';
```

3. Find the gradebook render line:

```jsx
      {view === 'gradebook' && <GradebookView data={gradebook} courseId={id} />}
```

and replace it with:

```jsx
      {view === 'gradebook' && <GradebookView data={gradebook} courseId={id} mastery={mastery} />}
```

- [ ] **Step 2: Add the `MiniRubricStrip` and `RubricModal` components**

In `client/src/pages/CoursePage.jsx`, add these two components immediately above the `function GradebookView(` declaration:

```jsx
// ─── Gradebook mini rubric (#32) ─────────────────────────────────────────────

// A segmented strip — one segment per aligned measurement topic, colored by
// the student's earned level. Grey segment = topic not yet scored. Clickable.
function MiniRubricStrip({ topics, onClick }) {
  const summary = topics
    .map(t => `${t.external_id || t.title}: ${t.grade || 'not graded'}`)
    .join('\n');
  return (
    <button
      type="button"
      onClick={onClick}
      title={summary}
      aria-label="Show rubric detail"
      style={{
        display: 'flex', width: 64, height: 16, padding: 0, margin: '0 auto',
        border: '1px solid var(--border)', borderRadius: 3,
        overflow: 'hidden', cursor: 'pointer', background: 'none',
      }}
    >
      {topics.map(t => {
        const c = t.grade ? LEVEL_COLORS[t.grade] : null;
        return (
          <span
            key={t.topic_id}
            style={{ flex: 1, background: c ? c.bg : 'var(--bg-subtle)' }}
          />
        );
      })}
    </button>
  );
}

// Modal opened from a MiniRubricStrip — the full rubric grid (shared
// CompactRubric) plus the overall comment, matching the /student/ page.
function RubricModal({ student, assignment, courseId, topics, comment, onClose }) {
  const name = student.preferred_name_teacher || student.preferred_name || student.first_name;
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--card-bg)', borderRadius: 12,
          maxWidth: 560, width: '100%', maxHeight: '85vh', overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          padding: '0.85rem 1.1rem', borderBottom: '1px solid var(--border)',
        }}>
          <div>
            <div style={{ fontWeight: 700 }}>{name} {student.last_name}</div>
            <div className="text-sm text-muted" style={{ marginTop: 2 }}>
              {assignment.title}
              <span className="badge badge-summative" style={{ fontSize: '0.6rem', marginLeft: 6 }}>S</span>
            </div>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: '1rem 1.1rem' }}>
          <CompactRubric topics={topics} />
          {comment && (
            <div
              className="text-sm"
              style={{
                marginTop: '0.85rem', background: 'var(--bg-subtle)',
                border: '1px solid var(--border)', borderRadius: 8,
                padding: '0.6rem 0.75rem',
              }}
            >
              <span style={{ fontWeight: 700, marginRight: 5 }}>Comment:</span>{comment}
            </div>
          )}
        </div>
        <div style={{ padding: '0 1.1rem 1rem' }}>
          <Link
            to={`/course/${courseId}/assessment/${assignment.schoology_assignment_id}`}
            className="link"
            style={{ fontSize: '0.8rem' }}
          >
            Open full grading page →
          </Link>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update the `GradebookView` signature and add state**

In `client/src/pages/CoursePage.jsx`, change the `GradebookView` declaration from:

```jsx
function GradebookView({ data, courseId }) {
  if (!data || !data.assignments.length) {
    return <div className="card"><p className="text-muted">No assignments yet.</p></div>;
  }

  const { assignments, students, grades, grading_scales } = data;
  const displayName = (s) => s.preferred_name_teacher || s.preferred_name || s.first_name;
```

to:

```jsx
function GradebookView({ data, courseId, mastery }) {
  const indexed = useMemo(() => indexMastery(mastery), [mastery]);
  const [rubricModal, setRubricModal] = useState(null);

  if (!data || !data.assignments.length) {
    return <div className="card"><p className="text-muted">No assignments yet.</p></div>;
  }

  const { assignments, students, grades, grading_scales } = data;
  const displayName = (s) => s.preferred_name_teacher || s.preferred_name || s.first_name;
```

(The `useMemo` / `useState` calls go before the early `return` so hook order is stable.)

- [ ] **Step 4: Render the strip in aligned cells**

In `client/src/pages/CoursePage.jsx`, inside `GradebookView`, replace the block that currently starts at the comment `// Aligned (summative) assignments don't get scale-aware labels —` and runs through the closing `);` of the cell `return` (the `<td key={a.id} ...>` ... `</td>`). Replace this exact block:

```jsx
                // Aligned (summative) assignments don't get scale-aware labels —
                // the meaningful display is the per-topic mastery rubric (shown
                // on the assessment page; future: rubric icon hover here). For
                // now, keep raw score for aligned and let the scale label drive
                // formatives only.
                const lbl = a.aligned
                  ? gradeLabel({ score: g.score, max_points: a.max_points, exception: g.exception, grading_scale_id: null, scales: null })
                  : gradeLabel({ score: g.score, max_points: a.max_points, exception: g.exception, grading_scale_id: a.grading_scale_id, scales: grading_scales });
                // For General Academic-family levels, shorten to ED/EX/D/EM/IE
                // and apply the same color coding used in the aligned rubric.
                const code = lbl.kind === 'scale' ? masteryCodeForLevel(lbl.text) : null;
                const c = code ? LEVEL_COLORS[code] : null;
                const text = lbl.kind === 'pending' ? '—' : (code || lbl.text);
                const cellStyle = {
                  textAlign: 'center',
                  ...(lbl.kind === 'mismatch' && { color: 'var(--danger)' }),
                  ...(g.resubmit_requested && { background: 'var(--badge-resubmit-bg)' }),
                  ...(g.resubmitted && { boxShadow: 'inset 0 0 0 2px var(--resubmit-ring)' }),
                };
                const inner = c
                  ? <span style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}`, padding: '0.1rem 0.4rem', borderRadius: 4, fontWeight: 500, display: 'inline-block', minWidth: 24 }}>{text}</span>
                  : text;
                const status = submissionStatus({
                  score: g.score, exception: g.exception, late: g.late, draft: g.draft,
                  submitted_at: g.submitted_at, due_date: a.due_date,
                });
                // Don't double up exception text — gradeLabel already shows it.
                const inlineBadges = status.filter(b => b.kind !== 'exception');
                // Tooltip names whichever resubmission signals apply, falling
                // back to the mismatch warning or the grade comment.
                const signalTitle = [
                  g.resubmit_requested ? 'Re-submit requested' : null,
                  g.resubmitted ? 'Resubmitted since last graded' : null,
                ].filter(Boolean).join(' · ');
                const cellTitle = signalTitle
                  || (lbl.kind === 'mismatch'
                      ? 'Score does not match any defined level on this grading scale — check Schoology'
                      : (g.grade_comment || ''));
                return (
                  <td key={a.id} style={cellStyle} title={cellTitle}>
                    {inner}
                    {inlineBadges.map(b => (
                      <span key={b.kind} className={`badge ${b.tone === 'red' ? 'badge-red' : b.tone === 'blue' ? 'badge-blue' : 'badge-pink'}`} style={{ fontSize: '0.55rem', marginLeft: 3 }} title={b.label}>
                        {SHORT_BADGE[b.kind] || b.label[0]}
                      </span>
                    ))}
                  </td>
                );
```

with:

```jsx
                // Aligned summatives show a mini rubric strip of the student's
                // per-topic proficiency instead of a numeric score (#32).
                // Rubric-locking exceptions (Excused/Incomplete/Missing) delete
                // the scores in Schoology, so those cells keep the badge below.
                const isRubricLocked = g.exception === 1 || g.exception === 2 || g.exception === 3;
                const rubricTopics = (a.aligned && !isRubricLocked)
                  ? buildAssignmentRubric(a.schoology_assignment_id, s.schoology_uid, indexed)
                  : [];
                const showStrip = rubricTopics.length > 0;

                // Non-aligned cells (and aligned cells with no rubric data
                // available) keep the scale-aware / numeric label.
                const lbl = a.aligned
                  ? gradeLabel({ score: g.score, max_points: a.max_points, exception: g.exception, grading_scale_id: null, scales: null })
                  : gradeLabel({ score: g.score, max_points: a.max_points, exception: g.exception, grading_scale_id: a.grading_scale_id, scales: grading_scales });
                // For General Academic-family levels, shorten to ED/EX/D/EM/IE
                // and apply the same color coding used in the aligned rubric.
                const code = lbl.kind === 'scale' ? masteryCodeForLevel(lbl.text) : null;
                const c = code ? LEVEL_COLORS[code] : null;
                const text = lbl.kind === 'pending' ? '—' : (code || lbl.text);
                const cellStyle = {
                  textAlign: 'center',
                  ...(lbl.kind === 'mismatch' && { color: 'var(--danger)' }),
                  ...(g.resubmit_requested && { background: 'var(--badge-resubmit-bg)' }),
                  ...(g.resubmitted && { boxShadow: 'inset 0 0 0 2px var(--resubmit-ring)' }),
                };
                const inner = showStrip
                  ? <MiniRubricStrip
                      topics={rubricTopics}
                      onClick={() => setRubricModal({
                        student: s, assignment: a, topics: rubricTopics,
                        comment: g.grade_comment || '',
                      })}
                    />
                  : (c
                      ? <span style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}`, padding: '0.1rem 0.4rem', borderRadius: 4, fontWeight: 500, display: 'inline-block', minWidth: 24 }}>{text}</span>
                      : text);
                const status = submissionStatus({
                  score: g.score, exception: g.exception, late: g.late, draft: g.draft,
                  submitted_at: g.submitted_at, due_date: a.due_date,
                });
                // Don't double up exception text — gradeLabel already shows it.
                const inlineBadges = status.filter(b => b.kind !== 'exception');
                // Tooltip names whichever resubmission signals apply, falling
                // back to the mismatch warning or the grade comment.
                const signalTitle = [
                  g.resubmit_requested ? 'Re-submit requested' : null,
                  g.resubmitted ? 'Resubmitted since last graded' : null,
                ].filter(Boolean).join(' · ');
                const cellTitle = signalTitle
                  || (lbl.kind === 'mismatch'
                      ? 'Score does not match any defined level on this grading scale — check Schoology'
                      : (g.grade_comment || ''));
                return (
                  <td key={a.id} style={cellStyle} title={cellTitle}>
                    {inner}
                    {inlineBadges.map(b => (
                      <span key={b.kind} className={`badge ${b.tone === 'red' ? 'badge-red' : b.tone === 'blue' ? 'badge-blue' : 'badge-pink'}`} style={{ fontSize: '0.55rem', marginLeft: 3 }} title={b.label}>
                        {SHORT_BADGE[b.kind] || b.label[0]}
                      </span>
                    ))}
                  </td>
                );
```

- [ ] **Step 5: Render the modal from GradebookView's return**

In `client/src/pages/CoursePage.jsx`, `GradebookView` currently ends with:

```jsx
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <table style={{ fontSize: '0.8rem' }}>
```

…and closes with:

```jsx
        </tbody>
      </table>
    </div>
  );
}
```

Change the opening to wrap in a fragment — replace:

```jsx
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <table style={{ fontSize: '0.8rem' }}>
```

with:

```jsx
  return (
    <>
    <div className="card" style={{ overflowX: 'auto' }}>
      <table style={{ fontSize: '0.8rem' }}>
```

…and replace the closing block:

```jsx
        </tbody>
      </table>
    </div>
  );
}
```

with:

```jsx
        </tbody>
      </table>
    </div>
    {rubricModal && (
      <RubricModal
        student={rubricModal.student}
        assignment={rubricModal.assignment}
        courseId={courseId}
        topics={rubricModal.topics}
        comment={rubricModal.comment}
        onClose={() => setRubricModal(null)}
      />
    )}
    </>
  );
}
```

(Note: the closing `</tbody></table></div>);}` block is unique to `GradebookView` — `RosterView` has content after its `</table>`, and `AssessmentsView` has no `<table>`. Apply the change to the `GradebookView` function only.)

- [ ] **Step 6: Verify the build compiles**

Run: `cd client && npx vite build`
Expected: builds with no errors.

- [ ] **Step 7: Manual browser verification**

Start the dev server (kill stale ports first if needed):

```bash
lsof -ti:3001 | xargs kill -9 2>/dev/null; lsof -ti:5173 | xargs kill -9 2>/dev/null
npm run dev
```

Open `http://localhost:5173/course/4` → **Gradebook** tab. Confirm:

- Summative columns show a segmented strip instead of a number; each segment is colored by the student's level (blue ED / green EX / yellow D / orange EM / red IE).
- A topic the student has not been graded on shows a grey segment (strip still has one segment per aligned topic).
- Formative columns are unchanged (numeric / scale label).
- Clicking a strip opens the modal: header (student + assignment + S badge), the rubric grid with the earned level filled, the comment (when present), and an "Open full grading page →" link. The modal closes on ✕ and on backdrop click.
- A cell with an Excused / Incomplete / Missing exception shows the exception badge, not a strip.
- Open a course with no mastery data synced — summative cells fall back to the numeric label with no error in the browser console.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/CoursePage.jsx
git commit -m "$(cat <<'EOF'
feat(#32): mini rubric strip + modal on the course gradebook

Aligned-summative gradebook cells now show a segmented proficiency strip
(one segment per measurement topic, grey when ungraded) instead of a raw
score. Clicking opens a modal with the full rubric grid (shared
CompactRubric) and the overall comment. Exception cells and formative
cells are unchanged; falls back to the numeric label when no mastery
data is available.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Segmented strip in aligned summative cells — Task 4 (`MiniRubricStrip`, cell logic).
- Grey segments for ungraded topics — Task 2 (`buildAssignmentRubric` returns `grade: null`) + Task 4 (`MiniRubricStrip` renders `var(--bg-subtle)`).
- Modal = shared `CompactRubric` + comment + header + link — Tasks 3 and 4.
- Server `alignments` field — Task 1.
- Reuse course mastery data already fetched — Task 4 Step 1 (`mastery` prop, no new fetch).
- Score-derived fallback when alignments table empty — Task 2 (`indexMastery`).
- Exception cells keep the badge, no strip — Task 4 Step 4 (`isRubricLocked`).
- Aligned cell with no data falls back to numeric — Task 4 Step 4 (`showStrip` false → numeric `inner`).
- Formative cells unchanged — Task 4 Step 4 (strip only when `a.aligned`).
- Unit tests for `buildAssignmentRubric` ordering / ungraded / fallback / no-scores / unknown assignment — Task 2.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output.

**Type consistency:** `indexMastery` returns `{ topicMeta, topicsByAssignment, gradeLookup }`; `buildAssignmentRubric` consumes those exact names. `buildAssignmentRubric` output keys (`topic_id, title, external_id, category_title, grade`) match `CompactRubric`'s expected `topics` props and the `MiniRubricStrip` `topics` usage. `RubricModal` props (`student, assignment, courseId, topics, comment, onClose`) match the call site in Task 4 Step 5. `mastery` prop threaded CoursePage → GradebookView consistently.

**Scope:** Single focused feature (#32). #57 (flags on modal) and #36 (comment indicator) are explicitly excluded.
