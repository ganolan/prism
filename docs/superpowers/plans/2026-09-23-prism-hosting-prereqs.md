# Prism hosting prerequisites (Half 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the six prerequisite code changes the hosting design needs, so that when the Mac mini is provisioned nothing is blocked on application code.

**Architecture:** Each change replaces an implicit, process-local assumption (bind everywhere, session lives beside the code, the database is whatever sits next to me) with an explicit, environment-declared one. Every change is a small pure module plus a call-site swap, so each carries a real unit test and none of them depends on the mini existing.

**Tech Stack:** Node ESM (mini runs v25.9.0, npm 11.12.1), Express 4, better-sqlite3, Vitest (server: `npx vitest run` from the repo root; client: `cd client && npx vitest run`), React 18 + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md` — "Prerequisite code changes" table, items 1–6. Decision record: `docs/adr/0003-prism-served-from-a-home-server-over-tailscale.md`.

## Global Constraints

- **ESM only.** `"type": "module"`; use `import`, never `require`.
- **No new dependencies.** Everything here uses what is already in `package.json`.
- **Node v25.9.0 / npm 11.12.1** — the versions on the mini, and what CI will pin.
- **Colors come from CSS custom properties** in `client/src/app.css`. Never a hex literal in a component. Sidebar content uses `var(--sidebar-text)`, not `var(--text-muted)` (that one is for the light content area and is unreadable on the sidebar gradient).
- **Dates render `en-GB`** (DD/MM/YYYY). Never `en-US`.
- **A pure module beside its test.** New backend logic gets a `*.test.js` sibling; new client logic gets a `*.test.jsx` sibling.
- **Commit at the end of every task**, conventional-commit prefix matching the existing log (`feat:`, `fix:`, `docs:`), issue number in the subject where one exists.
- **Branch:** `feat/hosting-prereqs`, cut from `main`. This repo is solo trunk-based — when the branch is done it merges into `main` fast-forward and `main` is pushed (no PR).
- **Do not write deploy scripts, launchd plists, or `.github/workflows/` here.** That is Half 2 and needs decisions this plan does not make.

## Review Focus

Five things the spec implies, which a careless implementation of these tasks would leave broken. Each has a test in the task that owns the code.

1. **`HOST=0.0.0.0` must still work.** Loopback is the default, not a hardcode. If the override does not work, the first person who needs LAN access edits the source and the default is lost. → Task 1.
2. **A malformed or half-written `release.json` must not 500 `/api/version`.** The file is written during a deploy swap, which is exactly when someone is refreshing the page to see if the deploy landed. → Task 5.
3. **Restore against a missing local database must succeed.** A fresh clone has no `students.db` and no sidecars; unlinking absent files must be a no-op, not a crash. → Task 3.
4. **`PRISM_SESSION_DIR` pointing at a directory that does not exist yet must be created,** including missing parents. On the mini the first `mastery:login` runs against an empty `~/prism/data/`. → Task 2.
5. **The MCP `DB_PATH` guard must fire only on the CLI entry, and must accept `:memory:`.** If it runs at module load it breaks the whole MCP test suite; if it rejects `:memory:` it breaks every test that seeds one. → Task 6.

---

### Task 1: Bind loopback by default

Prism has no application auth. The tailnet is the perimeter (ADR 0003), which only holds if the process is not listening on every interface. `server/index.js:80` currently calls `app.listen(PORT)` with no host, so Express binds `0.0.0.0`.

**Files:**
- Create: `server/lib/listenConfig.js`
- Test: `server/lib/listenConfig.test.js`
- Modify: `server/index.js:26` (PORT const), `server/index.js:80-82` (listen call)
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveHost(env?: object) => string`, `resolvePort(env?: object) => number`, `DEFAULT_HOST = '127.0.0.1'`, `DEFAULT_PORT = 3001`.

- [ ] **Step 1: Write the failing test**

Create `server/lib/listenConfig.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { resolveHost, resolvePort, DEFAULT_HOST, DEFAULT_PORT } from './listenConfig.js';

describe('resolveHost', () => {
  it('defaults to loopback so the tailnet is the only route in', () => {
    expect(resolveHost({})).toBe('127.0.0.1');
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });

  it('treats an empty or whitespace HOST as unset', () => {
    expect(resolveHost({ HOST: '' })).toBe('127.0.0.1');
    expect(resolveHost({ HOST: '   ' })).toBe('127.0.0.1');
  });

  // Review Focus 1: loopback is a default, not a hardcode.
  it('honours an explicit override', () => {
    expect(resolveHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveHost({ HOST: '::1' })).toBe('::1');
  });
});

describe('resolvePort', () => {
  it('defaults to 3001', () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(3001);
  });

  it('parses a numeric PORT, including 0 for an ephemeral port', () => {
    expect(resolvePort({ PORT: '3002' })).toBe(3002);
    expect(resolvePort({ PORT: '0' })).toBe(0);
  });

  it('falls back to the default rather than binding a nonsense port', () => {
    expect(resolvePort({ PORT: 'not-a-port' })).toBe(3001);
    expect(resolvePort({ PORT: '99999' })).toBe(3001);
    expect(resolvePort({ PORT: '-1' })).toBe(3001);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/lib/listenConfig.test.js`
Expected: FAIL — `Failed to load .../listenConfig.js` (the module does not exist).

- [ ] **Step 3: Write the implementation**

Create `server/lib/listenConfig.js`:

```js
/**
 * Where the Express server binds.
 *
 * Prism has no application auth: the tailnet is the security perimeter
 * (docs/adr/0003). That only holds if the process listens on loopback, so
 * `tailscale serve` is the single route in. Widening it is a deliberate act
 * via HOST, never the default.
 */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3001;

export function resolveHost(env = process.env) {
  const host = String(env.HOST ?? '').trim();
  return host || DEFAULT_HOST;
}

// `Number('')` is 0, which is a *valid* port — so an unset PORT has to be
// caught as an empty string before it reaches the range check, or every
// default boot would bind an ephemeral port.
export function resolvePort(env = process.env) {
  const raw = String(env.PORT ?? '').trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  const valid = Number.isInteger(port) && port >= 0 && port <= 65535;
  return valid ? port : DEFAULT_PORT;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/lib/listenConfig.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into the server**

In `server/index.js`, add to the import block (after line 23):

```js
import { resolveHost, resolvePort } from './lib/listenConfig.js';
```

Replace line 26:

```js
const PORT = process.env.PORT || 3001;
```

with:

```js
const PORT = resolvePort();
const HOST = resolveHost();
```

Replace lines 80-82:

```js
app.listen(PORT, () => {
  console.log(`Prism server running on http://localhost:${PORT}`);
});
```

with:

```js
app.listen(PORT, HOST, () => {
  console.log(`Prism server running on http://${HOST}:${PORT}`);
});
```

- [ ] **Step 6: Document the override**

In `.env.example`, under `# Optional overrides`, after the `# PORT=3001` line, add:

```
# Interface the API server binds to. Default 127.0.0.1 — loopback only, because
# the app has no auth and the tailnet is the perimeter (`tailscale serve`
# proxies to loopback). Set 0.0.0.0 only to expose a dev server to your LAN on
# purpose.
# HOST=127.0.0.1
```

- [ ] **Step 7: Verify the server still boots and serves**

Run: `PORT=3099 node server/index.js` in one shell; in another, `curl -s localhost:3099/api/features`.
Expected: the log line reads `Prism server running on http://127.0.0.1:3099`, and curl returns the feature-flag JSON. Stop the server.

Then confirm the bind is real: `curl -s --max-time 2 http://$(ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1):3099/api/features`
Expected on a machine with a LAN address: connection refused. (If `ipconfig getifaddr en0` is empty the check is vacuous — skip it, the unit test covers the logic.)

- [ ] **Step 8: Run the full server suite**

Run: `npx vitest run`
Expected: all green, no regressions.

- [ ] **Step 9: Commit**

```bash
git add server/lib/listenConfig.js server/lib/listenConfig.test.js server/index.js .env.example
git commit -m "feat: bind loopback by default, HOST to override

The app has no auth; ADR 0003 makes the tailnet the perimeter, which only
holds if Express is not listening on every interface."
```

---

### Task 2: Session path comes from the environment, in every service that opens a browser

The spec names `masterySync.js:31`. It is one of **five** services that build the path from `process.cwd()`:

```
server/services/masterySync.js:31-32
server/services/psAttendanceSync.js:46-47
server/services/archivedCourses.js:20
server/services/graderSubmissions.js:26
server/services/peopleSearch.js:23-24
```

All five must change together. On the server `process.cwd()` is the deployed release directory, so a session saved under it is swapped away by the next deploy — and four of the five would keep failing silently after the fifth was fixed.

Probe scripts under `scripts/` keep their `process.cwd()` form: they are dev tools, run from a dev clone's root by design (AGENTS.md).

**Files:**
- Create: `server/lib/sessionPaths.js`
- Test: `server/lib/sessionPaths.test.js`
- Modify: `server/services/masterySync.js`, `server/services/psAttendanceSync.js`, `server/services/archivedCourses.js`, `server/services/graderSubmissions.js`, `server/services/peopleSearch.js`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `sessionDir(env?: object) => string`, `sessionStateFile(env?: object) => string`, `ensureSessionDir(env?: object) => string`, `SESSION_DIR_NAME = '.playwright-session'`, `STATE_FILE_NAME = 'storage-state.json'`.

- [ ] **Step 1: Write the failing test**

Create `server/lib/sessionPaths.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sessionDir,
  sessionStateFile,
  ensureSessionDir,
  SESSION_DIR_NAME,
  STATE_FILE_NAME,
} from './sessionPaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'prism-session-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('sessionDir', () => {
  it('defaults to .playwright-session under the working directory', () => {
    expect(sessionDir({})).toBe(join(process.cwd(), SESSION_DIR_NAME));
  });

  it('treats an empty or whitespace override as unset', () => {
    expect(sessionDir({ PRISM_SESSION_DIR: '' })).toBe(join(process.cwd(), SESSION_DIR_NAME));
    expect(sessionDir({ PRISM_SESSION_DIR: '  ' })).toBe(join(process.cwd(), SESSION_DIR_NAME));
  });

  it('uses PRISM_SESSION_DIR verbatim when set, so a release swap cannot move it', () => {
    expect(sessionDir({ PRISM_SESSION_DIR: '/Users/gnolan/prism/data/.playwright-session' }))
      .toBe('/Users/gnolan/prism/data/.playwright-session');
  });
});

describe('sessionStateFile', () => {
  it('is storage-state.json inside the session directory', () => {
    expect(sessionStateFile({ PRISM_SESSION_DIR: '/tmp/sess' })).toBe(join('/tmp/sess', STATE_FILE_NAME));
    expect(STATE_FILE_NAME).toBe('storage-state.json');
  });
});

// Review Focus 4: on the server the first mastery:login runs against an empty
// ~/prism/data/ — the whole path has to be created, not just the leaf.
describe('ensureSessionDir', () => {
  it('creates the directory including missing parents', () => {
    const nested = join(tmp, 'data', 'nested', '.playwright-session');
    expect(existsSync(nested)).toBe(false);
    expect(ensureSessionDir({ PRISM_SESSION_DIR: nested })).toBe(nested);
    expect(existsSync(nested)).toBe(true);
  });

  it('is a no-op when the directory already exists', () => {
    const dir = join(tmp, '.playwright-session');
    ensureSessionDir({ PRISM_SESSION_DIR: dir });
    expect(() => ensureSessionDir({ PRISM_SESSION_DIR: dir })).not.toThrow();
    expect(existsSync(dir)).toBe(true);
  });
});

// A sixth service that hardcodes the path would break on the server in exactly
// the way this task exists to fix, and would do it silently.
describe('no service hardcodes the session directory', () => {
  it('every server/services/*.js goes through sessionPaths', () => {
    const dir = join(__dirname, '..', 'services');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes(SESSION_DIR_NAME));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/lib/sessionPaths.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `server/lib/sessionPaths.js`:

```js
/**
 * Where the saved Schoology / PowerSchool browser session lives.
 *
 * Resolved per call rather than at module load, and overridable by
 * PRISM_SESSION_DIR. On the server the session must sit in ~/prism/data/,
 * outside the deployed release — a session inside a release is swapped away by
 * the next deploy, and mastery sync then fails until someone re-logs in
 * (docs/adr/0003, and the hosting design's release layout).
 */
import { mkdirSync } from 'fs';
import { join } from 'path';

export const SESSION_DIR_NAME = '.playwright-session';
export const STATE_FILE_NAME = 'storage-state.json';

export function sessionDir(env = process.env) {
  const dir = String(env.PRISM_SESSION_DIR ?? '').trim();
  return dir || join(process.cwd(), SESSION_DIR_NAME);
}

export function sessionStateFile(env = process.env) {
  return join(sessionDir(env), STATE_FILE_NAME);
}

/** Session directory, created if absent (parents included). Returns the path. */
export function ensureSessionDir(env = process.env) {
  const dir = sessionDir(env);
  mkdirSync(dir, { recursive: true });
  return dir;
}
```

- [ ] **Step 4: Run the test to verify the unit tests pass and the guard test fails**

Run: `npx vitest run server/lib/sessionPaths.test.js`
Expected: the `sessionDir` / `sessionStateFile` / `ensureSessionDir` tests PASS; the "no service hardcodes" test FAILS, listing the five service filenames. That failure is the to-do list for the next step.

- [ ] **Step 5: Convert the five services**

In each of `masterySync.js`, `psAttendanceSync.js`, `archivedCourses.js`, `graderSubmissions.js`, `peopleSearch.js`:

1. Delete the module-level `const SESSION_DIR = ...` and `const STATE_FILE = ...` lines.
2. Add the import (next to the file's other `server/lib` imports; from `server/services/` the path is `../lib/sessionPaths.js`):

```js
import { sessionDir, sessionStateFile, ensureSessionDir } from '../lib/sessionPaths.js';
```

Import only the names the file actually uses — most use `STATE_FILE` alone and so need `sessionStateFile` only.

3. Replace every remaining use of the identifier `STATE_FILE` with the call `sessionStateFile()`, and every use of `SESSION_DIR` with `sessionDir()`.
4. In `masterySync.js` the pair at line 77 —

```js
if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
```

— becomes:

```js
ensureSessionDir();
```

and `writeFileSync` on the next lines takes `sessionStateFile()`. Drop `mkdirSync` from that file's `node:fs` import if nothing else uses it; leave `existsSync` (it is used elsewhere in the file).

Find every site with:

```bash
grep -n "STATE_FILE\|SESSION_DIR" server/services/*.js
```

Expected after the edits: no matches outside the new import lines.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run server/lib/sessionPaths.test.js`
Expected: PASS, all 7 tests including the guard.

Run: `npx vitest run`
Expected: full server suite green.

- [ ] **Step 7: Document the override**

In `.env.example`, in the `# Optional overrides` block, add:

```
# Where the saved Schoology/PowerSchool browser session lives. Defaults to
# .playwright-session in the working directory. On a deployed server point it
# at the data directory, outside the release, or every deploy discards the
# session and mastery sync breaks until someone re-runs `npm run mastery:login`.
# PRISM_SESSION_DIR=/Users/you/prism/data/.playwright-session
```

- [ ] **Step 8: Commit**

```bash
git add server/lib/sessionPaths.js server/lib/sessionPaths.test.js server/services/ .env.example
git commit -m "feat: resolve the browser-session path from PRISM_SESSION_DIR

Five services built it from process.cwd(), which on a deployed server is the
release directory — so the session would be swapped away by every deploy. A
guard test fails if a sixth service ever hardcodes it again."
```

---

### Task 3: Restore never leaves a foreign WAL behind (#130)

`scripts/db-restore.js:52` copies a snapshot over `students.db` while `students.db-wal` and `students.db-shm` may still sit beside it. SQLite then replays a WAL belonging to a *different* database over the restored file. The mtime guard does not cover this — a stale older local DB passes the guard and keeps its sidecars.

Two bugs, same root cause (file-copying a WAL-mode database), fixed together: the safety copy at line 48 uses `copyFileSync` too, so it silently drops anything still in the WAL. A safety copy that loses the data it exists to protect is worse than none, and it sits three lines from the fix.

The script becomes a module + CLI, mirroring `scripts/db-backup.js`, so the logic is testable.

**Files:**
- Modify (rewrite): `scripts/db-restore.js`
- Test: `scripts/db-restore.test.js`

**Interfaces:**
- Consumes: `listSnapshots(dir)`, `snapshotName(date)` from `scripts/db-backup.js` (already exported).
- Produces: `removeSidecars(dbPath) => string[]`, `safetyCopy(dbPath, dest) => Promise<string>`, `restore({ dbPath, srcDir, force?, now? }) => Promise<{ snapshot, src, dbPath, safety, removedSidecars }>`, `SIDECAR_SUFFIXES = ['-wal', '-shm']`.

- [ ] **Step 1: Write the failing test**

Create `scripts/db-restore.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  copyFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { removeSidecars, safetyCopy, restore, SIDECAR_SUFFIXES } from './db-restore.js';

let dir, dbPath, snapDir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prism-restore-'));
  dbPath = join(dir, 'students.db');
  snapDir = join(dir, 'snapshots');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A WAL-mode database with `rows` inserted. Returns the OPEN connection. */
function makeDb(path, rows) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
  const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
  for (const row of rows) insert.run(row);
  return db;
}

function readRows(path) {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare('SELECT v FROM t ORDER BY v').all().map((r) => r.v);
  } finally {
    db.close();
  }
}

function writeSnapshot(name, rows) {
  mkdirSync(snapDir, { recursive: true });
  const path = join(snapDir, name);
  const db = makeDb(path, rows);
  db.close();
  return path;
}

/**
 * A database with genuine uncheckpointed -wal/-shm sidecars beside it and NO
 * open handle — the state left by an unclean shutdown, or by a live trio
 * copied between machines, which is the case #130 is about. SQLite truncates
 * the WAL when the last connection closes, so the only way to produce it is to
 * copy the trio out from under a live connection.
 */
function makeTrio(path, rows) {
  const source = join(dir, 'source.db');
  const db = makeDb(source, rows);
  copyFileSync(source, path);
  for (const suffix of ['-wal', '-shm']) copyFileSync(`${source}${suffix}`, `${path}${suffix}`);
  db.close();
  return path;
}

describe('removeSidecars', () => {
  it('deletes the WAL and SHM beside the database and reports what it removed', () => {
    writeFileSync(dbPath, 'db');
    writeFileSync(`${dbPath}-wal`, 'wal');
    writeFileSync(`${dbPath}-shm`, 'shm');

    expect(removeSidecars(dbPath).sort()).toEqual([`${dbPath}-shm`, `${dbPath}-wal`]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
    expect(SIDECAR_SUFFIXES).toEqual(['-wal', '-shm']);
  });

  // Review Focus 3: a fresh clone has neither database nor sidecars.
  it('is a no-op when nothing is there', () => {
    expect(removeSidecars(dbPath)).toEqual([]);
  });
});

describe('safetyCopy', () => {
  it('captures rows that exist only in the WAL', async () => {
    makeTrio(dbPath, ['a', 'b']);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const dest = join(dir, 'safety.db');
    await safetyCopy(dbPath, dest);

    expect(readRows(dest)).toEqual(['a', 'b']);
  });
});

describe('restore', () => {
  it('replaces the database with the newest snapshot', async () => {
    writeSnapshot('students-20260101T000000Z.db', ['old']);
    writeSnapshot('students-20260301T000000Z.db', ['new']);
    const live = makeDb(dbPath, ['local']);
    live.close();

    const result = await restore({ dbPath, srcDir: snapDir, force: true });

    expect(result.snapshot).toBe('students-20260301T000000Z.db');
    expect(readRows(dbPath)).toEqual(['new']);
  });

  // The #130 bug: the snapshot landed on the main file while the old WAL stayed
  // beside it, and SQLite would replay that foreign WAL over the restored data.
  it('leaves no foreign WAL beside the restored database', async () => {
    writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);
    makeTrio(dbPath, ['local-row']);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const result = await restore({ dbPath, srcDir: snapDir, force: true });

    expect(result.removedSidecars).toHaveLength(2);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(readRows(dbPath)).toEqual(['snapshot-row']);
  });

  it('writes a safety copy that includes uncheckpointed local work', async () => {
    writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);
    makeTrio(dbPath, ['only-in-wal']);

    const result = await restore({ dbPath, srcDir: snapDir, force: true });

    expect(result.safety).toMatch(/\.before-restore-/);
    expect(readRows(result.safety)).toEqual(['only-in-wal']);
  });

  it('refuses when the local database is newer than the snapshot', async () => {
    const snap = writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);
    const live = makeDb(dbPath, ['local-row']);
    live.close();
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(snap, old, old);

    await expect(restore({ dbPath, srcDir: snapDir })).rejects.toThrow(/Refusing to restore/);
    expect(readRows(dbPath)).toEqual(['local-row']);
  });

  it('proceeds past the guard when forced', async () => {
    const snap = writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);
    const live = makeDb(dbPath, ['local-row']);
    live.close();
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(snap, old, old);

    await restore({ dbPath, srcDir: snapDir, force: true });
    expect(readRows(dbPath)).toEqual(['snapshot-row']);
  });

  // Review Focus 3 again, end to end: a clone that has never synced.
  it('restores onto a machine with no database yet', async () => {
    writeSnapshot('students-20260301T000000Z.db', ['snapshot-row']);

    const result = await restore({ dbPath, srcDir: snapDir });

    expect(result.safety).toBe(null);
    expect(readRows(dbPath)).toEqual(['snapshot-row']);
  });

  it('explains itself when there is nowhere to restore from', async () => {
    await expect(restore({ dbPath, srcDir: '' })).rejects.toThrow(/PRISM_BACKUP_DIR/);
    await expect(restore({ dbPath, srcDir: snapDir })).rejects.toThrow(/npm run db:backup/);
  });
});
```

Replace the `require('node:fs').mkdirSync` line in `writeSnapshot` with a proper ESM import — add `mkdirSync` to the `node:fs` import list at the top and call it directly. (`require` is not available in this ESM project; it is written out here only to show where the directory gets created.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/db-restore.test.js`
Expected: FAIL — `db-restore.js` exports nothing, so the imports are undefined.

- [ ] **Step 3: Rewrite the script as a module plus CLI**

Replace the whole of `scripts/db-restore.js` with:

```js
#!/usr/bin/env node
/**
 * Restore the newest snapshot from PRISM_BACKUP_DIR over the local database.
 *
 * Two WAL hazards this handles, both of which are silent (#130):
 *
 * 1. The database being replaced may have -wal/-shm sidecars. Copying a
 *    snapshot over the main file alone leaves them in place, and SQLite will
 *    replay a WAL belonging to a *different* database over the restored file.
 *    The documented outcome is corruption. The mtime guard does not cover it:
 *    a stale older local DB passes the guard and keeps its foreign WAL.
 * 2. The safety copy has to be taken with SQLite's backup API. `copyFileSync`
 *    captures the main file only, dropping whatever is still in the WAL — a
 *    safety copy that loses the work it exists to protect.
 *
 * The mtime guard stays on `db:restore` (a genuine two-machine handoff) and is
 * skipped by `db:refresh`, where the local database is disposable by design.
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listSnapshots, snapshotName } from './db-backup.js';

export const SIDECAR_SUFFIXES = ['-wal', '-shm'];

/** Delete the WAL/SHM sidecars beside `dbPath`. Returns the paths removed. */
export function removeSidecars(dbPath) {
  const removed = [];
  for (const suffix of SIDECAR_SUFFIXES) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) {
      rmSync(path);
      removed.push(path);
    }
  }
  return removed;
}

/** Consistent copy of a live WAL-mode database, via SQLite's backup API. */
export async function safetyCopy(dbPath, dest) {
  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  return dest;
}

export async function restore({ dbPath, srcDir, force = false, now = new Date() }) {
  if (!srcDir) throw new Error('Set PRISM_BACKUP_DIR in .env first.');

  const [newest] = listSnapshots(srcDir);
  if (!newest) throw new Error(`No snapshots found in ${srcDir}. Run: npm run db:backup`);
  const src = join(srcDir, newest);

  if (existsSync(dbPath) && !force) {
    const localMtime = statSync(dbPath).mtime;
    const snapMtime = statSync(src).mtime;
    if (localMtime > snapMtime) {
      throw new Error(
        `Refusing to restore: local DB (${localMtime.toISOString()}) is newer than\n` +
          `the snapshot (${snapMtime.toISOString()}).\n` +
          `Back up this machine first (npm run db:backup), or re-run with --force.\n` +
          `On a dev clone whose data is disposable, use: npm run db:refresh`,
      );
    }
  }

  // Order matters. The safety copy is taken while the old WAL is still intact,
  // so it captures everything; only then do the sidecars go; only then does the
  // snapshot land, onto a file with no foreign WAL beside it.
  let safety = null;
  if (existsSync(dbPath)) {
    safety = `${dbPath}.before-restore-${snapshotName(now).replace(/^students-|\.db$/g, '')}`;
    await safetyCopy(dbPath, safety);
  }

  const removedSidecars = removeSidecars(dbPath);
  copyFileSync(src, dbPath);

  return { snapshot: newest, src, dbPath, safety, removedSidecars };
}

// ---- CLI ----
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { config } = await import('dotenv');
  config();

  const dbPath = process.env.DB_PATH || 'server/db/students.db';
  const srcDir = process.env.PRISM_BACKUP_DIR;
  const force = process.argv.includes('--force');

  try {
    const result = await restore({ dbPath, srcDir, force });
    if (result.safety) console.log(`Safety copy of current DB: ${result.safety}`);
    for (const path of result.removedSidecars) console.log(`Removed stale sidecar: ${path}`);
    console.log(`Restored ${result.snapshot} -> ${result.dbPath}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/db-restore.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the full server suite**

Run: `npx vitest run`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add scripts/db-restore.js scripts/db-restore.test.js
git commit -m "fix(#130): db-restore left a foreign WAL beside the restored database

Copying a snapshot over students.db while its -wal/-shm sidecars remained let
SQLite replay a WAL from a different database over the restored file. The
safety copy had the same bug in reverse — copyFileSync dropped whatever was
still in the WAL, so it silently lost the work it existed to protect."
```

---

### Task 4: `db:refresh` for disposable clones, and a CI-skippable postinstall

`db:restore`'s mtime guard is correct for a two-machine handoff and wrong for a dev clone pulling last night's snapshot — where it fires every time. And `postinstall` unconditionally downloads ~150MB of chromium, which CI does not need (every external service is mocked there) and cannot skip with `--ignore-scripts`, because `better-sqlite3` needs its install script for the native binary.

**Files:**
- Create: `scripts/postinstall.js`
- Test: `scripts/postinstall.test.js`
- Modify: `package.json` (`scripts.postinstall`, new `scripts.db:refresh`)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `restore(...)` from Task 3 via the `db-restore.js` CLI (`--force`).
- Produces: `shouldInstallBrowsers(env?: object) => boolean`.

- [ ] **Step 1: Write the failing test**

Create `scripts/postinstall.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { shouldInstallBrowsers } from './postinstall.js';

describe('shouldInstallBrowsers', () => {
  it('installs by default — a fresh clone needs chromium for mastery sync', () => {
    expect(shouldInstallBrowsers({})).toBe(true);
  });

  it('skips when PRISM_SKIP_BROWSERS is set to something meant as true', () => {
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: '1' })).toBe(false);
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: 'true' })).toBe(false);
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: 'yes' })).toBe(false);
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: ' TRUE ' })).toBe(false);
  });

  it('still installs when the variable is present but means false', () => {
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: '' })).toBe(true);
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: '0' })).toBe(true);
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: 'false' })).toBe(true);
    expect(shouldInstallBrowsers({ PRISM_SKIP_BROWSERS: 'no' })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/postinstall.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `scripts/postinstall.js`:

```js
#!/usr/bin/env node
/**
 * Install the chromium build the browser-session services need.
 *
 * CI does not need it: every external service is mocked there, and the
 * download is ~150MB per run. `npm ci --ignore-scripts` is not the way out —
 * better-sqlite3 needs its own install script to produce the native binary —
 * so the opt-out is PRISM_SKIP_BROWSERS, read here.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MEANS_FALSE = new Set(['', '0', 'false', 'no']);

export function shouldInstallBrowsers(env = process.env) {
  const raw = env.PRISM_SKIP_BROWSERS;
  if (raw === undefined || raw === null) return true;
  return MEANS_FALSE.has(String(raw).trim().toLowerCase());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!shouldInstallBrowsers()) {
    console.log('PRISM_SKIP_BROWSERS set — skipping `playwright install chromium`.');
    process.exit(0);
  }
  const result = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/postinstall.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire up the npm scripts**

In `package.json`, replace line 18:

```json
    "postinstall": "npx playwright install chromium",
```

with:

```json
    "postinstall": "node scripts/postinstall.js",
```

and add a `db:refresh` line immediately after `db:restore` (line 17):

```json
    "db:refresh": "node scripts/db-restore.js --force",
```

- [ ] **Step 6: Verify both paths by hand**

Run: `PRISM_SKIP_BROWSERS=1 node scripts/postinstall.js`
Expected: prints the skip line, exits 0, downloads nothing.

Run: `node scripts/postinstall.js`
Expected: playwright reports chromium already installed (it is, from the existing setup) and exits 0.

- [ ] **Step 7: Document the variable**

In `.env.example`, in the `# Optional overrides` block, add:

```
# Set in CI (and anywhere the browser-session features are unused) to skip the
# ~150MB chromium download in postinstall. Every external service is mocked in
# the test suite, so CI never launches a browser.
# PRISM_SKIP_BROWSERS=1
```

- [ ] **Step 8: Run the full server suite**

Run: `npx vitest run`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add scripts/postinstall.js scripts/postinstall.test.js package.json .env.example
git commit -m "feat: db:refresh for disposable clones, PRISM_SKIP_BROWSERS for CI

db:restore's mtime guard is right for a two-machine handoff and wrong for a
dev clone pulling last night's snapshot, where it fires every time. postinstall
downloaded chromium unconditionally, which CI never launches."
```

---

### Task 5: `GET /api/version` and a sidebar badge

"Is my push live?" should not be answered by squinting at behaviour. It matters most in the design's mode 3 — a local Vite client proxying `/api` to the server — where the badge names the *backend* you are really talking to, not the page you loaded.

A deploy writes `release.json` at the release root; nothing else creates it. A clone without one is a dev clone and says `dev`.

**Files:**
- Create: `server/lib/version.js`, `server/lib/version.test.js`
- Create: `client/src/components/VersionBadge.jsx`, `client/src/components/VersionBadge.test.jsx`
- Modify: `server/index.js` (import + route), `server/index.test.js` (handler + test)
- Modify: `client/src/services/api.js`, `client/src/App.jsx`, `client/src/app.css`
- Modify: `docs/design-language.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveVersion({ env?, releaseFile?, read? }) => { sha: string|null, builtAt: string|null, mode: 'release'|'dev' }`, `RELEASE_FILE` (absolute path), `DEV_VERSION`; client `getVersion() => Promise<version>`; component `<VersionBadge />`.

- [ ] **Step 1: Write the failing server test**

Create `server/lib/version.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { resolveVersion, DEV_VERSION } from './version.js';

const reads = (contents) => () => {
  if (contents === null) throw new Error('ENOENT');
  return contents;
};

describe('resolveVersion', () => {
  it('reports a dev clone when there is no release marker and no env', () => {
    expect(resolveVersion({ env: {}, read: reads(null) })).toEqual({
      sha: null,
      builtAt: null,
      mode: 'dev',
    });
    expect(DEV_VERSION.mode).toBe('dev');
  });

  it('prefers the environment, which is how the deploy stamps a running process', () => {
    expect(
      resolveVersion({
        env: { PRISM_GIT_SHA: '1e96c01', PRISM_BUILT_AT: '2026-09-23T01:06:43Z' },
        read: reads('{"sha":"deadbee","builtAt":"2020-01-01T00:00:00Z"}'),
      }),
    ).toEqual({ sha: '1e96c01', builtAt: '2026-09-23T01:06:43Z', mode: 'release' });
  });

  it('falls back to release.json', () => {
    expect(
      resolveVersion({
        env: {},
        read: reads('{"sha":"1e96c01","builtAt":"2026-09-23T01:06:43Z"}'),
      }),
    ).toEqual({ sha: '1e96c01', builtAt: '2026-09-23T01:06:43Z', mode: 'release' });
  });

  it('treats a release with no builtAt as a release with no build time', () => {
    expect(resolveVersion({ env: {}, read: reads('{"sha":"1e96c01"}') })).toEqual({
      sha: '1e96c01',
      builtAt: null,
      mode: 'release',
    });
  });

  // Review Focus 2: release.json is written during a deploy swap, which is
  // exactly when someone is refreshing to see whether the deploy landed.
  it('reports dev rather than throwing on a half-written or junk release.json', () => {
    expect(resolveVersion({ env: {}, read: reads('{"sha":"1e9') })).toEqual(DEV_VERSION);
    expect(resolveVersion({ env: {}, read: reads('') })).toEqual(DEV_VERSION);
    expect(resolveVersion({ env: {}, read: reads('{}') })).toEqual(DEV_VERSION);
    expect(resolveVersion({ env: {}, read: reads('{"sha":123}') })).toEqual(DEV_VERSION);
    expect(resolveVersion({ env: {}, read: reads('null') })).toEqual(DEV_VERSION);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/lib/version.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the server implementation**

Create `server/lib/version.js`:

```js
/**
 * What is actually running.
 *
 * A deploy stamps the process (PRISM_GIT_SHA / PRISM_BUILT_AT) and writes
 * release.json at the release root; nothing else creates either. A checkout
 * with neither is a dev clone and says so — which is the useful answer when a
 * local client is proxying /api at the server, because the badge then names
 * the backend rather than the page.
 *
 * Never throws: release.json is written during a deploy swap, and a
 * half-written file must not take the endpoint down.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const RELEASE_FILE = join(__dirname, '..', '..', 'release.json');
export const DEV_VERSION = Object.freeze({ sha: null, builtAt: null, mode: 'dev' });

const str = (value) => (typeof value === 'string' ? value.trim() : '');

export function resolveVersion({ env = process.env, releaseFile = RELEASE_FILE, read = readFileSync } = {}) {
  const envSha = str(env.PRISM_GIT_SHA);
  if (envSha) {
    return { sha: envSha, builtAt: str(env.PRISM_BUILT_AT) || null, mode: 'release' };
  }

  try {
    const parsed = JSON.parse(read(releaseFile, 'utf8'));
    const sha = str(parsed?.sha);
    if (!sha) return { ...DEV_VERSION };
    return { sha, builtAt: str(parsed?.builtAt) || null, mode: 'release' };
  } catch {
    return { ...DEV_VERSION };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/lib/version.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the route and its test**

In `server/index.js`, add to the imports (after line 23):

```js
import { resolveVersion } from './lib/version.js';
```

and add the route after the `/api/features` handler (after line 55):

```js
// What build is answering — the deployed SHA and build time, or dev.
app.get('/api/version', (req, res) => {
  res.json(resolveVersion());
});
```

In `server/index.test.js`, add the import:

```js
import { resolveVersion } from './lib/version.js';
```

add the handler inside `buildApp()` (after the `/api/features` handler):

```js
  app.get('/api/version', (req, res) => {
    res.json(resolveVersion());
  });
```

and append the test:

```js
describe('GET /api/version', () => {
  test('returns 200 with sha, builtAt and mode', async () => {
    const res = await get('/api/version');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['builtAt', 'mode', 'sha']);
    expect(['release', 'dev']).toContain(res.body.mode);
  });
});
```

Run: `npx vitest run server/index.test.js`
Expected: PASS.

- [ ] **Step 6: Write the failing client test**

Create `client/src/components/VersionBadge.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import VersionBadge from './VersionBadge.jsx';
import { getVersion } from '../services/api.js';

vi.mock('../services/api.js', () => ({ getVersion: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('VersionBadge', () => {
  it('shows the short sha of a deployed release', async () => {
    getVersion.mockResolvedValue({
      sha: '1e96c01abcdef',
      builtAt: '2026-09-23T01:06:43Z',
      mode: 'release',
    });

    render(<VersionBadge />);

    expect(await screen.findByText('1e96c01')).toBeInTheDocument();
  });

  it('formats the build date the way the user reads dates (en-GB)', async () => {
    getVersion.mockResolvedValue({
      sha: '1e96c01',
      builtAt: '2026-09-23T01:06:43Z',
      mode: 'release',
    });

    render(<VersionBadge />);

    // Computed rather than hardcoded so the test does not depend on the
    // runner's timezone — but still pins DD/MM/YYYY: an en-US component would
    // render 9/23/2026, which does not contain this string.
    const expected = new Date('2026-09-23T01:06:43Z').toLocaleDateString('en-GB');
    const badge = await screen.findByText('1e96c01');
    expect(badge).toHaveAttribute('title', expect.stringContaining(expected));
  });

  it('says dev on a clone with no release deployed', async () => {
    getVersion.mockResolvedValue({ sha: null, builtAt: null, mode: 'dev' });

    render(<VersionBadge />);

    expect(await screen.findByText('dev')).toBeInTheDocument();
  });

  it('renders nothing when the server cannot be reached', async () => {
    getVersion.mockRejectedValue(new Error('Failed to fetch'));

    const { container } = render(<VersionBadge />);

    await waitFor(() => expect(getVersion).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
```

Run: `cd client && npx vitest run src/components/VersionBadge.test.jsx`
Expected: FAIL — component does not exist.

- [ ] **Step 7: Write the client implementation**

Create `client/src/components/VersionBadge.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { getVersion } from '../services/api.js';

/**
 * Which build is answering /api — small and quiet, at the foot of the sidebar.
 * It names the backend, not the page: when a local client proxies /api at the
 * server, this is what tells you which one you are actually looking at.
 */
export default function VersionBadge() {
  const [version, setVersion] = useState(null);

  useEffect(() => {
    let live = true;
    getVersion()
      .then((v) => live && setVersion(v))
      .catch(() => live && setVersion(null));
    return () => {
      live = false;
    };
  }, []);

  if (!version) return null;

  const label = version.mode === 'release' && version.sha ? version.sha.slice(0, 7) : 'dev';
  const built = version.builtAt ? new Date(version.builtAt) : null;
  const title =
    built && !Number.isNaN(built.getTime())
      ? `Built ${built.toLocaleDateString('en-GB')} ${built.toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
        })}`
      : 'Development clone — no release deployed';

  return (
    <div className="version-badge" title={title}>
      {label}
    </div>
  );
}
```

In `client/src/services/api.js`, beside the existing `getFeatures` export (line 103):

```js
export const getVersion = () => request('/version');
```

In `client/src/App.jsx`, add the import after line 15:

```js
import VersionBadge from './components/VersionBadge.jsx';
```

and render it as the last child of the sidebar, after the closing `</div>` of `theme-switcher` (line 53):

```jsx
          <VersionBadge />
```

In `client/src/app.css`, append:

```css
.version-badge {
  margin-top: 0.75rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.7rem;
  letter-spacing: 0.02em;
  color: var(--sidebar-text);
  opacity: 0.55;
  cursor: default;
  transition: opacity 0.15s ease;
}

.version-badge:hover {
  opacity: 0.9;
}
```

- [ ] **Step 8: Run the client tests**

Run: `cd client && npx vitest run src/components/VersionBadge.test.jsx`
Expected: PASS, 4 tests.

Run: `cd client && npx vitest run`
Expected: full client suite green.

- [ ] **Step 9: Log the UI decision**

AGENTS.md requires every notable UI decision to land in `docs/design-language.md`. Append:

```markdown
## Version badge — the sidebar names the backend (September 2026)

- **The badge reports what `/api` answered, not what the page was built from.**
  A short SHA means a deployed release; `dev` means a clone with no
  `release.json`. This is deliberate: when a local Vite client proxies `/api`
  at the server, the only question worth answering is which backend is
  serving the data, and a build-time constant baked into the bundle would
  answer the wrong one.
- **Quiet by default, legible on hover** — `opacity: 0.55` rising to `0.9`,
  monospace, 0.7rem, `var(--sidebar-text)`. It is reference information, not
  navigation, and should never compete with the nav links above it.
- **It renders nothing when the request fails.** A server that cannot be
  reached already shows itself everywhere else in the UI; an error chip in
  the sidebar would be noise on top of noise.
- **The build time is a `title`, in `en-GB`** — `Built 23/09/2026 09:06`.
```

- [ ] **Step 10: Run both suites**

Run: `npx vitest run && (cd client && npx vitest run)`
Expected: both green.

- [ ] **Step 11: Commit**

```bash
git add server/lib/version.js server/lib/version.test.js server/index.js server/index.test.js \
        client/src/components/VersionBadge.jsx client/src/components/VersionBadge.test.jsx \
        client/src/services/api.js client/src/App.jsx client/src/app.css docs/design-language.md
git commit -m "feat: GET /api/version and a sidebar badge naming the live build

Reads a deploy-written release.json (or PRISM_GIT_SHA), falls back to dev, and
never throws on a half-written marker. The badge names the backend, which is
the question worth answering when a local client proxies /api at a server."
```

---

### Task 6: PrisMCP refuses to start without an explicit `DB_PATH`

PrisMCP writes student data straight into SQLite and loads no dotenv, so `DB_PATH` resolves to whatever sits beside the code. Launched from a dev clone it opens the **disposable** database, `write_student_suggestions` reports success, and the next `db:refresh` erases the work. It is the worst failure mode in the design, and it is entirely silent — so it gets a guard rather than a convention.

The committed `.mcp.json` becomes explicit about the path it has always used, rather than relying on the default it is now refusing.

**Files:**
- Create: `mcp/dbGuard.js`, `mcp/dbGuard.test.js`, `mcp/serverImport.test.js`
- Modify: `mcp/server.js` (the `main()` entry only)
- Modify: `.mcp.json`
- Modify: `docs/prismcp-install-and-verify.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `assertExplicitDbPath(env?: object) => string` (returns the path, throws otherwise).

- [ ] **Step 1: Write the failing test**

Create `mcp/dbGuard.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { assertExplicitDbPath } from './dbGuard.js';

describe('assertExplicitDbPath', () => {
  it('returns the path when one was declared', () => {
    expect(assertExplicitDbPath({ DB_PATH: '/Users/gnolan/prism/data/students.db' }))
      .toBe('/Users/gnolan/prism/data/students.db');
  });

  // Review Focus 5: every MCP test seeds an in-memory database.
  it('accepts :memory:', () => {
    expect(assertExplicitDbPath({ DB_PATH: ':memory:' })).toBe(':memory:');
  });

  it('refuses an unset, empty or whitespace DB_PATH', () => {
    expect(() => assertExplicitDbPath({})).toThrow(/explicit DB_PATH/);
    expect(() => assertExplicitDbPath({ DB_PATH: '' })).toThrow(/explicit DB_PATH/);
    expect(() => assertExplicitDbPath({ DB_PATH: '   ' })).toThrow(/explicit DB_PATH/);
  });

  it('tells the reader how to fix it', () => {
    expect(() => assertExplicitDbPath({})).toThrow(/DB_PATH=/);
  });
});
```

Create `mcp/serverImport.test.js`:

```js
import { describe, it, expect } from 'vitest';

// Review Focus 5: the guard belongs to the CLI entry, not module scope. If it
// ran at import, every MCP test file would fail before its first assertion.
describe('importing the MCP server', () => {
  it('does not run the DB_PATH guard', async () => {
    delete process.env.DB_PATH;
    const mod = await import('./server.js');
    expect(typeof mod.createServer).toBe('function');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run mcp/dbGuard.test.js`
Expected: FAIL — module not found. (`mcp/serverImport.test.js` passes already; it is a regression guard for step 3, so run it again after the edit.)

- [ ] **Step 3: Write the implementation**

Create `mcp/dbGuard.js`:

```js
/**
 * PrisMCP writes grading suggestions straight into SQLite and loads no dotenv,
 * so an unset DB_PATH resolves beside the code — on a dev clone, a throwaway
 * copy. Every write would then report success into a database nobody meant,
 * and the next `db:refresh` would erase it. Silent, and unrecoverable.
 *
 * So: declare the database or do not start.
 */
export function assertExplicitDbPath(env = process.env) {
  const dbPath = String(env.DB_PATH ?? '').trim();
  if (dbPath) return dbPath;

  throw new Error(
    'PrisMCP will not start without an explicit DB_PATH.\n' +
      'It writes grading suggestions straight into SQLite, and an unset DB_PATH\n' +
      'resolves to whatever database sits beside the code — on a dev clone that is\n' +
      'a disposable copy, and the writes would be lost at the next db:refresh.\n' +
      'Declare it in your MCP client config, e.g.\n' +
      '  DB_PATH=/Users/you/prism/data/students.db node mcp/server.js',
  );
}
```

In `mcp/server.js`, add to the imports (after the `./handlers.js` import):

```js
import { assertExplicitDbPath } from './dbGuard.js';
```

and make it the first statement of `main()`:

```js
async function main() {
  assertExplicitDbPath();
  connectDb();
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
```

Leave `createServer()` and `connectDb()` untouched — the guard is an entry-point concern, and putting it in either would break the test suite and `scripts/prismcp-e2e.mjs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run mcp/`
Expected: PASS — `dbGuard.test.js` (4), `serverImport.test.js` (1), and the existing `server.test.js` / `handlers.test.js` unaffected.

- [ ] **Step 5: Make the committed MCP config explicit**

Replace `.mcp.json` with:

```json
{
  "mcpServers": {
    "prism": {
      "type": "stdio",
      "command": "node",
      "args": ["mcp/server.js"],
      "env": {
        "DB_PATH": "server/db/students.db"
      }
    }
  }
}
```

This is the path it already used; it is now declared rather than inferred. A session running against a server's database overrides it in user-scoped config — never by editing this file, which is the correct default for a clone running beside its own database.

- [ ] **Step 6: Verify the guard end to end**

Run: `node mcp/server.js`
Expected: exits non-zero, printing `[prismcp] fatal:` and the guard message. Nothing opens a database.

Run: `DB_PATH=server/db/students.db node mcp/server.js`
Expected: starts and waits on stdio (no output). Stop it with Ctrl-C.

Run: `npm run mcp:e2e`
Expected: passes — it already sets `DB_PATH` explicitly to a throwaway temp database.

- [ ] **Step 7: Update the install doc**

In `docs/prismcp-install-and-verify.md`, add a section covering:

- PrisMCP now refuses to start without `DB_PATH`, and why (a silent write into a disposable clone's database is unrecoverable).
- The committed `.mcp.json` sets `DB_PATH=server/db/students.db`, which is correct for a clone running beside its own database.
- To grade against a server's database, configure it **user-scoped**, not by editing the committed file. Record the shape the hosting design settled on, marked as not yet operational:

```json
{
  "command": "ssh",
  "args": ["<host>", "cd ~/prism/current && DB_PATH=$HOME/prism/data/students.db node mcp/server.js"]
}
```

- Note that `npm run mcp` now fails by design unless `DB_PATH` is set in the environment.

- [ ] **Step 8: Run both suites**

Run: `npx vitest run && (cd client && npx vitest run)`
Expected: both green.

- [ ] **Step 9: Commit**

```bash
git add mcp/dbGuard.js mcp/dbGuard.test.js mcp/serverImport.test.js mcp/server.js \
        .mcp.json docs/prismcp-install-and-verify.md
git commit -m "feat: PrisMCP refuses to start without an explicit DB_PATH

Launched from a dev clone it opened the disposable database, reported every
write as a success, and lost the lot at the next db:refresh. The committed
.mcp.json now declares the path it always used."
```

---

### Task 7: Close out the branch

**Files:**
- Modify: `.claude/build-progress.md`
- Modify: `docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md` (status of items 1–6)

- [ ] **Step 1: Run everything**

Run: `npx vitest run && (cd client && npx vitest run) && npm run build`
Expected: server suite green, client suite green, client production build succeeds.

Record the three numbers (server tests, client tests, build result) — they go in the progress note.

- [ ] **Step 2: Note the work in build-progress**

Append a section to `.claude/build-progress.md` following the style of the existing entries: what shipped, the decisions that are not obvious from the diff (five services shared one hardcoded session path, not the one the spec named; the safety copy had the same WAL bug as the restore; the MCP guard is an entry-point concern so tests and the e2e script are untouched), the live verification performed, and the test counts.

- [ ] **Step 3: Mark the spec's prerequisite table**

In the spec's "Prerequisite code changes" table, mark rows 1–6 as done with the date, and note that row 2 covered five services rather than the one named. Leave rows 7–8 (CI workflow, deploy script and plists) as outstanding — they are Half 2.

- [ ] **Step 4: Commit and merge**

```bash
git add .claude/build-progress.md docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md
git commit -m "docs: record the hosting prerequisites as shipped"
git checkout main
git merge --ff-only feat/hosting-prereqs
git push -u origin main
```

- [ ] **Step 5: Close #130**

`gh issue close 130 --comment "..."` — the comment should name the two WAL bugs fixed (foreign WAL replay on restore; the safety copy silently dropping uncheckpointed rows) and the commit.
