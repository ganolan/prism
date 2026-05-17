# Unified Sync with Progress Overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the Schoology and Mastery syncs behind one sidebar button with a pre-sync config modal, and add a blocking live-progress overlay.

**Architecture:** A new server orchestrator (`syncOrchestrator.js`) runs `fullSync` then `syncMasteryForCourse` per selected course, emitting structured progress events. `POST /api/sync` streams those events as newline-delimited JSON. The client renders a `SyncDialog` modal with two presentational children — `SyncConfig` (course picker) and `SyncProgress` (overlay) — driven by a pure `reduceSyncEvents` reducer.

**Tech Stack:** Node/Express (ESM), better-sqlite3, Playwright (mastery), React 18, Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-17-unified-sync-design.md`

---

## File Structure

**Backend**
- `server/services/masterySync.js` *(modify)* — export `hasMasterySession()`; add `allowInteractiveLogin` option to `syncMasteryForCourse`.
- `server/services/syncOrchestrator.js` *(create)* — `runUnifiedSync()`, `classifyMasteryError()`.
- `server/services/syncOrchestrator.test.js` *(create)* — orchestrator tests.
- `server/routes/schoology.js` *(modify)* — streaming `POST /api/sync`.
- `server/routes/schoology.test.js` *(create)* — streaming + 409 tests.
- `server/routes/mastery.js` *(modify)* — `GET /api/mastery/login-status`.
- `server/routes/mastery.test.js` *(create)* — login-status test.

**Frontend**
- `client/src/services/api.js` *(modify)* — `runSync()`, `getMasteryLoginStatus()`.
- `client/src/lib/syncEvents.js` *(create)* — `reduceSyncEvents()` pure reducer.
- `client/src/lib/syncEvents.test.js` *(create)* — reducer tests.
- `client/src/components/SyncConfig.jsx` *(create)* — course picker (presentational).
- `client/src/components/SyncConfig.test.jsx` *(create)*.
- `client/src/components/SyncProgress.jsx` *(create)* — progress overlay (presentational).
- `client/src/components/SyncProgress.test.jsx` *(create)*.
- `client/src/components/SyncDialog.jsx` *(create)* — parent modal, data + streaming.
- `client/src/components/SyncDialog.test.jsx` *(create)*.
- `client/src/App.jsx` *(modify)* — sidebar button opens `SyncDialog`.
- `client/src/app.css` *(modify)* — dialog styles.

**Test commands:** server — `npm run test:server`; client — `cd client && npm test -- --run`.

---

## Task 1: masterySync — session helper + non-interactive option

The unified sync must not pop a visible login browser mid-run. Add an opt-out and a session-existence check.

**Files:**
- Modify: `server/services/masterySync.js`

- [ ] **Step 1: Export a session-existence helper**

After the `STATE_FILE` constant (around line 27 of `server/services/masterySync.js`), add:

```js
// True if a saved Schoology browser session file exists on disk. Best-effort:
// the session may still be expired — this only reports presence, not validity.
export function hasMasterySession() {
  return existsSync(STATE_FILE);
}
```

`existsSync` is already imported from `fs` at the top of the file — confirm it is; if not, add it to that import.

- [ ] **Step 2: Add `allowInteractiveLogin` option to `syncMasteryForCourse`**

Change the signature (currently `export async function syncMasteryForCourse(courseId, { onProgress } = {})`) to:

```js
export async function syncMasteryForCourse(courseId, { onProgress, allowInteractiveLogin = true } = {}) {
```

- [ ] **Step 3: Make the not-logged-in branch respect the option**

In `syncMasteryForCourse`, find the `if (!loggedIn) {` block (around line 205). Replace its body's first lines so that when interactive login is disallowed it throws instead of opening a browser:

```js
    const loggedIn = checkLoggedIn(page);
    if (!loggedIn) {
      if (!allowInteractiveLogin) {
        await browser.close();
        throw new Error('Not logged in to Schoology — the mastery session has expired. Log in and retry.');
      }
      log('Not logged in — opening browser for Schoology login...');
      await browser.close();
```

Leave the rest of the block (the `interactiveLogin()` call and headless retry) unchanged.

- [ ] **Step 4: Verify the server suite still passes**

Run: `npm run test:server`
Expected: PASS (existing `server/db/index.test.js` tests). No new test here — the changed code paths are Playwright browser automation, which is exercised by the route/orchestrator tests via mocks (Tasks 2 and 4), not unit-tested directly.

- [ ] **Step 5: Commit**

```bash
git add server/services/masterySync.js
git commit -m "feat(#18): mastery session helper + non-interactive login option

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: syncOrchestrator — runUnifiedSync + classifyMasteryError

**Files:**
- Create: `server/services/syncOrchestrator.js`
- Test: `server/services/syncOrchestrator.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/services/syncOrchestrator.test.js`:

```js
import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';

// Shared mutable DB handle the mocked getDb() returns.
const h = vi.hoisted(() => ({ db: null }));

vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDb: () => h.db };
});
vi.mock('./sync.js', () => ({ fullSync: vi.fn() }));
vi.mock('./masterySync.js', () => ({ syncMasteryForCourse: vi.fn() }));

import { fullSync } from './sync.js';
import { syncMasteryForCourse } from './masterySync.js';
import { runUnifiedSync, classifyMasteryError } from './syncOrchestrator.js';

function seedCourse(db, name) {
  return db.prepare(
    `INSERT INTO courses (schoology_section_id, course_name) VALUES (?, ?)`
  ).run(`sec-${name}`, name).lastInsertRowid;
}

describe('classifyMasteryError', () => {
  test('login errors classified as login', () => {
    expect(classifyMasteryError(new Error('Not logged in to Schoology'))).toBe('login');
    expect(classifyMasteryError(new Error('Run `npm run mastery:login`'))).toBe('login');
  });
  test('other errors classified as other', () => {
    expect(classifyMasteryError(new Error('page load timeout'))).toBe('other');
  });
});

describe('runUnifiedSync', () => {
  beforeEach(() => {
    h.db = new Database(':memory:');
    migrate(h.db);
    fullSync.mockReset();
    syncMasteryForCourse.mockReset();
    fullSync.mockResolvedValue({ success: true, records: 42 });
    syncMasteryForCourse.mockResolvedValue({ scoresCount: 7 });
  });

  test('runs Schoology before mastery and emits ordered events', async () => {
    const cid = seedCourse(h.db, 'Biology 9');
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => events.push(e));

    const phases = events.filter((e) => e.phase);
    expect(phases[0]).toMatchObject({ phase: 'schoology', status: 'running' });
    expect(phases.some((e) => e.phase === 'schoology' && e.status === 'done' && e.records === 42)).toBe(true);
    expect(phases.some((e) => e.phase === 'mastery' && e.status === 'done' && e.records === 7)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'summary' });
  });

  test('skipSchoology omits the Schoology phase', async () => {
    const cid = seedCourse(h.db, 'Chem 11');
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid], skipSchoology: true }, (e) => events.push(e));
    expect(fullSync).not.toHaveBeenCalled();
    expect(events.some((e) => e.phase === 'schoology')).toBe(false);
  });

  test('one mastery course failing does not abort the others', async () => {
    const c1 = seedCourse(h.db, 'Course A');
    const c2 = seedCourse(h.db, 'Course B');
    syncMasteryForCourse
      .mockRejectedValueOnce(new Error('Not logged in to Schoology'))
      .mockResolvedValueOnce({ scoresCount: 3 });
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [c1, c2] }, (e) => events.push(e));

    const masteryDone = events.filter((e) => e.phase === 'mastery' && e.status === 'done');
    const masteryErr = events.filter((e) => e.phase === 'mastery' && e.status === 'error');
    expect(masteryDone).toHaveLength(1);
    expect(masteryErr).toHaveLength(1);
    expect(masteryErr[0].errorKind).toBe('login');
  });

  test('a Schoology failure skips the mastery phase', async () => {
    const cid = seedCourse(h.db, 'Bio');
    fullSync.mockRejectedValue(new Error('schoology API down'));
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => events.push(e));
    expect(syncMasteryForCourse).not.toHaveBeenCalled();
    expect(events.some((e) => e.phase === 'schoology' && e.status === 'error')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'summary', fatal: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:server`
Expected: FAIL — `Cannot find module './syncOrchestrator.js'`.

- [ ] **Step 3: Implement the orchestrator**

Create `server/services/syncOrchestrator.js`:

```js
import { getDb } from '../db/index.js';
import { fullSync } from './sync.js';
import { syncMasteryForCourse } from './masterySync.js';

// Classify a mastery sync failure: 'login' means the Schoology browser session
// is missing/expired (recoverable by re-login); 'other' is anything else.
export function classifyMasteryError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('not logged in') || msg.includes('log in') || msg.includes('mastery:login')) {
    return 'login';
  }
  return 'other';
}

// Run the unified sync: the Schoology public-API pull, then a Playwright
// mastery pull for each requested course. Every step reports through onEvent.
// Event shapes:
//   { phase:'schoology', status:'running'|'done'|'error', records?, message? }
//   { phase:'mastery', courseId, courseName, status, records?, errorKind?, message? }
//   { type:'log', message }
//   { type:'summary', schoology, mastery, elapsedMs, fatal? }
export async function runUnifiedSync({ masteryCourseIds = [], skipSchoology = false }, onEvent) {
  const emit = (evt) => onEvent?.(evt);
  const db = getDb();
  const startedAt = Date.now();
  const summary = { schoology: null, mastery: [] };

  if (!skipSchoology) {
    emit({ phase: 'schoology', status: 'running' });
    try {
      const result = await fullSync((progress) => emit({ type: 'log', message: progress.message }));
      summary.schoology = { records: result.records };
      emit({ phase: 'schoology', status: 'done', records: result.records });
    } catch (err) {
      emit({ phase: 'schoology', status: 'error', message: err.message });
      emit({ type: 'summary', ...summary, elapsedMs: Date.now() - startedAt, fatal: true });
      return summary;
    }
  }

  for (const courseId of masteryCourseIds) {
    const courseRow = db.prepare('SELECT id, course_name FROM courses WHERE id = ?').get(courseId);
    const courseName = courseRow?.course_name || `Course ${courseId}`;
    emit({ phase: 'mastery', courseId, courseName, status: 'running' });

    const syncId = db.prepare(
      `INSERT INTO sync_log (sync_type, status, started_at) VALUES ('mastery', 'running', ?)`
    ).run(new Date().toISOString()).lastInsertRowid;

    try {
      const result = await syncMasteryForCourse(courseId, {
        allowInteractiveLogin: false,
        onProgress: (p) => emit({ type: 'log', message: `[${courseName}] ${p.message}` }),
      });
      const records = result.scoresCount || 0;
      db.prepare(`UPDATE sync_log SET status = 'completed', records_synced = ?, completed_at = ? WHERE id = ?`)
        .run(records, new Date().toISOString(), syncId);
      summary.mastery.push({ courseId, courseName, status: 'done', records });
      emit({ phase: 'mastery', courseId, courseName, status: 'done', records });
    } catch (err) {
      const errorKind = classifyMasteryError(err);
      db.prepare(`UPDATE sync_log SET status = 'error', error_message = ?, completed_at = ? WHERE id = ?`)
        .run(err.message, new Date().toISOString(), syncId);
      summary.mastery.push({ courseId, courseName, status: 'error', errorKind, message: err.message });
      emit({ phase: 'mastery', courseId, courseName, status: 'error', errorKind, message: err.message });
    }
  }

  emit({ type: 'summary', ...summary, elapsedMs: Date.now() - startedAt });
  return summary;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:server`
Expected: PASS — all `classifyMasteryError` and `runUnifiedSync` tests green.

- [ ] **Step 5: Commit**

```bash
git add server/services/syncOrchestrator.js server/services/syncOrchestrator.test.js
git commit -m "feat(#18): sync orchestrator runs Schoology then mastery per course

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: schoology route — streaming POST /api/sync

**Files:**
- Modify: `server/routes/schoology.js`
- Test: `server/routes/schoology.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/routes/schoology.test.js`:

```js
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

const h = vi.hoisted(() => ({ impl: null }));

vi.mock('../services/syncOrchestrator.js', () => ({
  runUnifiedSync: (opts, onEvent) => h.impl(opts, onEvent),
}));

import router from './schoology.js';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0);
  return { server, port: server.address().port };
}

async function readNdjson(res) {
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('POST /api/sync', () => {
  beforeEach(() => {
    h.impl = async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'done', records: 9 });
      onEvent({ type: 'summary', schoology: { records: 9 }, mastery: [], elapsedMs: 1 });
    };
  });

  test('streams newline-delimited JSON progress events', async () => {
    const { server, port } = startServer();
    try {
      const res = await fetch(`http://localhost:${port}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masteryCourseIds: [] }),
      });
      expect(res.status).toBe(200);
      const events = await readNdjson(res);
      expect(events[0]).toMatchObject({ phase: 'schoology', status: 'done' });
      expect(events.at(-1)).toMatchObject({ type: 'summary' });
    } finally {
      server.close();
    }
  });

  test('returns 409 when a sync is already in progress', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    h.impl = async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'running' });
      await gate;
      onEvent({ type: 'summary', schoology: null, mastery: [], elapsedMs: 1 });
    };
    const { server, port } = startServer();
    try {
      const first = fetch(`http://localhost:${port}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await new Promise((r) => setTimeout(r, 30));
      const second = await fetch(`http://localhost:${port}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(second.status).toBe(409);
      release();
      await (await first).text();
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:server`
Expected: FAIL — the current `POST /api/sync` calls `fullSync` and responds with `res.json`, so no streamed events arrive.

- [ ] **Step 3: Rewrite the route**

Replace the entire contents of `server/routes/schoology.js` with:

```js
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { runUnifiedSync } from '../services/syncOrchestrator.js';

const router = Router();

let syncInProgress = false;

// POST /api/sync — run the unified sync, streaming progress as newline-
// delimited JSON. Body: { masteryCourseIds?: number[], skipSchoology?: boolean }.
router.post('/sync', async (req, res) => {
  if (syncInProgress) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }
  syncInProgress = true;
  const { masteryCourseIds = [], skipSchoology = false } = req.body || {};
  res.set('Content-Type', 'application/x-ndjson');
  const write = (evt) => res.write(JSON.stringify(evt) + '\n');
  try {
    await runUnifiedSync({ masteryCourseIds, skipSchoology }, write);
  } catch (err) {
    console.error('[sync] Error:', err);
    write({ type: 'error', message: err.message });
  } finally {
    syncInProgress = false;
    res.end();
  }
});

// GET /api/sync/status — last sync info
router.get('/sync/status', (req, res) => {
  const db = getDb();
  const last = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get();
  res.json({ syncing: syncInProgress, last: last || null });
});

export default router;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:server`
Expected: PASS — streaming and 409 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/routes/schoology.js server/routes/schoology.test.js
git commit -m "feat(#17): stream sync progress as newline-delimited JSON

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: mastery route — GET /api/mastery/login-status

**Files:**
- Modify: `server/routes/mastery.js`
- Test: `server/routes/mastery.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/routes/mastery.test.js`:

```js
import { describe, test, expect, vi } from 'vitest';
import express from 'express';

const h = vi.hoisted(() => ({ loggedIn: true }));

vi.mock('../services/masterySync.js', () => ({
  hasMasterySession: () => h.loggedIn,
  // Other named exports the route imports — unused in this test.
  syncMasteryForCourse: vi.fn(),
  syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn(),
  writeMasteryOverride: vi.fn(),
  getMasteryForCourse: vi.fn(),
  getRubricScoresForStudent: vi.fn(),
  interactiveLogin: vi.fn(),
}));
vi.mock('../services/schoology.js', () => ({
  pushGradeComments: vi.fn(),
  getSectionGrades: vi.fn(),
}));

import router from './mastery.js';

async function get(path) {
  const app = express();
  app.use('/api/mastery', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('GET /api/mastery/login-status', () => {
  test('reports loggedIn true when a session file exists', async () => {
    h.loggedIn = true;
    const { status, body } = await get('/api/mastery/login-status');
    expect(status).toBe(200);
    expect(body).toEqual({ loggedIn: true });
  });

  test('reports loggedIn false when no session file exists', async () => {
    h.loggedIn = false;
    const { body } = await get('/api/mastery/login-status');
    expect(body).toEqual({ loggedIn: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:server`
Expected: FAIL — route returns 404 (`GET /api/mastery/login-status` does not exist).

- [ ] **Step 3: Implement the route**

In `server/routes/mastery.js`, add `hasMasterySession` to the import from `../services/masterySync.js` (the line beginning `import { syncMasteryForCourse, ...`). Then, immediately after the `POST /api/mastery/login` handler (after its closing `});`, around line 25), add:

```js
// GET /api/mastery/login-status — best-effort: does a saved browser session
// file exist? Does not verify the session is still valid.
router.get('/login-status', (req, res) => {
  res.json({ loggedIn: hasMasterySession() });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:server`
Expected: PASS — both login-status tests green.

- [ ] **Step 5: Commit**

```bash
git add server/routes/mastery.js server/routes/mastery.test.js
git commit -m "feat(#18): add mastery login-status endpoint

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: api.js — streaming runSync + getMasteryLoginStatus

**Files:**
- Modify: `client/src/services/api.js`
- Test: `client/src/services/api.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `client/src/services/api.test.js`:

```js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSync } from './api.js';

function streamResponse(lines) {
  const body = {
    getReader() {
      let i = 0;
      const enc = new TextEncoder();
      return {
        read() {
          if (i < lines.length) {
            return Promise.resolve({ done: false, value: enc.encode(lines[i++]) });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  return { ok: true, status: 200, body };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('runSync', () => {
  it('parses newline-delimited JSON events and calls onEvent for each', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      '{"phase":"schoology","status":"done"}\n{"type":',
      '"summary","mastery":[]}\n',
    ])));
    const events = [];
    await runSync({ masteryCourseIds: [1] }, (e) => events.push(e));
    expect(events).toEqual([
      { phase: 'schoology', status: 'done' },
      { type: 'summary', mastery: [] },
    ]);
  });

  it('throws a clear error on 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    await expect(runSync({}, () => {})).rejects.toThrow(/already running/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npm test -- --run src/services/api.test.js`
Expected: FAIL — `runSync` is not exported from `api.js`.

- [ ] **Step 3: Implement the functions**

In `client/src/services/api.js`, replace the `// Sync` block (the two lines defining `triggerSync` and `getSyncStatus`) with:

```js
// Sync
export const getSyncStatus = () => request('/sync/status');

// Run the unified sync. Streams newline-delimited JSON progress events from the
// server; each parsed event is passed to onEvent. Resolves when the stream ends.
export async function runSync({ masteryCourseIds = [], skipSchoology = false }, onEvent) {
  const res = await fetch(`${BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masteryCourseIds, skipSchoology }),
  });
  if (res.status === 409) throw new Error('A sync is already running.');
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Sync failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (final) => {
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
    if (final && buffer.trim()) onEvent(JSON.parse(buffer.trim()));
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flush(false);
  }
  flush(true);
}
```

Then, in the `// Mastery / SBG` block, add alongside `triggerMasteryLogin`:

```js
export const getMasteryLoginStatus = () => request('/mastery/login-status');
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npm test -- --run src/services/api.test.js`
Expected: PASS — both `runSync` tests green.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/api.js client/src/services/api.test.js
git commit -m "feat(#17): streaming runSync client + mastery login-status

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: syncEvents — reduceSyncEvents reducer

**Files:**
- Create: `client/src/lib/syncEvents.js`
- Test: `client/src/lib/syncEvents.test.js`

- [ ] **Step 1: Write the failing tests**

Create `client/src/lib/syncEvents.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { reduceSyncEvents } from './syncEvents.js';

describe('reduceSyncEvents', () => {
  it('builds an ordered phase list, updating status in place', () => {
    const { phases } = reduceSyncEvents([
      { phase: 'schoology', status: 'running' },
      { phase: 'schoology', status: 'done', records: 42 },
      { phase: 'mastery', courseId: 5, courseName: 'Biology 9', status: 'running' },
      { phase: 'mastery', courseId: 5, courseName: 'Biology 9', status: 'done', records: 7 },
    ]);
    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({ kind: 'schoology', status: 'done', records: 42 });
    expect(phases[1]).toMatchObject({ kind: 'mastery', courseId: 5, status: 'done', records: 7 });
  });

  it('collects log lines and the summary', () => {
    const { logLines, summary } = reduceSyncEvents([
      { type: 'log', message: 'Fetched 4 sections' },
      { type: 'summary', mastery: [], elapsedMs: 100 },
    ]);
    expect(logLines).toEqual(['Fetched 4 sections']);
    expect(summary).toMatchObject({ elapsedMs: 100 });
  });

  it('records failures with their errorKind', () => {
    const { failures } = reduceSyncEvents([
      { phase: 'mastery', courseId: 1, courseName: 'A', status: 'error', errorKind: 'login', message: 'expired' },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ courseId: 1, errorKind: 'login' });
  });

  it('computes progress as completed phases over total', () => {
    const { progress } = reduceSyncEvents([
      { phase: 'schoology', status: 'done' },
      { phase: 'mastery', courseId: 1, courseName: 'A', status: 'running' },
    ]);
    expect(progress).toBe(0.5);
  });

  it('marks fatal when a summary is fatal', () => {
    const { fatal } = reduceSyncEvents([{ type: 'summary', fatal: true, mastery: [] }]);
    expect(fatal).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && npm test -- --run src/lib/syncEvents.test.js`
Expected: FAIL — `Cannot find module './syncEvents.js'`.

- [ ] **Step 3: Implement the reducer**

Create `client/src/lib/syncEvents.js`:

```js
// Reduce a stream of sync progress events (see syncOrchestrator.js for shapes)
// into render-ready UI state for the progress overlay.
export function reduceSyncEvents(events) {
  const phases = [];
  const logLines = [];
  let summary = null;
  let fatal = false;
  const find = (key) => phases.find((p) => p.key === key);

  for (const evt of events) {
    if (evt.type === 'log') { logLines.push(evt.message); continue; }
    if (evt.type === 'summary') { summary = evt; fatal = fatal || !!evt.fatal; continue; }
    if (evt.type === 'error') { fatal = true; continue; }

    if (evt.phase === 'schoology') {
      let p = find('schoology');
      if (!p) { p = { key: 'schoology', kind: 'schoology', label: 'Schoology data' }; phases.push(p); }
      p.status = evt.status;
      if (evt.records != null) p.records = evt.records;
      if (evt.message) p.message = evt.message;
    } else if (evt.phase === 'mastery') {
      const key = `mastery:${evt.courseId}`;
      let p = find(key);
      if (!p) { p = { key, kind: 'mastery', courseId: evt.courseId }; phases.push(p); }
      p.status = evt.status;
      p.label = `Mastery · ${evt.courseName}`;
      if (evt.records != null) p.records = evt.records;
      if (evt.errorKind) p.errorKind = evt.errorKind;
      if (evt.message) p.message = evt.message;
    }
  }

  const failures = phases.filter((p) => p.status === 'error');
  const done = phases.filter((p) => p.status === 'done' || p.status === 'error').length;
  const progress = phases.length ? done / phases.length : 0;
  return { phases, logLines, summary, fatal, failures, progress };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && npm test -- --run src/lib/syncEvents.test.js`
Expected: PASS — all five reducer tests green.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/syncEvents.js client/src/lib/syncEvents.test.js
git commit -m "feat(#17): reduceSyncEvents — sync events to UI state

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: SyncConfig component — course picker

Presentational. Receives courses and login state as props; manages only selection/collapse UI state.

**Files:**
- Create: `client/src/components/SyncConfig.jsx`
- Test: `client/src/components/SyncConfig.test.jsx`

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/SyncConfig.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import SyncConfig from './SyncConfig.jsx';

const COURSES = [
  { id: 1, course_name: 'Biology 9', hidden: 0, archived: 0 },
  { id: 2, course_name: 'Chemistry 11', hidden: 0, archived: 0 },
  { id: 3, course_name: 'Old Physics', hidden: 1, archived: 0 },
  { id: 4, course_name: 'Archived Bio', hidden: 0, archived: 1 },
];

function renderConfig(props = {}) {
  return render(
    <SyncConfig
      courses={COURSES}
      loggedIn={true}
      busy={false}
      onStart={props.onStart || (() => {})}
      onCancel={props.onCancel || (() => {})}
      onLogin={props.onLogin || (() => {})}
    />
  );
}

describe('SyncConfig', () => {
  it('renders the three course groups with counts', () => {
    renderConfig();
    expect(screen.getByText(/Visible courses/)).toBeInTheDocument();
    expect(screen.getByText(/Hidden courses/)).toBeInTheDocument();
    expect(screen.getByText(/Archived courses/)).toBeInTheDocument();
  });

  it('shows visible courses expanded and others collapsed by default', () => {
    renderConfig();
    expect(screen.getByLabelText('Biology 9')).toBeInTheDocument();
    expect(screen.queryByLabelText('Old Physics')).not.toBeInTheDocument();
  });

  it('expands a collapsed group when its header is clicked', () => {
    renderConfig();
    fireEvent.click(screen.getByText(/Hidden courses/));
    expect(screen.getByLabelText('Old Physics')).toBeInTheDocument();
  });

  it('pre-selects all visible courses and starts with their ids', () => {
    const onStart = vi.fn();
    renderConfig({ onStart });
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    expect(onStart).toHaveBeenCalledWith([1, 2]);
  });

  it('group select-all checkbox is indeterminate when only some are selected', () => {
    renderConfig();
    fireEvent.click(screen.getByLabelText('Biology 9')); // deselect one
    const groupCheckbox = screen.getByLabelText(/select all visible/i);
    expect(groupCheckbox.indeterminate).toBe(true);
  });

  it('shows a login prompt instead of the course tree when not logged in', () => {
    render(
      <SyncConfig courses={COURSES} loggedIn={false} busy={false}
        onStart={() => {}} onCancel={() => {}} onLogin={() => {}} />
    );
    expect(screen.getByRole('button', { name: /log in to schoology/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Biology 9')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && npm test -- --run src/components/SyncConfig.test.jsx`
Expected: FAIL — `Cannot find module './SyncConfig.jsx'`.

- [ ] **Step 3: Implement the component**

Create `client/src/components/SyncConfig.jsx`:

```jsx
import { useState, useMemo } from 'react';

const GROUPS = [
  { key: 'visible', label: 'Visible courses', match: (c) => !c.hidden && !c.archived },
  { key: 'hidden', label: 'Hidden courses', match: (c) => c.hidden && !c.archived },
  { key: 'archived', label: 'Archived courses', match: (c) => c.archived },
];

// Checkbox that supports the indeterminate (tri-state) visual.
function TriCheckbox({ checked, indeterminate, ...rest }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => { if (el) el.indeterminate = indeterminate; }}
      {...rest}
    />
  );
}

export default function SyncConfig({ courses, loggedIn, busy, onStart, onCancel, onLogin }) {
  const groups = useMemo(
    () => GROUPS.map((g) => ({ ...g, courses: courses.filter(g.match) })).filter((g) => g.courses.length),
    [courses]
  );
  const visibleIds = useMemo(
    () => courses.filter(GROUPS[0].match).map((c) => c.id),
    [courses]
  );

  const [selected, setSelected] = useState(() => new Set(visibleIds));
  const [collapsed, setCollapsed] = useState({ visible: false, hidden: true, archived: true });

  const toggleCourse = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleGroup = (group) => setSelected((prev) => {
    const next = new Set(prev);
    const ids = group.courses.map((c) => c.id);
    const allOn = ids.every((id) => next.has(id));
    ids.forEach((id) => (allOn ? next.delete(id) : next.add(id)));
    return next;
  });
  const toggleCollapse = (key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const count = selected.size;

  return (
    <div className="sync-config">
      <div className="sync-step">
        <div className="sync-step-title">
          <span>Step 1 · Schoology data</span>
          <span className="sync-badge sync-badge-run">Always runs</span>
        </div>
        <p className="sync-step-desc">
          Courses, students, assignments, grades &amp; submission status — all sections in one pass.
        </p>
      </div>

      <div className="sync-step">
        <div className="sync-step-title">
          <span>Step 2 · Mastery (SBG) data</span>
          <span className="sync-badge">Optional</span>
        </div>

        {!loggedIn ? (
          <div className="alert alert-warning sync-login-prompt">
            <p>Mastery sync needs a Schoology browser session. Log in once to enable it.</p>
            <button className="secondary" onClick={onLogin} disabled={busy}>
              Log in to Schoology
            </button>
          </div>
        ) : (
          <>
            <div className="alert alert-warning sync-disclaimer">
              Mastery sync opens a browser session and runs one course at a time —
              roughly 20–40s per course. Pick only what you need.
            </div>
            {groups.map((group) => {
              const ids = group.courses.map((c) => c.id);
              const onCount = ids.filter((id) => selected.has(id)).length;
              return (
                <div className="sync-group" key={group.key}>
                  <div className="sync-group-head">
                    <button
                      type="button"
                      className="sync-caret"
                      onClick={() => toggleCollapse(group.key)}
                    >
                      {collapsed[group.key] ? '▸' : '▾'}
                    </button>
                    <label className="sync-group-label">
                      <TriCheckbox
                        aria-label={`Select all ${group.label.toLowerCase()}`}
                        checked={onCount === ids.length}
                        indeterminate={onCount > 0 && onCount < ids.length}
                        onChange={() => toggleGroup(group)}
                      />
                      <span
                        className="sync-group-name"
                        onClick={() => toggleCollapse(group.key)}
                      >
                        {group.label} <span className="text-muted">({onCount} of {ids.length})</span>
                      </span>
                    </label>
                  </div>
                  {!collapsed[group.key] && (
                    <div className="sync-course-list">
                      {group.courses.map((c) => (
                        <label className="sync-course" key={c.id}>
                          <input
                            type="checkbox"
                            aria-label={c.course_name}
                            checked={selected.has(c.id)}
                            onChange={() => toggleCourse(c.id)}
                          />
                          <span>{c.course_name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="sync-foot">
        <span className="text-muted text-sm">
          Schoology + {count} mastery course{count === 1 ? '' : 's'}
        </span>
        <div className="sync-foot-actions">
          <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="primary"
            onClick={() => onStart([...selected])}
            disabled={busy}
          >
            Start sync
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && npm test -- --run src/components/SyncConfig.test.jsx`
Expected: PASS — all six SyncConfig tests green.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SyncConfig.jsx client/src/components/SyncConfig.test.jsx
git commit -m "feat(#18): SyncConfig — grouped mastery course picker

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: SyncProgress component — live overlay

Presentational. Receives reduced sync state plus mode and callbacks.

**Files:**
- Create: `client/src/components/SyncProgress.jsx`
- Test: `client/src/components/SyncProgress.test.jsx`

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/SyncProgress.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import SyncProgress from './SyncProgress.jsx';

const RUNNING = {
  phases: [
    { key: 'schoology', kind: 'schoology', label: 'Schoology data', status: 'done', records: 418 },
    { key: 'mastery:1', kind: 'mastery', courseId: 1, label: 'Mastery · Biology 9', status: 'running' },
  ],
  logLines: ['Fetched 4 sections'],
  failures: [],
  progress: 0.5,
  summary: null,
  fatal: false,
};

function noop() {}

describe('SyncProgress', () => {
  it('lists each phase with its status', () => {
    render(<SyncProgress reduced={RUNNING} mode="running" onDone={noop} onRetry={noop} onLogin={noop} />);
    expect(screen.getByText('Schoology data')).toBeInTheDocument();
    expect(screen.getByText('Mastery · Biology 9')).toBeInTheDocument();
  });

  it('disables the Done button while running', () => {
    render(<SyncProgress reduced={RUNNING} mode="running" onDone={noop} onRetry={noop} onLogin={noop} />);
    expect(screen.getByRole('button', { name: /done/i })).toBeDisabled();
  });

  it('enables Done when the sync is finished', () => {
    const done = { ...RUNNING, mode: 'done' };
    render(<SyncProgress reduced={done} mode="done" onDone={noop} onRetry={noop} onLogin={noop} />);
    expect(screen.getByRole('button', { name: /done/i })).toBeEnabled();
  });

  it('shows an amber login-remedy banner for a login failure', () => {
    const reduced = {
      ...RUNNING,
      failures: [{ key: 'mastery:1', courseId: 1, label: 'Mastery · Biology 9', errorKind: 'login', message: 'expired' }],
    };
    render(<SyncProgress reduced={reduced} mode="done" onDone={noop} onRetry={noop} onLogin={noop} />);
    const banner = screen.getByTestId('remedy-mastery:1');
    expect(banner.className).toMatch(/alert-warning/);
    expect(within(banner).getByRole('button', { name: /log in to schoology/i })).toBeInTheDocument();
  });

  it('shows a plain error-remedy banner for a generic failure', () => {
    const reduced = {
      ...RUNNING,
      failures: [{ key: 'mastery:1', courseId: 1, label: 'Mastery · Biology 9', errorKind: 'other', message: 'page timeout' }],
    };
    render(<SyncProgress reduced={reduced} mode="done" onDone={noop} onRetry={noop} onLogin={noop} />);
    const banner = screen.getByTestId('remedy-mastery:1');
    expect(banner.className).toMatch(/alert-error/);
    expect(screen.getByText(/page timeout/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && npm test -- --run src/components/SyncProgress.test.jsx`
Expected: FAIL — `Cannot find module './SyncProgress.jsx'`.

- [ ] **Step 3: Implement the component**

Create `client/src/components/SyncProgress.jsx`:

```jsx
const STATUS_ICON = { running: '●', done: '✓', error: '✕' };

function PhaseRow({ phase }) {
  const status = phase.status || 'pending';
  return (
    <div className={`sync-phase sync-phase-${status}`}>
      <span className="sync-phase-icon">{STATUS_ICON[status] || '○'}</span>
      <span className="sync-phase-label">{phase.label}</span>
      <span className="sync-phase-count">
        {phase.status === 'done' && phase.records != null && `${phase.records} records`}
        {phase.status === 'running' && 'syncing…'}
        {phase.status === 'error' && 'not synced'}
      </span>
    </div>
  );
}

function RemedyBanner({ failure, retryEnabled, onLogin, onRetry }) {
  const isLogin = failure.errorKind === 'login';
  return (
    <div
      data-testid={`remedy-${failure.key}`}
      className={`alert ${isLogin ? 'alert-warning' : 'alert-error'} sync-remedy`}
    >
      {isLogin ? (
        <p>
          <strong>{failure.label}</strong> couldn't sync — the Schoology session expired.
          Log in again, then retry.
        </p>
      ) : (
        <p>
          <strong>{failure.label}</strong> failed: {failure.message}. This is usually
          temporary — retry, or try again later from the Sync menu.
        </p>
      )}
      <div className="sync-remedy-actions">
        {isLogin && (
          <button className="secondary" onClick={onLogin}>Log in to Schoology</button>
        )}
        <button
          className="secondary"
          onClick={() => onRetry([failure.courseId])}
          disabled={isLogin && !retryEnabled}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

export default function SyncProgress({ reduced, mode, retryEnabled, onDone, onRetry, onLogin }) {
  const { phases, logLines, failures, progress, summary, fatal } = reduced;
  const running = mode === 'running';

  let heading = 'Syncing…';
  let headingClass = '';
  if (mode === 'done') {
    if (fatal) { heading = 'Sync failed'; headingClass = 'sync-head-error'; }
    else if (failures.length) { heading = 'Sync finished with issues'; headingClass = 'sync-head-warn'; }
    else { heading = 'Sync complete'; headingClass = 'sync-head-ok'; }
  }

  return (
    <div className="sync-progress">
      <div className={`sync-progress-head ${headingClass}`}>
        <h3>{running && <span className="sync-spinner" />}{heading}</h3>
        {running && <p className="text-muted text-sm">Please don't close Prism — this takes a minute.</p>}
      </div>

      <div className="sync-bar">
        <div className="sync-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>

      <div className="sync-phase-list">
        {phases.map((p) => <PhaseRow key={p.key} phase={p} />)}
      </div>

      {logLines.length > 0 && (
        <div className="sync-log">
          {logLines.slice(-40).map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}

      {mode === 'done' && failures.map((f) => (
        <RemedyBanner
          key={f.key}
          failure={f}
          retryEnabled={retryEnabled}
          onLogin={onLogin}
          onRetry={onRetry}
        />
      ))}

      <div className="sync-foot">
        <span className="text-muted text-sm">
          {summary && mode === 'done' && `Finished in ${(summary.elapsedMs / 1000).toFixed(0)}s`}
        </span>
        <button className="primary" onClick={onDone} disabled={running}>Done</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && npm test -- --run src/components/SyncProgress.test.jsx`
Expected: PASS — all five SyncProgress tests green.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SyncProgress.jsx client/src/components/SyncProgress.test.jsx
git commit -m "feat(#17): SyncProgress — live overlay with remediation banners

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: SyncDialog + App wiring + styles

Parent modal: owns data fetching, the event stream, mode transitions, and retry. Wires into the sidebar.

**Files:**
- Create: `client/src/components/SyncDialog.jsx`
- Test: `client/src/components/SyncDialog.test.jsx`
- Modify: `client/src/App.jsx`
- Modify: `client/src/app.css`

- [ ] **Step 1: Write the failing test**

Create `client/src/components/SyncDialog.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SyncDialog from './SyncDialog.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

beforeEach(() => {
  vi.mocked(api.getCourses).mockResolvedValue([
    { id: 1, course_name: 'Biology 9', hidden: 0, archived: 0 },
  ]);
  vi.mocked(api.getMasteryLoginStatus).mockResolvedValue({ loggedIn: true });
});

describe('SyncDialog', () => {
  it('loads courses and shows the config step', async () => {
    render(<SyncDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Step 1 · Schoology/)).toBeInTheDocument());
    expect(screen.getByLabelText('Biology 9')).toBeInTheDocument();
  });

  it('switches to the progress overlay when Start sync is clicked', async () => {
    vi.mocked(api.runSync).mockImplementation(async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'done', records: 5 });
      onEvent({ type: 'summary', schoology: { records: 5 }, mastery: [], elapsedMs: 1000 });
    });
    render(<SyncDialog onClose={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: /start sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    await waitFor(() => expect(screen.getByText(/Sync complete/)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npm test -- --run src/components/SyncDialog.test.jsx`
Expected: FAIL — `Cannot find module './SyncDialog.jsx'`.

- [ ] **Step 3: Implement SyncDialog**

Create `client/src/components/SyncDialog.jsx`:

```jsx
import { useState, useEffect, useMemo } from 'react';
import { getCourses, getMasteryLoginStatus, triggerMasteryLogin, runSync } from '../services/api.js';
import { reduceSyncEvents } from '../lib/syncEvents.js';
import SyncConfig from './SyncConfig.jsx';
import SyncProgress from './SyncProgress.jsx';

export default function SyncDialog({ onClose }) {
  const [mode, setMode] = useState('loading'); // loading | config | running | done
  const [courses, setCourses] = useState([]);
  const [loggedIn, setLoggedIn] = useState(false);
  const [events, setEvents] = useState([]);
  const [retryEnabled, setRetryEnabled] = useState(false);

  useEffect(() => {
    Promise.all([getCourses(true, true), getMasteryLoginStatus()])
      .then(([courseList, status]) => {
        setCourses(courseList);
        setLoggedIn(!!status.loggedIn);
        setMode('config');
      })
      .catch(() => setMode('config'));
  }, []);

  const reduced = useMemo(() => reduceSyncEvents(events), [events]);

  async function startSync(masteryCourseIds, { skipSchoology = false } = {}) {
    setEvents([]);
    setMode('running');
    try {
      await runSync({ masteryCourseIds, skipSchoology }, (evt) => {
        setEvents((prev) => [...prev, evt]);
      });
    } catch (err) {
      setEvents((prev) => [...prev, { type: 'error', message: err.message }]);
    }
    setMode('done');
  }

  async function handleLogin() {
    try {
      await triggerMasteryLogin();
      const status = await getMasteryLoginStatus();
      setLoggedIn(!!status.loggedIn);
      setRetryEnabled(true);
    } catch {
      /* login browser failed or was cancelled — leave state unchanged */
    }
  }

  function handleRetry(courseIds) {
    setRetryEnabled(false);
    startSync(courseIds, { skipSchoology: true });
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content sync-dialog">
        {mode === 'loading' && <p className="loading">Loading courses…</p>}

        {mode === 'config' && (
          <SyncConfig
            courses={courses}
            loggedIn={loggedIn}
            busy={false}
            onStart={(ids) => startSync(ids)}
            onCancel={onClose}
            onLogin={handleLogin}
          />
        )}

        {(mode === 'running' || mode === 'done') && (
          <SyncProgress
            reduced={reduced}
            mode={mode}
            retryEnabled={retryEnabled}
            onDone={onClose}
            onRetry={handleRetry}
            onLogin={handleLogin}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npm test -- --run src/components/SyncDialog.test.jsx`
Expected: PASS — both SyncDialog tests green.

- [ ] **Step 5: Wire SyncDialog into App.jsx**

In `client/src/App.jsx`:

1. Replace the import line `import { triggerSync, getSyncStatus } from './services/api.js';` with:
   ```jsx
   import SyncDialog from './components/SyncDialog.jsx';
   ```
2. Replace the state + `handleSync` block (lines 17–32: the `syncing`/`syncResult` state and the `handleSync` function) with:
   ```jsx
   const [syncOpen, setSyncOpen] = useState(false);
   const { theme, setTheme, themes } = useTheme();
   ```
3. Replace the sidebar sync button + result block (the `<button className="sync-btn" ...>` element and the `{syncResult && (...)}` block) with:
   ```jsx
   <button className="sync-btn" onClick={() => setSyncOpen(true)}>
     Sync
   </button>
   ```
4. Just before the closing `</div>` of `<div className="app">` (after `</main>`), add:
   ```jsx
   {syncOpen && <SyncDialog onClose={() => setSyncOpen(false)} />}
   ```

- [ ] **Step 6: Add styles to app.css**

Append to `client/src/app.css` (uses existing CSS custom properties — no hardcoded colors):

```css
/* ── Sync dialog ─────────────────────────────────────────────── */
.sync-dialog { width: 540px; max-width: 92vw; padding: 0; }
.sync-config, .sync-progress { display: flex; flex-direction: column; }
.sync-config, .sync-progress { padding: 1.25rem 1.5rem; }

.sync-step {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.75rem 0.9rem;
  margin-bottom: 0.85rem;
}
.sync-step-title { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; }
.sync-step-desc { color: var(--text-muted); font-size: 0.85rem; margin: 0.35rem 0 0; }
.sync-badge {
  font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 0.1rem 0.45rem; border-radius: 4px;
  background: var(--table-header-bg); color: var(--text-muted);
}
.sync-badge-run { background: var(--accent-subtle); color: var(--accent); }

.sync-disclaimer, .sync-login-prompt { font-size: 0.8rem; margin: 0.6rem 0; }
.sync-login-prompt button { margin-top: 0.5rem; }

.sync-group { margin: 0.25rem 0 0.25rem 0.5rem; }
.sync-group-head { display: flex; align-items: center; gap: 0.4rem; }
.sync-caret {
  background: none; border: none; cursor: pointer;
  color: var(--text-muted); font-size: 0.8rem; padding: 0.15rem;
}
.sync-group-label { display: flex; align-items: center; gap: 0.4rem; font-weight: 600; }
.sync-group-name { cursor: pointer; }
.sync-course-list { margin-left: 1.6rem; }
.sync-course { display: flex; align-items: center; gap: 0.4rem; padding: 0.15rem 0; }

.sync-foot {
  display: flex; justify-content: space-between; align-items: center;
  border-top: 1px solid var(--border); padding-top: 0.85rem; margin-top: 0.5rem;
}
.sync-foot-actions { display: flex; gap: 0.5rem; }

.sync-progress-head h3 { margin: 0; display: flex; align-items: center; gap: 0.5rem; }
.sync-head-ok h3 { color: var(--success); }
.sync-head-warn h3 { color: var(--warning); }
.sync-head-error h3 { color: var(--error); }
.sync-spinner {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid var(--border); border-top-color: var(--accent);
  display: inline-block; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.sync-bar {
  height: 6px; background: var(--table-header-bg); border-radius: 3px;
  margin: 0.85rem 0; overflow: hidden;
}
.sync-bar-fill {
  height: 100%; background: var(--accent); border-radius: 3px;
  transition: width 0.3s ease;
}

.sync-phase-list { display: flex; flex-direction: column; gap: 0.15rem; }
.sync-phase { display: flex; align-items: center; gap: 0.5rem; padding: 0.2rem 0; }
.sync-phase-icon { width: 1rem; text-align: center; }
.sync-phase-done .sync-phase-icon { color: var(--success); }
.sync-phase-running .sync-phase-icon { color: var(--accent); }
.sync-phase-error .sync-phase-icon { color: var(--error); }
.sync-phase-pending { color: var(--text-muted); }
.sync-phase-count { margin-left: auto; color: var(--text-muted); font-size: 0.8rem; }

.sync-log {
  margin-top: 0.6rem; background: var(--table-header-bg);
  border: 1px solid var(--border); border-radius: 6px;
  padding: 0.5rem 0.65rem; font-family: ui-monospace, monospace;
  font-size: 0.72rem; color: var(--text-muted);
  max-height: 110px; overflow-y: auto; line-height: 1.6;
}

.sync-remedy { margin-top: 0.6rem; font-size: 0.82rem; }
.sync-remedy-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
```

`.alert`, `.alert-warning`, and `.alert-error` already exist in `app.css` — the remedy banners reuse them as-is.

- [ ] **Step 7: Run the full client and server suites**

Run: `cd client && npm test -- --run`
Expected: PASS — all client tests, including the new ones.

Run: `npm run test:server`
Expected: PASS — all server tests.

- [ ] **Step 8: Manual smoke check**

Start the app (`npm run dev`), click the sidebar **Sync** button. Confirm: the config modal opens; visible courses are listed and pre-checked; collapsed Hidden/Archived groups expand on click; **Start sync** switches to the progress overlay; the phase checklist and log box update; **Done** is disabled until the stream ends, then closes the modal.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/SyncDialog.jsx client/src/components/SyncDialog.test.jsx client/src/App.jsx client/src/app.css
git commit -m "feat(#18,#17): SyncDialog modal — unified sync entry point

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** unified entry (Tasks 1–9) ✓; Schoology-always Step 1 (Task 7) ✓; grouped collapsible mastery picker with tri-state (Task 7) ✓; login prompt when no session (Tasks 4, 7, 9) ✓; streaming progress (Tasks 3, 5) ✓; phase checklist + log box (Tasks 6, 8) ✓; per-course failure + amber/red remediation + retry skipping Schoology (Tasks 2, 8, 9) ✓; 409 guard (Task 3) ✓; no schema change ✓.
- **Refinement vs. spec:** the spec said `SyncConfig` fetches its own data; the plan moves all fetching to `SyncDialog` so `SyncConfig`/`SyncProgress` stay pure and unit-testable. Behaviour is unchanged.
- **Type consistency:** event shapes (`phase`/`type`/`status`/`errorKind`/`records`) are identical across `syncOrchestrator.js`, `reduceSyncEvents`, and the components. `runSync(opts, onEvent)` and `runUnifiedSync(opts, onEvent)` share the `{ masteryCourseIds, skipSchoology }` option shape.
```
