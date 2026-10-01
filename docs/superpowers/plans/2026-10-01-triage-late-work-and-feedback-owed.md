# Triage — late-work referral watch + feedback owed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, on the Dashboard and each course page (and through PrisMCP), which students are approaching an academic-office referral for late summative work and which assessments have waited longest for feedback, all counted in school days from the PowerSchool calendar, with adjustable limits.

**Architecture:** The PowerSchool block sync already fetches `section_info` per section. It now also stores the year's calendar in a `school_days` table. A pure `schoolDays` module counts school days, falling back to weekdays and flagging the result `approx`. A single `triage` service builds both lists from the existing grades, submissions and mastery tables plus new `settings` and `referrals` tables. Express routes and PrisMCP tools both call that service. The React `TriageSection` (two panels) is mounted on the Dashboard (all courses) and on CoursePage (one course). A Settings page edits the limits.

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest (server: root `vitest.config.js`; client: `client/` Vitest + React Testing Library), React 18 + react-router, `@modelcontextprotocol/sdk` + zod (PrisMCP).

**Spec:** `docs/superpowers/specs/2026-10-01-triage-late-work-and-feedback-owed-design.md`. Read it first, especially **Rules** and **Verification results**.

## Global Constraints

- ESM everywhere (`import`/`export`, `"type": "module"`).
- **Colours only via CSS custom properties** from `client/src/app.css` (`--success`, `--warning`, `--danger`, `--badge-*`, `--bg-subtle`, `--accent`, `--text-muted`, `--border`). Never write hex values in components or new CSS.
- **Phone rules** go only in the single `PHONE LAYOUT` `@media (max-width: 768px)` block at the end of `client/src/app.css`.
- **Dates:** use `formatDate` / `formatDateTime` from `client/src/lib/formatDate.js` (en-GB, DD/MM/YYYY). Server dates are `YYYY-MM-DD` strings in the machine's local timezone (Hong Kong on prod).
- **Schema:** new tables go in `server/db/schema.sql` (`CREATE TABLE IF NOT EXISTS`). A column added to an **existing** table goes in **both** `schema.sql` and the `MIGRATIONS` array in `server/db/index.js`.
- Default limits: referral **8** school days, feedback **10** school days, amber lead **3**, show formative by default **false**. Bounds: limits 1–60, lead 0–59.
- Triage covers **current courses only** (`archived = 0 AND excluded = 0`; the all-courses view also requires `hidden = 0`).
- **This machine may be prod** (`hostname` = `macmini.local`, prod on `127.0.0.1:3001`). Never kill by port. Run dev with `PORT=3002 npm run dev`. Stop with `npm run dev:stop`. Never run `db:backup` from this clone.
- Work on branch **`feat/triage`**. Do **not** push `main`: pushing `main` deploys prod. Merging is the user's call at the end.
- Tests sit beside the code (`*.test.js` / `*.test.jsx`). Server tests: `npx vitest run <path>` from the repo root. Client tests: `cd client && npx vitest run <path>`.

## Review Focus

1. **A "Missing" exception (3) on non-LTI work.** The teacher's grade entry sets `grades.submitted_at > 0`. That student must still count as **outstanding**, not submitted. Covered by Task 6's test "Missing exception still counts as outstanding".
2. **Resubmission after an on-time first submission** must not be flagged as "submitted day N" past the limit. `first_submitted_at` keeps the earliest time. Covered by Task 4 ("keeps the earliest across syncs") and Task 6 ("on-time first submission, late resubmission → not listed").
3. **Individually-assigned tasks** (`num_assignees > 0`). Non-assignees must never appear as late. Covered by Task 6 ("non-assignee of an individually-assigned task is not listed").
4. **Dropped students** (`enrolments.dropped_at` set) must never appear. Covered by Task 6 ("dropped student is not listed").
5. **A PowerSchool fetch that returns no calendar** must not wipe the stored calendar. Covered by Task 2 ("empty list is a no-op and keeps the stored calendar").

---

### Task 0: Branch + commit the amended spec

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-triage-late-work-and-feedback-owed-design.md` (already amended with "Verification results")
- Create: `docs/superpowers/plans/2026-10-01-triage-late-work-and-feedback-owed.md` (this file)

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/triage
```

- [ ] **Step 2: Commit the spec amendments + plan**

```bash
git add docs/superpowers/specs/2026-10-01-triage-late-work-and-feedback-owed-design.md docs/superpowers/plans/2026-10-01-triage-late-work-and-feedback-owed.md
git commit -m "docs(triage): spec verification results + implementation plan"
```

---

### Task 1: `schoolDays` — pure school-day arithmetic

**Files:**
- Create: `server/lib/schoolDays.js`
- Test: `server/lib/schoolDays.test.js`

**Interfaces:**
- Produces:
  - `addDays(iso: string, n: number): string`
  - `isWeekday(iso: string): boolean`
  - `todayLocal(now?: Date): string`
  - `epochToLocalDate(secs: number|null): string|null`
  - `makeCalendar(rows: Array<{date, in_session, cycle_letter?, source?}>)` returns
    `{ between(from, to) → { days: number, approx: boolean }, isSchoolDay(date) → boolean, info(date) → { date, isSchoolDay, cycleLetter, schoolDayNumber, approx }, covers(date) → boolean, source: 'powerschool'|'weekdays', totalSchoolDays: number }`

- [ ] **Step 1: Write the failing test**

```js
// server/lib/schoolDays.test.js
import { describe, test, expect } from 'vitest';
import { makeCalendar, addDays, isWeekday, epochToLocalDate } from './schoolDays.js';

// 28/09/2026–09/10/2026 from the 26-27 Master Plan: Thu 01/10 (National Day)
// and Fri 02/10 (PD day) are not school days.
function window() {
  const rows = [];
  for (let d = '2026-09-28'; d <= '2026-10-09'; d = addDays(d, 1)) {
    const off = !isWeekday(d) || d === '2026-10-01' || d === '2026-10-02';
    rows.push({ date: d, in_session: off ? 0 : 1, cycle_letter: off ? null : 'A', source: 'powerschool' });
  }
  return rows;
}

describe('makeCalendar.between (school days d with from < d <= to)', () => {
  const cal = makeCalendar(window());

  test('skips the holiday, PD day and weekend: due Wed 30/09, today Mon 05/10 → 1', () => {
    expect(cal.between('2026-09-30', '2026-10-05')).toEqual({ days: 1, approx: false });
  });

  test('same day → 0', () => {
    expect(cal.between('2026-10-05', '2026-10-05')).toEqual({ days: 0, approx: false });
  });

  test('to before from → 0', () => {
    expect(cal.between('2026-10-06', '2026-10-05').days).toBe(0);
  });

  test('full week after the break → 5', () => {
    expect(cal.between('2026-09-30', '2026-10-09').days).toBe(5);
  });

  test('due on a non-school day counts from the next school day', () => {
    expect(cal.between('2026-10-01', '2026-10-06').days).toBe(2);
  });

  test('beyond the stored calendar falls back to weekdays and flags approx', () => {
    // 09/10 covered (school day); 10–11/10 weekend; 12–13/10 uncovered weekdays.
    expect(cal.between('2026-10-08', '2026-10-13')).toEqual({ days: 3, approx: true });
  });
});

describe('makeCalendar with no rows', () => {
  test('counts weekdays, approx, source "weekdays"', () => {
    const cal = makeCalendar([]);
    expect(cal.between('2026-09-25', '2026-09-29')).toEqual({ days: 2, approx: true });
    expect(cal.source).toBe('weekdays');
    expect(cal.totalSchoolDays).toBe(0);
  });
});

describe('makeCalendar.info', () => {
  const cal = makeCalendar(window());

  test('school day: number within the stored year + letter', () => {
    expect(cal.info('2026-10-05')).toEqual({
      date: '2026-10-05', isSchoolDay: true, cycleLetter: 'A', schoolDayNumber: 4, approx: false,
    });
  });

  test('holiday: not a school day, no number', () => {
    expect(cal.info('2026-10-01')).toMatchObject({ isSchoolDay: false, schoolDayNumber: null });
  });

  test('source + total', () => {
    expect(cal.source).toBe('powerschool');
    expect(cal.totalSchoolDays).toBe(8);
  });
});

describe('epochToLocalDate', () => {
  test('0 / missing → null', () => {
    expect(epochToLocalDate(0)).toBeNull();
    expect(epochToLocalDate(null)).toBeNull();
  });
  test('04:00Z is the same calendar day in UTC and Hong Kong', () => {
    expect(epochToLocalDate(Date.parse('2026-10-05T04:00:00Z') / 1000)).toBe('2026-10-05');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run server/lib/schoolDays.test.js`
Expected: FAIL, "Failed to resolve import './schoolDays.js'".

- [ ] **Step 3: Implement**

```js
// server/lib/schoolDays.js
// School-day arithmetic for triage (late-work referral + feedback-owed clocks,
// docs/superpowers/specs/2026-10-01-triage-late-work-and-feedback-owed-design.md).
// Pure: built from school_days rows (the PowerSchool calendar), no DB access.
// Dates are local calendar dates as 'YYYY-MM-DD'. Outside the stored calendar's
// date span we fall back to Mon–Fri and flag the result `approx`.

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isWeekday(iso) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

// Today's local date (the machine's timezone — Hong Kong on prod).
export function todayLocal(now = new Date()) {
  return now.toLocaleDateString('en-CA');
}

// Epoch seconds → local 'YYYY-MM-DD'; null for 0/missing.
export function epochToLocalDate(secs) {
  const n = Number(secs);
  return n > 0 ? new Date(n * 1000).toLocaleDateString('en-CA') : null;
}

export function makeCalendar(rows = []) {
  const inSession = new Set();
  const letters = new Map();
  let min = null;
  let max = null;
  let source = null;
  for (const r of rows) {
    if (!r || !ISO.test(r.date)) continue;
    if (r.in_session) inSession.add(r.date);
    if (r.cycle_letter) letters.set(r.date, r.cycle_letter);
    if (min === null || r.date < min) min = r.date;
    if (max === null || r.date > max) max = r.date;
    source = source || r.source || 'powerschool';
  }
  const sessionDays = [...inSession].sort();
  const covers = (d) => min !== null && d >= min && d <= max;
  const isSchoolDay = (d) => (covers(d) ? inSession.has(d) : isWeekday(d));

  // School days d with from < d <= to (0 when to <= from).
  function between(from, to) {
    let days = 0;
    let approx = min === null;
    if (!ISO.test(from) || !ISO.test(to) || to <= from) return { days, approx };
    for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
      if (!covers(d)) approx = true;
      if (isSchoolDay(d)) days++;
    }
    return { days, approx };
  }

  function info(date) {
    const idx = sessionDays.indexOf(date);
    return {
      date,
      isSchoolDay: isSchoolDay(date),
      cycleLetter: letters.get(date) ?? null,
      schoolDayNumber: idx >= 0 ? idx + 1 : null,
      approx: !covers(date),
    };
  }

  return { between, isSchoolDay, info, covers, source: source || 'weekdays', totalSchoolDays: inSession.size };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run server/lib/schoolDays.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/schoolDays.js server/lib/schoolDays.test.js
git commit -m "feat(triage): school-day arithmetic with weekday fallback"
```

---

### Task 2: Store the PowerSchool calendar (`school_days`)

**Files:**
- Modify: `server/db/schema.sql` (append the table)
- Create: `server/lib/psCalendar.js`, `server/services/schoolCalendar.js`
- Modify: `server/services/psAttendanceSync.js` (collect each section's calendar in the loop; store it after the loop)
- Test: `server/lib/psCalendar.test.js`, `server/services/schoolCalendar.test.js`

**Interfaces:**
- Consumes: `makeCalendar` (Task 1).
- Produces:
  - `extractCalendarDays(sectionInfo): Array<{date, inSession, cycleLetter, raw}>`
  - `mergeCalendarDays(byDate: Map, days): Map`
  - `storeSchoolDays(db, days, now?): number`
  - `loadCalendar(db)` returns the `makeCalendar` object plus `syncedAt: string|null`.

- [ ] **Step 1: Add the table to `server/db/schema.sql`** (append at the end)

```sql
-- Triage school-day calendar, from PowerSchool section_info `calenderDays`
-- (PowerSchool's spelling). One row per date in the current school year,
-- merged across synced sections; in_session drives school-day counting.
-- `raw` keeps the calenderDays entry verbatim so later fields need no re-probe.
CREATE TABLE IF NOT EXISTS school_days (
  date TEXT PRIMARY KEY,                -- 'YYYY-MM-DD'
  in_session INTEGER NOT NULL DEFAULT 0,
  cycle_letter TEXT,                    -- cycleDay.letter ('A'/'B')
  raw TEXT,
  source TEXT NOT NULL DEFAULT 'powerschool',
  synced_at TEXT
);
```

- [ ] **Step 2: Write the failing tests**

```js
// server/lib/psCalendar.test.js
import { describe, test, expect } from 'vitest';
import { extractCalendarDays, mergeCalendarDays } from './psCalendar.js';

describe('extractCalendarDays', () => {
  test('reads calenderDays (PS spelling): date, inSession, letter, raw', () => {
    const days = extractCalendarDays({
      calenderDays: {
        '2026-10-05': { inSession: true, cycleDay: { letter: 'B' } },
        '2026-10-01': { inSession: false },
        notADate: { inSession: true },
      },
    });
    expect(days).toEqual([
      { date: '2026-10-05', inSession: true, cycleLetter: 'B', raw: '{"inSession":true,"cycleDay":{"letter":"B"}}' },
      { date: '2026-10-01', inSession: false, cycleLetter: null, raw: '{"inSession":false}' },
    ]);
  });

  test('accepts calendarDays; missing calendar → []', () => {
    expect(extractCalendarDays({ calendarDays: { '2026-10-05': { inSession: true } } })).toHaveLength(1);
    expect(extractCalendarDays(null)).toEqual([]);
  });
});

describe('mergeCalendarDays', () => {
  test('in session if ANY section says so; first non-null letter wins', () => {
    const m = new Map();
    mergeCalendarDays(m, [{ date: '2026-10-05', inSession: false, cycleLetter: null, raw: 'a' }]);
    mergeCalendarDays(m, [{ date: '2026-10-05', inSession: true, cycleLetter: 'B', raw: 'b' }]);
    expect(m.get('2026-10-05')).toMatchObject({ inSession: true, cycleLetter: 'B', raw: 'a' });
  });
});
```

```js
// server/services/schoolCalendar.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { storeSchoolDays, loadCalendar } from './schoolCalendar.js';

const day = (date, inSession, letter = null) => ({ date, inSession, cycleLetter: letter, raw: '{}' });

beforeEach(() => { getDb().exec('DELETE FROM school_days;'); });

describe('storeSchoolDays', () => {
  test('replaces the stored PowerSchool calendar', () => {
    const db = getDb();
    storeSchoolDays(db, [day('2026-10-05', true, 'A'), day('2026-10-06', true, 'B')], '2026-10-01T00:00:00Z');
    storeSchoolDays(db, [day('2026-10-07', true, 'A')], '2026-10-02T00:00:00Z');
    expect(db.prepare('SELECT date FROM school_days ORDER BY date').all().map((r) => r.date)).toEqual(['2026-10-07']);
  });

  test('empty list is a no-op and keeps the stored calendar', () => {
    const db = getDb();
    storeSchoolDays(db, [day('2026-10-05', true)], '2026-10-01T00:00:00Z');
    expect(storeSchoolDays(db, [])).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM school_days').get().n).toBe(1);
  });
});

describe('loadCalendar', () => {
  test('builds a calendar from the stored rows, with syncedAt', () => {
    const db = getDb();
    storeSchoolDays(db, [day('2026-10-05', true, 'A'), day('2026-10-06', false)], '2026-10-01T00:00:00Z');
    const cal = loadCalendar(db);
    expect(cal.source).toBe('powerschool');
    expect(cal.totalSchoolDays).toBe(1);
    expect(cal.isSchoolDay('2026-10-06')).toBe(false);
    expect(cal.syncedAt).toBe('2026-10-01T00:00:00Z');
  });

  test('empty table → weekday calendar', () => {
    const cal = loadCalendar(getDb());
    expect(cal.source).toBe('weekdays');
    expect(cal.syncedAt).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run server/lib/psCalendar.test.js server/services/schoolCalendar.test.js`
Expected: FAIL, unresolved imports.

- [ ] **Step 4: Implement**

```js
// server/lib/psCalendar.js
// PowerSchool section_info calendar → school_days rows (triage). The key is
// PowerSchool's own misspelling `calenderDays`; accept `calendarDays` too. Each
// entry is kept verbatim in `raw` (see .claude/powerschool-api-reference.md).
export function extractCalendarDays(sectionInfo) {
  const cal = sectionInfo?.calenderDays || sectionInfo?.calendarDays || {};
  return Object.entries(cal)
    .filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .map(([date, d]) => ({
      date,
      inSession: !!d?.inSession,
      cycleLetter: d?.cycleDay?.letter ?? null,
      raw: JSON.stringify(d ?? null),
    }));
}

// Merge one section's days into a Map<date, day>. A section's calendar may only
// mark the days it meets, so a date is in session if ANY section says so; the
// first non-null cycle letter wins.
export function mergeCalendarDays(byDate, days) {
  for (const day of days) {
    const prev = byDate.get(day.date);
    if (!prev) { byDate.set(day.date, { ...day }); continue; }
    prev.inSession = prev.inSession || day.inSession;
    prev.cycleLetter = prev.cycleLetter ?? day.cycleLetter;
  }
  return byDate;
}
```

```js
// server/services/schoolCalendar.js
// Persistence for the triage school-day calendar (school_days table).
import { makeCalendar } from '../lib/schoolDays.js';

// Replace the stored PowerSchool calendar with `days` (whole year per sync). An
// empty list is a no-op, so a failed or empty fetch never wipes a good calendar.
export function storeSchoolDays(db, days, now = new Date().toISOString()) {
  if (!days.length) return 0;
  const insert = db.prepare(`
    INSERT INTO school_days (date, in_session, cycle_letter, raw, source, synced_at)
    VALUES (?, ?, ?, ?, 'powerschool', ?)
  `);
  db.transaction(() => {
    db.prepare(`DELETE FROM school_days WHERE source = 'powerschool'`).run();
    for (const d of days) insert.run(d.date, d.inSession ? 1 : 0, d.cycleLetter, d.raw, now);
  })();
  return days.length;
}

export function loadCalendar(db) {
  const rows = db.prepare('SELECT date, in_session, cycle_letter, source, synced_at FROM school_days').all();
  const syncedAt = rows.reduce((m, r) => (r.synced_at && (!m || r.synced_at > m) ? r.synced_at : m), null);
  return { ...makeCalendar(rows), syncedAt };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run server/lib/psCalendar.test.js server/services/schoolCalendar.test.js`
Expected: PASS.

- [ ] **Step 6: Hook into the PowerSchool sync** (`server/services/psAttendanceSync.js`)

Add imports next to the existing `psBlockNumber.js` import:

```js
import { extractCalendarDays, mergeCalendarDays } from '../lib/psCalendar.js';
import { storeSchoolDays } from './schoolCalendar.js';
```

Next to `const gradeByDcid = new Map();`, add:

```js
    const calendarByDate = new Map(); // date → merged school day (triage calendar)
```

Directly after `const { status, first } = await fetchSectionInfoFirst(page, sectionDcid);`, add:

```js
        if (first) mergeCalendarDays(calendarByDate, extractCalendarDays(first));
```

Directly before `summary.gradeLevels.seen = gradeByDcid.size;` (after the loop), add:

```js
    summary.schoolDays = storeSchoolDays(db, [...calendarByDate.values()]);
    log(summary.schoolDays
      ? `School calendar: ${summary.schoolDays} days stored.`
      : 'School calendar: none returned — kept the stored calendar.');
```

- [ ] **Step 7: Run the PowerSchool sync tests (no regressions)**

Run: `npx vitest run server/services/psAttendanceSync.test.js server/routes/courses.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/db/schema.sql server/lib/psCalendar.js server/lib/psCalendar.test.js server/services/schoolCalendar.js server/services/schoolCalendar.test.js server/services/psAttendanceSync.js
git commit -m "feat(triage): store the PowerSchool school calendar during block sync"
```

---

### Task 3: Settings (table, service, routes)

**Files:**
- Modify: `server/db/schema.sql` (append the table)
- Create: `server/services/settings.js`, `server/routes/settings.js`
- Modify: `server/index.js` (register `/api/settings`)
- Test: `server/services/settings.test.js`, `server/routes/settings.test.js`

**Interfaces:**
- Produces:
  - `TRIAGE_DEFAULTS = { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false }`
  - `getTriageSettings(db)` returns the same shape.
  - `updateTriageSettings(db, patch)` returns the full settings after the update.
  - `GET /api/settings` returns `{ triage }`. `PUT /api/settings` takes `{ triage: patch }` and returns `{ triage }`.

- [ ] **Step 1: Append to `server/db/schema.sql`**

```sql
-- App settings (key/value, JSON-encoded values). Server-side so every device,
-- prod and PrisMCP agree. Keys are namespaced, e.g. 'triage.referralLimitDays';
-- a missing row means the code default.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Write the failing tests**

```js
// server/services/settings.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { getTriageSettings, updateTriageSettings, TRIAGE_DEFAULTS } from './settings.js';

beforeEach(() => { getDb().exec('DELETE FROM settings;'); });

describe('triage settings', () => {
  test('defaults when nothing is stored', () => {
    expect(getTriageSettings(getDb())).toEqual({
      referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false,
    });
    expect(TRIAGE_DEFAULTS.referralLimitDays).toBe(8);
  });

  test('round-trips a patch and keeps the other values', () => {
    const s = updateTriageSettings(getDb(), { referralLimitDays: 6, showFormativeDefault: true });
    expect(s).toEqual({ referralLimitDays: 6, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: true });
    expect(getTriageSettings(getDb())).toEqual(s);
  });

  test('clamps out-of-range numbers and ignores unknown keys', () => {
    const s = updateTriageSettings(getDb(), { referralLimitDays: 0, feedbackLimitDays: 999, warnLeadDays: -2, bogus: 1 });
    expect(s).toMatchObject({ referralLimitDays: 1, feedbackLimitDays: 60, warnLeadDays: 0 });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM settings WHERE key LIKE '%bogus%'`).get().n).toBe(0);
  });

  test('a corrupt stored value falls back to the default', () => {
    getDb().prepare(`INSERT INTO settings (key, value) VALUES ('triage.referralLimitDays', 'not json')`).run();
    expect(getTriageSettings(getDb()).referralLimitDays).toBe(8);
  });
});
```

```js
// server/routes/settings.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './settings.js';
import { getDb } from '../db/index.js';

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

beforeEach(() => { getDb().exec('DELETE FROM settings;'); });

describe('/api/settings', () => {
  test('GET returns triage defaults', async () => {
    const { status, body } = await call('GET', '/api/settings');
    expect(status).toBe(200);
    expect(body.triage.feedbackLimitDays).toBe(10);
  });

  test('PUT updates and returns the full triage settings', async () => {
    const { body } = await call('PUT', '/api/settings', { triage: { feedbackLimitDays: 12 } });
    expect(body.triage).toMatchObject({ feedbackLimitDays: 12, referralLimitDays: 8 });
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run server/services/settings.test.js server/routes/settings.test.js`
Expected: FAIL, unresolved imports.

- [ ] **Step 4: Implement**

```js
// server/services/settings.js
// Server-side app settings (settings table). Triage limits live under 'triage.*'.
const TRIAGE_KEYS = {
  referralLimitDays: { def: 8, min: 1, max: 60 },
  feedbackLimitDays: { def: 10, min: 1, max: 60 },
  warnLeadDays: { def: 3, min: 0, max: 59 },
  showFormativeDefault: { def: false, bool: true },
};

export const TRIAGE_DEFAULTS = Object.fromEntries(Object.entries(TRIAGE_KEYS).map(([k, s]) => [k, s.def]));

function coerce(spec, value) {
  if (spec.bool) return value === true || value === 'true' || value === 1;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, n));
}

function parse(spec, text) {
  try { return coerce(spec, JSON.parse(text)); } catch { return spec.def; }
}

export function getTriageSettings(db) {
  const stored = new Map(
    db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'triage.%'`).all()
      .map((r) => [r.key.slice('triage.'.length), r.value]),
  );
  return Object.fromEntries(
    Object.entries(TRIAGE_KEYS).map(([k, spec]) => [k, stored.has(k) ? parse(spec, stored.get(k)) : spec.def]),
  );
}

export function updateTriageSettings(db, patch = {}) {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch || {})) {
      const spec = TRIAGE_KEYS[k];
      if (spec) upsert.run(`triage.${k}`, JSON.stringify(coerce(spec, v)));
    }
  })();
  return getTriageSettings(db);
}
```

```js
// server/routes/settings.js
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { getTriageSettings, updateTriageSettings } from '../services/settings.js';

const router = Router();

// GET /api/settings — { triage: { referralLimitDays, feedbackLimitDays, warnLeadDays, showFormativeDefault } }
router.get('/', (req, res) => {
  res.json({ triage: getTriageSettings(getDb()) });
});

// PUT /api/settings — body { triage: { ...partial } }; values are clamped server-side.
router.put('/', (req, res) => {
  res.json({ triage: updateTriageSettings(getDb(), req.body?.triage || {}) });
});

export default router;
```

In `server/index.js`, add `import settingsRouter from './routes/settings.js';` beside the other route imports, and `app.use('/api/settings', settingsRouter);` after `app.use('/api/assessment-drafts', assessmentDraftsRouter);`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run server/services/settings.test.js server/routes/settings.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.sql server/services/settings.js server/services/settings.test.js server/routes/settings.js server/routes/settings.test.js server/index.js
git commit -m "feat(triage): server-side settings for triage limits"
```

---

### Task 4: `grades.first_submitted_at` — the earliest observed submission

**Files:**
- Modify: `server/db/schema.sql` (grades table: add the column)
- Modify: `server/db/index.js` (`MIGRATIONS` entry; `backfillFirstSubmittedAt`; call it in `migrate`)
- Modify: `server/services/sync.js` (three upserts: native, retry, LTI-with-time)
- Test: `server/services/sync.test.js` (add cases), `server/db/firstSubmitted.test.js`

**Interfaces:**
- Produces: `grades.first_submitted_at INTEGER` (epoch seconds, 0 = none), a running minimum of the non-zero submission times seen. Also `backfillFirstSubmittedAt(database)` exported from `server/db/index.js`.

- [ ] **Step 1: Schema + migration**

In `server/db/schema.sql`, inside `CREATE TABLE IF NOT EXISTS grades (`, add before `synced_at TEXT,`:

```sql
  -- Triage: earliest submission time Prism has observed (epoch secs, 0 = none).
  -- A running minimum across syncs — the bulk revisions API only returns the
  -- latest revision, so this is the best available "first submitted" signal.
  first_submitted_at INTEGER DEFAULT 0,
```

In `server/db/index.js`, add to `MIGRATIONS` just before the `// Indexes for issue #13 columns` comment:

```js
  // Triage: earliest observed submission time (running minimum). See
  // docs/superpowers/specs/2026-10-01-triage-late-work-and-feedback-owed-design.md.
  `ALTER TABLE grades ADD COLUMN first_submitted_at INTEGER DEFAULT 0`,
```

Add after `backfillExcludedCourses`:

```js
// Triage: seed first_submitted_at from the best pre-existing signal (the newest
// non-draft revision / LTI submission time). Idempotent — only fills rows that
// have never been set; the sync keeps it as a running minimum from then on.
export function backfillFirstSubmittedAt(database) {
  database.exec(`
    UPDATE grades SET first_submitted_at = latest_revision_at
    WHERE COALESCE(first_submitted_at, 0) = 0 AND COALESCE(latest_revision_at, 0) > 0
  `);
}
```

In `migrate(database)`, add `backfillFirstSubmittedAt(database);` after `backfillExcludedCourses(database);`.

- [ ] **Step 2: Write the failing tests**

```js
// server/db/firstSubmitted.test.js
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, backfillFirstSubmittedAt } from './index.js';

describe('backfillFirstSubmittedAt', () => {
  test('seeds from latest_revision_at only where unset', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO students (id, schoology_uid, first_name, last_name) VALUES (1, 'u1', 'A', 'B')`).run();
    db.prepare(`INSERT INTO courses (id, schoology_section_id, course_name) VALUES (1, 's1', 'C')`).run();
    db.prepare(`INSERT INTO assignments (id, course_id, schoology_assignment_id, title) VALUES (1, 1, 'a1', 'T'), (2, 1, 'a2', 'T2'), (3, 1, 'a3', 'T3')`).run();
    db.prepare(`INSERT INTO grades (student_id, assignment_id, latest_revision_at, first_submitted_at) VALUES (1, 1, 500, 0), (1, 2, 900, 300), (1, 3, 0, 0)`).run();
    backfillFirstSubmittedAt(db);
    const got = db.prepare('SELECT assignment_id, first_submitted_at FROM grades ORDER BY assignment_id').all();
    expect(got).toEqual([
      { assignment_id: 1, first_submitted_at: 500 },
      { assignment_id: 2, first_submitted_at: 300 },
      { assignment_id: 3, first_submitted_at: 0 },
    ]);
  });
});
```

In `server/services/sync.test.js`, inside `describe('syncSectionData — submission state: native bulk + lti documents (#55/#62)', …)`, add after the existing LTI `#125` tests. They reuse that block's `db`, `courseId`, `getGradeRow`, and the mocked `getSectionEnrollments` / `getSectionAssignments` / `getAssignmentSubmissions`. Read the block's `beforeEach` first; the existing tests show the exact call shape.

```js
  test('triage: native first_submitted_at keeps the earliest across syncs', async () => {
    getSectionEnrollments.mockResolvedValue([{ id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' }]);
    getSectionAssignments.mockResolvedValue([{ id: 'N1', title: 'Essay', published: 1, allow_dropbox: '1' }]);

    getAssignmentSubmissions.mockResolvedValue([{ revision_id: 1, uid: '701', created: 1000, late: 0, draft: 0 }]);
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {});
    expect(getGradeRow('701', 'N1').first_submitted_at).toBe(1000);

    // A later resubmission moves latest_revision_at but not first_submitted_at.
    getAssignmentSubmissions.mockResolvedValue([{ revision_id: 2, uid: '701', created: 2000, late: 1, draft: 0 }]);
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {});
    const row = getGradeRow('701', 'N1');
    expect(row.latest_revision_at).toBe(2000);
    expect(row.first_submitted_at).toBe(1000);
  });

  test('triage: lti submitted time seeds first_submitted_at and keeps the earliest', async () => {
    getSectionEnrollments.mockResolvedValue([{ id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' }]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);
    const docs = (t) => async () => ({
      states: new Map([['701', 'submitted']]),
      details: new Map([['701', { submittedAt: t, late: 0 }]]),
    });
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), { fetchDocuments: docs(1500) });
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), { fetchDocuments: docs(2500) });
    expect(getGradeRow('701', 'L1').first_submitted_at).toBe(1500);
  });
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run server/db/firstSubmitted.test.js server/services/sync.test.js`
Expected: the backfill test passes once Step 1 is in. The two new sync tests FAIL, because `first_submitted_at` stays 0 (the upserts don't write it yet).

- [ ] **Step 4: Write `first_submitted_at` in the sync upserts** (`server/services/sync.js`)

Near the top of the file, after the imports, add:

```js
// Triage: grades.first_submitted_at is a running minimum of the non-zero
// submission times we observe (the bulk revisions API only returns the latest
// revision). Used in each submission upsert's ON CONFLICT clause.
const KEEP_EARLIEST_FIRST_SUBMITTED = `
      first_submitted_at = CASE
        WHEN excluded.first_submitted_at > 0
         AND (COALESCE(grades.first_submitted_at, 0) = 0 OR excluded.first_submitted_at < grades.first_submitted_at)
        THEN excluded.first_submitted_at ELSE grades.first_submitted_at END`;
```

Change **both** native upserts: `upsertSubmissionWithType` in `syncSectionData`, and the one in `retrySubmissions`. They are identical. The new text:

```js
  const upsertSubmissionWithType = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, exception, late, draft, latest_revision_at, first_submitted_at, submission_type, synced_at)
    VALUES (?, ?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      late = excluded.late,
      draft = excluded.draft,
      latest_revision_at = excluded.latest_revision_at,
      submission_type = excluded.submission_type,
      synced_at = excluded.synced_at,${KEEP_EARLIEST_FIRST_SUBMITTED}
  `);
```

Every `.run(` call of `upsertSubmissionWithType` (in `syncSectionData` and in `retrySubmissions`) gains the latest revision time a second time, as the `first_submitted_at` argument. For example, in `writeSubmissions`:

```js
        upsertSubmissionWithType.run(
          r.studentId, r.assignmentId, r.enrolmentId, r.maxPoints,
          d.late, d.draft, d.latestRevisionAt, d.latestRevisionAt, d.submissionType, now,
        );
```

Find the retry pass's `.run(` with `grep -n "upsertSubmissionWithType.run" server/services/sync.js`. Apply the same change there: duplicate its `latestRevisionAt` argument into the new slot.

Change `upsertLtiStateWithTime` to:

```js
  const upsertLtiStateWithTime = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, lti_submission_state, submitted_at, latest_revision_at, first_submitted_at, late, synced_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      lti_submission_state = excluded.lti_submission_state,
      submitted_at = excluded.submitted_at,
      latest_revision_at = excluded.latest_revision_at,
      late = excluded.late,
      synced_at = excluded.synced_at,${KEEP_EARLIEST_FIRST_SUBMITTED}
  `);
```

Its `.run(` becomes:

```js
            upsertLtiStateWithTime.run(
              studentRow.id, assignRow.id, String(e.id), assignRow.max_points ?? null, state,
              detail.submittedAt ?? 0, detail.submittedAt ?? 0, detail.submittedAt ?? 0, detail.late ?? 0, now,
            );
```

Leave `clearSubmissionWithType` alone. A cleared submission keeps its observed first time.

- [ ] **Step 5: Run the tests and confirm they pass (whole sync suite, no regressions)**

Run: `npx vitest run server/db/firstSubmitted.test.js server/services/sync.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.sql server/db/index.js server/db/firstSubmitted.test.js server/services/sync.js server/services/sync.test.js
git commit -m "feat(triage): record the earliest observed submission time per grade"
```

---

### Task 5: Referrals table

**Files:**
- Modify: `server/db/schema.sql`

The table is exercised by Task 6's tests. There's no separate test here.

- [ ] **Step 1: Append to `server/db/schema.sql`**

```sql
-- Triage: the teacher's handling of a late-work pair that reached the referral
-- limit — 'referred' (sent to the academic office) or 'exempt' (e.g. an agreed
-- extension). A row removes the pair from the late-work list; undo = delete.
-- days_late is the school-day count when the action was taken.
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  action TEXT NOT NULL CHECK (action IN ('referred', 'exempt')),
  note TEXT,
  days_late INTEGER,
  source TEXT NOT NULL DEFAULT 'app',   -- 'app' | 'mcp'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, assignment_id)
);
```

- [ ] **Step 2: Commit** (together with Task 6, since the table is only used there; skip a separate commit if implementing back-to-back)

---

### Task 6: Triage service — late work, feedback owed, referrals

**Files:**
- Create: `server/services/triage.js`
- Test: `server/services/triage.test.js`

**Interfaces:**
- Consumes: `todayLocal`, `epochToLocalDate` (Task 1); `loadCalendar` (Task 2); `getTriageSettings` (Task 3); `grades.first_submitted_at` (Task 4); the `referrals` table (Task 5); and `gradingState` from `server/services/assessmentContext.js`, plus `preferredFirstName` from `server/services/studentNames.js` (both existing).
- Produces:
  - `toneFor(days, limit, warnLead): 'green'|'amber'|'red'`
  - `getTriage(db, { courseId?, studentId?, includeFormative?, today? })` returns:
    ```
    { today, includeFormative, settings, lastSyncAt, referralCount, approx,
      calendar: { source, totalSchoolDays, syncedAt, today: info(today) },
      counts: { atReferralLimit, feedbackOverdue },
      lateWork: [{ kind: 'outstanding'|'submitted_late', studentId, studentUid, studentName, courseId, courseName,
                   assignmentId, schoologyAssignmentId, title, dueDate, daysLate, submittedOn, tone, approx }],
      feedbackOwed: [{ assignmentId, schoologyAssignmentId, courseId, courseName, title, dueDate, aligned,
                       owed, submittedTotal, oldestWaitDays, tone, approx }] }
    ```
  - `listReferrals(db, { courseId?, studentId?, since?, id? })` returns `[{ id, action, note, daysLate, source, createdAt, studentId, studentName, assignmentId, schoologyAssignmentId, title, dueDate, courseId, courseName }]`
  - `recordReferral(db, { studentId, assignmentId, action, note?, source?, today? })` returns the referral row, or throws `TriageError` with `code` `'BAD_ACTION'|'NOT_FOUND'|'NOT_ON_LIST'`.
  - `undoReferral(db, id)` returns `{ deleted: boolean }`.
  - `class TriageError extends Error { code }`

- [ ] **Step 1: Write the failing tests**

```js
// server/services/triage.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { addDays, isWeekday } from '../lib/schoolDays.js';
import { storeSchoolDays } from './schoolCalendar.js';
import { updateTriageSettings } from './settings.js';
import { getTriage, recordReferral, undoReferral, listReferrals, toneFor, TriageError } from './triage.js';

const TODAY = '2026-10-16'; // Fri

// Calendar 01/09–30/10/2026: weekdays in session except 01/10 + 02/10.
function seedCalendar(db) {
  const days = [];
  for (let d = '2026-09-01'; d <= '2026-10-30'; d = addDays(d, 1)) {
    const off = !isWeekday(d) || d === '2026-10-01' || d === '2026-10-02';
    days.push({ date: d, inSession: !off, cycleLetter: null, raw: '{}' });
  }
  storeSchoolDays(db, days, '2026-10-01T00:00:00Z');
}

const epoch = (iso) => Date.parse(`${iso}T04:00:00Z`) / 1000; // same date in UTC and HK

let db, courseId, topicCount;
function student(uid, first, last, { dropped = false } = {}) {
  const id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, ?)`).run(uid, first, last).lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, dropped_at) VALUES (?, ?, ?)`).run(id, courseId, dropped ? '2026-09-10' : null);
  return id;
}
function assignment(sid, title, due, { summative = true, lti = 0, assignees = null } = {}) {
  const id = db.prepare(`
    INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, is_lti_submission, num_assignees, published)
    VALUES (?, ?, ?, ?, ?, ?, 1)`).run(courseId, sid, title, `${due} 15:30:00`, lti, assignees ? assignees.length : null).lastInsertRowid;
  if (summative) {
    topicCount += 1;
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES (?, 'cat-1', ?, ?, 'T')`).run(`topic-${sid}`, courseId, `X.${topicCount}`);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES (?, ?, ?)`).run(sid, `topic-${sid}`, courseId);
  }
  for (const uid of assignees || []) db.prepare(`INSERT INTO assignment_assignees (assignment_id, schoology_uid) VALUES (?, ?)`).run(id, uid);
  return id;
}
function grade(studentId, assignmentId, cols) {
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
    .run(studentId, assignmentId, ...keys.map((k) => cols[k]));
}
function scoreTopic(uid, sid) {
  db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES (?, ?, ?, 75, 'EX')`).run(uid, sid, `topic-${sid}`);
}

beforeEach(() => {
  db = getDb();
  db.exec(
    'DELETE FROM referrals; DELETE FROM settings; DELETE FROM school_days; DELETE FROM mastery_scores; DELETE FROM mastery_alignments; ' +
    'DELETE FROM assignment_assignees; DELETE FROM grades; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
    'DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses; DELETE FROM sync_log;',
  );
  topicCount = 0;
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AP CSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'X', 'Cat')`).run(courseId);
  seedCalendar(db);
});

describe('toneFor', () => {
  test('green below limit-lead, amber from limit-lead, red from limit', () => {
    expect(toneFor(4, 8, 3)).toBe('green');
    expect(toneFor(5, 8, 3)).toBe('amber');
    expect(toneFor(8, 8, 3)).toBe('red');
  });
});

describe('getTriage — late work', () => {
  test('never-engaged student (no grades row) is outstanding, counted in school days', () => {
    const maya = student('u1', 'Maya', 'Chen');
    assignment('a1', 'Create Task CP2', '2026-10-05'); // Mon; 06..16/10 = 9 school days
    const t = getTriage(db, { today: TODAY });
    expect(t.lateWork).toHaveLength(1);
    expect(t.lateWork[0]).toMatchObject({
      kind: 'outstanding', studentId: maya, studentName: 'Maya Chen', title: 'Create Task CP2',
      dueDate: '2026-10-05', daysLate: 9, tone: 'red', approx: false, courseName: 'AP CSP',
    });
    expect(t.counts.atReferralLimit).toBe(1);
  });

  test('due today or not yet due → not listed', () => {
    student('u1', 'Maya', 'Chen');
    assignment('a1', 'Due today', TODAY);
    assignment('a2', 'Future', '2026-10-20');
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('formative work never appears on the late list', () => {
    student('u1', 'Maya', 'Chen');
    assignment('f1', 'Practice', '2026-10-05', { summative: false });
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('submitted before the limit clears; excused never listed', () => {
    const a = student('u1', 'Ada', 'L');
    const b = student('u2', 'Bo', 'M');
    const id = assignment('a1', 'Essay', '2026-10-05');
    grade(a, id, { submission_type: 'drop', latest_revision_at: epoch('2026-10-07'), first_submitted_at: epoch('2026-10-07') });
    grade(b, id, { exception: 1 });
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('Missing exception still counts as outstanding (grade timestamp is not a submission)', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Essay', '2026-10-05');
    grade(a, id, { exception: 3, submitted_at: epoch('2026-10-06') });
    expect(getTriage(db, { today: TODAY }).lateWork[0]).toMatchObject({ kind: 'outstanding', daysLate: 9 });
  });

  test('scored on paper with no submission → not outstanding', () => {
    const a = student('u1', 'Ada', 'L');
    assignment('a1', 'Paper test', '2026-10-05');
    scoreTopic('u1', 'a1');
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('submitted after crossing the limit stays listed (sticky), tagged submitted_late', () => {
    const a = student('u1', 'Ada', 'L');
    // Due Mon 21/09; first submitted Mon 05/10 → 22–25/09 (4) + 28–30/09 (3) + 05/10 (1) = 8 (01/10 + 02/10 off).
    const id = assignment('a1', 'Essay', '2026-09-21');
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05'), latest_revision_at: epoch('2026-10-05') });
    const row = getTriage(db, { today: TODAY }).lateWork[0];
    expect(row).toMatchObject({ kind: 'submitted_late', daysLate: 8, submittedOn: '2026-10-05', tone: 'red' });
  });

  test('on-time first submission, late resubmission → not listed', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Essay', '2026-09-21');
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-09-21'), latest_revision_at: epoch('2026-10-14') });
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('non-assignee of an individually-assigned task is not listed', () => {
    student('u1', 'Ada', 'L');
    student('u2', 'Bo', 'M');
    assignment('a1', 'Extra-time copy', '2026-10-05', { assignees: ['u2'] });
    expect(getTriage(db, { today: TODAY }).lateWork.map((r) => r.studentName)).toEqual(['Bo M']);
  });

  test('dropped student is not listed', () => {
    student('u1', 'Ada', 'L', { dropped: true });
    assignment('a1', 'Essay', '2026-10-05');
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('LTI in-progress counts as not submitted', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'OneDrive essay', '2026-10-05', { lti: 1 });
    grade(a, id, { lti_submission_state: 'in_progress' });
    expect(getTriage(db, { today: TODAY }).lateWork).toHaveLength(1);
  });

  test('settings move the thresholds', () => {
    student('u1', 'Ada', 'L');
    assignment('a1', 'Essay', '2026-10-12'); // 13..16/10 = 4 school days
    expect(getTriage(db, { today: TODAY }).lateWork[0].tone).toBe('green');
    updateTriageSettings(db, { referralLimitDays: 4 });
    expect(getTriage(db, { today: TODAY }).lateWork[0].tone).toBe('red');
  });

  test('courseId and studentId filters', () => {
    const a = student('u1', 'Ada', 'L');
    student('u2', 'Bo', 'M');
    assignment('a1', 'Essay', '2026-10-05');
    const other = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-2', 'AIML')`).run().lastInsertRowid;
    expect(getTriage(db, { today: TODAY, courseId: other }).lateWork).toEqual([]);
    expect(getTriage(db, { today: TODAY, studentId: a }).lateWork.map((r) => r.studentId)).toEqual([a]);
  });

  test('archived and hidden courses are excluded from the all-courses view', () => {
    student('u1', 'Ada', 'L');
    assignment('a1', 'Essay', '2026-10-05');
    db.prepare('UPDATE courses SET hidden = 1 WHERE id = ?').run(courseId);
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
    expect(getTriage(db, { today: TODAY, courseId }).lateWork).toHaveLength(1); // course page still shows it
    db.prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
    expect(getTriage(db, { today: TODAY, courseId }).lateWork).toEqual([]);
  });

  test('no calendar → weekday count flagged approx', () => {
    db.exec('DELETE FROM school_days;');
    student('u1', 'Ada', 'L');
    assignment('a1', 'Essay', '2026-09-30'); // weekdays 01/10..16/10 = 12 (holidays not known)
    const t = getTriage(db, { today: TODAY });
    expect(t.lateWork[0]).toMatchObject({ daysLate: 12, approx: true });
    expect(t.calendar.source).toBe('weekdays');
    expect(t.approx).toBe(true);
  });
});

describe('getTriage — feedback owed', () => {
  test('submitted + ungraded or partial is owed; complete is not; oldest wait from max(due, first submitted)', () => {
    const a = student('u1', 'Ada', 'L');
    const b = student('u2', 'Bo', 'M');
    const c = student('u3', 'Cy', 'N');
    const id = assignment('a1', 'Model Card', '2026-10-05');
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-02') });               // on time → waits from due (9)
    grade(b, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-12'), grade_comment: 'part' }); // late, partial → from 12/10 (4)
    grade(c, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05'), grade_comment: 'Done' });
    scoreTopic('u3', 'a1');                                                                             // complete
    const t = getTriage(db, { today: TODAY });
    expect(t.feedbackOwed).toEqual([expect.objectContaining({
      title: 'Model Card', owed: 2, submittedTotal: 3, oldestWaitDays: 9, tone: 'amber', aligned: true,
    })]);
  });

  test('formative only when includeFormative (or the settings default)', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('f1', 'Practice', '2026-10-05', { summative: false });
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05') });
    expect(getTriage(db, { today: TODAY }).feedbackOwed).toEqual([]);
    expect(getTriage(db, { today: TODAY, includeFormative: true }).feedbackOwed).toHaveLength(1);
    updateTriageSettings(db, { showFormativeDefault: true });
    const t = getTriage(db, { today: TODAY });
    expect(t.includeFormative).toBe(true);
    expect(t.feedbackOwed).toHaveLength(1);
  });

  test('a scored formative (no topics) is complete', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('f1', 'Practice', '2026-10-05', { summative: false });
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05'), score: 1 });
    expect(getTriage(db, { today: TODAY, includeFormative: true }).feedbackOwed).toEqual([]);
  });
});

describe('referrals', () => {
  function atLimit() {
    const a = student('u1', 'Maya', 'Chen');
    const id = assignment('a1', 'CP2', '2026-10-05');
    return { studentId: a, assignmentId: id };
  }

  test('record → leaves the late list, appears in history; undo → back', () => {
    const pair = atLimit();
    const r = recordReferral(db, { ...pair, action: 'referred', today: TODAY });
    expect(r).toMatchObject({ action: 'referred', daysLate: 9, studentName: 'Maya Chen', title: 'CP2', source: 'app' });
    const t = getTriage(db, { today: TODAY });
    expect(t.lateWork).toEqual([]);
    expect(t.referralCount).toBe(1);
    expect(listReferrals(db, {})).toHaveLength(1);
    expect(undoReferral(db, r.id)).toEqual({ deleted: true });
    expect(getTriage(db, { today: TODAY }).lateWork).toHaveLength(1);
  });

  test('exempt keeps its note and source', () => {
    const pair = atLimit();
    const r = recordReferral(db, { ...pair, action: 'exempt', note: 'agreed extension', source: 'mcp', today: TODAY });
    expect(r).toMatchObject({ action: 'exempt', note: 'agreed extension', source: 'mcp' });
  });

  test('rejects a bad action, an unknown assignment, and a pair not on the list', () => {
    const pair = atLimit();
    expect(() => recordReferral(db, { ...pair, action: 'nope', today: TODAY })).toThrow(TriageError);
    expect(() => recordReferral(db, { ...pair, assignmentId: 9999, action: 'referred', today: TODAY }))
      .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    const future = assignment('a9', 'Not due', '2026-10-30');
    expect(() => recordReferral(db, { studentId: pair.studentId, assignmentId: future, action: 'referred', today: TODAY }))
      .toThrow(expect.objectContaining({ code: 'NOT_ON_LIST' }));
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run server/services/triage.test.js`
Expected: FAIL, "Failed to resolve import './triage.js'".

- [ ] **Step 3: Implement**

```js
// server/services/triage.js
// Triage: late-work referral watch + feedback owed
// (docs/superpowers/specs/2026-10-01-triage-late-work-and-feedback-owed-design.md).
// The single source of truth for the web API (server/routes/triage.js) and
// PrisMCP (mcp/handlers.js), so the agent sees exactly the dashboard's numbers.
// All day counts are school days (server/lib/schoolDays.js).

import { todayLocal, epochToLocalDate } from '../lib/schoolDays.js';
import { loadCalendar } from './schoolCalendar.js';
import { getTriageSettings } from './settings.js';
import { gradingState } from './assessmentContext.js';
import { preferredFirstName } from './studentNames.js';

export class TriageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function toneFor(days, limit, warnLead) {
  if (days >= limit) return 'red';
  if (days >= limit - warnLead) return 'amber';
  return 'green';
}

// Current courses. The all-courses view (Dashboard, PrisMCP) also drops hidden
// ones; a specific course (its own page) is shown even when hidden.
function currentCourses(db, courseId) {
  if (courseId != null) {
    return db.prepare(`SELECT id, course_name FROM courses WHERE id = ? AND archived = 0 AND excluded = 0`).all(Number(courseId));
  }
  return db.prepare(`
    SELECT id, course_name FROM courses WHERE archived = 0 AND excluded = 0 AND hidden = 0 ORDER BY course_name
  `).all();
}

function roster(db, courseId) {
  return db.prepare(`
    SELECT s.id, s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher
    FROM students s JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ? AND e.dropped_at IS NULL
    ORDER BY s.last_name, s.first_name
  `).all(courseId);
}

// Published assignments whose due date has passed (due date before today).
function pastDueAssignments(db, courseId, today) {
  return db.prepare(`
    SELECT a.id, a.course_id, a.schoology_assignment_id, a.title, a.due_date, a.is_lti_submission, a.num_assignees,
      CASE WHEN EXISTS (
        SELECT 1 FROM mastery_alignments ma WHERE ma.assignment_schoology_id = a.schoology_assignment_id
        UNION
        SELECT 1 FROM mastery_scores ms WHERE ms.assignment_schoology_id = a.schoology_assignment_id
      ) THEN 1 ELSE 0 END AS aligned
    FROM assignments a
    WHERE a.course_id = ? AND a.published = 1
      AND a.due_date IS NOT NULL AND a.due_date != '' AND substr(a.due_date, 1, 10) < ?
  `).all(courseId, today);
}

function assignmentFacts(db, a) {
  let topicsCount = db.prepare(
    `SELECT COUNT(*) AS n FROM mastery_alignments WHERE assignment_schoology_id = ? AND course_id = ?`,
  ).get(a.schoology_assignment_id, a.course_id).n;
  if (topicsCount === 0 && a.aligned) {
    // Alignments not synced yet: fall back to the topics that have scores (mirrors getAlignedTopics).
    topicsCount = db.prepare(
      `SELECT COUNT(DISTINCT topic_id) AS n FROM mastery_scores WHERE assignment_schoology_id = ?`,
    ).get(a.schoology_assignment_id).n;
  }
  const scoredByUid = new Map(db.prepare(`
    SELECT student_uid, COUNT(*) AS n FROM mastery_scores WHERE assignment_schoology_id = ? GROUP BY student_uid
  `).all(a.schoology_assignment_id).map((r) => [r.student_uid, r.n]));
  const gradeByStudent = new Map(db.prepare(`
    SELECT student_id, score, grade_comment, exception, submitted_at, first_submitted_at,
           submission_type, lti_submission_state
    FROM grades WHERE assignment_id = ?
  `).all(a.id).map((g) => [g.student_id, g]));
  const assignees = a.num_assignees > 0
    ? new Set(db.prepare(`SELECT schoology_uid FROM assignment_assignees WHERE assignment_id = ?`).all(a.id).map((r) => r.schoology_uid))
    : null;
  return { topicsCount, scoredByUid, gradeByStudent, assignees };
}

// Submitted = a real submission signal. For non-LTI work grade.timestamp
// (submitted_at) also follows a teacher's grade entry, and a Missing (3)
// exception is exactly such an entry without a submission.
function isSubmitted(a, g) {
  if (g.submission_type) return true;
  if (a.is_lti_submission) return g.lti_submission_state === 'submitted';
  return Number(g.exception) !== 3 && Number(g.submitted_at) > 0;
}

function studentState(a, facts, st) {
  const g = facts.gradeByStudent.get(st.id) || {};
  const topicScored = facts.scoredByUid.get(st.schoology_uid) || 0;
  const grading = gradingState({
    // No rubric topics: the plain score is the grade (client gradingStateOf parity).
    scoredCount: facts.topicsCount === 0 ? (g.score != null ? 1 : 0) : topicScored,
    topicsCount: facts.topicsCount,
    hasComment: (g.grade_comment || '').trim().length > 0,
    exception: g.exception ?? 0,
  });
  return {
    excused: Number(g.exception) === 1,
    submitted: isSubmitted(a, g),
    scored: g.score != null || topicScored > 0,
    grading,
    firstSubmittedOn: epochToLocalDate(g.first_submitted_at),
  };
}

const fullName = (st) => `${preferredFirstName(st)} ${st.last_name}`;

export function getTriage(db, { courseId = null, studentId = null, includeFormative, today = todayLocal() } = {}) {
  const settings = getTriageSettings(db);
  const formative = includeFormative ?? settings.showFormativeDefault;
  const { referralLimitDays, feedbackLimitDays, warnLeadDays } = settings;
  const cal = loadCalendar(db);
  const handled = new Set(db.prepare('SELECT student_id, assignment_id FROM referrals').all()
    .map((r) => `${r.student_id}:${r.assignment_id}`));

  const lateWork = [];
  const feedbackOwed = [];
  const courses = currentCourses(db, courseId);
  for (const c of courses) {
    const students = roster(db, c.id).filter((st) => studentId == null || st.id === Number(studentId));
    for (const a of pastDueAssignments(db, c.id, today)) {
      if (!a.aligned && !formative) continue; // nothing to report for formative work
      const facts = assignmentFacts(db, a);
      const due = a.due_date.slice(0, 10);
      let owed = 0;
      let submittedTotal = 0;
      let oldestWaitDays = 0;
      let waitApprox = false;

      for (const st of students) {
        if (facts.assignees && !facts.assignees.has(st.schoology_uid)) continue;
        const s = studentState(a, facts, st);
        if (s.excused) continue;

        // Late work (summative only).
        if (a.aligned && !handled.has(`${st.id}:${a.id}`)) {
          let row = null;
          if (!s.submitted && !s.scored) {
            const { days, approx } = cal.between(due, today);
            if (days >= 1) row = { kind: 'outstanding', daysLate: days, submittedOn: null, approx };
          } else if (s.firstSubmittedOn) {
            const { days, approx } = cal.between(due, s.firstSubmittedOn);
            if (days >= referralLimitDays) row = { kind: 'submitted_late', daysLate: days, submittedOn: s.firstSubmittedOn, approx };
          }
          if (row) {
            lateWork.push({
              ...row,
              studentId: st.id, studentUid: st.schoology_uid, studentName: fullName(st),
              courseId: c.id, courseName: c.course_name,
              assignmentId: a.id, schoologyAssignmentId: a.schoology_assignment_id, title: a.title, dueDate: due,
              tone: toneFor(row.daysLate, referralLimitDays, warnLeadDays),
            });
          }
        }

        // Feedback owed.
        if (!s.submitted && !s.scored) continue;
        submittedTotal++;
        if (s.grading === 'complete') continue;
        owed++;
        const start = s.firstSubmittedOn && s.firstSubmittedOn > due ? s.firstSubmittedOn : due;
        const w = cal.between(start, today);
        oldestWaitDays = Math.max(oldestWaitDays, w.days);
        waitApprox = waitApprox || w.approx;
      }

      if (owed > 0) {
        feedbackOwed.push({
          assignmentId: a.id, schoologyAssignmentId: a.schoology_assignment_id,
          courseId: c.id, courseName: c.course_name, title: a.title, dueDate: due, aligned: !!a.aligned,
          owed, submittedTotal, oldestWaitDays,
          tone: toneFor(oldestWaitDays, feedbackLimitDays, warnLeadDays), approx: waitApprox,
        });
      }
    }
  }

  lateWork.sort((x, y) => y.daysLate - x.daysLate || x.studentName.localeCompare(y.studentName));
  feedbackOwed.sort((x, y) => y.oldestWaitDays - x.oldestWaitDays || x.title.localeCompare(y.title));

  const courseIds = courses.map((c) => c.id);
  const referralCount = courseIds.length
    ? db.prepare(`SELECT COUNT(*) AS n FROM referrals WHERE course_id IN (${courseIds.map(() => '?').join(',')})`).get(...courseIds).n
    : 0;
  const last = db.prepare('SELECT COALESCE(completed_at, started_at) AS at FROM sync_log ORDER BY id DESC LIMIT 1').get();

  return {
    today,
    includeFormative: formative,
    settings,
    lastSyncAt: last?.at ?? null,
    referralCount,
    calendar: { source: cal.source, totalSchoolDays: cal.totalSchoolDays, syncedAt: cal.syncedAt, today: cal.info(today) },
    counts: {
      atReferralLimit: lateWork.filter((r) => r.tone === 'red').length,
      feedbackOverdue: feedbackOwed.filter((r) => r.tone === 'red').length,
    },
    approx: lateWork.some((r) => r.approx) || feedbackOwed.some((r) => r.approx),
    lateWork,
    feedbackOwed,
  };
}

export function listReferrals(db, { courseId = null, studentId = null, since = null, id = null } = {}) {
  return db.prepare(`
    SELECT r.id, r.action, r.note, r.days_late AS daysLate, r.source, r.created_at AS createdAt,
           r.student_id AS studentId, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
           r.assignment_id AS assignmentId, a.schoology_assignment_id AS schoologyAssignmentId, a.title,
           substr(a.due_date, 1, 10) AS dueDate, r.course_id AS courseId, c.course_name AS courseName
    FROM referrals r
    JOIN students s ON s.id = r.student_id
    JOIN assignments a ON a.id = r.assignment_id
    JOIN courses c ON c.id = r.course_id
    WHERE (? IS NULL OR r.id = ?) AND (? IS NULL OR r.course_id = ?)
      AND (? IS NULL OR r.student_id = ?) AND (? IS NULL OR r.created_at >= ?)
    ORDER BY r.created_at DESC, r.id DESC
  `).all(id, id, courseId, courseId, studentId, studentId, since, since)
    .map(({ first_name, last_name, preferred_name, preferred_name_teacher, ...r }) => ({
      ...r,
      studentName: `${preferredFirstName({ first_name, preferred_name, preferred_name_teacher })} ${last_name}`,
    }));
}

export function recordReferral(db, { studentId, assignmentId, action, note = null, source = 'app', today = todayLocal() } = {}) {
  if (action !== 'referred' && action !== 'exempt') {
    throw new TriageError('BAD_ACTION', `action must be 'referred' or 'exempt'`);
  }
  const a = db.prepare('SELECT id, course_id FROM assignments WHERE id = ?').get(Number(assignmentId));
  if (!a) throw new TriageError('NOT_FOUND', `No assignment with id ${assignmentId}`);
  const row = getTriage(db, { courseId: a.course_id, studentId, includeFormative: false, today })
    .lateWork.find((r) => r.assignmentId === a.id);
  if (!row) throw new TriageError('NOT_ON_LIST', 'That student and assignment are not on the late-work list');
  const id = db.prepare(`
    INSERT INTO referrals (student_id, assignment_id, course_id, action, note, days_late, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(Number(studentId), a.id, a.course_id, action, note || null, row.daysLate, source).lastInsertRowid;
  return listReferrals(db, { id })[0];
}

export function undoReferral(db, id) {
  return { deleted: db.prepare('DELETE FROM referrals WHERE id = ?').run(Number(id)).changes > 0 };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run server/services/triage.test.js`
Expected: PASS. If a day count is off, recount by hand against the seeded calendar (01/10 and 02/10 are off, plus weekends) before changing the code. The test comments give the expected spans.

- [ ] **Step 5: Run the whole server suite**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.sql server/services/triage.js server/services/triage.test.js
git commit -m "feat(triage): late-work + feedback-owed service with referrals"
```

---

### Task 7: Triage API routes

**Files:**
- Create: `server/routes/triage.js`
- Modify: `server/index.js`
- Test: `server/routes/triage.test.js`

**Interfaces:**
- Consumes: `getTriage`, `listReferrals`, `recordReferral`, `undoReferral`, `TriageError` (Task 6).
- Produces:
  - `GET /api/triage?courseId=&includeFormative=true|false` returns the `getTriage` payload.
  - `GET /api/triage/referrals?courseId=` returns `listReferrals`.
  - `POST /api/triage/referrals` with `{ studentId, assignmentId, action, note? }` returns 201 with the row. Errors: 400 BAD_ACTION, 404 NOT_FOUND, 409 NOT_ON_LIST.
  - `DELETE /api/triage/referrals/:id` returns `{ deleted }`.

- [ ] **Step 1: Write the failing test**

```js
// server/routes/triage.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './triage.js';
import { getDb } from '../db/index.js';

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/triage', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

let studentId, assignmentId;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM referrals; DELETE FROM school_days; DELETE FROM mastery_alignments; DELETE FROM grades; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'AP CSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'X', 'C')`).run(courseId);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat', ?, 'X.1', 'T')`).run(courseId);
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(studentId, courseId);
  // Due long ago (weekday fallback, no calendar) → well past the limit.
  assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date) VALUES (?, 'a1', 'CP2', '2020-01-06 15:30:00')`).run(courseId).lastInsertRowid;
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('a1', 't1', ?)`).run(courseId);
});

describe('/api/triage', () => {
  test('GET returns both lists', async () => {
    const { status, body } = await call('GET', '/api/triage');
    expect(status).toBe(200);
    expect(body.lateWork).toHaveLength(1);
    expect(body.feedbackOwed).toEqual([]);
    expect(body.calendar.source).toBe('weekdays');
  });

  test('POST referral → 201; it then leaves the list; DELETE undoes', async () => {
    const created = await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'referred' });
    expect(created.status).toBe(201);
    expect((await call('GET', '/api/triage')).body.lateWork).toEqual([]);
    expect((await call('GET', '/api/triage/referrals')).body).toHaveLength(1);
    expect((await call('DELETE', `/api/triage/referrals/${created.body.id}`)).body).toEqual({ deleted: true });
  });

  test('POST errors map to status codes', async () => {
    expect((await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/triage/referrals', { studentId, assignmentId: 999, action: 'referred' })).status).toBe(404);
    await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'referred' });
    expect((await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'exempt' })).status).toBe(409);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run server/routes/triage.test.js`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement**

```js
// server/routes/triage.js
// Late-work referral watch + feedback owed (server/services/triage.js).
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { getTriage, listReferrals, recordReferral, undoReferral, TriageError } from '../services/triage.js';

const router = Router();
const STATUS = { BAD_ACTION: 400, NOT_FOUND: 404, NOT_ON_LIST: 409 };
const optBool = (v) => (v === undefined ? undefined : v === 'true');

// GET /api/triage?courseId=&includeFormative= — both lists (all current courses when no courseId).
router.get('/', (req, res) => {
  res.json(getTriage(getDb(), {
    courseId: req.query.courseId ?? null,
    includeFormative: optBool(req.query.includeFormative),
  }));
});

// GET /api/triage/referrals?courseId= — referred / exempt history, newest first.
router.get('/referrals', (req, res) => {
  res.json(listReferrals(getDb(), { courseId: req.query.courseId ?? null }));
});

// POST /api/triage/referrals — { studentId, assignmentId, action: 'referred'|'exempt', note? }
router.post('/referrals', (req, res) => {
  const { studentId, assignmentId, action, note } = req.body || {};
  try {
    res.status(201).json(recordReferral(getDb(), { studentId, assignmentId, action, note, source: 'app' }));
  } catch (err) {
    if (err instanceof TriageError) return res.status(STATUS[err.code] || 400).json({ error: err.message, code: err.code });
    throw err;
  }
});

// DELETE /api/triage/referrals/:id — undo a referral / exemption.
router.delete('/referrals/:id', (req, res) => {
  res.json(undoReferral(getDb(), req.params.id));
});

export default router;
```

In `server/index.js`: add `import triageRouter from './routes/triage.js';`, and `app.use('/api/triage', triageRouter);` after the `/api/settings` line.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run server/routes/triage.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/triage.js server/routes/triage.test.js server/index.js
git commit -m "feat(triage): /api/triage routes"
```

---

### Task 8: PrisMCP tools

**Files:**
- Modify: `mcp/handlers.js` (new handlers), `mcp/server.js` (register tools, extend `INSTRUCTIONS`)
- Modify: `docs/prismcp-install-and-verify.md` (add the tools wherever the existing tools are listed)
- Test: `mcp/handlers.test.js`, `mcp/server.test.js` (add cases)

**Interfaces:**
- Consumes: Task 6 service, `loadCalendar` (Task 2), `todayLocal` (Task 1).
- Produces handlers:
  - `resolveCourseRef(db, ref): number|null`
  - `getTriageTool(db, { course?, student?, include_formative? })`
  - `listReferralsTool(db, { course?, since? })`
  - `schoolCalendarTool(db, { date?, to? })`
  - `recordReferralTool(db, { student_id, assignment_id, action, note? })`
  - `undoReferralTool(db, { id })`
- Produces tools: `get_triage`, `list_referrals`, `school_calendar`, `record_referral`, `undo_referral`.

- [ ] **Step 1: Write the failing tests** (append to `mcp/handlers.test.js`; extend that file's `beforeEach` DELETE list with `DELETE FROM referrals; DELETE FROM school_days; DELETE FROM mastery_scores;` at the front)

```js
import { resolveCourseRef, getTriageTool, listReferralsTool, schoolCalendarTool, recordReferralTool, undoReferralTool } from './handlers.js';

function seedLate(db) {
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, course_code) VALUES ('s', 'AP Computer Science Principles', 'APCSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'X', 'C')`).run(courseId);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat', ?, 'X.1', 'T')`).run(courseId);
  const studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(studentId, courseId);
  const assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date) VALUES (?, 'a1', 'CP2', '2020-01-06 15:30:00')`).run(courseId).lastInsertRowid;
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('a1', 't1', ?)`).run(courseId);
  return { courseId, studentId, assignmentId };
}

describe('triage tools', () => {
  test('resolveCourseRef: id, name fragment, code; ambiguous/unknown throw', () => {
    const db = getDb();
    const { courseId } = seedLate(db);
    expect(resolveCourseRef(db, courseId)).toBe(courseId);
    expect(resolveCourseRef(db, 'computer science')).toBe(courseId);
    expect(resolveCourseRef(db, 'apcsp')).toBe(courseId);
    expect(resolveCourseRef(db, undefined)).toBeNull();
    expect(() => resolveCourseRef(db, 'robotics')).toThrow(/No active course/);
  });

  test('getTriageTool filters by student name fragment', () => {
    const db = getDb();
    seedLate(db);
    expect(getTriageTool(db, { student: 'maya' }).lateWork).toHaveLength(1);
    expect(getTriageTool(db, { student: 'zed' }).lateWork).toEqual([]);
  });

  test('record → list → undo through the tools (source mcp)', () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLate(db);
    const r = recordReferralTool(db, { student_id: studentId, assignment_id: assignmentId, action: 'exempt', note: 'extension' });
    expect(r).toMatchObject({ action: 'exempt', source: 'mcp', note: 'extension' });
    expect(listReferralsTool(db, {})).toHaveLength(1);
    expect(undoReferralTool(db, { id: r.id })).toEqual({ deleted: true });
  });

  test('record_referral rejects a pair not on the list', () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLate(db);
    recordReferralTool(db, { student_id: studentId, assignment_id: assignmentId, action: 'referred' });
    expect(() => recordReferralTool(db, { student_id: studentId, assignment_id: assignmentId, action: 'referred' }))
      .toThrow(/not on the late-work list/);
  });

  test('schoolCalendarTool: between + today info, weekday fallback when empty', () => {
    const out = schoolCalendarTool(getDb(), { date: '2026-09-25', to: '2026-09-29' });
    expect(out.between).toMatchObject({ from: '2026-09-25', to: '2026-09-29', days: 2, approx: true });
    expect(out.source).toBe('weekdays');
    expect(out.today).toHaveProperty('isSchoolDay');
  });
});
```

In `mcp/server.test.js`, add `DELETE FROM referrals; DELETE FROM school_days;` to its `beforeEach`, plus:

```js
describe('PrisMCP triage tools', () => {
  test('get_triage is exposed and returns both lists', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'get_triage', arguments: {} });
    const data = JSON.parse(res.content[0].text);
    expect(data).toHaveProperty('lateWork');
    expect(data).toHaveProperty('feedbackOwed');
  });

  test('lists all five triage tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_triage', 'list_referrals', 'school_calendar', 'record_referral', 'undo_referral']));
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run mcp/handlers.test.js mcp/server.test.js`
Expected: FAIL (missing exports and tools).

- [ ] **Step 3: Implement the handlers** (append to `mcp/handlers.js`; add the imports at the top)

```js
import { getTriage, listReferrals, recordReferral, undoReferral } from '../server/services/triage.js';
import { loadCalendar } from '../server/services/schoolCalendar.js';
import { todayLocal } from '../server/lib/schoolDays.js';
```

```js
// ── Triage (late-work referral watch + feedback owed) ────────────────────────
// Same service as the dashboard (server/services/triage.js), so numbers match.

// A course reference: a local id, or a case-insensitive fragment of the course
// name or code, among current courses. null/'' → all courses.
export function resolveCourseRef(db, ref) {
  if (ref == null || ref === '') return null;
  const courses = db.prepare(`SELECT id, course_name, course_code FROM courses WHERE archived = 0 AND excluded = 0`).all();
  if (/^\d+$/.test(String(ref))) {
    const hit = courses.find((c) => c.id === Number(ref));
    if (hit) return hit.id;
  }
  const q = String(ref).toLowerCase();
  const hits = courses.filter((c) => c.course_name.toLowerCase().includes(q) || (c.course_code || '').toLowerCase().includes(q));
  if (hits.length === 1) return hits[0].id;
  if (hits.length === 0) throw new Error(`No active course matches "${ref}" — call list_courses for ids`);
  throw new Error(`"${ref}" matches several courses (${hits.map((c) => c.course_name).join(', ')}) — pass a course id`);
}

export function getTriageTool(db, { course, student, include_formative } = {}) {
  const t = getTriage(db, { courseId: resolveCourseRef(db, course), includeFormative: include_formative });
  if (student != null && student !== '') {
    const q = String(student).toLowerCase();
    t.lateWork = t.lateWork.filter((r) => String(r.studentId) === String(student) || r.studentName.toLowerCase().includes(q));
  }
  return t;
}

export function listReferralsTool(db, { course, since } = {}) {
  return listReferrals(db, { courseId: resolveCourseRef(db, course), since: since || null });
}

export function schoolCalendarTool(db, { date, to } = {}) {
  const cal = loadCalendar(db);
  const today = todayLocal();
  const from = date || today;
  return {
    source: cal.source,
    totalSchoolDays: cal.totalSchoolDays,
    syncedAt: cal.syncedAt,
    today: cal.info(today),
    date: cal.info(from),
    ...(to ? { between: { from, to, ...cal.between(from, to), rule: 'school days d with from < d <= to' } } : {}),
  };
}

export function recordReferralTool(db, { student_id, assignment_id, action, note } = {}) {
  return recordReferral(db, { studentId: student_id, assignmentId: assignment_id, action, note, source: 'mcp' });
}

export function undoReferralTool(db, { id } = {}) {
  return undoReferral(db, id);
}
```

- [ ] **Step 4: Register the tools** (`mcp/server.js`)

Extend the handlers import with `getTriageTool, listReferralsTool, schoolCalendarTool, recordReferralTool, undoReferralTool`. Replace `INSTRUCTIONS` with:

```js
export const INSTRUCTIONS =
  "Read a Prism-tracked course/assignment's roster, rubric measurement-topics, " +
  'and current grades, and write AI grading suggestions back into Prism for ' +
  'teacher review. Use when grading student work for a course managed in Prism. ' +
  'Also triage: which students are approaching an academic-office referral for ' +
  'late summative work, which assessments have waited longest for feedback ' +
  '(all in school days), and school-calendar arithmetic.';
```

Before the `// Read-only @-mention mirror` comment, add:

```js
  const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

  server.registerTool(
    'get_triage',
    {
      description:
        "Late-work referral watch + feedback owed, exactly as Prism's dashboard shows them. lateWork: summative work " +
        'not submitted (or submitted after crossing the limit), with daysLate in SCHOOL days and tone green/amber/red ' +
        '(red = at the referral limit). feedbackOwed: per assessment, how many submissions are ungraded and the oldest ' +
        'wait in school days. Includes the limits (settings), calendar source (approx = weekday fallback) and lastSyncAt — ' +
        'say when data may be stale. Use for "who is close to referral?" or "what should I grade first?".',
      inputSchema: {
        course: z.union([z.number(), z.string()]).optional().describe('Course id (list_courses) or a name/code fragment; omit for all current courses'),
        student: z.union([z.number(), z.string()]).optional().describe('Student id or name fragment to filter lateWork'),
        include_formative: z.boolean().optional().describe('Include formative work in feedbackOwed (default: the teacher setting)'),
      },
    },
    async (args) => text(getTriageTool(getDb(), args))
  );

  server.registerTool(
    'list_referrals',
    {
      description: 'History of late-work pairs the teacher marked referred (to the academic office) or exempt, newest first, with notes and the school-day count at the time.',
      inputSchema: {
        course: z.union([z.number(), z.string()]).optional().describe('Course id or name/code fragment'),
        since: z.string().optional().describe("Only records on/after this date, 'YYYY-MM-DD'"),
      },
    },
    async (args) => text(listReferralsTool(getDb(), args))
  );

  server.registerTool(
    'school_calendar',
    {
      description: "School-calendar arithmetic using the same rule as triage: info for a date (school day?, cycle letter, school-day number) and, with `to`, the count of school days d where date < d <= to. source 'weekdays' / approx = no PowerSchool calendar for that range.",
      inputSchema: {
        date: z.string().optional().describe("'YYYY-MM-DD' (default today)"),
        to: z.string().optional().describe("'YYYY-MM-DD' end date for a school-day count"),
      },
    },
    async (args) => text(schoolCalendarTool(getDb(), args))
  );

  server.registerTool(
    'record_referral',
    {
      description: "Record the teacher's action on a late-work row: 'referred' (sent to the academic office) or 'exempt' (e.g. agreed extension; add a note). ONLY call when the teacher explicitly says so. Use student_id/assignment_id from get_triage lateWork; rejects pairs not currently on the list.",
      inputSchema: {
        student_id: z.number().describe('lateWork[].studentId'),
        assignment_id: z.number().describe('lateWork[].assignmentId'),
        action: z.enum(['referred', 'exempt']),
        note: z.string().optional().describe('Optional reason, e.g. "agreed extension"'),
      },
    },
    async (args) => text(recordReferralTool(getDb(), args))
  );

  server.registerTool(
    'undo_referral',
    {
      description: 'Undo a referral/exemption by its id (from list_referrals or record_referral). The pair returns to the late-work list if still late. Only when the teacher asks.',
      inputSchema: { id: z.number().describe('Referral id') },
    },
    async (args) => text(undoReferralTool(getDb(), args))
  );
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run mcp/`
Expected: PASS.

- [ ] **Step 6: Document the tools**

Run `grep -n "attach_rubric\|list_courses" docs/prismcp-install-and-verify.md`. Wherever that doc lists the tools, add the five new ones in the same style: one line each, saying what each is for.

- [ ] **Step 7: Commit**

```bash
git add mcp/handlers.js mcp/handlers.test.js mcp/server.js mcp/server.test.js docs/prismcp-install-and-verify.md
git commit -m "feat(prismcp): triage tools — get_triage, list_referrals, school_calendar, record/undo_referral"
```

---

### Task 9: Client — API, helpers, triage panels, CSS

**Files:**
- Modify: `client/src/services/api.js`
- Create: `client/src/lib/triage.js`, `client/src/components/triage/UrgencyMeter.jsx`, `client/src/components/triage/LateWorkPanel.jsx`, `client/src/components/triage/FeedbackOwedPanel.jsx`, `client/src/components/triage/ReferralHistory.jsx`, `client/src/components/triage/TriageSection.jsx`
- Modify: `client/src/app.css` (a TRIAGE section before PHONE LAYOUT, plus phone rules inside it)
- Modify: `docs/design-language.md` (append the pattern)
- Test: `client/src/lib/triage.test.js`, `client/src/components/triage/TriageSection.test.jsx`

**Interfaces:**
- Consumes: the `/api/triage*` routes (Task 7).
- Produces:
  - api: `getTriage({ courseId?, includeFormative? })`, `getReferrals({ courseId? })`, `recordReferral({ studentId, assignmentId, action, note? })`, `undoReferral(id)`, `getSettings()`, `updateSettings({ triage })`.
  - lib: `meterPct(days, limit)`, `courseTriageSummary(triage, courseId) → { atLimit, late, toGrade, oldestWait, waitTone }`, `waitsByAssignment(triage) → { [schoologyAssignmentId]: feedbackRow }`, `TONE_BADGE = { red: 'badge-red', amber: 'badge-amber', green: 'badge-gray' }`.
  - `<TriageSection courseId? onLoaded? />` and `<UrgencyMeter days limit tone />`.

- [ ] **Step 1: API functions** (append to `client/src/services/api.js`)

```js
// Triage — late-work referral watch + feedback owed (counts in school days).
export const getTriage = ({ courseId, includeFormative } = {}) => {
  const p = new URLSearchParams();
  if (courseId != null) p.set('courseId', courseId);
  if (includeFormative != null) p.set('includeFormative', String(includeFormative));
  const qs = p.toString();
  return request(`/triage${qs ? `?${qs}` : ''}`);
};
export const getReferrals = ({ courseId } = {}) =>
  request(`/triage/referrals${courseId != null ? `?courseId=${courseId}` : ''}`);
export const recordReferral = (body) => request('/triage/referrals', { method: 'POST', body: JSON.stringify(body) });
export const undoReferral = (id) => request(`/triage/referrals/${id}`, { method: 'DELETE' });

// Settings (server-side, shared by every device and PrisMCP).
export const getSettings = () => request('/settings');
export const updateSettings = (body) => request('/settings', { method: 'PUT', body: JSON.stringify(body) });
```

- [ ] **Step 2: Write the failing tests**

```js
// client/src/lib/triage.test.js
import { describe, it, expect } from 'vitest';
import { meterPct, courseTriageSummary, waitsByAssignment } from './triage.js';

const T = {
  lateWork: [
    { courseId: 1, tone: 'red' }, { courseId: 1, tone: 'amber' }, { courseId: 2, tone: 'green' },
  ],
  feedbackOwed: [
    { courseId: 1, owed: 7, oldestWaitDays: 8, tone: 'amber', schoologyAssignmentId: 'a1' },
    { courseId: 1, owed: 3, oldestWaitDays: 11, tone: 'red', schoologyAssignmentId: 'a2' },
  ],
};

describe('triage helpers', () => {
  it('meterPct clamps to 4–100', () => {
    expect(meterPct(0, 8)).toBe(4);
    expect(meterPct(4, 8)).toBe(50);
    expect(meterPct(20, 8)).toBe(100);
  });

  it('courseTriageSummary counts per course', () => {
    expect(courseTriageSummary(T, 1)).toEqual({ atLimit: 1, late: 1, toGrade: 10, oldestWait: 11, waitTone: 'red' });
    expect(courseTriageSummary(null, 1)).toEqual({ atLimit: 0, late: 0, toGrade: 0, oldestWait: 0, waitTone: 'green' });
  });

  it('waitsByAssignment keys by Schoology id', () => {
    expect(Object.keys(waitsByAssignment(T))).toEqual(['a1', 'a2']);
  });
});
```

```jsx
// client/src/components/triage/TriageSection.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TriageSection from './TriageSection.jsx';
import * as api from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getTriage: vi.fn(),
  recordReferral: vi.fn(),
  getReferrals: vi.fn(),
  undoReferral: vi.fn(),
}));

const SETTINGS = { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false };
const PAYLOAD = {
  settings: SETTINGS, includeFormative: false, referralCount: 2, lastSyncAt: '2026-10-01 07:42:00',
  calendar: { source: 'powerschool', totalSchoolDays: 164, today: { schoolDayNumber: 35, cycleLetter: 'A' } },
  lateWork: [
    { kind: 'outstanding', studentId: 1, studentName: 'Maya Chen', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, tone: 'red', approx: false },
    { kind: 'submitted_late', studentId: 2, studentName: 'Ethan Wong', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-09-21', daysLate: 10, submittedOn: '2026-10-05', tone: 'red', approx: false },
    { kind: 'outstanding', studentId: 3, studentName: 'Aiden Li', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-14', daysLate: 2, tone: 'green', approx: false },
  ],
  feedbackOwed: [
    { assignmentId: 4, schoologyAssignmentId: 'a4', courseId: 5, courseName: 'AP CSP', title: 'Model Card', dueDate: '2026-09-14', aligned: true, owed: 18, submittedTotal: 22, oldestWaitDays: 11, tone: 'red', approx: false },
  ],
};

function renderSection(props = {}) {
  return render(<MemoryRouter><TriageSection {...props} /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getTriage.mockResolvedValue(PAYLOAD);
  api.recordReferral.mockResolvedValue({ id: 1 });
});

describe('TriageSection', () => {
  it('renders both panels with counts, tags and course chips (all-courses view)', async () => {
    renderSection();
    expect(await screen.findByText('Maya Chen')).toBeInTheDocument();
    expect(screen.getByText('2 at referral limit')).toBeInTheDocument();
    expect(screen.getByText('submitted day 10')).toBeInTheDocument();
    expect(screen.getByText('6 left')).toBeInTheDocument();
    expect(screen.getByText('18 of 22 ungraded')).toBeInTheDocument();
    expect(screen.getAllByText('AP CSP').length).toBeGreaterThan(0);
    expect(screen.getByText(/Referred \/ exempt \(2\)/)).toBeInTheDocument();
  });

  it('hides course chips on a course page and passes courseId', async () => {
    renderSection({ courseId: 5 });
    await screen.findByText('Maya Chen');
    expect(api.getTriage).toHaveBeenCalledWith({ courseId: 5, includeFormative: undefined });
    expect(screen.queryByText('AP CSP')).not.toBeInTheDocument();
  });

  it('Mark referred posts and reloads', async () => {
    renderSection();
    fireEvent.click((await screen.findAllByText('Mark referred'))[0]);
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 1, assignmentId: 9, action: 'referred', note: undefined }));
    expect(api.getTriage).toHaveBeenCalledTimes(2);
  });

  it('Exempt takes an optional note', async () => {
    renderSection();
    fireEvent.click((await screen.findAllByText('Exempt'))[0]);
    fireEvent.change(screen.getByLabelText('Exemption note'), { target: { value: 'agreed extension' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 1, assignmentId: 9, action: 'exempt', note: 'agreed extension' }));
  });

  it('Show formative refetches with includeFormative true', async () => {
    renderSection();
    fireEvent.click(await screen.findByLabelText('Show formative'));
    await waitFor(() => expect(api.getTriage).toHaveBeenLastCalledWith({ courseId: null, includeFormative: true }));
  });

  it('hands the payload to onLoaded', async () => {
    const onLoaded = vi.fn();
    renderSection({ onLoaded });
    await waitFor(() => expect(onLoaded).toHaveBeenCalledWith(PAYLOAD));
  });

  it('renders nothing when the API yields no payload', async () => {
    api.getTriage.mockResolvedValue(undefined);
    const { container } = renderSection();
    await waitFor(() => expect(api.getTriage).toHaveBeenCalled());
    expect(container.querySelector('.triage')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd client && npx vitest run src/lib/triage.test.js src/components/triage/TriageSection.test.jsx`
Expected: FAIL, unresolved imports.

- [ ] **Step 4: Implement the lib + components**

```js
// client/src/lib/triage.js
// Pure helpers for the triage panels (Dashboard + CoursePage).

export const TONE_BADGE = { red: 'badge-red', amber: 'badge-amber', green: 'badge-gray' };

// Meter fill %, with a 4% stub so a 0-day row still shows its colour.
export const meterPct = (days, limit) =>
  Math.max(4, Math.min(100, Math.round((days / Math.max(1, limit)) * 100)));

// Per-course counts for the dashboard course-card chips.
export function courseTriageSummary(triage, courseId) {
  const late = (triage?.lateWork || []).filter((r) => r.courseId === courseId);
  const owed = (triage?.feedbackOwed || []).filter((r) => r.courseId === courseId);
  const atLimit = late.filter((r) => r.tone === 'red').length;
  const oldestWait = owed.reduce((m, r) => Math.max(m, r.oldestWaitDays), 0);
  return {
    atLimit,
    late: late.length - atLimit,
    toGrade: owed.reduce((n, r) => n + r.owed, 0),
    oldestWait,
    waitTone: owed.find((r) => r.oldestWaitDays === oldestWait)?.tone ?? 'green',
  };
}

// Schoology assignment id → feedback-owed row (Assessments tab wait column).
export function waitsByAssignment(triage) {
  return Object.fromEntries((triage?.feedbackOwed || []).map((r) => [r.schoologyAssignmentId, r]));
}
```

```jsx
// client/src/components/triage/UrgencyMeter.jsx
import { meterPct } from '../../lib/triage.js';

// Horizontal fill toward a school-day limit; colour from the tone
// (green → amber → red). Width is the only inline style (it's data).
export default function UrgencyMeter({ days, limit, tone }) {
  return (
    <span className={`urgency-meter urgency-meter--${tone}`} role="img" aria-label={`${days} of ${limit} school days`}>
      <span className="urgency-meter__fill" style={{ width: `${meterPct(days, limit)}%` }} />
    </span>
  );
}
```

```jsx
// client/src/components/triage/LateWorkPanel.jsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyMeter from './UrgencyMeter.jsx';

const APPROX_TITLE = 'Approximate: counted as weekdays (no PowerSchool calendar for these dates)';

// Late summative work, worst first. At the referral limit a row offers
// Mark referred / Exempt (optional note); below it, the days left.
export default function LateWorkPanel({ rows, settings, showCourse, onRecord, onShowHistory, referralCount }) {
  const [exempting, setExempting] = useState(null);
  const [note, setNote] = useState('');
  const limit = settings.referralLimitDays;
  const atLimit = rows.filter((r) => r.tone === 'red').length;
  const key = (r) => `${r.studentId}:${r.assignmentId}`;

  return (
    <section className="card triage-panel" aria-label="Late work">
      <h3 className="triage-panel__title">
        Late work {atLimit > 0 && <span className="badge badge-red">{atLimit} at referral limit</span>}
      </h3>
      <p className="triage-panel__sub">Summative work not yet submitted · school days since due · refer at {limit}</p>
      {rows.length === 0 && <p className="text-sm text-muted">No late summative work.</p>}
      {rows.map((r) => (
        <div key={key(r)} className="triage-row triage-row--late">
          <Link to={`/student/${r.studentId}`} className="triage-row__name">{r.studentName}</Link>
          <span className="triage-row__task">
            {showCourse && <span className="triage-row__course">{r.courseName}</span>}
            {r.title}
            {r.kind === 'submitted_late' && <span className="badge badge-amber triage-row__tag">submitted day {r.daysLate}</span>}
          </span>
          <UrgencyMeter days={r.daysLate} limit={limit} tone={r.tone} />
          <span className={`triage-days triage-days--${r.tone}`}>
            {r.daysLate}{r.approx && <abbr title={APPROX_TITLE}>≈</abbr>}
          </span>
          <span className="triage-row__action">
            {r.tone !== 'red' && <span className="text-sm text-muted">{limit - r.daysLate} left</span>}
            {r.tone === 'red' && exempting !== key(r) && (
              <>
                <button className="primary" onClick={() => onRecord(r, 'referred')}>Mark referred</button>
                <button className="ghost" onClick={() => { setExempting(key(r)); setNote(''); }}>Exempt</button>
              </>
            )}
            {r.tone === 'red' && exempting === key(r) && (
              <>
                <input
                  className="triage-note" placeholder="Note (optional)" aria-label="Exemption note"
                  value={note} onChange={(e) => setNote(e.target.value)}
                />
                <button className="secondary" onClick={() => { onRecord(r, 'exempt', note); setExempting(null); }}>Save</button>
                <button className="ghost" onClick={() => setExempting(null)}>Cancel</button>
              </>
            )}
          </span>
        </div>
      ))}
      <button className="ghost triage-panel__history" onClick={onShowHistory}>
        Referred / exempt ({referralCount}) ›
      </button>
    </section>
  );
}
```

```jsx
// client/src/components/triage/FeedbackOwedPanel.jsx
import { Link } from 'react-router-dom';
import UrgencyMeter from './UrgencyMeter.jsx';

const APPROX_TITLE = 'Approximate: counted as weekdays (no PowerSchool calendar for these dates)';

// Assessments with ungraded submissions, longest wait first.
export default function FeedbackOwedPanel({ rows, settings, showCourse, includeFormative, onToggleFormative }) {
  const limit = settings.feedbackLimitDays;
  const overdue = rows.filter((r) => r.tone === 'red').length;
  return (
    <section className="card triage-panel" aria-label="Feedback owed">
      <div className="triage-panel__head">
        <h3 className="triage-panel__title">
          Feedback owed {overdue > 0 && <span className="badge badge-red">{overdue} overdue</span>}
        </h3>
        <label className="text-sm text-muted triage-panel__toggle">
          <input type="checkbox" checked={includeFormative} onChange={(e) => onToggleFormative(e.target.checked)} aria-label="Show formative" />
          Show formative
        </label>
      </div>
      <p className="triage-panel__sub">
        Ungraded {includeFormative ? '' : 'summative '}work · school days the oldest submission has waited · aim ≤ {limit}
      </p>
      {rows.length === 0 && <p className="text-sm text-muted">Nothing waiting for feedback.</p>}
      {rows.map((r) => (
        <div key={r.assignmentId} className="triage-row triage-row--feedback">
          <Link className="triage-row__task" to={`/course/${r.courseId}/assessment/${r.schoologyAssignmentId}`}>
            {showCourse && <span className="triage-row__course">{r.courseName}</span>}
            <strong>{r.title}</strong>
            {!r.aligned && <span className="badge badge-formative triage-row__tag">F</span>}
          </Link>
          <span className="text-sm text-muted">{r.owed} of {r.submittedTotal} ungraded</span>
          <UrgencyMeter days={r.oldestWaitDays} limit={limit} tone={r.tone} />
          <span className={`triage-days triage-days--${r.tone}`}>
            {r.oldestWaitDays}{r.approx && <abbr title={APPROX_TITLE}>≈</abbr>}
          </span>
        </div>
      ))}
    </section>
  );
}
```

```jsx
// client/src/components/triage/ReferralHistory.jsx
import { useEffect, useState } from 'react';
import { getReferrals, undoReferral } from '../../services/api.js';
import { formatDate } from '../../lib/formatDate.js';

// Referred / exempt records, newest first, each undoable.
export default function ReferralHistory({ courseId, onClose, onChanged }) {
  const [rows, setRows] = useState(null);

  async function load() {
    try { setRows((await getReferrals({ courseId })) || []); } catch { setRows([]); }
  }
  useEffect(() => { load(); }, [courseId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function undo(id) {
    await undoReferral(id);
    await load();
    onChanged?.();
  }

  return (
    <section className="card triage-history" aria-label="Referral history">
      <div className="triage-panel__head">
        <h3 className="triage-panel__title">Referred / exempt</h3>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
      {rows === null && <p className="text-sm text-muted">Loading…</p>}
      {rows?.length === 0 && <p className="text-sm text-muted">No referrals or exemptions recorded yet.</p>}
      {rows?.map((r) => (
        <div key={r.id} className="triage-row triage-row--history">
          <span className="triage-row__name">{r.studentName}</span>
          <span className="triage-row__task"><span className="triage-row__course">{r.courseName}</span>{r.title}</span>
          <span className={`badge ${r.action === 'referred' ? 'badge-red' : 'badge-gray'}`}>
            {r.action === 'referred' ? 'Referred' : 'Exempt'} · day {r.daysLate}
          </span>
          <span className="text-sm text-muted">{formatDate(`${r.createdAt.replace(' ', 'T')}Z`)}{r.note ? ` — ${r.note}` : ''}</span>
          <button className="ghost" onClick={() => undo(r.id)}>Undo</button>
        </div>
      ))}
    </section>
  );
}
```

```jsx
// client/src/components/triage/TriageSection.jsx
import { useCallback, useEffect, useState } from 'react';
import { getTriage, recordReferral } from '../../services/api.js';
import { useDataVersion } from '../../hooks/useDataVersion.jsx';
import { formatDateTime } from '../../lib/formatDate.js';
import LateWorkPanel from './LateWorkPanel.jsx';
import FeedbackOwedPanel from './FeedbackOwedPanel.jsx';
import ReferralHistory from './ReferralHistory.jsx';

// The two triage panels: across all current courses (no courseId — Dashboard)
// or for one course (CoursePage). Owns its fetch; onLoaded hands the payload up
// (the Dashboard uses it for course-card chips and the school-day header).
export default function TriageSection({ courseId = null, onLoaded }) {
  const dataVersion = useDataVersion();
  const [data, setData] = useState(null);
  const [includeFormative, setIncludeFormative] = useState(undefined); // undefined → the Settings default
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const t = await getTriage({ courseId, includeFormative });
      if (!t) return;
      setData(t);
      setError(null);
      onLoaded?.(t);
    } catch (err) {
      setError(err.message);
    }
  }, [courseId, includeFormative]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load, dataVersion]);

  async function handleRecord(row, action, note) {
    try {
      await recordReferral({ studentId: row.studentId, assignmentId: row.assignmentId, action, note });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!data) return error ? <div className="alert alert-warning">Triage unavailable: {error}</div> : null;
  const showCourse = courseId == null;
  return (
    <div className="triage">
      {error && <div className="alert alert-warning">{error}</div>}
      {!showCourse && data.lastSyncAt && (
        <p className="text-sm text-muted triage__asof">Counts as of the last sync, {formatDateTime(data.lastSyncAt)}</p>
      )}
      <div className="triage-grid">
        <LateWorkPanel
          rows={data.lateWork} settings={data.settings} showCourse={showCourse}
          onRecord={handleRecord} onShowHistory={() => setShowHistory(true)} referralCount={data.referralCount}
        />
        <FeedbackOwedPanel
          rows={data.feedbackOwed} settings={data.settings} showCourse={showCourse}
          includeFormative={data.includeFormative} onToggleFormative={setIncludeFormative}
        />
      </div>
      {showHistory && <ReferralHistory courseId={courseId} onClose={() => setShowHistory(false)} onChanged={load} />}
    </div>
  );
}
```

Note: `lastSyncAt` is passed to `formatDateTime` raw, exactly as `Dashboard.jsx` formats `syncStatus.last.completed_at`, so the two always agree. `ReferralHistory` appends `Z` because `referrals.created_at` is a known-UTC `datetime('now')` and only its date is shown.

- [ ] **Step 5: CSS** (`client/src/app.css`)

Insert this block **immediately before** the comment block that contains `PHONE LAYOUT`:

```css
/* ========================================================================
   TRIAGE — late-work referral watch + feedback owed (TriageSection on the
   Dashboard + CoursePage). Urgency = green → amber → red against a
   school-day limit; see docs/design-language.md "Urgency meter".
   ======================================================================== */
.triage { margin-bottom: 1.5rem; }
.triage__asof { margin-bottom: 0.5rem; }
.triage-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 1rem; align-items: start; }
.triage-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.triage-panel__title { font-size: 1rem; font-weight: 700; display: flex; align-items: center; gap: 0.5rem; }
.triage-panel__sub { font-size: 0.78rem; color: var(--text-muted); margin: 0.15rem 0 0.6rem; }
.triage-panel__toggle { display: inline-flex; align-items: center; gap: 0.3rem; cursor: pointer; }
.triage-panel__history { margin-top: 0.5rem; color: var(--accent); }
.triage-history { margin-top: 1rem; }
.triage-row { display: grid; align-items: center; gap: 0.6rem; padding: 0.45rem 0.1rem; border-top: 1px solid var(--border); }
.triage-row--late { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.8fr) 5rem 2rem auto; }
.triage-row--feedback { grid-template-columns: minmax(0, 2fr) auto 5rem 2rem; }
.triage-row--history { grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr) auto minmax(0, 1fr) auto; }
.triage-row__name { font-weight: 600; color: var(--text); }
.triage-row__task { font-size: 0.85rem; min-width: 0; color: var(--text); }
.triage-row__course { font-size: 0.72rem; font-weight: 700; color: var(--accent); margin-right: 0.35rem; }
.triage-row__tag { margin-left: 0.35rem; }
.triage-row__action { display: inline-flex; gap: 0.35rem; justify-content: flex-end; align-items: center; }
.triage-note { width: 9rem; font-size: 0.8rem; }
.triage-days { font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; }
.triage-days--red { color: var(--badge-red-text); }
.triage-days--amber { color: var(--badge-amber-text); }
.triage-days abbr { text-decoration: none; cursor: help; }
.urgency-meter { display: block; height: 8px; border-radius: 4px; background: var(--bg-subtle); overflow: hidden; }
.urgency-meter__fill { display: block; height: 100%; border-radius: 4px; }
.urgency-meter--green .urgency-meter__fill { background: var(--success); }
.urgency-meter--amber .urgency-meter__fill { background: var(--warning); }
.urgency-meter--red .urgency-meter__fill { background: var(--danger); }
.triage-wait { display: inline-flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
.triage-wait .urgency-meter { width: 5rem; }
.settings-section { margin-bottom: 1rem; }
.settings-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin: 0.6rem 0; }
```

Inside the `PHONE LAYOUT` `@media (max-width: 768px)` block, add:

```css
  /* Triage: panels stack; each row wraps to name+days / task / meter / actions. */
  .triage-grid { grid-template-columns: 1fr; }
  .triage-row { display: flex; flex-wrap: wrap; row-gap: 0.3rem; }
  .triage-row__name { flex: 1 1 auto; }
  .triage-row__task { flex: 1 1 100%; order: 1; }
  .triage-row .urgency-meter { flex: 1 1 6rem; order: 2; }
  .triage-days { order: 3; }
  .triage-row__action { flex: 1 1 100%; order: 4; justify-content: flex-start; flex-wrap: wrap; }
  .triage-wait { flex-wrap: wrap; }
```

- [ ] **Step 6: Design-language entry** (append to `docs/design-language.md`)

```markdown
## Urgency meter (triage) — 2026-10-01

Used by the Dashboard / course-page triage panels (late work, feedback owed) and the Assessments
tab wait column. A thin bar (`.urgency-meter`) fills toward a **school-day limit** and takes its
colour from a tone computed on the server (`toneFor`): green below `limit − warnLead`, amber
from there, red at the limit. The number beside it (`.triage-days--{tone}`) is the actual count, so
the colour is never the only signal. `≈` (with a tooltip) marks counts from the weekday fallback
(no PowerSchool calendar). Rows use `.triage-row` grids on desktop and wrap to stacked lines in the
phone block. Actions appear only where the teacher must act (red rows: Mark referred / Exempt).
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `cd client && npx vitest run src/lib/triage.test.js src/components/triage/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/services/api.js client/src/lib/triage.js client/src/lib/triage.test.js client/src/components/triage client/src/app.css docs/design-language.md
git commit -m "feat(triage): late-work + feedback-owed panels"
```

---

### Task 10: Dashboard integration

**Files:**
- Modify: `client/src/pages/Dashboard.jsx`
- Test: `client/src/pages/Dashboard.test.jsx`

**Interfaces:**
- Consumes: `TriageSection`, `courseTriageSummary`, `TONE_BADGE` (Task 9).

- [ ] **Step 1: Write the failing test**

In `client/src/pages/Dashboard.test.jsx`, add `getTriage: vi.fn(), recordReferral: vi.fn(), getReferrals: vi.fn(), undoReferral: vi.fn(),` to the `vi.mock('../services/api.js', …)` factory. In `beforeEach`, add `api.getTriage.mockResolvedValue(null);`. Then add:

```jsx
describe('Dashboard — triage', () => {
  it('shows triage panels and per-course chips on the Current tab', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 5, course_name: 'AP Computer Science Principles', grading_period: 'Semester 1: 08/14/2026 - 01/11/2027', student_count: 24 },
    ]);
    api.getTriage.mockResolvedValue({
      settings: { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false },
      includeFormative: false, referralCount: 0, lastSyncAt: null,
      calendar: { source: 'powerschool', totalSchoolDays: 164, today: { schoolDayNumber: 35, cycleLetter: 'A' } },
      lateWork: [{ kind: 'outstanding', studentId: 1, studentName: 'Maya Chen', courseId: 5, courseName: 'AP Computer Science Principles', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, tone: 'red', approx: false }],
      feedbackOwed: [{ assignmentId: 4, schoologyAssignmentId: 'a4', courseId: 5, courseName: 'AP Computer Science Principles', title: 'CP1', dueDate: '2026-09-17', aligned: true, owed: 7, submittedTotal: 24, oldestWaitDays: 8, tone: 'amber', approx: false }],
    });
    renderDashboard();
    expect(await screen.findByText('Maya Chen')).toBeInTheDocument();
    expect(await screen.findByText('1 at limit')).toBeInTheDocument();
    expect(screen.getByText('7 to grade · 8d')).toBeInTheDocument();
    expect(screen.getByText('School day 35 of 164 · Day A')).toBeInTheDocument();
  });

  it('no triage on the Archived tab', async () => {
    renderDashboard();
    fireEvent.click(await screen.findByText('Archived'));
    expect(api.getTriage).toHaveBeenCalledTimes(1); // only the initial Current-tab mount
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && npx vitest run src/pages/Dashboard.test.jsx`
Expected: the new tests FAIL. Existing tests still pass.

- [ ] **Step 3: Implement** (`client/src/pages/Dashboard.jsx`)

Imports:

```jsx
import TriageSection from '../components/triage/TriageSection.jsx';
import { courseTriageSummary, TONE_BADGE } from '../lib/triage.js';
```

State, beside the others: `const [triage, setTriage] = useState(null);`

In `CourseCard`, inside the badges `<div>` after the student-count badge, add:

```jsx
            {!showSemester && triage && (() => {
              const t = courseTriageSummary(triage, c.id);
              return (
                <>
                  {t.atLimit > 0 && <span className="badge badge-red">{t.atLimit} at limit</span>}
                  {t.late > 0 && <span className="badge badge-amber">{t.late} late</span>}
                  {t.toGrade > 0 && <span className={`badge ${TONE_BADGE[t.waitTone]}`}>{t.toGrade} to grade · {t.oldestWait}d</span>}
                </>
              );
            })()}
```

Header: replace the header `<div>` content so the school-day line sits on the right:

```jsx
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 className="page-title" style={{ marginBottom: 0 }}>Dashboard</h2>
        {triage?.calendar?.today?.schoolDayNumber && (
          <span className="text-sm text-muted">
            School day {triage.calendar.today.schoolDayNumber} of {triage.calendar.totalSchoolDays}
            {triage.calendar.today.cycleLetter ? ` · Day ${triage.calendar.today.cycleLetter}` : ''}
          </span>
        )}
      </div>
```

Directly after the controls row (the `<div>` with the Current/Archived tab buttons), add:

```jsx
      {activeTab === 'current' && <TriageSection onLoaded={setTriage} />}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && npx vitest run src/pages/Dashboard.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Dashboard.jsx client/src/pages/Dashboard.test.jsx
git commit -m "feat(triage): dashboard panels, course-card chips, school-day header"
```

---

### Task 11: CoursePage integration (panels + Assessments wait column)

**Files:**
- Modify: `client/src/pages/CoursePage.jsx`
- Test: `client/src/pages/CoursePage.assignmentLink.test.jsx` (add an `AssessmentsView` case)

**Interfaces:**
- Consumes: `TriageSection`, `UrgencyMeter`, `waitsByAssignment` (Task 9); `getTriage` (api).
- Produces: `AssessmentsView({ data, courseId, waits = {}, feedbackLimit = 10 })`.

- [ ] **Step 1: Write the failing test** (append to `client/src/pages/CoursePage.assignmentLink.test.jsx`, reusing its imports and render helpers)

```jsx
describe('AssessmentsView — feedback wait column (triage)', () => {
  it('shows ungraded count + wait for assignments that owe feedback', () => {
    const assignments = [
      { id: 1, title: 'CP1', aligned: 1, schoology_assignment_id: 'a1', due_date: '2026-09-17' },
      { id: 2, title: 'Quiz', aligned: 1, schoology_assignment_id: 'a2', due_date: '2026-09-02' },
    ];
    render(
      <MemoryRouter>
        <AssessmentsView
          data={{ assignments, folders: [] }} courseId="5" feedbackLimit={10}
          waits={{ a1: { owed: 7, submittedTotal: 24, oldestWaitDays: 8, tone: 'amber' } }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('7/24 ungraded')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '8 of 10 school days' })).toBeInTheDocument();
    expect(screen.getAllByText(/ungraded/)).toHaveLength(1);
  });
});
```

Check the file's existing imports (`render`, `screen`, `MemoryRouter`). Add any that are missing.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && npx vitest run src/pages/CoursePage.assignmentLink.test.jsx`
Expected: the new test FAILS.

- [ ] **Step 3: Implement** (`client/src/pages/CoursePage.jsx`)

Imports:

```jsx
import TriageSection from '../components/triage/TriageSection.jsx';
import UrgencyMeter from '../components/triage/UrgencyMeter.jsx';
import { waitsByAssignment } from '../lib/triage.js';
```

Add `getTriage` to the existing `../services/api.js` import list.

In `CoursePage`, beside the other state:

```jsx
  const [triageWaits, setTriageWaits] = useState({ waits: {}, feedbackLimit: 10 });
```

Add an effect next to the existing data-loading effect. It must use the same dependencies as that effect, including the data version; find the `useEffect` that calls `getGradebook` and mirror its dependency array:

```jsx
  // Assessments-tab wait column: every assignment still owed feedback (incl.
  // formative). Async + try so an automocked/absent API is a silent no-op.
  useEffect(() => {
    (async () => {
      try {
        const t = await getTriage({ courseId: id, includeFormative: true });
        if (t) setTriageWaits({ waits: waitsByAssignment(t), feedbackLimit: t.settings.feedbackLimitDays });
      } catch { /* triage is optional on this page */ }
    })();
  }, [id, dataVersion]);
```

(If the page's version variable is named differently, use the page's name. `grep -n "useDataVersion" client/src/pages/CoursePage.jsx`.)

After `</header>` in the returned JSX, add:

```jsx
      <TriageSection courseId={Number(id)} />
```

Change the Assessments render line to:

```jsx
      {view === 'assessments' && <AssessmentsView data={gradebook} courseId={id} waits={triageWaits.waits} feedbackLimit={triageWaits.feedbackLimit} />}
```

In `AssessmentsView`, change the signature to `export function AssessmentsView({ data, courseId, waits = {}, feedbackLimit = 10 })`. In the row, immediately before the `{a.due_date && (` block, add:

```jsx
                  {waits[a.schoology_assignment_id] && (() => {
                    const w = waits[a.schoology_assignment_id];
                    return (
                      <span className="triage-wait" title={`Oldest submission has waited ${w.oldestWaitDays} school days`}>
                        <span className="text-sm">{w.owed}/{w.submittedTotal} ungraded</span>
                        <UrgencyMeter days={w.oldestWaitDays} limit={feedbackLimit} tone={w.tone} />
                        <span className={`triage-days triage-days--${w.tone}`}>{w.oldestWaitDays}</span>
                      </span>
                    );
                  })()}
```

- [ ] **Step 4: Run all CoursePage tests**

Run: `cd client && npx vitest run src/pages/CoursePage`
Expected: PASS. `CoursePage.test.jsx` automocks the API, so `getTriage` returns `undefined`; `TriageSection` and the effect both treat that as "no data".

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/CoursePage.jsx client/src/pages/CoursePage.assignmentLink.test.jsx
git commit -m "feat(triage): course-page panels + Assessments feedback-wait column"
```

---

### Task 12: Settings page

**Files:**
- Create: `client/src/pages/SettingsPage.jsx`
- Modify: `client/src/App.jsx` (route + sidebar link)
- Test: `client/src/pages/SettingsPage.test.jsx`

**Interfaces:**
- Consumes: `getSettings`, `updateSettings`, `getTriage` (api); `NumberStepper`.

- [ ] **Step 1: Write the failing test**

```jsx
// client/src/pages/SettingsPage.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsPage from './SettingsPage.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getTriage: vi.fn(),
}));

const TRIAGE = { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false };

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue({ triage: TRIAGE });
  api.updateSettings.mockImplementation(async ({ triage }) => ({ triage: { ...TRIAGE, ...triage } }));
  api.getTriage.mockResolvedValue({ calendar: { source: 'powerschool', totalSchoolDays: 164, syncedAt: '2026-10-01T00:00:00Z' } });
});

describe('SettingsPage', () => {
  it('shows the triage limits and the calendar status', async () => {
    render(<SettingsPage />);
    expect(await screen.findByLabelText('Referral limit (school days)')).toHaveValue(8);
    expect(screen.getByLabelText('Feedback limit (school days)')).toHaveValue(10);
    expect(await screen.findByText(/PowerSchool · 164 school days/)).toBeInTheDocument();
  });

  it('saves a stepper change server-side', async () => {
    render(<SettingsPage />);
    await screen.findByLabelText('Referral limit (school days)');
    fireEvent.click(screen.getAllByLabelText('Increase')[0]);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ triage: { referralLimitDays: 9 } }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('warns when there is no PowerSchool calendar', async () => {
    api.getTriage.mockResolvedValue({ calendar: { source: 'weekdays', totalSchoolDays: 0, syncedAt: null } });
    render(<SettingsPage />);
    expect(await screen.findByText(/counting weekdays/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && npx vitest run src/pages/SettingsPage.test.jsx`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement**

```jsx
// client/src/pages/SettingsPage.jsx
import { useEffect, useState } from 'react';
import NumberStepper from '../components/NumberStepper.jsx';
import { getSettings, updateSettings, getTriage } from '../services/api.js';
import { formatDateTime } from '../lib/formatDate.js';

// App settings, stored server-side (shared by every device and PrisMCP).
export default function SettingsPage() {
  const [triage, setTriage] = useState(null);
  const [calendar, setCalendar] = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    getSettings().then((s) => setTriage(s.triage)).catch((err) => setStatus(`Could not load settings: ${err.message}`));
    (async () => {
      try { const t = await getTriage(); if (t) setCalendar(t.calendar); } catch { /* shown as loading */ }
    })();
  }, []);

  async function save(patch) {
    setTriage((prev) => ({ ...prev, ...patch }));
    try {
      const s = await updateSettings({ triage: patch });
      setTriage(s.triage);
      setStatus('Saved');
    } catch (err) {
      setStatus(`Not saved: ${err.message}`);
    }
  }

  if (!triage) return status ? <div className="error-msg">{status}</div> : <div className="loading">Loading...</div>;

  return (
    <div className="fade-in">
      <h2 className="page-title">Settings</h2>

      <section className="card settings-section">
        <h3>Triage</h3>
        <p className="text-sm text-muted">Counted in school days. Applies to the Dashboard, course pages and PrisMCP.</p>
        <div className="settings-row">
          <span>Refer late summative work at</span>
          <NumberStepper value={triage.referralLimitDays} min={1} max={60} onChange={(v) => save({ referralLimitDays: v })} aria-label="Referral limit (school days)" />
          <span className="text-sm text-muted">school days late</span>
        </div>
        <div className="settings-row">
          <span>Feedback is overdue after</span>
          <NumberStepper value={triage.feedbackLimitDays} min={1} max={60} onChange={(v) => save({ feedbackLimitDays: v })} aria-label="Feedback limit (school days)" />
          <span className="text-sm text-muted">school days waiting</span>
        </div>
        <div className="settings-row">
          <span>Amber warning starts</span>
          <NumberStepper value={triage.warnLeadDays} min={0} max={59} onChange={(v) => save({ warnLeadDays: v })} aria-label="Warning lead (school days)" />
          <span className="text-sm text-muted">school days before each limit</span>
        </div>
        <label className="settings-row">
          <input type="checkbox" checked={triage.showFormativeDefault} onChange={(e) => save({ showFormativeDefault: e.target.checked })} />
          <span>Show formative work in Feedback owed by default</span>
        </label>
        {status && <p className="text-sm text-muted" role="status">{status}</p>}
      </section>

      <section className="card settings-section">
        <h3>School calendar</h3>
        {!calendar && <p className="text-sm text-muted">Loading…</p>}
        {calendar?.source === 'powerschool' && (
          <p>PowerSchool · {calendar.totalSchoolDays} school days{calendar.syncedAt ? ` · synced ${formatDateTime(calendar.syncedAt)}` : ''}</p>
        )}
        {calendar && calendar.source !== 'powerschool' && (
          <div className="alert alert-warning">
            No school calendar yet, so Prism is counting weekdays (approximate). Run a sync while signed in to PowerSchool to load it.
          </div>
        )}
      </section>
    </div>
  );
}
```

In `client/src/App.jsx`: `import SettingsPage from './pages/SettingsPage.jsx';`, add `<NavLink to="/settings">Settings</NavLink>` after `<NavLink to="/import">Import CSV</NavLink>`, and add `<Route path="/settings" element={<SettingsPage />} />` after the `/import` route.

- [ ] **Step 4: Run the tests and confirm they pass (including App)**

Run: `cd client && npx vitest run src/pages/SettingsPage.test.jsx src/App.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/SettingsPage.jsx client/src/pages/SettingsPage.test.jsx client/src/App.jsx
git commit -m "feat(triage): Settings page for triage limits + calendar status"
```

---

### Task 13: Calendar parity check vs the Master Plan, and end-to-end check

**Files:**
- Create: `scripts/lib/masterPlanCalendar.js`, `scripts/lib/masterPlanCalendar.test.js`, `scripts/parity-school-calendar.js`
- Modify: `.claude/powerschool-api-reference.md` (record the observed `calenderDays` entry), `.claude/build-progress.md` (new section)

**Interfaces:**
- Produces:
  - `parseSharedStrings(xml): string[]`
  - `parseSheetRows(xml, shared): Array<{[col]: string}>`
  - `excelSerialToIso(n): string`
  - `planDays(rows): Array<{date, cycleDay: number|null}>`
  - `compareCalendars(psRows, plan)` returns `{ overlap, planSchoolDays, psSchoolDays, onlyInPs, onlyInPlan, letterByParity, letterMismatches }`
  - `readSheetFromXlsx(file, nameFragment): rows`

- [ ] **Step 1: Write the failing test**

```js
// scripts/lib/masterPlanCalendar.test.js
import { describe, test, expect } from 'vitest';
import { parseSharedStrings, parseSheetRows, excelSerialToIso, planDays, compareCalendars } from './masterPlanCalendar.js';

const SHARED = '<sst><si><t>Date</t></si><si><t>SAT</t></si><si><r><t>Fall</t></r><r><t> Break</t></r></si></sst>';
const SHEET = `<worksheet><sheetData>
  <row r="1"><c r="E1" t="s"><v>0</v></c></row>
  <row r="3"><c r="B3"><v>1</v></c><c r="E3"><v>46247</v></c><c r="F3"><v>1</v></c></row>
  <row r="12"><c r="E12"><v>46256</v></c><c r="F12" t="s"><v>1</v></c></row>
  <row r="13"><c r="E13"><v>46257</v></c></row>
</sheetData></worksheet>`;

describe('Master Plan parsing', () => {
  test('shared strings join rich-text runs', () => {
    expect(parseSharedStrings(SHARED)).toEqual(['Date', 'SAT', 'Fall Break']);
  });

  test('rows resolve shared strings by column', () => {
    const rows = parseSheetRows(SHEET, parseSharedStrings(SHARED));
    expect(rows[1]).toEqual({ B: '1', E: '46247', F: '1' });
    expect(rows[2].F).toBe('SAT');
  });

  test('Excel serial → ISO date (46247 = 13/08/2026)', () => {
    expect(excelSerialToIso(46247)).toBe('2026-08-13');
  });

  test('planDays: numeric F = school day; text/blank = not', () => {
    expect(planDays(parseSheetRows(SHEET, parseSharedStrings(SHARED)))).toEqual([
      { date: '2026-08-13', cycleDay: 1 },
      { date: '2026-08-22', cycleDay: null },
      { date: '2026-08-23', cycleDay: null },
    ]);
  });
});

describe('compareCalendars', () => {
  const plan = [
    { date: '2026-10-05', cycleDay: 2 },
    { date: '2026-10-06', cycleDay: 3 },
    { date: '2026-10-07', cycleDay: 4 },
    { date: '2026-10-08', cycleDay: null },
  ];

  test('identical → no differences; parity→letter mapping learned', () => {
    const ps = [
      { date: '2026-10-05', in_session: 1, cycle_letter: 'B' },
      { date: '2026-10-06', in_session: 1, cycle_letter: 'A' },
      { date: '2026-10-07', in_session: 1, cycle_letter: 'B' },
      { date: '2026-10-08', in_session: 0, cycle_letter: null },
    ];
    const r = compareCalendars(ps, plan);
    expect(r).toMatchObject({ onlyInPs: [], onlyInPlan: [], letterMismatches: [], planSchoolDays: 3, psSchoolDays: 3 });
    expect(r.letterByParity).toEqual({ 0: 'B', 1: 'A' });
  });

  test('reports differing dates and broken alternation', () => {
    const ps = [
      { date: '2026-10-05', in_session: 1, cycle_letter: 'B' },
      { date: '2026-10-06', in_session: 0, cycle_letter: null },
      { date: '2026-10-07', in_session: 1, cycle_letter: 'A' },
      { date: '2026-10-08', in_session: 1, cycle_letter: 'B' },
    ];
    const r = compareCalendars(ps, plan);
    expect(r.onlyInPlan).toEqual(['2026-10-06']);
    expect(r.onlyInPs).toEqual(['2026-10-08']);
    expect(r.letterMismatches).toEqual([{ date: '2026-10-07', cycleDay: 4, letter: 'A' }]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run scripts/lib/masterPlanCalendar.test.js`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement**

```js
// scripts/lib/masterPlanCalendar.js
// Parse a Master Plan workbook's "Daily Planning View" for the calendar parity
// check (scripts/parity-school-calendar.js). An .xlsx is a zip of XML: read it
// with the system `unzip` (no new dependency) and parse this flat sheet with
// regexes. Column E = date (Excel serial), F = cycle day 1–8 on school days
// (text like 'SAT' or blank otherwise).
import { execFileSync } from 'child_process';

export function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map((m) => decodeXml([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
}

export function parseSheetRows(xml, shared) {
  const rows = [];
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const col = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] || '')?.[1];
      if (!col || v === undefined) continue;
      cells[col] = /\bt="s"/.test(attrs) ? shared[Number(v)] : decodeXml(v);
    }
    rows.push(cells);
  }
  return rows;
}

export function excelSerialToIso(serial) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(Number(serial)) * 86400000).toISOString().slice(0, 10);
}

export function planDays(rows) {
  return rows
    .filter((r) => r.E && /^\d+(\.\d+)?$/.test(r.E))
    .map((r) => {
      const f = String(r.F ?? '').trim();
      return { date: excelSerialToIso(r.E), cycleDay: /^\d+$/.test(f) ? Number(f) : null };
    });
}

// Compare stored PowerSchool rows with the plan over the dates both cover.
export function compareCalendars(psRows, plan) {
  const ps = new Map(psRows.map((r) => [r.date, r]));
  const psDates = psRows.map((r) => r.date).sort();
  const planDates = plan.map((p) => p.date).sort();
  const from = psDates[0] > planDates[0] ? psDates[0] : planDates[0];
  const to = psDates.at(-1) < planDates.at(-1) ? psDates.at(-1) : planDates.at(-1);
  const inRange = (d) => d >= from && d <= to;

  const onlyInPs = [];
  const onlyInPlan = [];
  const letterByParity = {};
  const letterMismatches = [];
  const planDatesSet = new Set(planDates);
  let planSchoolDays = 0;

  for (const p of plan) {
    if (!inRange(p.date)) continue;
    const row = ps.get(p.date);
    const planSchool = p.cycleDay != null;
    const psSchool = !!row?.in_session;
    if (planSchool) planSchoolDays++;
    if (planSchool && !psSchool) onlyInPlan.push(p.date);
    if (!planSchool && psSchool) onlyInPs.push(p.date);
    if (planSchool && psSchool && row.cycle_letter) {
      const parity = p.cycleDay % 2;
      if (!(parity in letterByParity)) letterByParity[parity] = row.cycle_letter;
      else if (letterByParity[parity] !== row.cycle_letter) letterMismatches.push({ date: p.date, cycleDay: p.cycleDay, letter: row.cycle_letter });
    }
  }
  for (const r of psRows) {
    if (inRange(r.date) && r.in_session && !planDatesSet.has(r.date)) onlyInPs.push(r.date);
  }
  const psSchoolDays = psRows.filter((r) => inRange(r.date) && r.in_session).length;
  return { overlap: { from, to }, planSchoolDays, psSchoolDays, onlyInPs: onlyInPs.sort(), onlyInPlan, letterByParity, letterMismatches };
}

export function readSheetFromXlsx(file, nameFragment) {
  const unzip = (p) => execFileSync('unzip', ['-p', file, p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const wb = unzip('xl/workbook.xml');
  const sheet = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0])
    .find((tag) => decodeXml(/name="([^"]*)"/.exec(tag)?.[1] || '').includes(nameFragment));
  if (!sheet) throw new Error(`No sheet whose name contains "${nameFragment}"`);
  const rid = /r:id="([^"]+)"/.exec(sheet)[1];
  const rel = [...unzip('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0])
    .find((tag) => tag.includes(`Id="${rid}"`));
  const target = /Target="([^"]+)"/.exec(rel)[1];
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  let shared = [];
  try { shared = parseSharedStrings(unzip('xl/sharedStrings.xml')); } catch { /* no shared strings */ }
  return parseSheetRows(unzip(path), shared);
}
```

```js
// scripts/parity-school-calendar.js
// Calendar parity (triage spec): the stored PowerSchool school_days vs a Master
// Plan's Daily Planning View. Read-only. Exit 1 when they differ.
//
// Run from the REPO ROOT after a sync that included the PowerSchool block pass:
//   node scripts/parity-school-calendar.js "<path to 2026-27 Master Plan.xlsx>" ["Daily Planning View"]
import { getDb } from '../server/db/index.js';
import { readSheetFromXlsx, planDays, compareCalendars } from './lib/masterPlanCalendar.js';

const [file, sheet = 'Daily Planning View'] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/parity-school-calendar.js "<Master Plan.xlsx>" ["<sheet name fragment>"]');
  process.exit(2);
}

const plan = planDays(readSheetFromXlsx(file, sheet));
const ps = getDb().prepare('SELECT date, in_session, cycle_letter FROM school_days ORDER BY date').all();
if (!ps.length) {
  console.error('school_days is empty: run a sync with PowerSchool signed in first.');
  process.exit(1);
}

const r = compareCalendars(ps, plan);
console.log(`Overlap ${r.overlap.from} → ${r.overlap.to}`);
console.log(`School days: Master Plan ${r.planSchoolDays}, PowerSchool ${r.psSchoolDays}`);
console.log(`Cycle-day parity → PowerSchool letter: ${JSON.stringify(r.letterByParity)}`);
console.log(`Only in PowerSchool (${r.onlyInPs.length}): ${r.onlyInPs.join(', ') || '—'}`);
console.log(`Only in Master Plan (${r.onlyInPlan.length}): ${r.onlyInPlan.join(', ') || '—'}`);
console.log(`Letter mismatches (${r.letterMismatches.length}): ${r.letterMismatches.map((m) => `${m.date} day ${m.cycleDay}=${m.letter}`).join(', ') || '—'}`);
const ok = !r.onlyInPs.length && !r.onlyInPlan.length && !r.letterMismatches.length;
console.log(ok ? 'PARITY OK ✅' : 'PARITY DIFFERS ❌');
process.exit(ok ? 0 : 1);
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run scripts/lib/masterPlanCalendar.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/masterPlanCalendar.js scripts/lib/masterPlanCalendar.test.js scripts/parity-school-calendar.js
git commit -m "feat(triage): calendar parity check against the Master Plan"
```

- [ ] **Step 6: Live: fill the dev calendar and run parity** (dev clone DB only; never prod)

```bash
hostname                                    # expect macmini.local → prod is on 3001; we only touch the dev DB
node -e "import('./server/services/psAttendanceSync.js').then(async m => { const s = await m.syncPsAttendance({}); console.log('schoolDays', s.schoolDays); })"
sqlite3 server/db/students.db "SELECT COUNT(*), SUM(in_session) FROM school_days;"
sqlite3 server/db/students.db "SELECT date, raw FROM school_days WHERE in_session = 1 LIMIT 2; SELECT date, raw FROM school_days WHERE in_session = 0 LIMIT 1;"
cp "$HOME/Library/CloudStorage/OneDrive-HongKongInternationalSchool/Courses/Course Planners/2026-27 Master Plan.xlsx" /tmp/master-plan-2026-27.xlsx
node scripts/parity-school-calendar.js /tmp/master-plan-2026-27.xlsx
```

Expected: about 164 in-session days in the overlap, and `PARITY OK`. If they differ, do **not** paper over it. Report each differing date to the user with both values; the Master Plan is the reference. A systematic difference (for example, PowerSchool only marking the section's own meeting days) means revisiting `mergeCalendarDays` or the in-session rule before trusting the panels.

- [ ] **Step 7: Record the observed shape** (`.claude/powerschool-api-reference.md`)

In the `section_info` section, add a dated note (2026-10-01, triage) with the **actual** `raw` JSON of one in-session and one not-in-session entry, copied from the Step 6 output. Never write a shape you didn't see. Say whether `cycleDay` carries anything beyond `letter` (for example, a day number). Note that triage stores it in `school_days`, and record the parity result: day counts, and the letter ↔ odd/even mapping.

- [ ] **Step 8: End-to-end in the browser** (dev port **3002**, never 3001)

```bash
PORT=3002 npm run dev    # run in the background; wait for Vite + API
```

Write a throwaway screenshot script under `scripts/` (Playwright must resolve from the repo root). It loads `http://localhost:5173/` (or the Vite port the dev output prints), `/course/<an active course id>` with the Assessments tab clicked, and `/settings`, at 1440×900 and at 390×844. Save the PNGs to `/tmp`, then delete the script. **Open each PNG with the Read tool** so the user sees it (they review on mobile). Also run `npm run check:mobile http://localhost:5173`.

Check:
- the dashboard's school-day header matches the Master Plan for today;
- one late row and one feedback row match Schoology by hand;
- the triage "as of last sync" time agrees with the dashboard's own "Last sync" line (see the note in Task 9, Step 4);
- Mark referred / Exempt / Undo round-trip;
- the Settings stepper changes tones live.

Stop the dev server with `npm run dev:stop`.

- [ ] **Step 9: Full suites + build**

```bash
npm run test:server
(cd client && npx vitest run)
npm run build
```

Expected: all PASS; build succeeds.

- [ ] **Step 10: Build-progress note + commit**

Append a section to `.claude/build-progress.md`: "Triage — late-work referral watch + feedback owed (2026-10-01, branch `feat/triage`)". Cover what shipped, the parity result, the PowerSchool `calenderDays` shape link, and known limits (`first_submitted_at` is the earliest *observed* submission; the cycle is shown as a letter).

```bash
git add .claude/powerschool-api-reference.md .claude/build-progress.md
git commit -m "docs(triage): calendar shape + parity result + build progress"
```

Then hand off with superpowers:finishing-a-development-branch. Merging to `main` and pushing deploys prod, so the user decides.
