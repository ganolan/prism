# Recent-only Submission-Status Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the teacher opt into restricting the slow per-`(assignment × student)` submission-status check to assignments due in the last N days or in the future, skipping undated and clearly-old work — cutting sync wall time (#55).

**Architecture:** A pure server helper filters the dropbox-assignment list by due date inside `syncSectionData`; the `recentOnly`/`recentDays` flags thread from the Sync dialog → `POST /api/sync` → `runUnifiedSync` → `fullSync` → `syncSectionData`. The teacher's last-used choice is remembered in browser `localStorage` and overridable per sync via a checkbox + `[−] N [+]` stepper in the dialog. The server is stateless about the default — it only ever receives explicit per-request params, validated/clamped server-side.

**Tech Stack:** Express + better-sqlite3 (server, ESM), React + Vite (client), Vitest + @testing-library/react (tests).

**Spec:** `docs/superpowers/specs/2026-06-06-recent-only-submission-sync-design.md`

---

## File Structure

**Server**
- `server/services/recentWindow.js` — **new** pure helpers `filterRecentAssignments(assignments, recentOnly, recentDays, now)` and `clampDays(value, fallback)`. No I/O; unit-tested.
- `server/services/recentWindow.test.js` — **new** unit tests.
- `server/services/sync.js` — destructure `recentOnly`/`recentDays` in `syncSectionData`; window the dropbox list; return `windowSkipped`; thread the two opts through `fullSync`.
- `server/services/syncOrchestrator.js` — thread the two opts through `runUnifiedSync` → `fullSync`.
- `server/services/sync.test.js` — **extend** with a recent-window describe block.
- `server/routes/schoology.js` — parse + clamp the two params on `POST /sync`; pass into `runUnifiedSync`.
- `server/routes/schoology.test.js` — **extend** with param pass-through/clamp tests.

**Client**
- `client/src/lib/syncPrefs.js` — **new** `getSyncPrefs()`, `setSyncPrefs()`, `clampDays()` over `localStorage`.
- `client/src/lib/syncPrefs.test.js` — **new** unit tests.
- `client/src/components/NumberStepper.jsx` — **new** reusable `[−] N [+]` integer stepper.
- `client/src/components/NumberStepper.test.jsx` — **new** unit tests.
- `client/src/components/SyncConfig.jsx` — add the recent-only checkbox + stepper + "?" tooltip; seed from prefs; include the two opts in `onStart`; persist on Start.
- `client/src/components/SyncConfig.test.jsx` — **extend** (and update the existing `onStart` assertion).
- `client/src/components/SyncDialog.jsx` — thread the two opts through `startSync` → `runSync`.
- `client/src/services/api.js` — include the two opts in the `runSync` POST body.

**Slice order:** Tasks 1–3 are server-only and ship the capability (the perf win is live for any caller sending the params). Tasks 4–6 add the client control. Each task ends green.

---

## Task 1: Pure window-filter helper

**Files:**
- Create: `server/services/recentWindow.js`
- Test: `server/services/recentWindow.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/recentWindow.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { filterRecentAssignments, clampDays } from './recentWindow.js';

// Fixed reference instant → cutoff for 30 days is 2026-05-07.
const NOW = '2026-06-06T00:00:00.000Z';
const recent = { id: 'r', due: '2026-06-01' };  // within window
const old = { id: 'o', due: '2026-01-01' };     // > 30 days ago
const future = { id: 'f', due: '2026-12-01' };  // not yet due
const undated = { id: 'u', due: null };         // no due date
const all = [recent, old, future, undated];

describe('filterRecentAssignments', () => {
  it('passes everything through with no skips when recentOnly is off', () => {
    expect(filterRecentAssignments(all, false, 30, NOW)).toEqual({ target: all, windowSkipped: 0 });
  });

  it('keeps recent + future dated, skips old + undated when recentOnly is on', () => {
    const { target, windowSkipped } = filterRecentAssignments(all, true, 30, NOW);
    expect(target.map((a) => a.id)).toEqual(['r', 'f']);
    expect(windowSkipped).toBe(2);
  });

  it('treats an unparseable due date as undated (skipped)', () => {
    const { target } = filterRecentAssignments([{ id: 'x', due: 'not-a-date' }], true, 30, NOW);
    expect(target).toEqual([]);
  });

  it('widens the window with a larger recentDays', () => {
    const { target } = filterRecentAssignments(all, true, 365, NOW);
    expect(target.map((a) => a.id)).toEqual(['r', 'o', 'f']); // old now inside 365d
  });
});

describe('clampDays', () => {
  it('floors and clamps into 1..365, defaulting on non-numbers', () => {
    expect(clampDays(30)).toBe(30);
    expect(clampDays(0)).toBe(1);
    expect(clampDays(500)).toBe(365);
    expect(clampDays(12.9)).toBe(12);
    expect(clampDays('abc')).toBe(30);
    expect(clampDays(undefined)).toBe(30);
    expect(clampDays(50, 7)).toBe(50);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/services/recentWindow.test.js`
Expected: FAIL — `Failed to resolve import "./recentWindow.js"` (module does not exist).

- [ ] **Step 3: Implement the helper**

Create `server/services/recentWindow.js`:

```js
// #55: pure helpers for the recent-only submission-status window. No I/O.

const DAY_MS = 86400000;

// Restrict a list of assignments to those whose submission status is worth the
// expensive per-cell check: due within the last `recentDays` days, or due in
// the future. Undated and clearly-old assignments are dropped. When `recentOnly`
// is false this is a pass-through. `now` is an ISO string (the sync's reference
// timestamp), so it must be parsed before arithmetic.
export function filterRecentAssignments(assignments, recentOnly, recentDays, now) {
  if (!recentOnly) return { target: assignments, windowSkipped: 0 };
  const cutoff = Date.parse(now) - recentDays * DAY_MS;
  const target = assignments.filter((a) => {
    const t = a.due ? Date.parse(a.due) : NaN;
    return !Number.isNaN(t) && t >= cutoff;
  });
  return { target, windowSkipped: assignments.length - target.length };
}

// Coerce a day-window value to a positive integer in [1, 365]; non-numbers fall
// back to `fallback`. Shared by the route (trust boundary) and syncSectionData.
export function clampDays(value, fallback = 30) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(365, Math.max(1, n));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/services/recentWindow.test.js`
Expected: PASS (7 assertions across 2 describes).

- [ ] **Step 5: Commit**

```bash
git add server/services/recentWindow.js server/services/recentWindow.test.js
git commit -m "feat(sync): add recent-window assignment filter + clampDays helper (#55)"
```

---

## Task 2: Window the submission loop + thread opts through fullSync

**Files:**
- Modify: `server/services/sync.js` (imports ~L15; `syncSectionData` opts ~L58; dropbox list ~L212; return ~L355; `fullSync` ~L605 + the `syncSectionData` call ~L723)
- Modify: `server/services/syncOrchestrator.js` (`runUnifiedSync` ~L23 + `fullSync` call ~L34)
- Test: `server/services/sync.test.js` (add a describe block)

- [ ] **Step 1: Write the failing test**

Add to `server/services/sync.test.js` (a new top-level `describe`, after the existing `syncSectionData` blocks):

```js
describe('syncSectionData — recent-only submission window (#55)', () => {
  let db;
  let courseId;
  const NOW = '2026-06-06T00:00:00.000Z'; // 30-day cutoff = 2026-05-07

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-w', 'Window')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getSubmissionStatus.mockReset();
    getSectionGrades.mockResolvedValue([]);
    getSubmissionStatus.mockResolvedValue(null);
    getSectionEnrollments.mockResolvedValue([
      { id: '900001', uid: '700001', name_first: 'Ada', name_last: 'Lovelace', admin: '0' },
      { id: '900002', uid: '700002', name_first: 'Alan', name_last: 'Turing', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: '5001', title: 'Recent',  published: 1, allow_dropbox: '1', due: '2026-06-01' },
      { id: '5002', title: 'Old',     published: 1, allow_dropbox: '1', due: '2026-01-01' },
      { id: '5003', title: 'Undated', published: 1, allow_dropbox: '1', due: null },
    ]);
  });

  test('recentOnly skips old + undated dropbox assignments', async () => {
    const result = await syncSectionData(db, 'sec-w', courseId, NOW, { recentOnly: true, recentDays: 30 });
    expect(getSubmissionStatus).toHaveBeenCalledTimes(2); // 1 recent assignment × 2 students
    expect(result.windowSkipped).toBe(2);
  });

  test('recentOnly off checks every dropbox assignment (unchanged)', async () => {
    const result = await syncSectionData(db, 'sec-w', courseId, NOW, { recentOnly: false });
    expect(getSubmissionStatus).toHaveBeenCalledTimes(6); // 3 assignments × 2 students
    expect(result.windowSkipped).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/services/sync.test.js -t "recent-only submission window"`
Expected: FAIL — `result.windowSkipped` is `undefined`, and the recentOnly case still calls `getSubmissionStatus` 6 times (no filter applied yet).

- [ ] **Step 3: Add the helper import to `sync.js`**

After the `import { runWithLimits } from './rateLimitedRunner.js';` line (~L16), add:

```js
import { filterRecentAssignments } from './recentWindow.js';
```

- [ ] **Step 4: Destructure the two opts in `syncSectionData`**

Replace the opts destructure (~L58):

```js
  const {
    submissionConcurrency = 2,
    submissionRatePerSec = 4,
    submissionAbandonAfter = 5,
    skipSubmissions = false,
    recentOnly = false,
    recentDays = 30,
  } = opts;
```

- [ ] **Step 5: Window the dropbox list**

Replace the `dropboxAssignments` construction (~L212):

```js
  const dropboxAll = skipSubmissions
    ? []
    : assignments.filter(a => a.allow_dropbox === '1' || a.allow_dropbox === 1);
  // #55: when recentOnly, restrict the per-cell submission check to assignments
  // due within recentDays or in the future; skip undated + clearly-old work.
  const { target: dropboxAssignments, windowSkipped } =
    filterRecentAssignments(dropboxAll, recentOnly, recentDays, now);
```

(The downstream `for (const a of dropboxAssignments)` loop is unchanged — the variable name is preserved.)

- [ ] **Step 6: Return `windowSkipped`**

In the `syncSectionData` return object (~L355), add the field after `submissionSkipped,`:

```js
    submissionSkipped,
    windowSkipped,
    rateLimitHits,
```

- [ ] **Step 7: Run the window tests to verify they pass**

Run: `npx vitest run server/services/sync.test.js -t "recent-only submission window"`
Expected: PASS (both tests).

- [ ] **Step 8: Thread the opts through `fullSync`**

Extend the `fullSync` signature (~L605):

```js
export async function fullSync(onProgress, { includeHidden = false, recentOnly = false, recentDays = 30 } = {}) {
```

And in the `syncSectionData` call (~L723), add the two opts to the explicit options object:

```js
      const result = await syncSectionData(db, sectionId, courseRow.id, now, {
        ...syncConfig,
        recentOnly,
        recentDays,
        fetchSubmissionLookup: submissionFetcher ? (sid) => submissionFetcher.fetch(sid) : undefined,
      });
```

- [ ] **Step 9: Thread the opts through `runUnifiedSync`**

In `server/services/syncOrchestrator.js`, extend the `runUnifiedSync` destructure (~L23):

```js
export async function runUnifiedSync(
  { masteryCourseIds = [], skipSchoology = false, includeHidden = false, recentOnly = false, recentDays = 30 },
  onEvent
) {
```

And the `fullSync` call (~L34):

```js
      const result = await fullSync(
        (progress) => emit({ type: 'log', message: progress.message }),
        { includeHidden, recentOnly, recentDays }
      );
```

- [ ] **Step 10: Run the full server suite**

Run: `npx vitest run server/`
Expected: PASS — all existing server suites green plus the two new window tests.

- [ ] **Step 11: Commit**

```bash
git add server/services/sync.js server/services/syncOrchestrator.js server/services/sync.test.js
git commit -m "feat(sync): window the submission-status loop by due date (#55)"
```

---

## Task 3: Accept + validate the params on `POST /api/sync`

**Files:**
- Modify: `server/routes/schoology.js` (`POST /sync` body destructure, ~L23)
- Test: `server/routes/schoology.test.js` (add a describe block)

- [ ] **Step 1: Write the failing test**

Add to `server/routes/schoology.test.js` a new describe block (after the existing `POST /api/sync` block). It captures the opts the route hands to `runUnifiedSync` via the existing `h.impl` mock:

```js
describe('POST /api/sync — recent-only params (#55)', () => {
  let captured;
  beforeEach(() => {
    captured = null;
    h.impl = async (opts, onEvent) => {
      captured = opts;
      onEvent({ type: 'summary', schoology: null, mastery: [], elapsedMs: 1 });
    };
  });

  async function post(body) {
    const { server, port } = startServer();
    try {
      const res = await fetch(`http://localhost:${port}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await res.text(); // drain the ndjson stream
    } finally {
      server.close();
    }
  }

  test('defaults to recentOnly false / 30 days when omitted', async () => {
    await post({ masteryCourseIds: [] });
    expect(captured.recentOnly).toBe(false);
    expect(captured.recentDays).toBe(30);
  });

  test('passes through recentOnly and clamps recentDays into 1..365', async () => {
    await post({ recentOnly: true, recentDays: 9999 });
    expect(captured.recentOnly).toBe(true);
    expect(captured.recentDays).toBe(365);
  });

  test('coerces a non-numeric recentDays to the default', async () => {
    await post({ recentOnly: true, recentDays: 'abc' });
    expect(captured.recentDays).toBe(30);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/routes/schoology.test.js -t "recent-only params"`
Expected: FAIL — `captured.recentOnly` / `captured.recentDays` are `undefined` (the route does not read or forward them yet).

- [ ] **Step 3: Add the `clampDays` import**

At the top of `server/routes/schoology.js`, with the other imports, add:

```js
import { clampDays } from '../services/recentWindow.js';
```

- [ ] **Step 4: Parse, clamp, and forward the params**

In the `POST /sync` handler, replace the body destructure + `runUnifiedSync` call:

```js
  const {
    masteryCourseIds = [],
    skipSchoology = false,
    includeHidden = false,
    recentOnly = false,
    recentDays = 30,
  } = req.body || {};
```

and (a few lines down) the call:

```js
    await runUnifiedSync(
      { masteryCourseIds, skipSchoology, includeHidden, recentOnly: !!recentOnly, recentDays: clampDays(recentDays) },
      write,
    );
```

- [ ] **Step 5: Run the route tests + full server suite**

Run: `npx vitest run server/routes/schoology.test.js && npx vitest run server/`
Expected: PASS — the three new param tests pass and the existing `POST /api/sync` stream/409 tests stay green.

- [ ] **Step 6: Commit**

```bash
git add server/routes/schoology.js server/routes/schoology.test.js
git commit -m "feat(sync): accept + clamp recentOnly/recentDays on POST /api/sync (#55)"
```

---

## Task 4: Client `localStorage` prefs helper

**Files:**
- Create: `client/src/lib/syncPrefs.js`
- Test: `client/src/lib/syncPrefs.test.js`

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/syncPrefs.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { getSyncPrefs, setSyncPrefs, clampDays } from './syncPrefs.js';

beforeEach(() => localStorage.clear());

describe('getSyncPrefs', () => {
  it('returns the defaults (off / 30) when nothing is stored', () => {
    expect(getSyncPrefs()).toEqual({ recentOnly: false, recentDays: 30 });
  });

  it('reads back a stored pref, clamping the day value', () => {
    setSyncPrefs({ recentOnly: true, recentDays: 9999 });
    expect(getSyncPrefs()).toEqual({ recentOnly: true, recentDays: 365 });
  });
});

describe('setSyncPrefs', () => {
  it('round-trips through localStorage', () => {
    setSyncPrefs({ recentOnly: true, recentDays: 45 });
    expect(getSyncPrefs()).toEqual({ recentOnly: true, recentDays: 45 });
  });
});

describe('clampDays', () => {
  it('floors and clamps into 1..365, defaulting on non-numbers', () => {
    expect(clampDays(45)).toBe(45);
    expect(clampDays(0)).toBe(1);
    expect(clampDays(500)).toBe(365);
    expect(clampDays('x')).toBe(30);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npx vitest run src/lib/syncPrefs.test.js`
Expected: FAIL — `Failed to resolve import "./syncPrefs.js"`.

- [ ] **Step 3: Implement the helper**

Create `client/src/lib/syncPrefs.js` (mirrors the try/catch localStorage pattern of `assessmentDraft.js`):

```js
// #55: remembers the teacher's last-used "recent submissions only" choice so the
// Sync dialog can pre-fill it. Per-browser; the server stays stateless and only
// receives explicit per-request params.

const KEY_ON = 'prism:sync:recent-only';
const KEY_DAYS = 'prism:sync:recent-days';

// Coerce a day value to a positive integer in [1, 365]; non-numbers → fallback.
export function clampDays(value, fallback = 30) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(365, Math.max(1, n));
}

export function getSyncPrefs() {
  try {
    return {
      recentOnly: localStorage.getItem(KEY_ON) === 'true',
      recentDays: clampDays(localStorage.getItem(KEY_DAYS)),
    };
  } catch {
    // localStorage unavailable (private mode) — fall back to defaults.
    return { recentOnly: false, recentDays: 30 };
  }
}

export function setSyncPrefs({ recentOnly, recentDays }) {
  try {
    localStorage.setItem(KEY_ON, recentOnly ? 'true' : 'false');
    localStorage.setItem(KEY_DAYS, String(clampDays(recentDays)));
  } catch {
    // localStorage unavailable (private mode / quota) — degrade silently.
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && npx vitest run src/lib/syncPrefs.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/syncPrefs.js client/src/lib/syncPrefs.test.js
git commit -m "feat(sync): add syncPrefs localStorage helper (#55)"
```

---

## Task 5: `NumberStepper` component

**Files:**
- Create: `client/src/components/NumberStepper.jsx`
- Test: `client/src/components/NumberStepper.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `client/src/components/NumberStepper.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NumberStepper from './NumberStepper.jsx';

function setup(value = 30) {
  const onChange = vi.fn();
  render(<NumberStepper value={value} onChange={onChange} min={1} max={365} aria-label="Day window" />);
  return { onChange };
}

describe('NumberStepper', () => {
  it('increments and decrements by one', () => {
    const { onChange } = setup(30);
    fireEvent.click(screen.getByRole('button', { name: /increase/i }));
    expect(onChange).toHaveBeenCalledWith(31);
    fireEvent.click(screen.getByRole('button', { name: /decrease/i }));
    expect(onChange).toHaveBeenCalledWith(29);
  });

  it('disables the buttons at the bounds', () => {
    render(<NumberStepper value={1} onChange={() => {}} min={1} max={365} aria-label="d" />);
    expect(screen.getByRole('button', { name: /decrease/i })).toBeDisabled();
    render(<NumberStepper value={365} onChange={() => {}} min={1} max={365} aria-label="d2" />);
    expect(screen.getByRole('button', { name: /increase/i })).toBeDisabled();
  });

  it('accepts a typed value, clamping above max', () => {
    const { onChange } = setup(30);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '500' } });
    expect(onChange).toHaveBeenLastCalledWith(365);
  });

  it('accepts a typed in-range value as an integer', () => {
    const { onChange } = setup(30);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '12' } });
    expect(onChange).toHaveBeenLastCalledWith(12);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npx vitest run src/components/NumberStepper.test.jsx`
Expected: FAIL — `Failed to resolve import "./NumberStepper.jsx"`.

- [ ] **Step 3: Implement the component**

Create `client/src/components/NumberStepper.jsx` (follows the small controlled-input pattern of `TriCheckbox.jsx`; uses existing button classes per the theming convention):

```jsx
// A controlled [−] N [+] integer stepper. Emits clamped integer values via
// onChange. Non-numeric typed input is ignored (the field stays controlled).
export default function NumberStepper({ value, onChange, min = 1, max = 365, ...rest }) {
  const clamp = (n) => Math.min(max, Math.max(min, Math.floor(n)));
  const emit = (n) => { if (Number.isFinite(n)) onChange(clamp(n)); };
  return (
    <span className="number-stepper">
      <button
        type="button" className="ghost" aria-label="Decrease"
        onClick={() => emit(value - 1)} disabled={value <= min}
      >−</button>
      <input
        type="number" inputMode="numeric" min={min} max={max} value={value}
        onChange={(e) => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) emit(n); }}
        {...rest}
      />
      <button
        type="button" className="ghost" aria-label="Increase"
        onClick={() => emit(value + 1)} disabled={value >= max}
      >+</button>
    </span>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && npx vitest run src/components/NumberStepper.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/NumberStepper.jsx client/src/components/NumberStepper.test.jsx
git commit -m "feat(sync): add NumberStepper component (#55)"
```

---

## Task 6: Wire the control into the Sync dialog

**Files:**
- Modify: `client/src/components/SyncConfig.jsx` (imports; state; Step 1 markup ~L60; Start handler ~L210)
- Modify: `client/src/components/SyncConfig.test.jsx` (update the existing `onStart` assertion; add new tests)
- Modify: `client/src/components/SyncDialog.jsx` (`startSync` ~L35 + `runSync` call ~L41)
- Modify: `client/src/services/api.js` (`runSync` ~L63)

- [ ] **Step 1: Update the existing assertion + write the new failing tests**

In `client/src/components/SyncConfig.test.jsx`:

(a) Add a localStorage reset at the top of the `describe('SyncConfig', ...)` block so prefs default deterministically:

```jsx
import { beforeEach } from 'vitest';
// ...inside describe('SyncConfig', () => {
  beforeEach(() => localStorage.clear());
```

(b) Update the existing assertion (currently line ~50) to include the new opts:

```jsx
    expect(onStart).toHaveBeenCalledWith([1, 2], { includeHidden: false, recentOnly: false, recentDays: 30 });
```

(c) Add new tests inside the same describe:

```jsx
  it('reveals the day stepper only when "recent submissions" is checked', () => {
    renderConfig();
    expect(screen.queryByLabelText(/day window/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/only check recent submissions/i));
    expect(screen.getByLabelText(/day window/i)).toBeInTheDocument();
  });

  it('passes recentOnly + recentDays on Start and persists them', () => {
    const onStart = vi.fn();
    renderConfig({ onStart });
    fireEvent.click(screen.getByLabelText(/only check recent submissions/i));
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    expect(onStart).toHaveBeenCalledWith([1, 2], { includeHidden: false, recentOnly: true, recentDays: 30 });
    expect(localStorage.getItem('prism:sync:recent-only')).toBe('true');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && npx vitest run src/components/SyncConfig.test.jsx`
Expected: FAIL — the control does not exist; the updated assertion and the two new tests fail.

- [ ] **Step 3: Add imports + state to `SyncConfig.jsx`**

At the top of `SyncConfig.jsx`, add imports:

```jsx
import { getSyncPrefs, setSyncPrefs } from '../lib/syncPrefs.js';
import NumberStepper from './NumberStepper.jsx';
```

Inside the component body (next to the existing `const [includeHidden, setIncludeHidden] = useState(false);`), seed from prefs:

```jsx
  const [recentOnly, setRecentOnly] = useState(() => getSyncPrefs().recentOnly);
  const [recentDays, setRecentDays] = useState(() => getSyncPrefs().recentDays);
```

- [ ] **Step 4: Add the control markup in Step 1**

In the `sync-step-toggles` div (Step 1), directly after the existing "Include hidden courses" `<label>`, add:

```jsx
          <label>
            <input
              type="checkbox"
              checked={recentOnly}
              onChange={(e) => setRecentOnly(e.target.checked)}
            />
            <span>Only check recent submissions</span>
            <span
              className="sync-help"
              role="img"
              aria-label="What recent-only skips"
              title="Skips submission checks for assignments with no due date and those due more than N days ago. Courses, students, assignments, grades and mastery still sync fully."
            >?</span>
          </label>
          {recentOnly && (
            <div className="sync-recent-days">
              <span>Due within</span>
              <NumberStepper
                value={recentDays}
                onChange={setRecentDays}
                min={1}
                max={365}
                aria-label="Day window"
              />
              <span>days</span>
            </div>
          )}
```

- [ ] **Step 5: Persist + forward the opts in the Start handler**

Replace the Start button `onClick` (~L210):

```jsx
            onClick={() => {
              setSyncPrefs({ recentOnly, recentDays });
              onStart([...selected], { includeHidden, recentOnly, recentDays });
            }}
```

- [ ] **Step 6: Run the SyncConfig tests to verify they pass**

Run: `cd client && npx vitest run src/components/SyncConfig.test.jsx`
Expected: PASS — updated assertion + the two new tests, with the pre-existing tests still green.

- [ ] **Step 7: Thread the opts through `SyncDialog.jsx`**

Replace the `startSync` signature (~L35) and the `runSync` call (~L41):

```jsx
  async function startSync(masteryCourseIds, { skipSchoology = false, includeHidden = false, recentOnly = false, recentDays = 30 } = {}) {
    setEvents([]);
    setMetrics(null);
    setMode('running');
    let streamCompleted = false;
    try {
      await runSync({ masteryCourseIds, skipSchoology, includeHidden, recentOnly, recentDays }, (evt) => {
        setEvents((prev) => [...prev, evt]);
      });
```

- [ ] **Step 8: Forward the opts in `runSync` (`api.js`)**

Replace the `runSync` destructure + POST body (~L63):

```js
export async function runSync(
  { masteryCourseIds = [], skipSchoology = false, includeHidden = false, recentOnly = false, recentDays = 30 },
  onEvent
) {
  const res = await fetch(`${BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masteryCourseIds, skipSchoology, includeHidden, recentOnly, recentDays }),
  });
```

- [ ] **Step 9: Run the full client suite + build**

Run: `cd client && npx vitest run && npx vite build`
Expected: PASS — all client tests green and the production build succeeds.

- [ ] **Step 10: Commit**

```bash
git add client/src/components/SyncConfig.jsx client/src/components/SyncConfig.test.jsx client/src/components/SyncDialog.jsx client/src/services/api.js
git commit -m "feat(sync): recent-only submission control in the Sync dialog (#55)"
```

---

## Final verification

- [ ] **Run every gate green**

```bash
npx vitest run server/
cd client && npx vitest run && npx vite build
```
Expected: all server + client suites pass; production build succeeds.

---

## Notes for the implementer

- **Rubric colours / inline-style convention:** N/A here — this feature touches the Sync dialog, not the rubric grid. Follow the standard `app.css` CSS-var + button-class convention; the `.number-stepper`, `.sync-help`, and `.sync-recent-days` class hooks above can be styled with existing variables (no new hard-coded hex).
- **The "?" affordance** uses a native `title` tooltip — deliberately simple, no new visual component or design decision.
- **Why `windowSkipped` is surfaced:** the spec requires no silent truncation. It already flows out of `syncSectionData`; wiring it into the progress/metrics display is a small follow-up and is *not* required for the green gate (the count is returned and available). If trivial, fold it into `fullSync`'s metrics aggregation alongside `submissions_skipped`.
- **localStorage keys** use the repo's colon convention (`prism:sync:recent-only`, `prism:sync:recent-days`), consistent with `assessmentDraft.js`'s `prism:assessment-draft`.
