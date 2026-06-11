# Student Grade Level Sync & Display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `students.grad_year` from PowerSchool's attendance app and show each student's grade level on the profile, the search page, and the class roster (issue #43).

**Architecture:** Generalize the existing per-active-course PowerSchool pass (`blockNumberSync.js` → `psAttendanceSync.js`) so that, in one session, it resolves both block number (per-course) and grade level (per-student) — reading `gradeLevel` from `/ws/attendance/section_attendance` for an in-session day derived from the `section_info` calendar it already fetches. Grade level is stored as the time-invariant `grad_year` (computed `Y + (12 − gradeLevel)`); the displayed current grade is derived on read via one shared client helper, shown only for grades 1–12 (a departed student shows just "Class of YYYY").

**Tech Stack:** Node/Express + better-sqlite3 (ESM), Playwright (saved-session PowerSchool reads), React + Vite, Vitest (server + client) with React Testing Library.

**Spec:** `docs/superpowers/specs/2026-06-10-grade-level-sync-design.md`
**API intel:** `.claude/powerschool-api-reference.md` ("Deriving grade / graduating year", Step 3 roster).

**Conventions:** No schema change (reuse `students.grad_year`). Run server tests with `npm run test:server`, client tests with `npm run test:client` (or per-file `npx vitest run <path>`). Commit after each task.

---

## Phase 1 — Display (frontend). Safe to land first: surfaces stay empty until Phase 2 populates `grad_year`, which is current behaviour.

### Task 1: Shared client grade-level helper

**Files:**
- Create: `client/src/lib/gradeLevel.js`
- Test: `client/src/lib/gradeLevel.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// client/src/lib/gradeLevel.test.js
import { describe, it, expect } from 'vitest';
import { schoolYearEndYear, gradYearToLevel, formatGradeBadge } from './gradeLevel.js';

const JAN_2026 = new Date('2026-01-15'); // school year ending 2026
const AUG_2025 = new Date('2025-08-15'); // first day of school year ending 2026
const JUL_2025 = new Date('2025-07-15'); // still school year ending 2025

describe('schoolYearEndYear', () => {
  it('rolls over in August (month index >= 7)', () => {
    expect(schoolYearEndYear(AUG_2025)).toBe(2026);
    expect(schoolYearEndYear(JAN_2026)).toBe(2026);
    expect(schoolYearEndYear(JUL_2025)).toBe(2025);
  });
});

describe('gradYearToLevel', () => {
  it('derives the current grade from grad_year', () => {
    expect(gradYearToLevel(2026, JAN_2026)).toBe(12);
    expect(gradYearToLevel(2027, JAN_2026)).toBe(11);
    expect(gradYearToLevel(2029, JAN_2026)).toBe(9);
  });
  it('returns null for a graduated student (derived grade out of 1–12)', () => {
    expect(gradYearToLevel(2025, JAN_2026)).toBeNull(); // would be grade 13
  });
  it('returns null when grad_year is missing', () => {
    expect(gradYearToLevel(null, JAN_2026)).toBeNull();
    expect(gradYearToLevel(0, JAN_2026)).toBeNull();
  });
});

describe('formatGradeBadge', () => {
  it('labels an active student with grade and class', () => {
    expect(formatGradeBadge(2027, JAN_2026)).toEqual({ grade: 11, classOf: 2027, label: 'Grade 11 · Class of 2027' });
  });
  it('labels a departed student with class only', () => {
    expect(formatGradeBadge(2025, JAN_2026)).toEqual({ grade: null, classOf: 2025, label: 'Class of 2025' });
  });
  it('returns null when grad_year is missing', () => {
    expect(formatGradeBadge(null, JAN_2026)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && npx vitest run src/lib/gradeLevel.test.js`
Expected: FAIL — `Failed to resolve import "./gradeLevel.js"`.

- [ ] **Step 3: Write the implementation**

```js
// client/src/lib/gradeLevel.js
//
// Derive a student's grade level / graduating-year label from the stored
// (PowerSchool-derived) grad_year. grad_year is the time-INVARIANT value Prism
// persists; the current grade is derived on read so a departed student (whose
// grad_year stops being re-synced) never shows a stale grade. See
// docs/superpowers/specs/2026-06-10-grade-level-sync-design.md.

// A school year is named by its ENDING calendar year and rolls over in August
// (month index >= 7). 2025-26 → 2026.
export function schoolYearEndYear(now = new Date()) {
  return now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
}

// Current grade (1–12) derived from grad_year, or null when out of range
// (e.g. a graduated student whose derived grade exceeds 12).
export function gradYearToLevel(gradYear, now = new Date()) {
  if (!gradYear) return null;
  const grade = 12 - (gradYear - schoolYearEndYear(now));
  return grade >= 1 && grade <= 12 ? grade : null;
}

// Badge parts for a student:
//   active   → { grade: 11, classOf: 2027, label: 'Grade 11 · Class of 2027' }
//   departed → { grade: null, classOf: 2025, label: 'Class of 2025' }
//   unknown  → null  (no grad_year)
export function formatGradeBadge(gradYear, now = new Date()) {
  if (!gradYear) return null;
  const grade = gradYearToLevel(gradYear, now);
  const label = grade ? `Grade ${grade} · Class of ${gradYear}` : `Class of ${gradYear}`;
  return { grade, classOf: gradYear, label };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && npx vitest run src/lib/gradeLevel.test.js`
Expected: PASS (10 assertions).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/gradeLevel.js client/src/lib/gradeLevel.test.js
git commit -m "feat(#43): shared client grade-level helper (derive grade from invariant grad_year)"
```

---

### Task 2: Rewire the StudentPage badge to the shared helper

**Files:**
- Modify: `client/src/pages/StudentPage.jsx` (remove local `gradYearToLevel` at lines 48–56; update badge at 374–381; add import)

- [ ] **Step 1: Add the import**

At the top of `client/src/pages/StudentPage.jsx`, with the other `../lib/...` imports, add:

```js
import { formatGradeBadge } from '../lib/gradeLevel.js';
```

- [ ] **Step 2: Delete the local `gradYearToLevel`**

Remove this block (currently lines 48–56):

```js
function gradYearToLevel(gradYear) {
  if (!gradYear) return null;
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth(); // 0-indexed
  // Academic year starts in August: if we're past August, grad year minus current year
  const academicYear = currentMonth >= 7 ? currentYear + 1 : currentYear;
  const grade = 12 - (gradYear - academicYear);
  return grade >= 1 && grade <= 12 ? grade : null;
}
```

- [ ] **Step 3: Update the badge to use the helper**

Replace the badge block (currently lines 374–381):

```jsx
                  {student.grad_year && (() => {
                    const gradeLevel = gradYearToLevel(student.grad_year);
                    return (
                      <span className="badge badge-blue" title={`Graduating ${student.grad_year}`}>
                        {gradeLevel ? `Grade ${gradeLevel}` : ''} (Class of {student.grad_year})
                      </span>
                    );
                  })()}
```

with:

```jsx
                  {student.grad_year && (() => {
                    const badge = formatGradeBadge(student.grad_year);
                    return (
                      <span className="badge badge-blue" title={`Graduating ${student.grad_year}`}>
                        {badge.label}
                      </span>
                    );
                  })()}
```

- [ ] **Step 4: Run the existing StudentPage tests to verify nothing breaks**

Run: `cd client && npx vitest run src/pages/StudentPage.test.jsx`
Expected: PASS (existing `CourseSection` tests unaffected; the badge logic is now covered by `gradeLevel.test.js`).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/StudentPage.jsx
git commit -m "refactor(#43): StudentPage badge uses shared formatGradeBadge (Grade N · Class of YYYY)"
```

---

### Task 3: Grade column on the student search page

**Files:**
- Modify: `client/src/pages/SearchPage.jsx` (add import, header, cell)
- Test: `client/src/pages/SearchPage.test.jsx` (create)

- [ ] **Step 1: Write the failing test**

```jsx
// client/src/pages/SearchPage.test.jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SearchPage from './SearchPage.jsx';

vi.mock('../services/api.js', () => ({
  searchStudents: vi.fn().mockResolvedValue([
    { id: 1, first_name: 'Ana', last_name: 'Lee', email: 'ana@hkis.edu.hk', grad_year: 2027 },
    { id: 2, first_name: 'Bo', last_name: 'Ng', email: 'bo@hkis.edu.hk', grad_year: 2025 },
  ]),
}));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-15')); });
afterEach(() => { vi.useRealTimers(); });

describe('SearchPage grade column', () => {
  it('shows the derived grade for an active student and a dash for a graduated one', async () => {
    render(<MemoryRouter><SearchPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Ana Lee')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: 'Grade' })).toBeInTheDocument();
    expect(screen.getByText('Grade 11')).toBeInTheDocument(); // Ana, grad_year 2027
    expect(screen.getByText('—')).toBeInTheDocument();        // Bo, grad_year 2025 (graduated)
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run src/pages/SearchPage.test.jsx`
Expected: FAIL — no `Grade` column header / `Grade 11` text.

- [ ] **Step 3: Add the import**

In `client/src/pages/SearchPage.jsx`, after the existing imports add:

```js
import { gradYearToLevel } from '../lib/gradeLevel.js';
```

- [ ] **Step 4: Add the header cell**

In the `<thead>` row (currently lines 60–64), add a `Grade` header after `Email`:

```jsx
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Grade</th>
                </tr>
```

- [ ] **Step 5: Add the body cell**

After the email cell (currently line 98 `<td className="text-sm">{s.email || '-'}</td>`), add:

```jsx
                    <td className="text-sm">
                      {gradYearToLevel(s.grad_year) ? `Grade ${gradYearToLevel(s.grad_year)}` : '—'}
                    </td>
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd client && npx vitest run src/pages/SearchPage.test.jsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/SearchPage.jsx client/src/pages/SearchPage.test.jsx
git commit -m "feat(#43): grade column on student search page"
```

---

### Task 4: Grade column on the class roster

**Files:**
- Modify: `client/src/pages/CoursePage.jsx` (export `RosterView`; add import, header, cell)
- Test: `client/src/pages/CoursePage.roster.test.jsx` (create)

- [ ] **Step 1: Export `RosterView` and add the import**

In `client/src/pages/CoursePage.jsx`, change the declaration (currently line 177) from:

```jsx
function RosterView({ students, mastery, courseId, displayName, onOverrideClick }) {
```

to:

```jsx
export function RosterView({ students, mastery, courseId, displayName, onOverrideClick }) {
```

And add this import near the other `../lib/...` imports (top of file):

```js
import { gradYearToLevel } from '../lib/gradeLevel.js';
```

- [ ] **Step 2: Write the failing test**

```jsx
// client/src/pages/CoursePage.roster.test.jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RosterView } from './CoursePage.jsx';

// RosterView calls useProficiencyScale(); stub it (no mastery categories rendered here).
vi.mock('../hooks/useProficiencyScale.js', () => ({
  useProficiencyScale: () => ({ pointsToLevel: () => null }),
}));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-15')); });
afterEach(() => { vi.useRealTimers(); });

const students = [
  { id: 1, first_name: 'Ana', last_name: 'Lee', email: 'ana@hkis.edu.hk', grad_year: 2027 },
];

describe('RosterView grade column', () => {
  it('renders a Grade header and the derived grade', () => {
    render(
      <MemoryRouter>
        <table><tbody></tbody></table>
      </MemoryRouter>
    );
    // Render the real component (wrapped so <td>/<th> have a table ancestor).
    render(
      <MemoryRouter>
        <RosterView
          students={students}
          mastery={null}
          courseId={1}
          displayName={(s) => s.first_name}
          onOverrideClick={() => {}}
        />
      </MemoryRouter>
    );
    expect(screen.getByRole('columnheader', { name: 'Grade' })).toBeInTheDocument();
    expect(screen.getByText('Grade 11')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd client && npx vitest run src/pages/CoursePage.roster.test.jsx`
Expected: FAIL — no `Grade` column header / `Grade 11` text.

- [ ] **Step 4: Add the header cell**

In `RosterView`'s `<thead>` row 1 (currently lines 222–224), add a `Grade` header after `Email`:

```jsx
            <th rowSpan={2}></th>
            <th rowSpan={2}>Name</th>
            <th rowSpan={2}>Email</th>
            <th rowSpan={2}>Grade</th>
```

- [ ] **Step 5: Add the body cell**

After the email cell (currently line 366 `<td className="text-sm">{s.email || '-'}</td>`), add:

```jsx
                <td className="text-sm">
                  {gradYearToLevel(s.grad_year) ? `Grade ${gradYearToLevel(s.grad_year)}` : '—'}
                </td>
```

- [ ] **Step 6: Run the roster test and the existing CoursePage test to verify both pass**

Run: `cd client && npx vitest run src/pages/CoursePage.roster.test.jsx src/pages/CoursePage.test.jsx`
Expected: PASS (the new column is additive; existing CoursePage tests unaffected).

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/CoursePage.jsx client/src/pages/CoursePage.roster.test.jsx
git commit -m "feat(#43): grade column on the class roster (export RosterView for testing)"
```

---

## Phase 2 — Sync (backend). Populates `grad_year` so Phase 1 surfaces light up.

### Task 5: Pure grade-level helpers

**Files:**
- Create: `server/lib/psGradeLevel.js`
- Test: `server/lib/psGradeLevel.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// server/lib/psGradeLevel.test.js
import { describe, test, expect } from 'vitest';
import {
  currentSchoolYearEndYear,
  gradeLevelToGradYear,
  pickInSessionDate,
  extractGradeLevels,
  userDcidFromLaunchForm,
} from './psGradeLevel.js';

describe('currentSchoolYearEndYear', () => {
  test('rolls over in August', () => {
    expect(currentSchoolYearEndYear(new Date('2025-08-15'))).toBe(2026);
    expect(currentSchoolYearEndYear(new Date('2026-01-15'))).toBe(2026);
    expect(currentSchoolYearEndYear(new Date('2025-07-15'))).toBe(2025);
  });
});

describe('gradeLevelToGradYear', () => {
  test('grad_year = schoolYearEndYear + (12 − gradeLevel)', () => {
    expect(gradeLevelToGradYear(12, 2026)).toBe(2026);
    expect(gradeLevelToGradYear(11, 2026)).toBe(2027);
    expect(gradeLevelToGradYear(9, 2026)).toBe(2029);
  });
  test('returns null for a non-integer grade', () => {
    expect(gradeLevelToGradYear(null, 2026)).toBeNull();
    expect(gradeLevelToGradYear('11', 2026)).toBeNull();
  });
});

describe('pickInSessionDate', () => {
  const cal = {
    '2026-06-08': { inSession: true },
    '2026-06-09': { inSession: true },
    '2026-06-13': { inSession: false }, // weekend
    '2026-06-15': { inSession: true },
  };
  test('most recent in-session day on or before today', () => {
    expect(pickInSessionDate({ calenderDays: cal }, '2026-06-10')).toBe('2026-06-09');
  });
  test('earliest future in-session day when the year has not started', () => {
    expect(pickInSessionDate({ calenderDays: cal }, '2026-06-01')).toBe('2026-06-08');
  });
  test('null when no in-session days exist', () => {
    expect(pickInSessionDate({ calenderDays: { '2026-06-13': { inSession: false } } }, '2026-06-10')).toBeNull();
    expect(pickInSessionDate({}, '2026-06-10')).toBeNull();
  });
});

describe('extractGradeLevels', () => {
  test('pulls { dcid, gradeLevel } from the nested roster', () => {
    const json = {
      sectionAttendances: [{
        studentAttendance: [
          { dcid: 42302, gradeLevel: 10, lastName: 'X' },
          { dcid: 52516, gradeLevel: 11, lastName: 'Y' },
          { dcid: 99999, lastName: 'Z' }, // no gradeLevel → skipped
        ],
      }],
    };
    expect(extractGradeLevels(json)).toEqual([
      { dcid: '42302', gradeLevel: 10 },
      { dcid: '52516', gradeLevel: 11 },
    ]);
  });
  test('empty/garbage input → []', () => {
    expect(extractGradeLevels(null)).toEqual([]);
    expect(extractGradeLevels({})).toEqual([]);
  });
});

describe('userDcidFromLaunchForm', () => {
  test('extracts custom_userdcid and strips the realm prefix', () => {
    expect(userDcidFromLaunchForm('<input name="custom_userdcid" value="2_10405">')).toBe('10405');
  });
  test('null when absent or empty', () => {
    expect(userDcidFromLaunchForm('<input name="custom_sectiondcid" value="49355">')).toBeNull();
    expect(userDcidFromLaunchForm('<input name="custom_userdcid" value="">')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/lib/psGradeLevel.test.js`
Expected: FAIL — `Cannot find module './psGradeLevel.js'`.

- [ ] **Step 3: Write the implementation**

```js
// server/lib/psGradeLevel.js
//
// Pure helpers for syncing per-student grade level from PowerSchool's attendance
// app (issue #43). gradeLevel (9–12) is read from /ws/attendance/section_attendance
// and joined to Prism students by school_uid === '1_' + dcid. Prism stores the
// INVARIANT grad_year (not the raw grade) and derives the displayed grade on read.
// See docs/superpowers/specs/2026-06-10-grade-level-sync-design.md and
// .claude/powerschool-api-reference.md "Deriving grade / graduating year".

// School year named by its ENDING calendar year, rolling over in August. 2025-26 → 2026.
export function currentSchoolYearEndYear(now = new Date()) {
  return now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
}

// grad_year from a current grade level (inverse of the client's gradYearToLevel).
export function gradeLevelToGradYear(gradeLevel, schoolYearEndYear) {
  if (!Number.isInteger(gradeLevel)) return null;
  return schoolYearEndYear + (12 - gradeLevel);
}

// Pick the date to query section_attendance for: the most recent in-session day
// on or before `today` (ISO YYYY-MM-DD); else the earliest future in-session day;
// else null. `sectionInfo` is section_info[0]; its calendar lives under
// `calenderDays` (PowerSchool's spelling) or `calendarDays`, each value carrying
// an `inSession` boolean. (ISO dates sort lexicographically.)
export function pickInSessionDate(sectionInfo, today) {
  const cal = sectionInfo?.calenderDays || sectionInfo?.calendarDays || {};
  const inSession = Object.entries(cal)
    .filter(([, d]) => d && d.inSession)
    .map(([date]) => date)
    .sort();
  if (inSession.length === 0) return null;
  const past = inSession.filter((d) => d <= today);
  return past.length ? past[past.length - 1] : inSession[0];
}

// Extract [{ dcid, gradeLevel }] from a section_attendance response. The roster is
// sectionAttendances[].studentAttendance[]; each entry carries dcid + gradeLevel.
// dcid is normalised to a string for the '1_' + dcid join.
export function extractGradeLevels(sectionAttendanceJson) {
  const out = [];
  for (const sec of sectionAttendanceJson?.sectionAttendances || []) {
    for (const sa of sec?.studentAttendance || []) {
      if (sa && sa.dcid != null && Number.isInteger(sa.gradeLevel)) {
        out.push({ dcid: String(sa.dcid), gradeLevel: sa.gradeLevel });
      }
    }
  }
  return out;
}

// Extract the teacher userDcid from the LTI launch-form HTML (hidden input
// custom_userdcid, e.g. "2_10405"), stripping the realm prefix. PowerSchool
// resolves the real user from the session, so this only needs to be plausible.
export function userDcidFromLaunchForm(html) {
  if (!html || typeof html !== 'string') return null;
  const m = html.match(/name=["']custom_userdcid["'][^>]*?value=["']([^"']*)["']/i)
    || html.match(/value=["']([^"']*)["'][^>]*?name=["']custom_userdcid["']/i);
  if (!m) return null;
  const v = m[1].trim();
  if (!v) return null;
  return v.includes('_') ? v.split('_').pop() : v;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/lib/psGradeLevel.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/psGradeLevel.js server/lib/psGradeLevel.test.js
git commit -m "feat(#43): pure helpers for PowerSchool grade-level sync"
```

---

### Task 6: Rename `blockNumberSync` → `psAttendanceSync` (pure refactor, behaviour identical)

**Files:**
- Rename: `server/services/blockNumberSync.js` → `server/services/psAttendanceSync.js`
- Rename: `server/services/blockNumberSync.test.js` → `server/services/psAttendanceSync.test.js`
- Modify: `server/routes/courses.js` (lines 8, 312), `server/routes/courses.test.js` (lines 14, 21, 277, 290, 299), `server/services/syncOrchestrator.js` (lines 4, 58), `server/services/syncOrchestrator.test.js` (lines 14, 18, 43, 46, 108, 112, 126, 132)

- [ ] **Step 1: Rename the files with git**

```bash
git mv server/services/blockNumberSync.js server/services/psAttendanceSync.js
git mv server/services/blockNumberSync.test.js server/services/psAttendanceSync.test.js
```

- [ ] **Step 2: Rename the export and log prefix inside `psAttendanceSync.js`**

- Line ~131: `export async function syncBlockNumbers(` → `export async function syncPsAttendance(`
- Line ~132 log prefix: `` `[blockNumberSync] ${message}` `` → `` `[psAttendanceSync] ${message}` ``
- Header comment line 2: `* blockNumberSync.js` → `* psAttendanceSync.js`

- [ ] **Step 3: Update `psAttendanceSync.test.js`**

- Line 11: `import { syncBlockNumbers } from './blockNumberSync.js';` → `import { syncPsAttendance } from './psAttendanceSync.js';`
- Replace the three `syncBlockNumbers(...)` call sites (lines ~26, 33, 39) with `syncPsAttendance(...)`.
- Update the `describe('syncBlockNumbers — guard', ...)` label to `describe('syncPsAttendance — guard', ...)`.

- [ ] **Step 4: Update `server/routes/courses.js`**

- Line 8: `import { syncBlockNumbers } from '../services/blockNumberSync.js';` → `import { syncPsAttendance } from '../services/psAttendanceSync.js';`
- Line 312: `await syncBlockNumbers({ courseIds: [courseRow.id] });` → `await syncPsAttendance({ courseIds: [courseRow.id] });`

- [ ] **Step 5: Update `server/routes/courses.test.js`**

- Line 14: `vi.mock('../services/blockNumberSync.js', () => ({ syncBlockNumbers: vi.fn().mockResolvedValue({ processed: 1, updated: 1, unchanged: 0, skipped: 0, results: [] }) }));`
  → `vi.mock('../services/psAttendanceSync.js', () => ({ syncPsAttendance: vi.fn().mockResolvedValue({ processed: 1, updated: 1, unchanged: 0, skipped: 0, results: [] }) }));`
- Line 21: `import { syncBlockNumbers } from '../services/blockNumberSync.js';` → `import { syncPsAttendance } from '../services/psAttendanceSync.js';`
- Lines 277, 290, 299: replace each `syncBlockNumbers` identifier with `syncPsAttendance`.

- [ ] **Step 6: Update `server/services/syncOrchestrator.js`**

- Line 4: `import { syncBlockNumbers } from './blockNumberSync.js';` → `import { syncPsAttendance } from './psAttendanceSync.js';`
- Line 58: `const r = await syncBlockNumbers({` → `const r = await syncPsAttendance({`

- [ ] **Step 7: Update `server/services/syncOrchestrator.test.js`**

- Line 14: `vi.mock('./blockNumberSync.js', () => ({ syncBlockNumbers: vi.fn() }));` → `vi.mock('./psAttendanceSync.js', () => ({ syncPsAttendance: vi.fn() }));`
- Line 18: `import { syncBlockNumbers } from './blockNumberSync.js';` → `import { syncPsAttendance } from './psAttendanceSync.js';`
- Lines 43, 46, 108, 112, 126, 132: replace each `syncBlockNumbers` identifier with `syncPsAttendance`.

- [ ] **Step 8: Verify no stale references remain**

Run: `grep -rn "syncBlockNumbers\|blockNumberSync" server client --include="*.js" --include="*.jsx" | grep -v node_modules`
Expected: no output.

- [ ] **Step 9: Run the full server suite to verify green**

Run: `npm run test:server`
Expected: PASS (same count as before the rename — behaviour unchanged).

- [ ] **Step 10: Commit**

```bash
git add -A server/services/psAttendanceSync.js server/services/psAttendanceSync.test.js server/routes/courses.js server/routes/courses.test.js server/services/syncOrchestrator.js server/services/syncOrchestrator.test.js
git commit -m "refactor(#43): rename blockNumberSync → psAttendanceSync (no behaviour change)"
```

---

### Task 7: `applyGradeLevels` — batched DB write joined by `school_uid`

**Files:**
- Modify: `server/services/psAttendanceSync.js` (add import + exported `applyGradeLevels`)
- Modify: `server/services/psAttendanceSync.test.js` (add a DB-backed describe block)

- [ ] **Step 1: Write the failing test**

Add to `server/services/psAttendanceSync.test.js` (it already mocks `getDb` and imports `migrate` + `Database`). Add `applyGradeLevels` to the import on line 11:

```js
import { syncPsAttendance, applyGradeLevels } from './psAttendanceSync.js';
```

Then append this describe block:

```js
describe('applyGradeLevels', () => {
  beforeEach(() => { h.db = new Database(':memory:'); migrate(h.db); });

  function seedStudent(schoolUid, gradYear = null) {
    const id = h.db.prepare(
      'INSERT INTO students (first_name, last_name, school_uid, grad_year) VALUES (?, ?, ?, ?)'
    ).run('First', 'Last', schoolUid, gradYear).lastInsertRowid;
    return id;
  }

  test('sets grad_year for matched students and leaves unmatched ones untouched', () => {
    const matched = seedStudent('1_42302', null);     // Gr 10 → 2028
    const other = seedStudent('1_77777', 2099);        // not in the map → preserved
    const map = new Map([['42302', 10], ['00000', 11]]); // 00000 has no matching student

    const updated = applyGradeLevels(h.db, map, new Date('2026-01-15'));

    expect(updated).toBe(1);
    expect(h.db.prepare('SELECT grad_year FROM students WHERE id = ?').get(matched).grad_year).toBe(2028);
    expect(h.db.prepare('SELECT grad_year FROM students WHERE id = ?').get(other).grad_year).toBe(2099);
  });

  test('empty map → no updates', () => {
    seedStudent('1_42302', 2027);
    expect(applyGradeLevels(h.db, new Map(), new Date('2026-01-15'))).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/services/psAttendanceSync.test.js`
Expected: FAIL — `applyGradeLevels is not a function` (not exported yet).

- [ ] **Step 3: Implement `applyGradeLevels`**

In `server/services/psAttendanceSync.js`, add to the imports near the top:

```js
import { currentSchoolYearEndYear, gradeLevelToGradYear } from '../lib/psGradeLevel.js';
```

And add this exported function (place it above `syncPsAttendance`):

```js
/**
 * Apply a Map<dcid → gradeLevel> to the students table: set each matched
 * student's grad_year (join: students.school_uid === '1_' + dcid). Stores the
 * INVARIANT grad_year (computed from the current grade), never the raw grade.
 * Students absent from the map are left untouched (never nulled). Returns the
 * number of student rows updated.
 */
export function applyGradeLevels(db, gradeByDcid, now = new Date()) {
  const yearEnd = currentSchoolYearEndYear(now);
  const ts = now.toISOString();
  const update = db.prepare('UPDATE students SET grad_year = ?, updated_at = ? WHERE school_uid = ?');
  let updated = 0;
  const tx = db.transaction((entries) => {
    for (const [dcid, gradeLevel] of entries) {
      const gradYear = gradeLevelToGradYear(gradeLevel, yearEnd);
      if (gradYear == null) continue;
      updated += update.run(gradYear, ts, `1_${dcid}`).changes;
    }
  });
  tx([...gradeByDcid.entries()]);
  return updated;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/services/psAttendanceSync.test.js`
Expected: PASS (guard tests + the two `applyGradeLevels` tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/psAttendanceSync.js server/services/psAttendanceSync.test.js
git commit -m "feat(#43): applyGradeLevels — batched grad_year write joined by school_uid"
```

---

### Task 8: Wire the `section_attendance` read into the sync loop

**Files:**
- Modify: `server/services/psAttendanceSync.js` (extend launch-id fetch, add `section_attendance` fetch, accumulate + apply grades, extend summary)

This wires the live read. The pure pieces (extraction, date pick, DB write) are already unit-tested; the Playwright loop itself is verified live in Task 10 (mirroring how the existing block loop is verified, not browser-mocked).

- [ ] **Step 1: Add the helper imports**

In `server/services/psAttendanceSync.js`, extend the `psGradeLevel.js` import (added in Task 7) to also bring in the read helpers, and the existing launch-form parser:

```js
import { currentSchoolYearEndYear, gradeLevelToGradYear, pickInSessionDate, extractGradeLevels, userDcidFromLaunchForm } from '../lib/psGradeLevel.js';
```

(`sectionDcidFromLaunchForm` and `pickBlockNumber` are already imported from `../lib/psBlockNumber.js`.)

- [ ] **Step 2: Make the launch-form fetch return both ids**

Replace `fetchSectionDcid` (currently lines ~78–84):

```js
// Resolve Schoology section → PS sectionDcid from the LTI launch-form HTML.
// Uses context.request (carries the Schoology session cookie, no app load).
async function fetchSectionDcid(context, schoologySectionId) {
  const resp = await context.request.get(runUrlFor(schoologySectionId), { maxRedirects: 5 });
  const html = await resp.text();
  return sectionDcidFromLaunchForm(html);
}
```

with:

```js
// Resolve Schoology section → PS sectionDcid + teacher userDcid from the LTI
// launch-form HTML. Uses context.request (carries the Schoology session cookie,
// no app load). The userDcid feeds the section_attendance (grade-level) read.
async function fetchLaunchIds(context, schoologySectionId) {
  const resp = await context.request.get(runUrlFor(schoologySectionId), { maxRedirects: 5 });
  const html = await resp.text();
  return {
    sectionDcid: sectionDcidFromLaunchForm(html),
    userDcid: userDcidFromLaunchForm(html),
  };
}

// GET /ws/attendance/section_attendance for an in-session date, from the live PS
// page (same-origin fetch). includeStudentAlerts=false keeps the PII surface
// minimal (we only need the roster + gradeLevel). Returns parsed JSON or null.
async function fetchSectionAttendance(page, sectionDcid, userDcid, date) {
  const { status, text } = await page.evaluate(async ({ host, dcid, uid, d }) => {
    const url = `https://${host}/ws/attendance/section_attendance`
      + `?sectionDcid=${dcid}&userDcid=${uid}&startDate=${d}&endDate=${d}`
      + `&includeStudentAlerts=false&multiSections=false&sortByFirstName=false`;
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    return { status: res.status, text: await res.text() };
  }, { host: PS_HOST, dcid: sectionDcid, uid: userDcid, d: date });
  if (status !== 200) return null;
  try { return JSON.parse(text); } catch { return null; }
}
```

- [ ] **Step 3: Initialise grade accumulation in `syncPsAttendance`**

In `syncPsAttendance`, just before the `for (const c of courses)` loop, add:

```js
  const gradeByDcid = new Map(); // dcid → gradeLevel, accumulated across all sections
  const todayIso = new Date().toISOString().slice(0, 10);
```

And extend the summary initialiser (the `const summary = { ... }` line near the top of the function) to include:

```js
  const summary = { processed: 0, updated: 0, unchanged: 0, skipped: 0, gradeLevels: { seen: 0, updated: 0 }, results: [] };
```

- [ ] **Step 4: Read grade level alongside the block in the loop**

In the loop body, replace the section-resolution block (currently lines ~172–181):

```js
      let pick;
      const sectionDcid = await fetchSectionDcid(context, c.schoology_section_id);
      if (!sectionDcid) {
        pick = { blockNumber: null, blockName: null, reason: 'no-section-dcid' };
      } else {
        const { status, first } = await fetchSectionInfoFirst(page, sectionDcid);
        pick = first
          ? pickBlockNumber(first)
          : { blockNumber: null, blockName: null, reason: `section-info-failed:${status}` };
      }
```

with:

```js
      let pick;
      const { sectionDcid, userDcid } = await fetchLaunchIds(context, c.schoology_section_id);
      if (!sectionDcid) {
        pick = { blockNumber: null, blockName: null, reason: 'no-section-dcid' };
      } else {
        const { status, first } = await fetchSectionInfoFirst(page, sectionDcid);
        pick = first
          ? pickBlockNumber(first)
          : { blockNumber: null, blockName: null, reason: `section-info-failed:${status}` };

        // Grade level: pick an in-session day from the SAME section_info calendar
        // and read the roster's per-student gradeLevel. Best-effort — a failure
        // here never affects block resolution.
        if (first && userDcid) {
          const date = pickInSessionDate(first, todayIso);
          if (date) {
            const sa = await fetchSectionAttendance(page, sectionDcid, userDcid, date);
            for (const { dcid, gradeLevel } of extractGradeLevels(sa || {})) {
              gradeByDcid.set(dcid, gradeLevel);
            }
          }
        }
      }
```

- [ ] **Step 5: Apply the grades after the loop**

After the `for` loop ends but before the final `log('Done: ...')` (i.e. just before line ~207), add:

```js
      summary.gradeLevels.seen = gradeByDcid.size;
      summary.gradeLevels.updated = applyGradeLevels(db, gradeByDcid);
      log(`Grade levels: ${summary.gradeLevels.updated} students updated (${gradeByDcid.size} seen).`);
```

- [ ] **Step 6: Run the server suite to verify the guard + applyGradeLevels tests still pass**

Run: `npm run test:server`
Expected: PASS. (The guard tests still return before launching a browser; `gradeLevels` is initialised in the summary, so the `no active courses` test's `toEqual` must include it — update that assertion if it fails.)

> If the `no active courses → ...` test in `psAttendanceSync.test.js` fails on the new `gradeLevels` key, update its expected object to:
> `{ processed: 0, updated: 0, unchanged: 0, skipped: 0, gradeLevels: { seen: 0, updated: 0 }, results: [] }`

- [ ] **Step 7: Commit**

```bash
git add server/services/psAttendanceSync.js server/services/psAttendanceSync.test.js
git commit -m "feat(#43): read per-student gradeLevel from section_attendance in the PS pass"
```

---

### Task 9: Surface grade-level counts in the sync orchestrator

**Files:**
- Modify: `server/services/syncOrchestrator.js` (block phase reports grade-level count)
- Modify: `server/services/syncOrchestrator.test.js` (assert the new field)

- [ ] **Step 1: Write the failing test**

In `server/services/syncOrchestrator.test.js`, find the test that asserts the block phase summary (around line 108, where `syncPsAttendance.mockResolvedValue({ updated: 2, skipped: 1 })`). Change that mock return to include grade levels and assert the orchestrator surfaces it:

```js
    syncPsAttendance.mockResolvedValue({ updated: 2, skipped: 1, gradeLevels: { seen: 30, updated: 28 } });
```

Then add an assertion (after the existing block-phase assertions in that test) that the emitted summary carries the grade count. Add near the other `events`/`summary` assertions:

```js
    const blocksDone = events.find(e => e.phase === 'blocks' && e.status === 'done');
    expect(blocksDone.gradeLevelsUpdated).toBe(28);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/services/syncOrchestrator.test.js`
Expected: FAIL — `blocksDone.gradeLevelsUpdated` is `undefined`.

- [ ] **Step 3: Update the orchestrator block phase**

In `server/services/syncOrchestrator.js`, in the `if (syncBlocks) { ... }` block (currently lines ~54–67), replace the summary + done-emit lines:

```js
      summary.blocks = { updated: r.updated, skipped: r.skipped, elapsedMs: Date.now() - blocksStartedAt };
      emit({ phase: 'blocks', status: 'done', records: r.updated, elapsedMs: summary.blocks.elapsedMs });
```

with:

```js
      const gradeLevelsUpdated = r.gradeLevels?.updated ?? 0;
      summary.blocks = { updated: r.updated, skipped: r.skipped, gradeLevelsUpdated, elapsedMs: Date.now() - blocksStartedAt };
      emit({ phase: 'blocks', status: 'done', records: r.updated, gradeLevelsUpdated, elapsedMs: summary.blocks.elapsedMs });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/services/syncOrchestrator.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/syncOrchestrator.js server/services/syncOrchestrator.test.js
git commit -m "feat(#43): surface grade-level update count in the sync orchestrator"
```

---

## Phase 3 — Verification

### Task 10: Full suite + live sync verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full server + client suites**

Run: `npm run test:server && npm run test:client`
Expected: PASS, server count = previous + new tests (psGradeLevel, applyGradeLevels, orchestrator field), client count = previous + new tests (gradeLevel, SearchPage, CoursePage roster).

- [ ] **Step 2: Confirm the Schoology/PowerSchool session is live**

Run: `node scripts/probe-ps-gradelevel-source.js`
Expected: prints `section_attendance` with `gradeLevel` values. If it reports the session expired, run `npm run mastery:login` first (the user must do this interactively), then retry.

- [ ] **Step 3: Capture the baseline `grad_year` count**

Run: `sqlite3 server/db/students.db "SELECT COUNT(*) FILTER (WHERE grad_year IS NOT NULL) AS with_year, COUNT(*) AS total FROM students;"`
Expected: note the numbers (likely `with_year` is 0 or low before this feature).

- [ ] **Step 4: Run a real sync with the PowerSchool pass enabled**

Start the app (`npm run dev`), open the Sync dialog, ensure the blocks/PowerSchool option is enabled, and run a sync. Watch the log for `Grade levels: N students updated`.

- [ ] **Step 5: Confirm `grad_year` is now populated**

Run: `sqlite3 server/db/students.db "SELECT COUNT(*) FILTER (WHERE grad_year IS NOT NULL) AS with_year, COUNT(*) AS total FROM students;"`
Expected: `with_year` increased to cover students in your active sections.

- [ ] **Step 6: Confirm the UI**

In the running app: a student profile shows "Grade N · Class of YYYY"; the search page shows a Grade column; a course roster shows a Grade column. Spot-check one known student's grade is correct.

- [ ] **Step 7: Clean up any probe output**

Run: `rm -f /tmp/ps-gradelevel-capture.json`
Expected: removes the PII capture if a probe was re-run.

- [ ] **Step 8: Update build progress**

Append a short note to `.claude/build-progress.md` recording that #43 is implemented (grade level synced via `psAttendanceSync`, stored as `grad_year`, displayed on profile/search/roster), then commit:

```bash
git add .claude/build-progress.md
git commit -m "docs(#43): note grade-level sync shipped"
```

---

## Self-Review

**Spec coverage:**
- Spike outcome / source choice → Tasks 5, 8 use `section_attendance` + in-session date. ✓
- Storage = invariant `grad_year`, no schema change → Tasks 5 (`gradeLevelToGradYear`), 7 (`applyGradeLevels`). ✓
- Architecture Approach A (generalize block sync) → Tasks 6 (rename), 8 (integrate). ✓
- Data flow: shared session/sectionDcid/section_info, in-session day, `Map<dcid>`, batched update, not-seen preserved → Tasks 7–8 (test asserts unmatched student preserved). ✓
- `userDcid` from launch form → Task 5 (`userDcidFromLaunchForm`), Task 8 (`fetchLaunchIds`). ✓
- Display: shared `gradeLevel.js` helper, profile/search/roster → Tasks 1–4. ✓
- Orchestration/opt-out: block phase reports both, `syncBlocks` gates the pass → Task 9 (phase id `blocks` kept; no client coupling confirmed). ✓
- Testing: pure-fn unit, DB integration, client lib + column render → Tasks 1,3,4,5,7,9. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✓

**Type/name consistency:** `syncPsAttendance`, `applyGradeLevels(db, gradeByDcid, now)`, `gradeLevelToGradYear(gradeLevel, schoolYearEndYear)`, `currentSchoolYearEndYear(now)`, `pickInSessionDate(sectionInfo, today)`, `extractGradeLevels(json)→[{dcid,gradeLevel}]`, `userDcidFromLaunchForm(html)`, client `gradYearToLevel(gradYear, now)` / `formatGradeBadge(gradYear, now)` — names used consistently across tasks. Summary shape `{ ..., gradeLevels: { seen, updated } }` consistent between Tasks 7–9. ✓
