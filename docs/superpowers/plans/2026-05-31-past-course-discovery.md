# Past-Course Discovery & Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a teacher enumerate past/archived Schoology courses by scraping `/courses/mycourses/past`, then import them (per-course or bulk) from an import-once "Past courses" panel in the Sync dialog — without typing section IDs.

**Architecture:** Thin backend (Approach A). A pure parser turns the past-courses HTML into a section list; a best-effort browser-session service fetches that HTML (mirrors `graderSubmissions.js`); a read endpoint `GET /api/courses/past` annotates each section with `imported`/`noCourseCode`. Import reuses the existing `POST /api/courses/import` unchanged — bulk import is a frontend loop. The UI is a collapsible panel in `SyncConfig`.

**Tech Stack:** Node ESM, Express, better-sqlite3, `node-html-parser`, Playwright (best-effort), Vitest, React + `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-05-31-past-course-discovery-design.md`

**Conventions:** TDD throughout. Small commits to `main`. Every commit message ends with the trailer:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (per CLAUDE.md). GET-only probing; no real course/student data committed (the test fixture is synthetic).

## File Structure

**Create:**
- `server/lib/__fixtures__/pastCoursesSample.js` — synthetic past-courses HTML (shared by parser + service tests)
- `server/lib/parsePastCourses.js` — pure parser
- `server/lib/parsePastCourses.test.js` — parser tests
- `server/services/pastCourses.js` — best-effort browser fetch + `getPastSections`
- `server/services/pastCourses.test.js` — `getPastSections` parse/inject tests
- `client/src/lib/courseDisplay.js` — extracted `parseGradingPeriod`, `groupByAcademicYear`, new `formatLastSynced`
- `client/src/lib/courseDisplay.test.js` — helper tests
- `client/src/components/PastCoursesPanel.jsx` — the panel
- `client/src/components/PastCoursesPanel.test.jsx` — panel tests

**Modify:**
- `server/routes/courses.js` — add `GET /past` **before** `GET /:id`
- `server/routes/courses.test.js` — add `GET /past` tests (+ `vi.mock` of the service)
- `client/src/services/api.js` — add `getPastSections`
- `client/src/pages/Dashboard.jsx` — import helpers from `courseDisplay.js`, drop local copies
- `client/src/components/SyncConfig.jsx` — render `<PastCoursesPanel>`; add current-course "last synced" line
- `client/src/components/SyncConfig.test.jsx` — add panel-present + last-synced assertions

---

### Task 1: Synthetic fixture + pure parser (TDD)

**Files:**
- Create: `server/lib/__fixtures__/pastCoursesSample.js`
- Create: `server/lib/parsePastCourses.js`
- Test: `server/lib/parsePastCourses.test.js`

- [ ] **Step 1: Create the synthetic fixture**

`server/lib/__fixtures__/pastCoursesSample.js`:

```js
// Synthetic sample of GET /courses/mycourses/past, matching the verified
// structure (li.course-item#course-{id} → .course-title, .course-code,
// div.section-item#section-{sectionId} → a[href="/course/{sectionId}"]).
// 3 courses / 4 sections: a single-section course, a 2-section course, and a
// no-course-code (MASTER-style) course. NOT real course data.
export const PAST_COURSES_HTML = `
<ul class="my-courses-list">
  <li class="course-item list-item" id="course-1001">
    <span class="course-title">Digital Design 9</span>
    <span class="course-code">DSGN9</span>
    <div class="section-item" id="section-7001">
      <a href="/course/7001">Section 2(A-B)</a>
    </div>
  </li>
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
  <li class="course-item list-item" id="course-1003">
    <span class="course-title">MASTER Art, Design &amp; Technology</span>
    <span class="course-code"></span>
    <div class="section-item" id="section-7004">
      <a href="/course/7004">Master Section</a>
    </div>
  </li>
</ul>
`;
```

- [ ] **Step 2: Write the failing parser test**

`server/lib/parsePastCourses.test.js`:

```js
import { describe, test, expect } from 'vitest';
import { parsePastCourses } from './parsePastCourses.js';
import { PAST_COURSES_HTML } from './__fixtures__/pastCoursesSample.js';

describe('parsePastCourses', () => {
  const rows = parsePastCourses(PAST_COURSES_HTML);

  test('returns one row per section (49-style section grain)', () => {
    expect(rows).toHaveLength(4);
  });

  test('extracts courseId/title/code and sectionId for a single-section course', () => {
    const r = rows.find((x) => x.sectionId === '7001');
    expect(r).toMatchObject({
      courseId: '1001',
      courseTitle: 'Digital Design 9',
      courseCode: 'DSGN9',
      sectionId: '7001',
    });
  });

  test('emits one row per section for a multi-section course, sharing course fields', () => {
    const multi = rows.filter((x) => x.courseId === '1002');
    expect(multi.map((x) => x.sectionId).sort()).toEqual(['7002', '7003']);
    expect(multi.every((x) => x.courseCode === 'GAME10')).toBe(true);
  });

  test('a course with an empty .course-code yields courseCode null (no-code signal)', () => {
    const master = rows.find((x) => x.sectionId === '7004');
    expect(master.courseCode).toBeNull();
    expect(master.courseTitle).toContain('MASTER');
  });

  test('returns an empty array for empty/garbage html', () => {
    expect(parsePastCourses('')).toEqual([]);
    expect(parsePastCourses('<div>nothing here</div>')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run server/lib/parsePastCourses.test.js`
Expected: FAIL — `Failed to resolve import "./parsePastCourses.js"`.

- [ ] **Step 4: Implement the parser**

`server/lib/parsePastCourses.js`:

```js
/**
 * parsePastCourses.js
 *
 * Pure parser for Schoology's past-courses page (GET /courses/mycourses/past,
 * browser-session auth — there is no JSON endpoint). Verified structure
 * (.claude/schoology-api-reference.md → "Three high-priority surfaces" #2):
 *   li.course-item#course-{courseId}
 *     .course-title, .course-code
 *     div.section-item#section-{sectionId}  (+ a[href="/course/{sectionId}"])
 *
 * Output is section-grained: one row per section-item (so a 2-section course
 * yields 2 rows sharing course fields). An empty .course-code → courseCode null
 * (the MASTER-style "not taught" signal). sectionTitle is best-effort.
 */
import { parse } from 'node-html-parser';

const stripPrefix = (id, prefix) => String(id || '').replace(new RegExp(`^${prefix}`), '');

export function parsePastCourses(html) {
  const root = parse(html || '');
  const out = [];
  for (const courseEl of root.querySelectorAll('li.course-item')) {
    const courseId = stripPrefix(courseEl.getAttribute('id'), 'course-');
    const courseTitle = courseEl.querySelector('.course-title')?.text.trim() || null;
    const rawCode = courseEl.querySelector('.course-code')?.text.trim();
    const courseCode = rawCode ? rawCode : null;
    for (const secEl of courseEl.querySelectorAll('.section-item')) {
      const sectionId = stripPrefix(secEl.getAttribute('id'), 'section-');
      if (!sectionId) continue;
      const sectionTitle =
        secEl.querySelector('.section-title')?.text.trim() ||
        secEl.querySelector('a[href^="/course/"]')?.text.trim() ||
        null;
      out.push({ courseId, courseTitle, courseCode, sectionId, sectionTitle });
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run server/lib/parsePastCourses.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add server/lib/parsePastCourses.js server/lib/parsePastCourses.test.js server/lib/__fixtures__/pastCoursesSample.js
git commit -m "feat(#5): pure parser for the past-courses HTML page"
```

---

### Task 2: `getPastSections` service (TDD, injected fetch)

**Files:**
- Create: `server/services/pastCourses.js`
- Test: `server/services/pastCourses.test.js`

- [ ] **Step 1: Write the failing service test**

`server/services/pastCourses.test.js`:

```js
import { describe, test, expect } from 'vitest';
import { getPastSections } from './pastCourses.js';
import { PAST_COURSES_HTML } from '../lib/__fixtures__/pastCoursesSample.js';

describe('getPastSections', () => {
  test('parses sections from fetched html', async () => {
    const list = await getPastSections(async () => PAST_COURSES_HTML);
    expect(list).toHaveLength(4);
    expect(list.map((s) => s.sectionId)).toContain('7002');
  });

  test('returns null when html is unavailable (no/expired session)', async () => {
    const list = await getPastSections(async () => null);
    expect(list).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/services/pastCourses.test.js`
Expected: FAIL — `Failed to resolve import "./pastCourses.js"`.

- [ ] **Step 3: Implement the service**

`server/services/pastCourses.js`:

```js
/**
 * pastCourses.js
 *
 * Best-effort reader for the teacher's past/archived course inventory via
 * Schoology's server-rendered page (GET /courses/mycourses/past, browser-session
 * auth — same saved Playwright session as the mastery sync). There is no JSON
 * endpoint, so the page HTML is scraped and parsed (parsePastCourses). Issue #5.
 *
 * Everything is best-effort: no saved session / expired session / launch or
 * navigation failure → returns null, and the caller treats discovery as
 * unavailable. It never throws.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { parsePastCourses } from '../lib/parsePastCourses.js';

const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');

function isLoggedInUrl(url) {
  return url.includes('schoology.hkis.edu.hk') &&
    !/\/login|\/saml|accounts\.google\.com|microsoftonline/.test(url);
}

/**
 * Fetch the raw past-courses HTML via the saved browser session. Returns the
 * page HTML, or null when there is no session / it has expired / anything fails.
 */
export async function fetchPastCoursesHtml() {
  if (!existsSync(STATE_FILE)) return null;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return null;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: STATE_FILE });
    const page = await context.newPage();
    await page.goto(`${SCHOOLOGY_BASE}/courses/mycourses/past`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    if (!isLoggedInUrl(page.url())) return null; // session expired → redirected to login
    return await page.content();
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Enumerate past sections. `fetchHtml` is injectable for testing (defaults to
 * the real browser fetch). Returns the parsed section list, or null when the
 * HTML is unavailable (so the caller can report discovery as unavailable).
 *
 * @param {() => Promise<string|null>} [fetchHtml]
 * @returns {Promise<Array<object>|null>}
 */
export async function getPastSections(fetchHtml = fetchPastCoursesHtml) {
  const html = await fetchHtml();
  if (!html) return null;
  return parsePastCourses(html);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/services/pastCourses.test.js`
Expected: PASS (2 tests). No browser is launched (fetch is injected).

- [ ] **Step 5: Commit**

```bash
git add server/services/pastCourses.js server/services/pastCourses.test.js
git commit -m "feat(#5): best-effort past-courses fetch service (getPastSections)"
```

---

### Task 3: `GET /api/courses/past` endpoint (TDD, route test)

**Files:**
- Modify: `server/routes/courses.js` (add route **before** `GET /:id` at line 35; add import)
- Test: `server/routes/courses.test.js` (add `vi.mock` + a describe block)

- [ ] **Step 1: Write the failing route tests**

In `server/routes/courses.test.js`, add the service mock at the top (after the existing `import express` line, before `import router`) and a new describe block at the end of the file.

Add near the top (the `vi.mock` is hoisted, so placement among imports is fine):

```js
vi.mock('../services/pastCourses.js', () => ({ getPastSections: vi.fn() }));
```

Add this import alongside the existing imports:

```js
import { getPastSections } from '../services/pastCourses.js';
```

Append this describe block:

```js
describe('GET /api/courses/past', () => {
  test('no session → { available: false }', async () => {
    getPastSections.mockResolvedValue(null);
    const { status, body } = await get('/api/courses/past');
    expect(status).toBe(200);
    expect(body).toEqual({ available: false, reason: 'no_session' });
  });

  test('annotates imported (already in DB) and noCourseCode', async () => {
    // beforeEach already seeded a course with schoology_section_id 'sec-1'.
    // Add one matching a discovered section so it reads as imported.
    getDb().prepare(
      `INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('7001', 'Digital Design 9', 1)`
    ).run();
    getPastSections.mockResolvedValue([
      { courseId: '1001', courseTitle: 'Digital Design 9', courseCode: 'DSGN9', sectionId: '7001', sectionTitle: null },
      { courseId: '1003', courseTitle: 'MASTER Art', courseCode: null, sectionId: '7004', sectionTitle: null },
    ]);

    const { status, body } = await get('/api/courses/past');
    expect(status).toBe(200);
    expect(body.available).toBe(true);

    const imported = body.sections.find((s) => s.sectionId === '7001');
    const master = body.sections.find((s) => s.sectionId === '7004');
    expect(imported.imported).toBe(true);
    expect(imported.noCourseCode).toBe(false);
    expect(master.imported).toBe(false);
    expect(master.noCourseCode).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/routes/courses.test.js`
Expected: FAIL — `GET /api/courses/past` returns the `/:id` 404 handler (or `available` is undefined), because the route doesn't exist yet.

- [ ] **Step 3: Add the route (before `GET /:id`) and the import**

In `server/routes/courses.js`, add to the imports (top of file):

```js
import { getPastSections } from '../services/pastCourses.js';
```

Insert this route **immediately after** `const router = Router();` (line 8) so it is matched before `router.get('/:id', ...)`:

```js
// GET /api/courses/past — enumerate past/archived sections by scraping
// /courses/mycourses/past (browser session). Annotates each with whether it's
// already imported and whether it lacks a course code. Registered before
// `/:id` so Express doesn't treat "past" as an :id. See issue #5.
router.get('/past', async (req, res) => {
  const sections = await getPastSections();
  if (!sections) return res.json({ available: false, reason: 'no_session' });

  const db = getDb();
  const known = new Set(
    db.prepare('SELECT schoology_section_id FROM courses').all().map((r) => String(r.schoology_section_id))
  );
  const annotated = sections.map((s) => ({
    ...s,
    imported: known.has(String(s.sectionId)),
    noCourseCode: !s.courseCode,
  }));
  res.json({ available: true, sections: annotated });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/routes/courses.test.js`
Expected: PASS (existing gradebook/students tests + the 2 new `past` tests).

- [ ] **Step 5: Commit**

```bash
git add server/routes/courses.js server/routes/courses.test.js
git commit -m "feat(#5): GET /api/courses/past — annotated past-section discovery"
```

---

### Task 4: Extract course-display helpers + `formatLastSynced` (refactor + TDD)

**Files:**
- Create: `client/src/lib/courseDisplay.js`
- Test: `client/src/lib/courseDisplay.test.js`
- Modify: `client/src/pages/Dashboard.jsx:5-30` (remove local fns), `Dashboard.jsx:1-3` (add import)

All client test commands run from `client/`.

- [ ] **Step 1: Create the shared module (move helpers verbatim + add `formatLastSynced`)**

`client/src/lib/courseDisplay.js`:

```js
// Course-card display helpers, shared by the Dashboard and the Sync dialog's
// Past-courses panel. parseGradingPeriod/groupByAcademicYear were extracted
// verbatim from Dashboard.jsx.

export function parseGradingPeriod(gradingPeriod) {
  if (!gradingPeriod) return { academicYear: 'Unknown', semester: 'Unknown' };
  let semester = 'Full Year';
  if (gradingPeriod.includes('Semester 1')) semester = 'Semester 1';
  else if (gradingPeriod.includes('Semester 2')) semester = 'Semester 2';
  const dateMatch = gradingPeriod.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (!dateMatch) return { academicYear: 'Unknown', semester };
  const month = parseInt(dateMatch[1], 10);
  const rawYear = parseInt(dateMatch[3], 10);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const startYear = month >= 8 ? year : year - 1;
  const academicYear = `${startYear}-${String(startYear + 1).slice(-2)}`;
  return { academicYear, semester };
}

export function groupByAcademicYear(courses) {
  const groups = {};
  for (const c of courses) {
    const { academicYear } = parseGradingPeriod(c.grading_period);
    if (!groups[academicYear]) groups[academicYear] = [];
    groups[academicYear].push(c);
  }
  return Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, yearCourses]) => ({ year, courses: yearCourses }));
}

// "synced 5/31/2026" / "never synced". synced_at is an ISO string or null.
export function formatLastSynced(syncedAt) {
  if (!syncedAt) return 'never synced';
  const d = new Date(syncedAt);
  if (Number.isNaN(d.getTime())) return 'never synced';
  return `synced ${d.toLocaleDateString()}`;
}
```

- [ ] **Step 2: Write the failing helper test**

`client/src/lib/courseDisplay.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parseGradingPeriod, groupByAcademicYear, formatLastSynced } from './courseDisplay.js';

describe('parseGradingPeriod', () => {
  it('extracts academic year and Semester 1', () => {
    expect(parseGradingPeriod('Semester 1: 08/14/2025 - 01/11/2026'))
      .toEqual({ academicYear: '2025-26', semester: 'Semester 1' });
  });
  it('defaults to Full Year when no semester marker', () => {
    expect(parseGradingPeriod('08/14/2025 - 06/01/2026').semester).toBe('Full Year');
  });
  it('returns Unknown for empty input', () => {
    expect(parseGradingPeriod('')).toEqual({ academicYear: 'Unknown', semester: 'Unknown' });
  });
});

describe('groupByAcademicYear', () => {
  it('groups and sorts years descending', () => {
    const groups = groupByAcademicYear([
      { id: 1, grading_period: 'Semester 1: 08/14/2024 - 01/11/2025' },
      { id: 2, grading_period: 'Semester 1: 08/14/2025 - 01/11/2026' },
    ]);
    expect(groups.map((g) => g.year)).toEqual(['2025-26', '2024-25']);
  });
});

describe('formatLastSynced', () => {
  it('returns "never synced" for null', () => {
    expect(formatLastSynced(null)).toBe('never synced');
  });
  it('formats an ISO timestamp', () => {
    expect(formatLastSynced('2026-05-31T00:00:00Z')).toMatch(/^synced /);
  });
});
```

- [ ] **Step 3: Run the helper test to verify it passes**

Run (from `client/`): `npx vitest run src/lib/courseDisplay.test.js`
Expected: PASS (the module already exists from Step 1).

- [ ] **Step 4: Point Dashboard at the shared module**

In `client/src/pages/Dashboard.jsx`:
- **Delete** the two local function definitions `parseGradingPeriod` (lines 5–18) and `groupByAcademicYear` (lines 20–30).
- **Add** this import after the existing `api.js` import (line 3):

```js
import { parseGradingPeriod, groupByAcademicYear } from '../lib/courseDisplay.js';
```

- [ ] **Step 5: Run the Dashboard tests to verify nothing broke**

Run (from `client/`): `npx vitest run`
Expected: PASS — all existing client tests still green (Dashboard now uses the extracted helpers).

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/courseDisplay.js client/src/lib/courseDisplay.test.js client/src/pages/Dashboard.jsx
git commit -m "refactor(#5): extract course-display helpers to lib/courseDisplay.js"
```

---

### Task 5: `api.getPastSections` + `PastCoursesPanel` (TDD)

**Files:**
- Modify: `client/src/services/api.js` (add one export)
- Create: `client/src/components/PastCoursesPanel.jsx`
- Test: `client/src/components/PastCoursesPanel.test.jsx`

- [ ] **Step 1: Add the api wrapper**

In `client/src/services/api.js`, after `getGradebook` (line 36):

```js
export const getPastSections = () => request('/courses/past');
```

- [ ] **Step 2: Write the failing panel test**

`client/src/components/PastCoursesPanel.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PastCoursesPanel from './PastCoursesPanel.jsx';
import { getPastSections, importCourse } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getPastSections: vi.fn(),
  importCourse: vi.fn(),
}));

const ARCHIVED = [
  { id: 10, course_name: 'Old Robotics', archived: 1,
    grading_period: 'Semester 1: 08/14/2024 - 01/11/2025', synced_at: '2025-01-20T00:00:00Z' },
];

const DISCOVERED = {
  available: true,
  sections: [
    { courseTitle: 'Photography 7', courseCode: null, sectionId: '7004', imported: false, noCourseCode: true },
    { courseTitle: 'Drama 8', courseCode: 'DRA8', sectionId: '7005', imported: false, noCourseCode: false },
  ],
};

function renderPanel(props = {}) {
  return render(
    <PastCoursesPanel
      courses={props.courses || ARCHIVED}
      loggedIn={props.loggedIn ?? true}
      onLogin={props.onLogin || (() => {})}
      busy={false}
    />
  );
}

function expand() {
  fireEvent.click(screen.getByLabelText(/Expand past courses/));
}

beforeEach(() => { vi.clearAllMocks(); });

describe('PastCoursesPanel', () => {
  it('lists imported archived courses grouped by year with Imported ✓', () => {
    renderPanel();
    expand();
    expect(screen.getByText('2024-25')).toBeInTheDocument();
    expect(screen.getByText('Old Robotics')).toBeInTheDocument();
    expect(screen.getByText(/Imported ✓/)).toBeInTheDocument();
  });

  it('discovers not-yet-imported sections, flags no-code, and sizes "Import all"', async () => {
    getPastSections.mockResolvedValue(DISCOVERED);
    renderPanel();
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for past courses/));
    await screen.findByText('Drama 8');
    expect(screen.getByText('Photography 7')).toBeInTheDocument();
    expect(screen.getByText(/no course code/)).toBeInTheDocument();
    expect(screen.getByText(/Import all \(1, excl\. no-code\)/)).toBeInTheDocument();
  });

  it('Import all imports only code-bearing, not-yet-imported sections', async () => {
    getPastSections.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({});
    renderPanel();
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for past courses/));
    await screen.findByText('Drama 8');
    fireEvent.click(screen.getByText(/Import all/));
    await waitFor(() => expect(importCourse).toHaveBeenCalledTimes(1));
    expect(importCourse).toHaveBeenCalledWith('7005');
  });

  it('shows the login prompt when discovery is unavailable', async () => {
    getPastSections.mockResolvedValue({ available: false, reason: 'no_session' });
    const onLogin = vi.fn();
    renderPanel({ onLogin });
    expand();
    fireEvent.click(screen.getByText(/Check Schoology for past courses/));
    await screen.findByText(/Log in to Schoology/);
    fireEvent.click(screen.getByText(/Log in to Schoology/));
    expect(onLogin).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the panel test to verify it fails**

Run (from `client/`): `npx vitest run src/components/PastCoursesPanel.test.jsx`
Expected: FAIL — `Failed to resolve import "./PastCoursesPanel.jsx"`.

- [ ] **Step 4: Implement the panel**

`client/src/components/PastCoursesPanel.jsx`:

```jsx
import { useState } from 'react';
import { getPastSections, importCourse } from '../services/api.js';
import { parseGradingPeriod, groupByAcademicYear, formatLastSynced } from '../lib/courseDisplay.js';

// Import-once panel for past/archived courses, embedded in the Sync dialog.
// Imported archived courses (already in the DB) render grouped by year; an
// explicit "Check Schoology for past courses" scrape surfaces not-yet-imported
// sections to import per-course or in bulk. Issue #5.
export default function PastCoursesPanel({ courses, loggedIn, onLogin, busy }) {
  const [collapsed, setCollapsed] = useState(true);
  const [discovered, setDiscovered] = useState(null); // null until checked
  const [checking, setChecking] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [importingId, setImportingId] = useState(null);
  const [importedIds, setImportedIds] = useState(() => new Set()); // imported this session
  const [bulk, setBulk] = useState(null); // { done, total } while bulk-importing
  const [error, setError] = useState(null);

  const yearGroups = groupByAcademicYear(courses.filter((c) => c.archived));

  const isImported = (s) => s.imported || importedIds.has(s.sectionId);
  const markImported = (sectionId) =>
    setImportedIds((prev) => new Set(prev).add(sectionId));

  async function handleCheck() {
    setChecking(true); setError(null); setNeedLogin(false);
    try {
      const res = await getPastSections();
      if (!res.available) { setNeedLogin(true); setDiscovered(null); }
      else setDiscovered(res.sections);
    } catch (e) {
      setError(e.message);
    } finally {
      setChecking(false);
    }
  }

  async function handleImport(sectionId) {
    setImportingId(sectionId); setError(null);
    try {
      await importCourse(sectionId);
      markImported(sectionId);
    } catch (e) {
      setError(e.message);
    } finally {
      setImportingId(null);
    }
  }

  async function handleImportAll() {
    const targets = (discovered || []).filter((s) => !isImported(s) && !s.noCourseCode);
    setBulk({ done: 0, total: targets.length }); setError(null);
    for (let i = 0; i < targets.length; i++) {
      try {
        await importCourse(targets[i].sectionId);
        markImported(targets[i].sectionId);
      } catch (e) {
        setError(e.message);
      }
      setBulk({ done: i + 1, total: targets.length });
    }
    setBulk(null);
  }

  const notImported = (discovered || []).filter((s) => !isImported(s));
  const importAllCount = notImported.filter((s) => !s.noCourseCode).length;

  return (
    <div className="sync-step">
      <div className="sync-step-title">
        <button
          type="button"
          className="sync-caret"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand past courses' : 'Collapse past courses'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span>Past courses</span>
        <span className="sync-badge">Import once</span>
      </div>

      {!collapsed && (
        <>
          {yearGroups.length === 0 ? (
            <p className="sync-step-desc">No past courses imported yet.</p>
          ) : (
            yearGroups.map(({ year, courses: yc }) => (
              <div className="sync-group" key={year}>
                <div className="sync-group-name">{year}</div>
                <div className="sync-course-list">
                  {yc.map((c) => {
                    const { semester } = parseGradingPeriod(c.grading_period);
                    return (
                      <div className="sync-course" key={c.id}>
                        <span>{c.course_name}</span>
                        <span className="text-muted text-sm">
                          {' '}— {semester} · Imported ✓ · {formatLastSynced(c.synced_at)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}

          <div className="sync-step-toggles" style={{ marginTop: '0.75rem' }}>
            <button type="button" className="secondary" onClick={handleCheck} disabled={checking || busy}>
              {checking ? 'Checking…' : 'Check Schoology for past courses'}
            </button>
          </div>

          {needLogin && (
            <div className="alert alert-warning sync-login-prompt">
              <p>Finding past courses needs a Schoology browser session. Log in once to enable it.</p>
              <button className="secondary" onClick={onLogin} disabled={busy}>Log in to Schoology</button>
            </div>
          )}

          {error && <div className="alert alert-warning">{error}</div>}

          {discovered && notImported.length > 0 && (
            <div className="sync-group">
              <div className="sync-group-name">
                Found on Schoology — not yet imported ({notImported.length})
              </div>
              <div className="sync-course-list">
                {notImported.map((s) => (
                  <div className="sync-course" key={s.sectionId}>
                    <span>
                      {s.courseTitle}
                      {s.noCourseCode && <span className="badge badge-gray"> no course code</span>}
                    </span>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => handleImport(s.sectionId)}
                      disabled={importingId === s.sectionId || !!bulk}
                    >
                      {importingId === s.sectionId ? 'Importing…' : 'Import'}
                    </button>
                  </div>
                ))}
              </div>
              {importAllCount > 0 && (
                <button
                  type="button"
                  className="primary"
                  onClick={handleImportAll}
                  disabled={!!bulk || importingId !== null}
                >
                  {bulk
                    ? `Importing ${bulk.done}/${bulk.total}…`
                    : `Import all (${importAllCount}, excl. no-code)`}
                </button>
              )}
            </div>
          )}

          {discovered && notImported.length === 0 && (
            <p className="sync-step-desc">All discovered past courses are imported.</p>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the panel test to verify it passes**

Run (from `client/`): `npx vitest run src/components/PastCoursesPanel.test.jsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/services/api.js client/src/components/PastCoursesPanel.jsx client/src/components/PastCoursesPanel.test.jsx
git commit -m "feat(#5): PastCoursesPanel — discover + per-course/bulk import"
```

---

### Task 6: Wire the panel into `SyncConfig` + current-course "last synced" line

**Files:**
- Modify: `client/src/components/SyncConfig.jsx`
- Modify: `client/src/components/SyncConfig.test.jsx`

- [ ] **Step 1: Write the failing SyncConfig assertions**

In `client/src/components/SyncConfig.test.jsx`, add `synced_at` to one visible course in the `COURSES` array so the line is assertable:

```js
const COURSES = [
  { id: 1, course_name: 'Biology 9', hidden: 0, archived: 0, synced_at: '2026-05-20T00:00:00Z' },
  { id: 2, course_name: 'Chemistry 11', hidden: 0, archived: 0 },
  { id: 3, course_name: 'Old Physics', hidden: 1, archived: 0 },
  { id: 4, course_name: 'Archived Bio', hidden: 0, archived: 1 },
];
```

Add two tests inside the `describe('SyncConfig', ...)` block:

```js
it('renders the Past courses panel', () => {
  renderConfig();
  expect(screen.getByText('Past courses')).toBeInTheDocument();
});

it('shows a last-synced line on a current course', () => {
  renderConfig();
  // Biology 9 is in the (expanded) visible group; its synced_at renders a line.
  expect(screen.getByText(/synced 5\/20\/2026/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run SyncConfig tests to verify the new ones fail**

Run (from `client/`): `npx vitest run src/components/SyncConfig.test.jsx`
Expected: FAIL on the two new tests ("Past courses" / "synced 5/20/2026" not found). Existing tests still pass.

- [ ] **Step 3: Render the panel + add the current-course line**

In `client/src/components/SyncConfig.jsx`:

Add imports at the top:

```js
import PastCoursesPanel from './PastCoursesPanel.jsx';
import { formatLastSynced } from '../lib/courseDisplay.js';
```

Update the visible-group course row so the synced line sits **outside** the `<label>` (keeping the input's accessible name unchanged so existing `getByLabelText` queries still pass). Replace the existing course-row map (lines 145–154):

```jsx
                      {group.courses.map((c) => (
                        <label className="sync-course" key={c.id}>
                          <input
                            type="checkbox"
                            checked={selected.has(c.id)}
                            onChange={() => toggleCourse(c.id)}
                          />
                          <span>{c.course_name}</span>
                        </label>
                      ))}
```

with:

```jsx
                      {group.courses.map((c) => (
                        <div className="sync-course-row" key={c.id}>
                          <label className="sync-course">
                            <input
                              type="checkbox"
                              checked={selected.has(c.id)}
                              onChange={() => toggleCourse(c.id)}
                            />
                            <span>{c.course_name}</span>
                          </label>
                          {group.key === 'visible' && (
                            <span className="text-muted text-sm">{formatLastSynced(c.synced_at)}</span>
                          )}
                        </div>
                      ))}
```

Render the panel just before the closing `</div>` of `Step 2` — i.e. immediately **after** the Step 2 `<div className="sync-step">` block (after line 162's closing `</div>`) and **before** the `<div className="sync-foot">` (line 164):

```jsx
      <PastCoursesPanel
        courses={courses}
        loggedIn={loggedIn}
        onLogin={onLogin}
        busy={busy}
      />
```

- [ ] **Step 4: Run the full client suite to verify everything passes**

Run (from `client/`): `npx vitest run`
Expected: PASS — existing SyncConfig tests (unchanged accessible names) + the two new SyncConfig tests + the panel/helper suites.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SyncConfig.jsx client/src/components/SyncConfig.test.jsx
git commit -m "feat(#5): surface PastCoursesPanel + last-synced line in the Sync dialog"
```

---

### Task 7: Live verification (45 / 49) + full suite

This is a verification task — no source changes. It confirms the parser against the **real** page (repo hard rule: never rely on an unobserved shape). Throwaway files live at the repo root as `_tmp_*.mjs` (gitignored) and are deleted after; no real course data is committed.

- [ ] **Step 1: Confirm the browser session is alive**

The scrape needs `.playwright-session/storage-state.json`. If it's missing or the probe below reports a login redirect, ask the user to run `! npm run mastery:login` and retry. Do not fabricate a result if the session is dead — report that discovery is unavailable.

- [ ] **Step 2: Capture the real page + run the parser (throwaway)**

Create `_tmp_past_probe.mjs` at the repo root:

```js
import { chromium } from 'playwright';
import { parsePastCourses } from './server/lib/parsePastCourses.js';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: '.playwright-session/storage-state.json' });
const page = await context.newPage();
await page.goto('https://schoology.hkis.edu.hk/courses/mycourses/past', { waitUntil: 'domcontentloaded', timeout: 30000 });
console.log('final url:', page.url());
const html = await page.content();
const rows = parsePastCourses(html);
const courseIds = new Set(rows.map((r) => r.courseId));
console.log('sections:', rows.length, 'courses:', courseIds.size);
console.log('no-code sections:', rows.filter((r) => !r.courseCode).length);
console.log('sample (masked titles):', rows.slice(0, 3).map((r) => ({
  courseId: r.courseId, sectionId: r.sectionId, hasCode: !!r.courseCode, titleLen: (r.courseTitle || '').length,
})));
await browser.close();
```

Run: `node _tmp_past_probe.mjs`
Expected: `final url:` stays on `schoology.hkis.edu.hk` (not a login/SAML URL); **~45 courses / ~49 sections**. If counts are far off, the live structure diverged from the fixture — inspect the HTML (`page.content()`), adjust the parser + fixture, and re-run Task 1 before continuing. Mask titles (lengths only) in any output; do not commit the captured HTML.

- [ ] **Step 3: Delete the throwaway**

Run: `rm -f _tmp_past_probe.mjs`

- [ ] **Step 4: Run both full suites**

Run (repo root): `npx vitest run` → expected all green (was 110 before; +2 service +2 route here).
Run (from `client/`): `npx vitest run` → expected all green (was 107 before; + courseDisplay + PastCoursesPanel + SyncConfig additions).

- [ ] **Step 5: (no commit — verification only)**

If Step 2 forced a parser/fixture change, that change was committed under Task 1's flow; otherwise nothing to commit here.

---

### Task 8: Docs + issue hygiene

**Files:**
- Modify: `.claude/build-progress.md`
- Modify: `.claude/schoology-api-reference.md` (only if Step 2 of Task 7 revealed a structural correction)

- [ ] **Step 1: Record the build in `build-progress.md`**

Append a dated entry summarizing: parser (`parsePastCourses`) + service (`getPastSections`, best-effort) + `GET /api/courses/past` + `PastCoursesPanel` in the Sync dialog; reuses `POST /api/courses/import` per section; import-once model; live-verified counts from Task 7. Include an explicit **"not yet explored"** line: the inert "Include archived" toggle cleanup (deferred), and bulk-import resilience under a real multi-section run (only the per-call path is unit-tested).

- [ ] **Step 2: Correct the API reference only if needed**

If Task 7 revealed the live structure differs from the documented `.course-title`/`.course-code`/`section-item` shape, correct the "Three high-priority surfaces" #2 note in `.claude/schoology-api-reference.md` in place (don't append). Otherwise leave it.

- [ ] **Step 3: Commit**

```bash
git add .claude/build-progress.md .claude/schoology-api-reference.md
git commit -m "docs(#5): record past-course discovery build + live-verified counts"
```

- [ ] **Step 4: Comment on issue #5**

Post a brief `gh issue comment 5` summarizing what shipped (discovery + per-course/bulk import in the Sync dialog, import-once), the live-verified section count, and the deferred items. Do not close — leave that to the user.

---

## Self-Review

**Spec coverage:**
- Scrape `/courses/mycourses/past` → Task 1 (parser) + Task 2 (service). ✓
- `GET /api/courses/past` with `imported`/`noCourseCode` + no-session branch → Task 3. ✓
- Reuse `POST /api/courses/import`; bulk = frontend loop → Task 5 (`handleImportAll`). ✓
- No-code shown/flagged, excluded from "Import all" → Task 5 test + impl. ✓
- Import-once, no re-sync affordance; grouped by year + semester + Imported ✓ → Task 5. ✓
- Cheap on load (DB-known), explicit scrape → Task 5 (`courses` prop vs. `handleCheck`). ✓
- Home = Sync dialog; current-course last-synced line → Task 6. ✓
- No-session → reuse login prompt → Task 5 test + impl. ✓
- Live verification 45/49 → Task 7. ✓
- Deferred: inert "Include archived" toggle, fully-auto sync, server bulk endpoint → untouched; toggle noted in Task 8. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output. ✓

**Type/name consistency:** `parsePastCourses` (rows: `courseId/courseTitle/courseCode/sectionId/sectionTitle`) → `getPastSections(fetchHtml)` → route adds `imported/noCourseCode` + `{ available, sections }` / `{ available:false, reason:'no_session' }` → `api.getPastSections()` → panel consumes `available/sections` and `s.sectionId/s.courseTitle/s.noCourseCode/s.imported`. `formatLastSynced`, `parseGradingPeriod`, `groupByAcademicYear` consistent across Tasks 4–6. ✓
