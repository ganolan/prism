# Archived-Import UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group BOTH the Dashboard Archived-tab cards and the import discovery list by academic year → semester (most recent first), add global/per-year tri-state selection + per-year "Import all", and run bulk imports through a modal progress popup (mirroring SyncProgress) that refreshes the Archived tab on completion.

**Architecture:** Frontend, plus one server parser enhancement. `parsePastCourses` switches to a document-order walk that attaches each section's grading-period `<h3>` header (no extra API calls). `parseGradingPeriod` is hardened (explicit year-range / single-digit months / `S1`/`S2`/`YR`/`Summer`) and a new `groupByYearAndSemester` groups both surfaces. New UI: a shared `TriCheckbox`, an `ArchivedImportList` (grouped tri-state selection), a `useImportRunner` hook (sequential POST loop + render model), and an `ImportProgress` modal. `ArchivedCoursesPanel` becomes a thin orchestrator; the Dashboard archived cards switch to the year→semester grouper.

**Tech Stack:** React 18 + Vite, Vitest + @testing-library/react (jsdom), `node-html-parser` (server). Backend import flow is unchanged (#70 already finalises gradebook + mastery + enrich).

**Spec:** `docs/superpowers/specs/2026-05-31-archived-import-ux-design.md` · **Issue:** #71

**Conventions:** server tests `npx vitest run <path>` from repo root; client tests `cd client && npx vitest run <src-relative path>`. Frontend colours via CSS custom properties in `client/src/app.css` (no hardcoded hex). Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Commit directly to `main`. Each task leaves `main` green.

**Dependency order:** Task 2 before 4 & 8; Task 3 before 4; Tasks 4, 5, 6 before 7. The sequence below already satisfies these.

---

### Task 1: `parsePastCourses` — document-order walk attaching `gradingPeriod`

**Files:**
- Modify: `server/lib/parsePastCourses.js`
- Modify: `server/lib/__fixtures__/pastCoursesSample.js`
- Test: `server/lib/parsePastCourses.test.js`
- Test: `server/routes/courses.test.js` (passthrough guard — no route code change)

- [ ] **Step 1: Update the fixture to interleave grading-period headers**

Replace the whole body of `server/lib/__fixtures__/pastCoursesSample.js` with:

```js
// Synthetic sample of GET /courses/mycourses/past, matching the verified
// structure: an <h3> grading-period header precedes each group of
// li.course-item#course-{id} (→ .course-title, .course-code,
// div.section-item#section-{sectionId} → a[href="/course/{sectionId}"]).
// 3 courses / 4 sections across 3 term headers: a normal semester header, a
// year-only header, and an abbreviated header. NOT real course data.
export const PAST_COURSES_HTML = `
<div class="my-courses">
  <h3>Semester 1: 08/14/2025 - 01/11/2026 · 8/14/25 - 1/11/26</h3>
  <ul class="my-courses-list">
    <li class="course-item list-item" id="course-1001">
      <span class="course-title">Digital Design 9</span>
      <span class="course-code">DSGN9</span>
      <div class="section-item" id="section-7001">
        <a href="/course/7001">Section 2(A-B)</a>
      </div>
    </li>
  </ul>
  <h3>2024-2025: 08/13/24 - 06/15/25 · 8/13/24 - 6/15/25</h3>
  <ul class="my-courses-list">
    <li class="course-item list-item" id="course-1002">
      <span class="course-title">Game Development 10</span>
      <span class="course-code">GAME10</span>
      <div class="section-item" id="section-7002">
        <a href="/course/7002">Section 8(A-B)</a>
      </div>
      <div class="section-item" id="section-7003">
        <a href="/course/7003">Section 9(C-D)</a>
      </div>
    </li>
  </ul>
  <h3>22-23 YR · 8/07/22 - 6/14/23</h3>
  <ul class="my-courses-list">
    <li class="course-item list-item" id="course-1003">
      <span class="course-title">MASTER Art, Design &amp; Technology</span>
      <span class="course-code"></span>
      <div class="section-item" id="section-7004">
        <a href="/course/7004">Master Section</a>
      </div>
    </li>
  </ul>
</div>
`;
```

- [ ] **Step 2: Add the failing tests**

Append these tests inside the existing `describe('parsePastCourses', …)` block in `server/lib/parsePastCourses.test.js` (after the last test, before the closing `});`):

```js
  test('attaches the preceding grading-period header to each section (#71)', () => {
    expect(rows.find((x) => x.sectionId === '7001').gradingPeriod).toContain('Semester 1: 08/14/2025 - 01/11/2026');
    expect(rows.find((x) => x.sectionId === '7002').gradingPeriod).toContain('2024-2025: 08/13/24 - 06/15/25');
    expect(rows.find((x) => x.sectionId === '7003').gradingPeriod).toContain('2024-2025: 08/13/24 - 06/15/25');
    expect(rows.find((x) => x.sectionId === '7004').gradingPeriod).toContain('22-23 YR');
  });

  test('gradingPeriod is null when no header precedes a course (#71)', () => {
    const out = parsePastCourses(`
      <li class="course-item" id="course-9"><span class="course-title">No Term</span><span class="course-code">NT</span>
        <div class="section-item" id="section-99"><a href="/course/99">S</a></div>
      </li>`);
    expect(out[0].gradingPeriod).toBeNull();
  });

  test('dedupes a section that appears more than once (#71)', () => {
    const out = parsePastCourses(`
      <h3>Semester 1: 08/14/2024 - 01/11/2025</h3>
      <li class="course-item" id="course-9"><span class="course-title">Dup</span><span class="course-code">D</span>
        <div class="section-item" id="section-50"><a href="/course/50">S</a></div>
        <div class="section-item" id="section-50"><a href="/course/50">S again</a></div>
      </li>`);
    expect(out).toHaveLength(1);
    expect(out[0].sectionId).toBe('50');
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run server/lib/parsePastCourses.test.js`
Expected: FAIL — `gradingPeriod` is `undefined` (not attached) and the dedupe test sees 2 rows.

- [ ] **Step 4: Rewrite `parsePastCourses.js` as an ordered walk**

Replace the entire body of `server/lib/parsePastCourses.js` (keep the leading doc comment if you like, but the export below is the new implementation):

```js
import { parse } from 'node-html-parser';

const stripPrefix = (id, prefix) => {
  const s = String(id || '');
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
};

// Schoology's /mycourses/past page renders an <h3> grading-period header before
// each group of courses for that term (verified live 2026-05-31), e.g.
// "Semester 1: 08/14/2025 - 01/11/2026", "2024-2025: …", "22-23 YR · …". A header
// is an <h3> whose text carries a date, a year-range, or a term token.
const TERM_HEADER = /\d{1,2}\/\d{2}\/\d{2,4}|\d{4}-\d{4}|\d{2}-\d{2}|semester|\bS[12]\b|\bYR\b|summer|full.?year/i;
const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();

function parseCourseItem(courseEl, gradingPeriod, seen, out) {
  const courseId = stripPrefix(courseEl.getAttribute('id'), 'course-');
  if (!courseId) return;
  const courseTitle = courseEl.querySelector('.course-title')?.text.trim() || null;
  const rawCode = courseEl.querySelector('.course-code')?.text.trim();
  const courseCode = rawCode ? rawCode : null;
  for (const secEl of courseEl.querySelectorAll('.section-item')) {
    const sectionId = stripPrefix(secEl.getAttribute('id'), 'section-');
    if (!sectionId || seen.has(sectionId)) continue; // dedupe by section
    seen.add(sectionId);
    const sectionTitle =
      secEl.querySelector('.section-title')?.text.trim() ||
      secEl.querySelector('a[href^="/course/"]')?.text.trim() ||
      null;
    out.push({ courseId, courseTitle, courseCode, sectionId, sectionTitle, gradingPeriod });
  }
}

export function parsePastCourses(html) {
  const root = parse(html || '');
  const out = [];
  const seen = new Set();
  let currentGradingPeriod = null;
  // Preorder DFS so headers and course-items are visited in document order; each
  // course-item inherits the most-recent term header above it.
  const walk = (node) => {
    if (node.nodeType !== 1) return; // ELEMENT_NODE only (skip text nodes)
    const tag = (node.rawTagName || '').toLowerCase();
    if (tag === 'h3') {
      const t = collapse(node.text);
      if (t && TERM_HEADER.test(t)) currentGradingPeriod = t;
      return; // headers contain no course-items
    }
    if (tag === 'li' && (node.getAttribute('class') || '').includes('course-item')) {
      parseCourseItem(node, currentGradingPeriod, seen, out);
      return; // sections handled; don't double-walk children
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return out;
}
```

- [ ] **Step 5: Run to verify the parser tests pass**

Run: `npx vitest run server/lib/parsePastCourses.test.js`
Expected: PASS — all original tests (length 4, per-section attribution, no-code, recurring-course, empty/garbage) plus the three new ones.

- [ ] **Step 6: Add a discover-route passthrough guard test**

The route at `server/routes/courses.js:30-34` already spreads `...s`, so `gradingPeriod` flows through with **no code change**. Add a guard test inside the existing `describe('GET /api/courses/archived/discover', …)` in `server/routes/courses.test.js`:

```js
  test('passes gradingPeriod through to the response (#71)', async () => {
    getArchivedSections.mockResolvedValue([
      { courseId: '1', courseTitle: 'X', courseCode: 'X1', sectionId: '7777', sectionTitle: null, gradingPeriod: 'Semester 1: 08/14/2024 - 01/11/2025' },
    ]);
    const { body } = await get('/api/courses/archived/discover');
    expect(body.sections[0].gradingPeriod).toBe('Semester 1: 08/14/2024 - 01/11/2025');
  });
```

- [ ] **Step 7: Run the route suite**

Run: `npx vitest run server/routes/courses.test.js`
Expected: PASS (the guard passes immediately — the route already spreads the field).

- [ ] **Step 8: Commit**

```bash
git add server/lib/parsePastCourses.js server/lib/__fixtures__/pastCoursesSample.js server/lib/parsePastCourses.test.js server/routes/courses.test.js
git commit -m "feat(#71): parsePastCourses attaches per-section gradingPeriod via document-order walk"
```

---

### Task 2: Harden `parseGradingPeriod` + add `groupByYearAndSemester`

**Files:**
- Modify: `client/src/lib/courseDisplay.js`
- Test: `client/src/lib/courseDisplay.test.js`

(`groupByAcademicYear` is KEPT in this task — `Dashboard.jsx` still uses it; it is removed in Task 8 when the Dashboard switches over.)

- [ ] **Step 1: Add the failing tests**

In `client/src/lib/courseDisplay.test.js`, change the import line to add `groupByYearAndSemester`:

```js
import { parseGradingPeriod, groupByAcademicYear, groupByYearAndSemester, formatLastSynced } from './courseDisplay.js';
```

Add these new `it` cases inside the existing `describe('parseGradingPeriod', …)` block:

```js
  it('prefers the explicit 4-digit year range over date inference', () => {
    expect(parseGradingPeriod('2024-2025: 08/13/24 - 06/15/25'))
      .toEqual({ academicYear: '2024-25', semester: 'Full Year' });
  });
  it('handles single-digit months (was Unknown before)', () => {
    expect(parseGradingPeriod('Semester 1: 8/15/22 - 1/08/23'))
      .toEqual({ academicYear: '2022-23', semester: 'Semester 1' });
  });
  it('reads an abbreviated year range + YR token', () => {
    expect(parseGradingPeriod('22-23 YR · 8/07/22 - 6/14/23'))
      .toEqual({ academicYear: '2022-23', semester: 'Full Year' });
  });
  it('reads an abbreviated year range + S2 token', () => {
    expect(parseGradingPeriod('21-22 S2 · 1/04/22 - 6/15/22'))
      .toEqual({ academicYear: '2021-22', semester: 'Semester 2' });
  });
  it('recognises a Summer term', () => {
    expect(parseGradingPeriod('22-23 Summer · 6/06/22 - 6/20/22'))
      .toEqual({ academicYear: '2022-23', semester: 'Summer' });
  });
  it('returns Unknown year (Full Year) for a string with no date/year/term', () => {
    expect(parseGradingPeriod('mystery')).toEqual({ academicYear: 'Unknown', semester: 'Full Year' });
  });
```

Add a new describe block (after the `groupByAcademicYear` block):

```js
describe('groupByYearAndSemester', () => {
  it('groups by year (desc, Unknown last) then ordered semesters', () => {
    const groups = groupByYearAndSemester([
      { id: 1, grading_period: 'Semester 2: 01/06/2025 - 06/15/2025' }, // 2024-25 S2
      { id: 2, grading_period: 'Semester 1: 08/14/2024 - 01/11/2025' }, // 2024-25 S1
      { id: 3, grading_period: 'Semester 1: 08/14/2025 - 01/11/2026' }, // 2025-26 S1
      { id: 4, grading_period: 'mystery' },                              // Unknown / Full Year
    ]);
    expect(groups.map((g) => g.year)).toEqual(['2025-26', '2024-25', 'Unknown']);
    const y2024 = groups.find((g) => g.year === '2024-25');
    expect(y2024.semesters.map((s) => s.semester)).toEqual(['Semester 1', 'Semester 2']);
    expect(y2024.semesters[0].courses.map((c) => c.id)).toEqual([2]);
  });

  it('accepts a getPeriod accessor for discovery rows', () => {
    const groups = groupByYearAndSemester(
      [{ sectionId: 'x', gradingPeriod: '22-23 YR · 8/07/22 - 6/14/23' }],
      (s) => s.gradingPeriod,
    );
    expect(groups[0].year).toBe('2022-23');
    expect(groups[0].semesters[0].semester).toBe('Full Year');
  });

  it('returns [] for no courses', () => {
    expect(groupByYearAndSemester([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/lib/courseDisplay.test.js`
Expected: FAIL — `groupByYearAndSemester` is not exported and several new `parseGradingPeriod` cases return `Unknown`.

- [ ] **Step 3: Harden `parseGradingPeriod` + add the grouper**

In `client/src/lib/courseDisplay.js`, replace the existing `parseGradingPeriod` function (lines 5-18) with:

```js
export function parseGradingPeriod(gradingPeriod) {
  if (!gradingPeriod) return { academicYear: 'Unknown', semester: 'Unknown' };
  const s = String(gradingPeriod);

  let semester = 'Full Year';
  if (/semester\s*1|\bS1\b/i.test(s)) semester = 'Semester 1';
  else if (/semester\s*2|\bS2\b/i.test(s)) semester = 'Semester 2';
  else if (/summer/i.test(s)) semester = 'Summer';

  return { academicYear: parseAcademicYear(s), semester };
}

// Derive a canonical "YYYY-YY" academic year, preferring the most reliable
// signal: an explicit 4-digit range, then an abbreviated range, then a date
// (month >= 8 ⇒ that's the start year). Tolerant of single-digit months.
function parseAcademicYear(s) {
  let m = s.match(/(20\d{2})\s*-\s*20\d{2}/);
  if (m) { const start = Number(m[1]); return `${start}-${String(start + 1).slice(-2)}`; }
  m = s.match(/\b(\d{2})-(\d{2})\b/);
  if (m) { const start = 2000 + Number(m[1]); return `${start}-${String(start + 1).slice(-2)}`; }
  m = s.match(/(\d{1,2})\/\d{1,2}\/(\d{2,4})/);
  if (m) {
    const month = Number(m[1]);
    const raw = Number(m[2]);
    const year = raw < 100 ? 2000 + raw : raw;
    const start = month >= 8 ? year : year - 1;
    return `${start}-${String(start + 1).slice(-2)}`;
  }
  return 'Unknown';
}
```

Add the grouper (e.g. directly after `groupByAcademicYear`):

```js
const SEMESTER_ORDER = { 'Semester 1': 0, 'Semester 2': 1, 'Summer': 2, 'Full Year': 3, 'Unknown': 4 };

// Group courses by academic year (descending, "Unknown" last), then by semester
// (Semester 1 → Semester 2 → Summer → Full Year → Unknown). `getPeriod` reads the
// grading-period string from each item — cards use the default (grading_period),
// discovery rows pass (s) => s.gradingPeriod. (#71)
// → [{ year, semesters: [{ semester, courses: [...] }] }]
export function groupByYearAndSemester(courses, getPeriod = (c) => c.grading_period) {
  const years = {};
  for (const c of courses) {
    const { academicYear, semester } = parseGradingPeriod(getPeriod(c));
    if (!years[academicYear]) years[academicYear] = {};
    if (!years[academicYear][semester]) years[academicYear][semester] = [];
    years[academicYear][semester].push(c);
  }
  return Object.keys(years)
    .sort((a, b) => {
      if (a === 'Unknown') return 1;
      if (b === 'Unknown') return -1;
      return b.localeCompare(a);
    })
    .map((year) => ({
      year,
      semesters: Object.keys(years[year])
        .sort((a, b) => (SEMESTER_ORDER[a] ?? 99) - (SEMESTER_ORDER[b] ?? 99))
        .map((semester) => ({ semester, courses: years[year][semester] })),
    }));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd client && npx vitest run src/lib/courseDisplay.test.js`
Expected: PASS — new `parseGradingPeriod` cases, the grouper, and the existing `groupByAcademicYear` + `formatLastSynced` tests (unchanged) all pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/courseDisplay.js client/src/lib/courseDisplay.test.js
git commit -m "feat(#71): harden parseGradingPeriod + add groupByYearAndSemester"
```

---

### Task 3: Extract a shared `TriCheckbox`

**Files:**
- Create: `client/src/components/TriCheckbox.jsx`
- Create (test): `client/src/components/TriCheckbox.test.jsx`
- Modify: `client/src/components/SyncConfig.jsx`

- [ ] **Step 1: Write the failing test**

Create `client/src/components/TriCheckbox.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import TriCheckbox from './TriCheckbox.jsx';

describe('TriCheckbox', () => {
  it('reflects the indeterminate visual via the DOM property', () => {
    const { getByRole } = render(<TriCheckbox checked={false} indeterminate={true} onChange={() => {}} />);
    expect(getByRole('checkbox').indeterminate).toBe(true);
  });
  it('is checked when checked and not indeterminate', () => {
    const { getByRole } = render(<TriCheckbox checked={true} indeterminate={false} onChange={() => {}} />);
    const el = getByRole('checkbox');
    expect(el.checked).toBe(true);
    expect(el.indeterminate).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/components/TriCheckbox.test.jsx`
Expected: FAIL — `./TriCheckbox.jsx` does not exist.

- [ ] **Step 3: Create the component**

Create `client/src/components/TriCheckbox.jsx`:

```jsx
// A controlled checkbox that also reflects the indeterminate (tri-state) visual,
// which React doesn't expose as a prop — set imperatively via a ref. Shared by
// SyncConfig (mastery groups) and ArchivedImportList (#71).
export default function TriCheckbox({ checked, indeterminate, ...rest }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => { if (el) el.indeterminate = indeterminate; }}
      {...rest}
    />
  );
}
```

- [ ] **Step 4: Point `SyncConfig.jsx` at the shared component**

In `client/src/components/SyncConfig.jsx`: add the import near the top (after the existing imports):

```js
import TriCheckbox from './TriCheckbox.jsx';
```

Then delete the local `TriCheckbox` definition (the `// Checkbox that supports the indeterminate (tri-state) visual.` comment plus the `function TriCheckbox({ checked, indeterminate, ...rest }) { … }` block, currently lines 9-19). All existing `<TriCheckbox … />` usages now resolve to the import.

- [ ] **Step 5: Run both component test files**

Run: `cd client && npx vitest run src/components/TriCheckbox.test.jsx src/components/SyncConfig.test.jsx`
Expected: PASS — the new test passes and `SyncConfig`'s existing tests (which exercise the rendered tri-state via `select all visible`) still pass.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/TriCheckbox.jsx client/src/components/TriCheckbox.test.jsx client/src/components/SyncConfig.jsx
git commit -m "refactor(#71): extract shared TriCheckbox from SyncConfig"
```

---

### Task 4: `ArchivedImportList` — grouped, tri-state-selectable discovery list

**Files:**
- Create: `client/src/components/ArchivedImportList.jsx`
- Create (test): `client/src/components/ArchivedImportList.test.jsx`
- Modify: `client/src/app.css` (new grouped-list classes)

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/ArchivedImportList.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ArchivedImportList from './ArchivedImportList.jsx';

const SECTIONS = [
  { sectionId: 'a1', courseTitle: 'Robotics',         noCourseCode: false, gradingPeriod: 'Semester 1: 08/14/2024 - 01/11/2025' }, // 2024-25 S1
  { sectionId: 'a2', courseTitle: 'Mobile App Dev',   noCourseCode: false, gradingPeriod: 'Semester 1: 08/14/2024 - 01/11/2025' }, // 2024-25 S1
  { sectionId: 'a3', courseTitle: 'Photography',      noCourseCode: true,  gradingPeriod: 'Semester 2: 01/06/2025 - 06/15/2025' }, // 2024-25 S2, no-code
  { sectionId: 'b1', courseTitle: 'Coding in Action', noCourseCode: false, gradingPeriod: 'Semester 1: 08/14/2023 - 01/11/2024' }, // 2023-24 S1
];

function renderList(props = {}) {
  return render(
    <ArchivedImportList
      sections={props.sections || SECTIONS}
      busy={props.busy ?? false}
      onImport={props.onImport || (() => {})}
    />
  );
}

describe('ArchivedImportList', () => {
  it('groups rows under year then semester, most recent year first', () => {
    renderList();
    const years = screen.getAllByText(/^20\d\d-\d\d$/).map((n) => n.textContent);
    expect(years).toEqual(['2024-25', '2023-24']);
    expect(screen.getAllByText('Semester 1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Robotics')).toBeInTheDocument();
  });

  it('counts the selection and imports it', () => {
    const onImport = vi.fn();
    renderList({ onImport });
    fireEvent.click(screen.getByLabelText('Robotics'));
    fireEvent.click(screen.getByLabelText('Coding in Action'));
    fireEvent.click(screen.getByRole('button', { name: /Import 2 selected/ }));
    expect(onImport.mock.calls[0][0].sort()).toEqual(['a1', 'b1']);
  });

  it('select-year selects only coded sections in that year (skips no-code)', () => {
    renderList();
    fireEvent.click(screen.getByLabelText('Select all 2024-25'));
    expect(screen.getByLabelText('Robotics').checked).toBe(true);
    expect(screen.getByLabelText('Mobile App Dev').checked).toBe(true);
    expect(screen.getByLabelText('Photography').checked).toBe(false); // no-code excluded from bulk
  });

  it('a no-code row is still individually tickable', () => {
    renderList();
    fireEvent.click(screen.getByLabelText('Photography'));
    expect(screen.getByLabelText('Photography').checked).toBe(true);
  });

  it('Import all imports the year\'s coded sections only', () => {
    const onImport = vi.fn();
    renderList({ onImport });
    fireEvent.click(screen.getByRole('button', { name: /Import all \(2\)/ })); // 2024-25 has a1,a2 coded
    expect(onImport.mock.calls[0][0].sort()).toEqual(['a1', 'a2']);
    expect(onImport.mock.calls[0][0]).not.toContain('a3');
  });

  it('Select all is indeterminate with a partial selection and toggles all coded', () => {
    renderList();
    fireEvent.click(screen.getByLabelText('Robotics'));
    expect(screen.getByLabelText('Select all').indeterminate).toBe(true);
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(screen.getByLabelText('Robotics').checked).toBe(true);
    expect(screen.getByLabelText('Coding in Action').checked).toBe(true);
  });

  it('disables every input and button when busy', () => {
    renderList({ busy: true });
    expect(screen.getByLabelText('Robotics')).toBeDisabled();
    expect(screen.getByLabelText('Select all')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Import all/ })).toBeDisabled();
  });

  it('prunes selection when sections shrink (imported drop out)', () => {
    const { rerender } = renderList();
    fireEvent.click(screen.getByLabelText('Robotics'));
    expect(screen.getByRole('button', { name: /Import 1 selected/ })).toBeInTheDocument();
    rerender(<ArchivedImportList sections={SECTIONS.filter((s) => s.sectionId !== 'a1')} busy={false} onImport={() => {}} />);
    expect(screen.getByRole('button', { name: /Import 0 selected/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/components/ArchivedImportList.test.jsx`
Expected: FAIL — `./ArchivedImportList.jsx` does not exist.

- [ ] **Step 3: Create the component**

Create `client/src/components/ArchivedImportList.jsx`:

```jsx
import { useState, useEffect, useMemo } from 'react';
import TriCheckbox from './TriCheckbox.jsx';
import { groupByYearAndSemester } from '../lib/courseDisplay.js';

// The grouped, tri-state-selectable discovery list (#71). `sections` are the
// not-yet-imported archived sections. Coded sections (those with a course code)
// form the bulk-select universe for "Select all" / per-year select / "Import
// all"; no-code sections are individually tickable but excluded from bulk.
// onImport(sectionIds) fires for both "Import all (year)" and "Import N selected".
export default function ArchivedImportList({ sections, busy, onImport }) {
  const [selected, setSelected] = useState(() => new Set());

  // Prune selection when sections change (imported ones fall out; failed stay).
  useEffect(() => {
    const present = new Set(sections.map((s) => s.sectionId));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [sections]);

  const groups = useMemo(() => groupByYearAndSemester(sections, (s) => s.gradingPeriod), [sections]);
  const codedIds = useMemo(() => sections.filter((s) => !s.noCourseCode).map((s) => s.sectionId), [sections]);

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const setMany = (ids, on) => setSelected((prev) => {
    const next = new Set(prev);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    return next;
  });
  const triState = (ids) => {
    const on = ids.filter((id) => selected.has(id)).length;
    return { checked: ids.length > 0 && on === ids.length, indeterminate: on > 0 && on < ids.length };
  };
  const codedInYear = (group) =>
    group.semesters.flatMap((s) => s.courses).filter((c) => !c.noCourseCode).map((c) => c.sectionId);

  const allState = triState(codedIds);

  return (
    <div className="archived-import-groups">
      <div className="archived-import-bulkbar">
        <label className="archived-import-selectall">
          <TriCheckbox
            aria-label="Select all"
            checked={allState.checked}
            indeterminate={allState.indeterminate}
            disabled={busy || codedIds.length === 0}
            onChange={() => setMany(codedIds, !allState.checked)}
          />
          <span>Select all</span>
        </label>
        <button
          type="button"
          className="primary"
          disabled={busy || selected.size === 0}
          onClick={() => onImport([...selected])}
        >
          Import {selected.size} selected
        </button>
      </div>

      {groups.map((group) => {
        const yearCoded = codedInYear(group);
        const yearState = triState(yearCoded);
        return (
          <div className="archived-import-year" key={group.year}>
            <div className="archived-import-year-head">
              {yearCoded.length > 0 ? (
                <label className="archived-import-year-select">
                  <TriCheckbox
                    aria-label={`Select all ${group.year}`}
                    checked={yearState.checked}
                    indeterminate={yearState.indeterminate}
                    disabled={busy}
                    onChange={() => setMany(yearCoded, !yearState.checked)}
                  />
                  <span className="archived-import-year-label">{group.year}</span>
                </label>
              ) : (
                <span className="archived-import-year-label">{group.year}</span>
              )}
              {yearCoded.length > 0 && (
                <button type="button" className="secondary" disabled={busy} onClick={() => onImport(yearCoded)}>
                  Import all ({yearCoded.length})
                </button>
              )}
            </div>

            {group.semesters.map((sem) => (
              <div className="archived-import-semester" key={sem.semester}>
                <div className="archived-import-semester-label">{sem.semester}</div>
                {sem.courses.map((c) => (
                  <label className="archived-import-checkrow" key={c.sectionId}>
                    <input
                      type="checkbox"
                      aria-label={c.courseTitle}
                      checked={selected.has(c.sectionId)}
                      disabled={busy}
                      onChange={() => toggle(c.sectionId)}
                    />
                    <span>
                      {c.courseTitle}
                      {c.noCourseCode && <span className="badge badge-gray"> no course code</span>}
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd client && npx vitest run src/components/ArchivedImportList.test.jsx`
Expected: PASS — all eight tests.

- [ ] **Step 5: Add the grouped-list styles**

Append to `client/src/app.css` (theme variables only — no hardcoded hex):

```css
/* #71 — archived-import grouped discovery list */
.archived-import-groups { margin-top: 0.5rem; }
.archived-import-bulkbar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem; padding: 0.5rem 0; margin-bottom: 0.75rem;
  border-bottom: 1px solid var(--border);
}
.archived-import-selectall { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; }
.archived-import-year { margin-bottom: 1.25rem; }
.archived-import-year-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem; margin-bottom: 0.4rem;
}
.archived-import-year-select { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; }
.archived-import-year-label {
  font-weight: 600; font-size: 0.85rem; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--text-muted);
}
.archived-import-semester { margin: 0.3rem 0 0.3rem 0.5rem; }
.archived-import-semester-label { font-size: 0.78rem; color: var(--text-muted); margin: 0.35rem 0 0.2rem; }
.archived-import-checkrow {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.2rem 0 0.2rem 0.5rem; cursor: pointer;
}
```

- [ ] **Step 6: Commit**

```bash
git add client/src/components/ArchivedImportList.jsx client/src/components/ArchivedImportList.test.jsx client/src/app.css
git commit -m "feat(#71): ArchivedImportList — grouped tri-state discovery list"
```

---

### Task 5: `useImportRunner` — sequential import loop + render model

**Files:**
- Create: `client/src/hooks/useImportRunner.js`
- Create (test): `client/src/hooks/useImportRunner.test.js`

- [ ] **Step 1: Write the failing tests**

Create `client/src/hooks/useImportRunner.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useImportRunner } from './useImportRunner.js';

const ok = (n) => ({ studentsCount: n, assignmentsCount: n, gradesCount: n });

describe('useImportRunner', () => {
  it('runs targets sequentially, recording counts and a log line each', async () => {
    const order = [];
    const importer = vi.fn(async (id) => { order.push(id); return ok(2); });
    const { result } = renderHook(() => useImportRunner({ importer }));

    await act(async () => {
      await result.current.run([
        { sectionId: 's1', title: 'Robotics' },
        { sectionId: 's2', title: 'Drama' },
      ]);
    });

    expect(order).toEqual(['s1', 's2']);
    expect(result.current.model.status).toBe('done');
    expect(result.current.model.done).toBe(2);
    expect(result.current.model.rows.every((r) => r.status === 'done')).toBe(true);
    expect(result.current.model.log).toContain('Imported Robotics (2 students, 2 grades)');
  });

  it('records a failure, continues the batch, and reports succeededIds', async () => {
    const importer = vi.fn(async (id) => { if (id === 's1') throw new Error('403'); return ok(1); });
    const onComplete = vi.fn();
    const { result } = renderHook(() => useImportRunner({ importer, onComplete }));

    await act(async () => {
      await result.current.run([
        { sectionId: 's1', title: 'Bad' },
        { sectionId: 's2', title: 'Good' },
      ]);
    });

    expect(result.current.model.failures).toEqual([{ sectionId: 's1', title: 'Bad', error: '403' }]);
    expect(result.current.model.rows[1].status).toBe('done');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ total: 2, succeeded: 1, succeededIds: ['s2'] }));
  });

  it('retryFailed re-runs only the failed sections', async () => {
    let failFirst = true;
    const importer = vi.fn(async (id) => {
      if (id === 's1' && failFirst) { failFirst = false; throw new Error('temporary'); }
      return ok(1);
    });
    const { result } = renderHook(() => useImportRunner({ importer }));

    await act(async () => {
      await result.current.run([
        { sectionId: 's1', title: 'Flaky' },
        { sectionId: 's2', title: 'Fine' },
      ]);
    });
    expect(result.current.model.failures).toHaveLength(1);

    importer.mockClear();
    await act(async () => { result.current.retryFailed(); });
    await waitFor(() => expect(result.current.model.failures).toHaveLength(0));
    expect(importer).toHaveBeenCalledTimes(1);
    expect(importer).toHaveBeenCalledWith('s1');
  });

  it('reset returns the model to idle', async () => {
    const { result } = renderHook(() => useImportRunner({ importer: async () => ok(1) }));
    await act(async () => { await result.current.run([{ sectionId: 's1', title: 'X' }]); });
    act(() => { result.current.reset(); });
    expect(result.current.model.status).toBe('idle');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/hooks/useImportRunner.test.js`
Expected: FAIL — `./useImportRunner.js` does not exist.

- [ ] **Step 3: Create the hook**

Create `client/src/hooks/useImportRunner.js`:

```js
import { useState, useRef, useCallback } from 'react';
import { importCourse } from '../services/api.js';

// Drives a SEQUENTIAL archived-course import (mastery uses a single browser
// session — one course at a time) and exposes a render model for the progress
// modal. `importer` is injectable for tests. onComplete(summary) fires once when
// a run finishes — summary = { total, succeeded, succeededIds, failures }. (#71)
const EMPTY = { status: 'idle', total: 0, done: 0, progress: 0, rows: [], log: [], failures: [] };

export function useImportRunner({ onComplete, importer = importCourse } = {}) {
  const [model, setModel] = useState(EMPTY);
  const ref = useRef(EMPTY);
  const publish = (m) => { ref.current = m; setModel(m); };

  const runTargets = useCallback(async (targets, priorLog) => {
    const rows = targets.map((t) => ({ ...t, status: 'pending' }));
    const log = [...priorLog];
    const failures = [];
    publish({
      status: 'running', total: targets.length, done: 0,
      progress: targets.length ? 0 : 1, rows: [...rows], log: [...log], failures: [],
    });

    for (let i = 0; i < targets.length; i++) {
      rows[i] = { ...rows[i], status: 'running' };
      publish({ ...ref.current, rows: [...rows] });
      try {
        const res = await importer(targets[i].sectionId);
        const counts = {
          students: res?.studentsCount ?? 0,
          assignments: res?.assignmentsCount ?? 0,
          grades: res?.gradesCount ?? 0,
        };
        rows[i] = { ...rows[i], status: 'done', counts };
        log.push(`Imported ${targets[i].title} (${counts.students} students, ${counts.grades} grades)`);
      } catch (e) {
        const error = e?.message || 'import failed';
        rows[i] = { ...rows[i], status: 'error', error };
        failures.push({ sectionId: targets[i].sectionId, title: targets[i].title, error });
        log.push(`${targets[i].title} failed: ${error}`);
      }
      const done = i + 1;
      publish({ ...ref.current, rows: [...rows], log: [...log], failures: [...failures], done, progress: done / targets.length });
    }

    publish({ ...ref.current, status: 'done' });
    const succeededIds = rows.filter((r) => r.status === 'done').map((r) => r.sectionId);
    onComplete?.({ total: ref.current.total, succeeded: succeededIds.length, succeededIds, failures });
  }, [importer, onComplete]);

  const run = useCallback((targets) => runTargets(targets, []), [runTargets]);
  const retryFailed = useCallback(() => {
    const targets = ref.current.failures.map((f) => ({ sectionId: f.sectionId, title: f.title }));
    if (targets.length) runTargets(targets, ref.current.log);
  }, [runTargets]);
  const reset = useCallback(() => publish(EMPTY), []);

  return { model, run, retryFailed, reset };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd client && npx vitest run src/hooks/useImportRunner.test.js`
Expected: PASS — all four tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useImportRunner.js client/src/hooks/useImportRunner.test.js
git commit -m "feat(#71): useImportRunner — sequential import loop + render model"
```

---

### Task 6: `ImportProgress` — modal popup mirroring SyncProgress

**Files:**
- Create: `client/src/components/ImportProgress.jsx`
- Create (test): `client/src/components/ImportProgress.test.jsx`

(Reuses existing `.sync-progress / .sync-bar / .sync-phase / .sync-log / .sync-foot / .sync-foot-actions / .sync-head-ok / .sync-head-warn / .sync-spinner / .modal-overlay / .modal-content` classes — no new CSS.)

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/ImportProgress.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ImportProgress from './ImportProgress.jsx';

const runningModel = {
  status: 'running', total: 2, done: 1, progress: 0.5,
  rows: [
    { sectionId: 's1', title: 'Robotics', status: 'done', counts: { students: 20, grades: 100 } },
    { sectionId: 's2', title: 'Drama', status: 'running' },
  ],
  log: ['Imported Robotics (20 students, 100 grades)'],
  failures: [],
};

const doneWithFailure = {
  status: 'done', total: 2, done: 2, progress: 1,
  rows: [
    { sectionId: 's1', title: 'Robotics', status: 'done', counts: { students: 20, grades: 100 } },
    { sectionId: 's2', title: 'PCG', status: 'error', error: 'not accessible (403)' },
  ],
  log: ['Imported Robotics (20 students, 100 grades)', 'PCG failed: not accessible (403)'],
  failures: [{ sectionId: 's2', title: 'PCG', error: 'not accessible (403)' }],
};

describe('ImportProgress', () => {
  it('shows progress and disables Done while running', () => {
    render(<ImportProgress model={runningModel} onRetry={() => {}} onDone={() => {}} />);
    expect(screen.getByText(/Importing archived courses/)).toBeInTheDocument();
    expect(screen.getByText(/Please don't close Prism/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /done/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /retry failed/i })).not.toBeInTheDocument();
  });

  it('summarises completion with a failure and offers Retry failed', () => {
    const onRetry = vi.fn();
    render(<ImportProgress model={doneWithFailure} onRetry={onRetry} onDone={() => {}} />);
    expect(screen.getByText(/Import complete · 1 of 2/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    expect(screen.getByText(/not accessible \(403\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry failed \(1\)/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('enables Done and hides Retry when all succeed', () => {
    const onDone = vi.fn();
    const allOk = {
      status: 'done', total: 1, done: 1, progress: 1,
      rows: [{ sectionId: 's1', title: 'Robotics', status: 'done', counts: { students: 1, grades: 1 } }],
      log: ['Imported Robotics (1 students, 1 grades)'], failures: [],
    };
    render(<ImportProgress model={allOk} onRetry={() => {}} onDone={onDone} />);
    expect(screen.getByText(/Import complete · 1 of 1/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry failed/i })).not.toBeInTheDocument();
    const done = screen.getByRole('button', { name: /done/i });
    expect(done).not.toBeDisabled();
    fireEvent.click(done);
    expect(onDone).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/components/ImportProgress.test.jsx`
Expected: FAIL — `./ImportProgress.jsx` does not exist.

- [ ] **Step 3: Create the component**

Create `client/src/components/ImportProgress.jsx`:

```jsx
const STATUS_ICON = { pending: '○', running: '●', done: '✓', error: '✕' };

function CourseRow({ row }) {
  return (
    <div className={`sync-phase sync-phase-${row.status}`}>
      <span className="sync-phase-icon">{STATUS_ICON[row.status] || '○'}</span>
      <span className="sync-phase-label">{row.title}</span>
      <span className="sync-phase-count">
        {row.status === 'done' && row.counts && `${row.counts.students} students · ${row.counts.grades} grades`}
        {row.status === 'running' && 'importing…'}
        {row.status === 'error' && row.error}
      </span>
    </div>
  );
}

// Modal popup mirroring SyncProgress (#71), driven by useImportRunner's model.
// Non-dismissable while running (no backdrop/Escape). No login-remedy banner:
// gradebook import is OAuth-based and mastery is best-effort (mastery-if-session,
// per #70), so a dead session silently skips mastery rather than failing import.
export default function ImportProgress({ model, onRetry, onDone }) {
  const running = model.status === 'running';
  const done = model.status === 'done';
  const failed = model.failures.length;
  const succeeded = model.total - failed;

  let heading = 'Importing archived courses…';
  let headingClass = '';
  if (done) {
    heading = `Import complete · ${succeeded} of ${model.total}`;
    headingClass = failed ? 'sync-head-warn' : 'sync-head-ok';
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content sync-dialog">
        <div className="sync-progress">
          <div className={`sync-progress-head ${headingClass}`}>
            <h2>
              {running && <span className="sync-spinner" aria-hidden="true" />}
              {heading}
              {done && failed > 0 && <span className="badge badge-gray"> · {failed} failed</span>}
            </h2>
            {running && <p className="text-muted text-sm">Please don't close Prism — this can take a few minutes.</p>}
          </div>

          <div className="sync-bar">
            <div className="sync-bar-fill" style={{ width: `${Math.round(model.progress * 100)}%` }} />
          </div>

          <div className="sync-phase-list">
            {model.rows.map((row) => <CourseRow key={row.sectionId} row={row} />)}
          </div>

          {model.log.length > 0 && (
            <div className="sync-log">
              {model.log.slice(-40).map((line, i) => (
                <div key={Math.max(0, model.log.length - 40) + i}>{line}</div>
              ))}
            </div>
          )}

          <div className="sync-foot">
            <span className="text-muted text-sm">
              {done && failed > 0 && `${failed} couldn't be imported`}
            </span>
            <div className="sync-foot-actions">
              {done && failed > 0 && (
                <button type="button" className="secondary" onClick={onRetry}>Retry failed ({failed})</button>
              )}
              <button type="button" className="primary" onClick={onDone} disabled={running}>Done</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd client && npx vitest run src/components/ImportProgress.test.jsx`
Expected: PASS — all three tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ImportProgress.jsx client/src/components/ImportProgress.test.jsx
git commit -m "feat(#71): ImportProgress modal mirroring SyncProgress"
```

---

### Task 7: `ArchivedCoursesPanel` orchestration

**Files:**
- Modify: `client/src/components/ArchivedCoursesPanel.jsx` (rewrite — use `ArchivedImportList` + `useImportRunner` + `ImportProgress`)
- Modify: `client/src/components/ArchivedCoursesPanel.test.jsx` (rewrite for the new UI)

- [ ] **Step 1: Rewrite the panel test for the new UI**

Replace the entire contents of `client/src/components/ArchivedCoursesPanel.test.jsx` with:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ArchivedCoursesPanel from './ArchivedCoursesPanel.jsx';
import { discoverArchivedCourses, importCourse, triggerMasteryLogin } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  discoverArchivedCourses: vi.fn(),
  importCourse: vi.fn(),
  triggerMasteryLogin: vi.fn(),
}));

const DISCOVERED = {
  available: true,
  sections: [
    { courseTitle: 'Photography 7', courseCode: null, sectionId: '7004', imported: false, noCourseCode: true, gradingPeriod: 'Semester 1: 08/14/2024 - 01/11/2025' },
    { courseTitle: 'Drama 8', courseCode: 'DRA8', sectionId: '7005', imported: false, noCourseCode: false, gradingPeriod: 'Semester 1: 08/14/2024 - 01/11/2025' },
  ],
};

function renderPanel(props = {}) {
  return render(<ArchivedCoursesPanel onImported={props.onImported || (() => {})} />);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('ArchivedCoursesPanel', () => {
  it('discovers not-yet-imported sections and lists them grouped', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    expect(screen.getByText('Photography 7')).toBeInTheDocument();
    expect(screen.getByText(/no course code/)).toBeInTheDocument();
    expect(screen.getByText('2024-25')).toBeInTheDocument();
  });

  it('excludes already-imported sections and reports the count', async () => {
    discoverArchivedCourses.mockResolvedValue({
      available: true,
      sections: [
        { courseTitle: 'History 9', courseCode: 'HIS9', sectionId: '7010', imported: true, noCourseCode: false, gradingPeriod: 'Semester 1: 08/14/2023 - 01/11/2024' },
        { courseTitle: 'Drama 8', courseCode: 'DRA8', sectionId: '7005', imported: false, noCourseCode: false, gradingPeriod: 'Semester 1: 08/14/2024 - 01/11/2025' },
      ],
    });
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    expect(screen.queryByText('History 9')).not.toBeInTheDocument();
    expect(screen.getByText(/Found on Schoology \(2\) — 1 not yet imported/)).toBeInTheDocument();
  });

  it('imports the selection via a progress modal, then drops it and refreshes', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({ studentsCount: 3, assignmentsCount: 4, gradesCount: 5 });
    const onImported = vi.fn();
    renderPanel({ onImported });
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    fireEvent.click(screen.getByLabelText('Drama 8'));
    fireEvent.click(screen.getByRole('button', { name: /Import 1 selected/ }));
    await screen.findByText(/Import complete · 1 of 1/);
    expect(importCourse).toHaveBeenCalledWith('7005');
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByText('Drama 8')).not.toBeInTheDocument());
    expect(onImported).toHaveBeenCalled();
  });

  it('Import all imports the year\'s coded sections only', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({ studentsCount: 1, assignmentsCount: 1, gradesCount: 1 });
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    fireEvent.click(screen.getByRole('button', { name: /Import all \(1\)/ }));
    await screen.findByText(/Import complete/);
    expect(importCourse).toHaveBeenCalledWith('7005');
    expect(importCourse).toHaveBeenCalledTimes(1); // Photography 7 (no-code) excluded
  });

  it('shows a failed import in the modal with Retry failed', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockRejectedValue(new Error('Section not accessible'));
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    fireEvent.click(screen.getByLabelText('Drama 8'));
    fireEvent.click(screen.getByRole('button', { name: /Import 1 selected/ }));
    expect(await screen.findByText('Section not accessible')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry failed \(1\)/i })).toBeInTheDocument();
  });

  it('logs in on demand and auto-re-runs discovery', async () => {
    discoverArchivedCourses
      .mockResolvedValueOnce({ available: false, reason: 'no_session' })
      .mockResolvedValueOnce(DISCOVERED);
    triggerMasteryLogin.mockResolvedValue({});
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText(/Log in to Schoology/);
    fireEvent.click(screen.getByText(/Log in to Schoology/));
    await waitFor(() => expect(triggerMasteryLogin).toHaveBeenCalled());
    await screen.findByText('Drama 8');
    expect(discoverArchivedCourses).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Log in to Schoology/)).not.toBeInTheDocument();
  });

  it('keeps the login prompt and surfaces an error when login fails', async () => {
    discoverArchivedCourses.mockResolvedValue({ available: false, reason: 'no_session' });
    triggerMasteryLogin.mockRejectedValue(new Error('Login window closed'));
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText(/Log in to Schoology/);
    fireEvent.click(screen.getByText(/Log in to Schoology/));
    expect(await screen.findByText('Login window closed')).toBeInTheDocument();
    expect(screen.getByText(/Log in to Schoology/)).toBeInTheDocument();
    expect(discoverArchivedCourses).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/components/ArchivedCoursesPanel.test.jsx`
Expected: FAIL — the old panel has no `ArchivedImportList`, no `Import N selected` button, and import errors surface inline (not in a modal).

- [ ] **Step 3: Rewrite `ArchivedCoursesPanel.jsx`**

Replace the entire contents of `client/src/components/ArchivedCoursesPanel.jsx` with:

```jsx
import { useState } from 'react';
import { discoverArchivedCourses, triggerMasteryLogin } from '../services/api.js';
import ArchivedImportList from './ArchivedImportList.jsx';
import ImportProgress from './ImportProgress.jsx';
import { useImportRunner } from '../hooks/useImportRunner.js';

// Discovery-only surface for importing archived (past) courses, mounted on the
// Dashboard Archived tab (issue #69, grouped + bulk in #71). It scrapes
// Schoology's /mycourses/past source page via the saved browser session to list
// archived sections NOT yet imported, grouped by year→semester, and imports a
// selection (or a whole year) through a progress modal. Already-imported archived
// courses are shown as cards by the Dashboard itself — this component never
// renders them. "Archived" is the app's canonical term; "past" only names
// Schoology's source page (see CONTEXT.md).
export default function ArchivedCoursesPanel({ onImported }) {
  const [discovered, setDiscovered] = useState(null); // null until checked
  const [checking, setChecking] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [importedIds, setImportedIds] = useState(() => new Set()); // imported this session
  const [error, setError] = useState(null);

  const { model, run, retryFailed, reset } = useImportRunner({
    onComplete: ({ succeededIds }) => {
      if (succeededIds.length) {
        setImportedIds((prev) => {
          const next = new Set(prev);
          succeededIds.forEach((id) => next.add(id));
          return next;
        });
        onImported?.(); // refresh the Dashboard cards
      }
    },
  });

  const isImported = (s) => s.imported || importedIds.has(s.sectionId);
  const remaining = (discovered || []).filter((s) => !isImported(s));

  async function handleCheck() {
    setChecking(true); setError(null); setNeedLogin(false);
    try {
      const res = await discoverArchivedCourses();
      if (!res.available) { setNeedLogin(true); setDiscovered(null); }
      else setDiscovered(res.sections);
    } catch (e) {
      setError(e.message);
    } finally {
      setChecking(false);
    }
  }

  async function handleLogin() {
    setLoggingIn(true); setError(null);
    try {
      await triggerMasteryLogin();
      await handleCheck(); // auto re-run discovery once logged in
    } catch (e) {
      setError(e.message);
    } finally {
      setLoggingIn(false);
    }
  }

  function handleImport(sectionIds) {
    const targets = sectionIds
      .map((id) => remaining.find((s) => s.sectionId === id))
      .filter(Boolean)
      .map((s) => ({ sectionId: s.sectionId, title: s.courseTitle }));
    if (targets.length) run(targets);
  }

  return (
    <div className="archived-import">
      <h3 className="archived-import-title">Import archived courses from Schoology</h3>

      {discovered === null && (
        <div className="archived-import-action">
          <button type="button" className="secondary" onClick={handleCheck} disabled={checking || loggingIn}>
            {checking ? 'Checking…' : 'Check Schoology for archived courses'}
          </button>
        </div>
      )}

      {needLogin && (
        <div className="alert alert-warning sync-login-prompt">
          <p>Finding archived courses needs a Schoology browser session. Log in once to enable it.</p>
          <button type="button" className="secondary" onClick={handleLogin} disabled={loggingIn}>
            {loggingIn ? 'Logging in…' : 'Log in to Schoology'}
          </button>
        </div>
      )}

      {error && <div className="alert alert-warning">{error}</div>}

      {discovered && remaining.length > 0 && (
        <>
          <p className="archived-import-found">
            Found on Schoology ({discovered.length}) — {remaining.length} not yet imported
          </p>
          <ArchivedImportList
            sections={remaining}
            busy={model.status === 'running'}
            onImport={handleImport}
          />
        </>
      )}

      {discovered && remaining.length === 0 && (
        <p className="archived-import-empty">
          {discovered.length === 0
            ? 'No archived courses found on Schoology.'
            : 'All archived courses found on Schoology are imported.'}
        </p>
      )}

      {model.status !== 'idle' && (
        <ImportProgress model={model} onRetry={retryFailed} onDone={reset} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd client && npx vitest run src/components/ArchivedCoursesPanel.test.jsx`
Expected: PASS — all seven tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ArchivedCoursesPanel.jsx client/src/components/ArchivedCoursesPanel.test.jsx
git commit -m "feat(#71): ArchivedCoursesPanel orchestrates grouped selection + import-progress modal"
```

---

### Task 8: Dashboard archived cards → year→semester grouping; remove `groupByAcademicYear`

**Files:**
- Modify: `client/src/pages/Dashboard.jsx`
- Modify: `client/src/lib/courseDisplay.js` (remove now-unused `groupByAcademicYear`)
- Modify: `client/src/lib/courseDisplay.test.js` (remove its describe block + import)
- Modify: `client/src/app.css` (semester sub-header class)

- [ ] **Step 1: Check for a Dashboard test that might reference the old grouping**

Run: `ls client/src/pages/Dashboard.test.jsx 2>/dev/null && grep -n "groupByAcademicYear\|badge-gray" client/src/pages/Dashboard.test.jsx || echo "no Dashboard.test.jsx"`
Expected: likely `no Dashboard.test.jsx`. If one exists and references the old grouping or the per-card semester badge, update those assertions to match the new nested year→semester rendering as you go.

- [ ] **Step 2: Switch the Dashboard to the year→semester grouper**

In `client/src/pages/Dashboard.jsx`, change the import on line 4 from:

```js
import { parseGradingPeriod, groupByAcademicYear } from '../lib/courseDisplay.js';
```

to:

```js
import { groupByYearAndSemester } from '../lib/courseDisplay.js';
```

In `CourseCard` (lines 54-56), remove the now-unused semester lookup. Change:

```js
  function CourseCard({ c, showSemester = false }) {
    const { semester } = parseGradingPeriod(c.grading_period);
    const isSettings = settingsCard === c.id;
```

to:

```js
  function CourseCard({ c, showSemester = false }) {
    const isSettings = settingsCard === c.id;
```

In `CourseCard`'s badges row (lines 78-81), remove the redundant semester badge (the sub-header now conveys it). Change:

```js
            {showSemester && <span className="badge badge-gray">{semester}</span>}
            {!!c.hidden && <span className="badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>Hidden</span>}
```

to:

```js
            {!!c.hidden && <span className="badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>Hidden</span>}
```

Change the grouping line (line 51) from:

```js
  const yearGroups = groupByAcademicYear(courses);
```

to:

```js
  const yearGroups = groupByYearAndSemester(courses);
```

Replace the archived-tab year rendering (lines 192-201, the `yearGroups.map(({ year, courses: groupCourses }) => ( … ))` block) with the nested year→semester version:

```js
            yearGroups.map(({ year, semesters }) => (
              <div key={year} style={{ marginBottom: '2rem' }}>
                <h3 style={{ marginBottom: '0.75rem', color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {year}
                </h3>
                {semesters.map(({ semester, courses: semCourses }) => (
                  <div key={semester} style={{ marginBottom: '1rem' }}>
                    <h4 className="archived-semester-subhead">{semester}</h4>
                    <div className="grid-2">
                      {semCourses.map(c => <CourseCard key={c.id} c={c} showSemester />)}
                    </div>
                  </div>
                ))}
              </div>
            ))
```

(The empty-state branch above it is unchanged — `yearGroups.length === 0` still holds because an empty `courses` array yields `[]`.)

- [ ] **Step 3: Remove `groupByAcademicYear` (Dashboard was its only consumer)**

In `client/src/lib/courseDisplay.js`, delete the `groupByAcademicYear` function (the `export function groupByAcademicYear(courses) { … }` block). Leave `parseGradingPeriod`, `parseAcademicYear`, `groupByYearAndSemester`, `SEMESTER_ORDER`, and `formatLastSynced`.

In `client/src/lib/courseDisplay.test.js`: remove `groupByAcademicYear` from the import line (leaving `import { parseGradingPeriod, groupByYearAndSemester, formatLastSynced } from './courseDisplay.js';`) and delete the entire `describe('groupByAcademicYear', …)` block.

- [ ] **Step 4: Add the semester sub-header style**

Append to `client/src/app.css`:

```css
.archived-semester-subhead {
  font-size: 0.78rem; color: var(--text-muted); font-weight: 500;
  margin: 0.25rem 0 0.5rem; letter-spacing: 0.04em;
}
```

- [ ] **Step 5: Run the client lib + build**

Run: `cd client && npx vitest run src/lib/courseDisplay.test.js && npm run build`
Expected: PASS — `courseDisplay.test.js` green (no `groupByAcademicYear` reference remains) and the production build succeeds (no unresolved import of the removed function).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Dashboard.jsx client/src/lib/courseDisplay.js client/src/lib/courseDisplay.test.js client/src/app.css
git commit -m "feat(#71): group archived cards by year then semester; drop groupByAcademicYear"
```

---

### Task 9: Full verification + build-progress + close #71

**Files:**
- Modify: `.claude/build-progress.md`

- [ ] **Step 1: Run both full suites + the production build**

Run: `npx vitest run` (server, from repo root), then `cd client && npx vitest run`, then `cd client && npm run build`.
Expected: all green. Server gains the parser + fixture + discover-passthrough tests; client gains `courseDisplay` (hardened parse + grouper), `TriCheckbox`, `ArchivedImportList`, `useImportRunner`, `ImportProgress`, and the rewritten `ArchivedCoursesPanel` tests. Investigate any failure before proceeding.

- [ ] **Step 2: Live verification (the user's call — do not auto-trigger a full sync)**

With the dev server running and a Schoology browser session present (ask the user to run `npm run mastery:login` only if the session is actually dead — confirm first):
- Open the Dashboard **Archived** tab → **Check Schoology for archived courses**. Confirm the discovery list is grouped by year → semester, most recent first, with tri-state **Select all** / per-year checkboxes and per-year **Import all (n)**.
- Confirm the imported-course **cards** below are grouped the same way (year → semester sub-headers).
- Select one course (or a year) and import. Confirm the **progress modal** appears (bar + per-course rows + scrolling log), and on completion the Archived tab shows the new card(s) under their year → semester without a manual refresh.
- (If a failure is easy to trigger) confirm a failed course shows in the modal with **Retry failed**.

- [ ] **Step 3: Append a build-progress entry**

Add a dated `## Archived-Import UX — year/semester grouping + bulk import (#71)` entry to `.claude/build-progress.md` summarising: live-probe finding (the `/mycourses/past` page carries grading-period `<h3>` headers → document-order parse, zero extra API calls); `parsePastCourses` ordered walk + `gradingPeriod`; hardened `parseGradingPeriod` (explicit year-range / single-digit months / `S1`/`S2`/`YR`/`Summer`) + new `groupByYearAndSemester` (replaces `groupByAcademicYear`); shared `TriCheckbox`; `ArchivedImportList` (global/per-year tri-state, per-row, per-year "Import all", no-code excluded from bulk but tickable); `useImportRunner` (sequential, continue-on-error, retry); `ImportProgress` modal (mirrors SyncProgress, no login-remedy); `ArchivedCoursesPanel` rewritten as orchestrator; Dashboard cards grouped year→semester (semester badge dropped). Add a "not yet explored" list: live multi-course bulk import at scale; whether imported cards' stored `grading_period` strings group identically to discovery headers (both funnel through the same hardened parser, but not yet compared on live data); a configurable date/locale preference + shared `formatDate` helper (deferred).

- [ ] **Step 4: Commit**

```bash
git add .claude/build-progress.md
git commit -m "docs(#71): build-progress — archived-import UX (grouping + bulk import) shipped"
```

- [ ] **Step 5: Close the issue (only after the user's go-ahead)**

Per project hygiene, push and issue-close happen only with the user's explicit OK. Once given:

```bash
gh issue close 71 --comment "Shipped: year→semester grouping for the Archived-tab cards and the import discovery list; global/per-year tri-state selection + per-year Import all; a progress modal (mirroring SyncProgress) with Retry-failed that refreshes the Archived tab on completion. Term metadata is parsed from the /mycourses/past grading-period headers (document-order walk, zero extra API calls), with parseGradingPeriod hardened for the live header shapes. Server + client suites green; production build clean."
```

---

## Self-Review

**Spec coverage:**
- Document-order parse attaching `gradingPeriod`, discover passthrough → Task 1.
- Hardened `parseGradingPeriod` + `groupByYearAndSemester` (both accessor shapes) → Task 2.
- Shared `TriCheckbox` → Task 3.
- `ArchivedImportList` — global + per-year tri-state, per-row, semester visual sub-header, per-year "Import all", no-code excluded-from-bulk-but-tickable, selection pruning, busy disabling → Task 4.
- `useImportRunner` — sequential loop, counts, continue-on-error, `retryFailed`, `succeededIds` summary → Task 5.
- `ImportProgress` modal — SyncProgress look, running/done/failure states, Retry-failed, no login-remedy → Task 6.
- `ArchivedCoursesPanel` orchestration — discovery, runner, modal, refresh-on-complete via `importedIds` (no re-scrape) → Task 7.
- Dashboard cards year→semester, semester badge dropped, `groupByAcademicYear` removed → Task 8.
- Verification + build-progress + close → Task 9. Out-of-scope items (collapse, parallel import, skip-mastery toggle, configurable locale, merging surfaces, backend change) are recorded in the spec; the build-progress "not yet explored" list carries the live-data follow-ups. ✓

**Placeholder scan:** every code step shows complete code; every run step has an expected outcome; no TBD/TODO. The Task 8 Step 1 grep and Task 9 live-verification are verification actions, not placeholders. ✓

**Type/name consistency:** discovery rows carry `{ courseId, courseTitle, courseCode, sectionId, sectionTitle, gradingPeriod }` (Task 1) — `gradingPeriod` is read by `groupByYearAndSemester(..., (s) => s.gradingPeriod)` (Tasks 2, 4) and `noCourseCode`/`courseTitle` by `ArchivedImportList` (Task 4). `groupByYearAndSemester` returns `[{ year, semesters: [{ semester, courses }] }]` — consumed identically in `ArchivedImportList` (Task 4) and `Dashboard` (Task 8). `useImportRunner` model `{ status, total, done, progress, rows:[{ sectionId, title, status, counts:{students,assignments,grades}, error }], log, failures:[{ sectionId, title, error }] }` and summary `{ total, succeeded, succeededIds, failures }` (Task 5) are consumed exactly by `ImportProgress` (Task 6) and `ArchivedCoursesPanel`'s `onComplete` (Task 7). `TriCheckbox` props `{ checked, indeterminate, ...rest }` (Task 3) used by both `SyncConfig` and `ArchivedImportList`. `importCourse(sectionId)` returns `{ studentsCount, assignmentsCount, gradesCount }` (verified in `api.js`), matching the runner's `res?.studentsCount` reads. `TriCheckbox`/`ArchivedImportList`/`useImportRunner`/`ImportProgress` are each created before the task (7) that composes them. ✓
