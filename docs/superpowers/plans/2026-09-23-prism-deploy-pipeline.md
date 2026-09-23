# Prism deploy pipeline (Half 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and bring up the push-to-deploy pipeline on the Mac mini — CI gate, deploy poller, rollback, launchd agents, and a scripted cutover — stopping at the edge of cutover, so that making the mini the master is one command the owner runs when the laptop is quiet.

**Architecture:** GitHub Actions runs the test suite on every push to `main`. A launchd agent on the mini polls every 30s, deploys a CI-green commit into `~/prism/releases/<id>/`, swaps the `~/prism/current` symlink, restarts the server agent, and swaps back if the new release does not answer `/api/version` with its own sha. All deploy logic is Node (like the rest of the repo), split into pure decisions (`lib.js`), real side effects (`effects.js`), and orchestrators (`deploy.js`, `rollback.js`, `cutover.js`, `install.js`) that take their effects as arguments so tests can run them against a throwaway git repo.

**Tech Stack:** Node 25 ESM, Vitest, better-sqlite3, git, launchd (`launchctl bootstrap/kickstart/bootout`), GitHub Actions, `gh api`, `tailscale serve`.

**Spec:** `docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md` — Section 2 (deploy pipeline), Section 1 (service, network, cutover, backups), Section 4 (PrisMCP), prerequisite table rows 7–8, and its "Provisioning status" and "Open items" sections. Decision record: `docs/adr/0003-prism-served-from-a-home-server-over-tailscale.md`.

## Decisions taken before this plan (owner, 2026-09-23)

- **PrisMCP requires an absolute `DB_PATH`, and the committed `.mcp.json` no longer defines `prism`.** Verified in the Claude Code docs: project scope (`.mcp.json`) outranks user scope, so a committed entry would silently beat the user-scoped SSH route the spec prescribes for after cutover.
- **Build to the edge of cutover, plus a runbook.** Cutover needs the laptop (still master) to stop its writers and take a fresh `db:backup`; that is the owner's step.
- **Native execution** (executing-plans), one fresh whole-branch review at the end of Part A.

## Settled from facts on the mini (not re-litigated here)

| Open item | Resolution | Evidence |
|---|---|---|
| Prod root | `~/prism/` | Spec default; path free |
| `PRISM_BACKUP_DIR` on the mini | OneDrive `_prism-data` | OneDrive is signed in on the mini; `.env` already points there |
| Agent or daemon | **Agent** | FileVault is on (arm64). Nothing runs until someone types the password at startup, and that unlock logs them in — so an agent starts exactly as soon as a daemon could. Planned restarts: `sudo fdesetup authrestart`. |
| Node for plists | `/usr/local/bin/node` | It is a Homebrew symlink into `Cellar/node/25.9.0_2`; `process.execPath` resolves to the Cellar path, which the next `brew upgrade` deletes |

## Global Constraints

- ESM only; **no new dependencies**.
- CI pins **Node 25**; the mini runs v25.9.0 / npm 11.12.1.
- **Every path in a plist is absolute.** launchd does not expand `~`.
- Prod server binds **127.0.0.1:3001**. It is published to the tailnet **only** by `tailscale serve`, and only at cutover.
- **Tests must pass on `ubuntu-latest` as well as macOS.** Any test that needs a macOS tool (`plutil`, `launchctl`) uses `it.skipIf(process.platform !== 'darwin')`.
- **Tests and verification never touch `server/db/students.db`, `~/prism/data/`, or the real `_prism-data` folder.** Temp directories only. (Half 1's RED run executed a real restore through an import side effect; do not repeat it.)
- **Before cutover:** no `tailscale serve`, no backup agent loaded, no restore into `~/prism/data/`.
- Commit at the end of every task. Conventional prefixes. Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branch **`feat/deploy-pipeline`** off `main`. Part A is reviewed on the branch; Part B runs after it is merged and pushed.
- UI dates `en-GB` (none expected in this plan).

## Review Focus

1. **Scripts launched through `~/prism/current` must actually run.** Every CLI in the repo guards its entry with `import.meta.url === pathToFileURL(process.argv[1]).href`. Node resolves symlinks for the first and not the second, so through the `current` symlink the guard is false and the script exits 0 having done nothing — the deploy poller, the nightly backup and PrisMCP would all silently no-op. (Observed 2026-09-23; it even fails on `/var`, which is a symlink to `/private/var`.) → Task 1.
2. **After a manual rollback the poller must not redeploy what was just rolled back** — the rolled-back commit is CI-green, so a naive poller undoes the rollback within 30 seconds; and a *second* rollback must not unpin main. → Task 7.
3. **A deploy that crashed must not leave a lock that silently stops every later deploy.** → Task 4.
4. **The nightly backup must not run before cutover.** Prod's database is empty until then; an empty snapshot would become the newest file in `_prism-data` — exactly the one the laptop's `db:restore` picks. And anything in `~/Library/LaunchAgents` is loaded at the next login, so staging it there is enough to trigger it. → Task 10.
5. **Cutover must refuse a stale snapshot and a prod database that already holds data, and must not publish or back up a server that failed its health check after the restore.** The spec's own warning: restoring the Sep 22 snapshot would silently drop every change since, and `integrity_check` would still pass. → Task 9.

---

# Part A — on the branch

### Task 1: `isMain()` that survives symlinks

**Files:**
- Create: `server/lib/isMain.js`, `server/lib/isMain.test.js`
- Modify: `scripts/db-backup.js:68-70`, `scripts/db-restore.js:145-147`, `scripts/postinstall.js:11,21`, `mcp/server.js:1,254`

**Interfaces:**
- Produces: `isMain(metaUrl: string, argv1 = process.argv[1]) => boolean`

- [ ] **Step 1: Watch the bug live first**

```bash
ln -sfn "$(pwd)" /tmp/prism-link && PRISM_SKIP_BROWSERS=1 node /tmp/prism-link/scripts/postinstall.js; echo "exit $?"
```
Expected: **no output**, exit 0 — the skip message never prints because the CLI block never ran. That silence is the bug.

- [ ] **Step 2: Write the failing test**

Create `server/lib/isMain.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from './isMain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'prism-ismain-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A script that reports whether isMain() thinks it is the entry point. */
function probe() {
  const real = join(tmp, 'releases', 'r1');
  mkdirSync(real, { recursive: true });
  const lib = pathToFileURL(join(__dirname, 'isMain.js')).href;
  writeFileSync(
    join(real, 'probe.mjs'),
    `import { isMain } from ${JSON.stringify(lib)};\nconsole.log(isMain(import.meta.url) ? 'main' : 'not-main');\n`,
  );
  symlinkSync(join('releases', 'r1'), join(tmp, 'current'));
  return { real: join(real, 'probe.mjs'), linked: join(tmp, 'current', 'probe.mjs') };
}

const runNode = (file) => spawnSync(process.execPath, [file], { encoding: 'utf8' }).stdout.trim();

describe('isMain', () => {
  it('is true when run by its real path', () => {
    expect(runNode(probe().real)).toBe('main');
  });

  // Review Focus 1 — how launchd starts every prod script.
  it('is true when run through a symlinked directory like ~/prism/current', () => {
    expect(runNode(probe().linked)).toBe('main');
  });

  it('is false for a module that is not the entry point', () => {
    expect(isMain(import.meta.url, join(tmp, 'something-else.js'))).toBe(false);
  });

  it('is false with no entry point at all', () => {
    expect(isMain(import.meta.url, undefined)).toBe(false);
  });
});

// The old guard is correct-looking and silently wrong; keep it from coming back.
describe('no CLI uses the symlink-blind entry guard', () => {
  it('has no `pathToFileURL(process.argv[1])` comparison left', () => {
    const files = [
      ...['scripts', 'mcp', join('scripts', 'deploy')].flatMap((d) => {
        try {
          return readdirSync(join(REPO, d)).map((f) => join(REPO, d, f));
        } catch {
          return [];
        }
      }),
    ].filter((f) => /\.(m?js)$/.test(f) && !f.endsWith('.test.js') && statSync(f).isFile());
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('pathToFileURL(process.argv[1])'));
    expect(offenders.map((f) => f.slice(REPO.length + 1))).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run server/lib/isMain.test.js`
Expected: FAIL — `Cannot find module './isMain.js'`.

- [ ] **Step 4: Implement**

Create `server/lib/isMain.js`:

```js
/**
 * True when the module at `metaUrl` is the script node was started with.
 *
 * The usual guard — `import.meta.url === pathToFileURL(process.argv[1]).href`
 * — compares a resolved path with an unresolved one. Node resolves the main
 * module through symlinks for import.meta.url but leaves argv[1] as typed, so
 * through any symlink the guard is false and the script exits 0 having done
 * nothing. On the server every script runs through ~/prism/current, which is a
 * symlink: the deploy poller, the nightly backup and PrisMCP would all silently
 * no-op. (Even /var on macOS is a symlink, to /private/var.)
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the isMain tests**

Run: `npx vitest run server/lib/isMain.test.js`
Expected: the four `isMain` tests PASS; the "no CLI uses the symlink-blind guard" test FAILS listing `mcp/server.js`, `scripts/db-backup.js`, `scripts/db-restore.js`, `scripts/postinstall.js`.

- [ ] **Step 6: Convert the four guards**

`scripts/db-backup.js` — replace lines 68–70:

```js
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
```
with:
```js
import { isMain } from '../server/lib/isMain.js';

if (isMain(import.meta.url)) {
```

`scripts/db-restore.js` — the same replacement at lines 145–147.

`scripts/postinstall.js` — replace line 11 `import { pathToFileURL } from 'node:url';` with `import { isMain } from '../server/lib/isMain.js';`, and line 21's guard with `if (isMain(import.meta.url)) {`.

`mcp/server.js` — replace line 1 `import { pathToFileURL } from 'url';` with `import { isMain } from '../server/lib/isMain.js';` (it is the file's only use of `pathToFileURL`), and line 254's guard with `if (isMain(import.meta.url)) {`.

- [ ] **Step 7: Verify**

Run: `npx vitest run server/lib/isMain.test.js` → PASS, 5 tests.
Run: `PRISM_SKIP_BROWSERS=1 node /tmp/prism-link/scripts/postinstall.js; rm /tmp/prism-link`
Expected: prints `PRISM_SKIP_BROWSERS set — skipping …` — the same command that printed nothing in Step 1.
Run: `npx vitest run` → full server suite green. Run: `npm run mcp:e2e` → `PrisMCP e2e PASS`.

- [ ] **Step 8: Commit**

```bash
git add server/lib/isMain.js server/lib/isMain.test.js scripts/db-backup.js scripts/db-restore.js scripts/postinstall.js mcp/server.js
git commit -m "fix: CLI entry guards silently no-op when run through a symlink" \
  -m "Every script compared import.meta.url (symlinks resolved) with argv[1] (as typed). Through ~/prism/current the deploy poller, nightly backup and PrisMCP would exit 0 having done nothing. isMain() compares real paths; a test keeps the old guard from returning." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: PrisMCP requires an absolute `DB_PATH`; no committed `prism` entry

**Files:**
- Modify: `mcp/dbGuard.js` (rewrite), `mcp/dbGuard.test.js`
- Delete: `.mcp.json` (its only server is `prism`)
- Modify: `docs/prismcp-install-and-verify.md` (the `DB_PATH is required` and `Claude Code (committed)` sections)

**Interfaces:**
- Produces: `assertExplicitDbPath(env?) => string` — returns the path unchanged; throws on missing or relative.

- [ ] **Step 1: Change the tests first**

In `mcp/dbGuard.test.js`, delete the `import { resolve } from 'node:path';` line and replace the test `'resolves a relative path against the working directory'` with:

```js
  // A relative path means "whichever directory the client launched me from",
  // and a committed project-scope entry outranks the user's own route to the
  // server's database. Both make the target database an accident of context.
  it('refuses a relative path', () => {
    expect(() => assertExplicitDbPath({ DB_PATH: 'server/db/students.db' })).toThrow(/ABSOLUTE DB_PATH/);
    expect(() => assertExplicitDbPath({ DB_PATH: './students.db' })).toThrow(/ABSOLUTE DB_PATH/);
  });

  it('accepts a SQLite file: URI', () => {
    expect(assertExplicitDbPath({ DB_PATH: 'file:/tmp/x.db?mode=ro' })).toBe('file:/tmp/x.db?mode=ro');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run mcp/dbGuard.test.js`
Expected: FAIL — `refuses a relative path` (the current guard resolves it instead).

- [ ] **Step 3: Rewrite `mcp/dbGuard.js`**

```js
/**
 * PrisMCP writes grading suggestions straight into SQLite and loads no dotenv.
 * Whatever DB_PATH it is given is the database every write lands in, and each
 * write reports success — so a wrong one is silent, and on a disposable clone
 * the work is erased at the next db:refresh.
 *
 * Hence DB_PATH must be declared, and it must be ABSOLUTE. A relative path
 * means "whichever directory the client launched me from" — the inference this
 * guard exists to remove. And Claude Code's project scope (.mcp.json) outranks
 * user scope, so a relative entry committed to the repo would silently beat a
 * correctly configured route to the server's database.
 */
import { isAbsolute } from 'node:path';

const HOW =
  'Configure it once per machine, user-scoped, e.g.\n' +
  '  claude mcp add prism -s user -e DB_PATH=/Users/you/prism/data/students.db -- /usr/local/bin/node /Users/you/prism/current/mcp/server.js\n' +
  'See docs/prismcp-install-and-verify.md.';

export function assertExplicitDbPath(env = process.env) {
  const dbPath = String(env.DB_PATH ?? '').trim();
  // SQLite's in-memory database and URI filenames are not filesystem paths.
  if (dbPath === ':memory:' || dbPath.startsWith('file:')) return dbPath;
  if (!dbPath) {
    throw new Error(`PrisMCP will not start without an explicit DB_PATH.\n${HOW}`);
  }
  if (!isAbsolute(dbPath)) {
    throw new Error(
      `PrisMCP needs an ABSOLUTE DB_PATH, got "${dbPath}".\n` +
        'A relative path resolves against whichever directory the client launched it from,\n' +
        'so the database it writes to would depend on where Claude happened to start.\n' +
        HOW,
    );
  }
  return dbPath;
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run mcp/` → PASS (`dbGuard.test.js` 7 tests; `server.test.js`, `handlers.test.js`, `serverImport.test.js` unaffected).
Run: `npm run mcp:e2e` → `PrisMCP e2e PASS` (it passes an absolute temp `DB_PATH`).
Run: `DB_PATH=server/db/students.db node mcp/server.js; echo "exit $?"` → the `ABSOLUTE DB_PATH` message, exit 1.

- [ ] **Step 5: Remove the committed entry**

```bash
git rm .mcp.json
```

- [ ] **Step 6: Rewrite the install doc sections**

In `docs/prismcp-install-and-verify.md`, replace the section `## \`DB_PATH\` is required (since 2026-09-23)` through the end of `### Claude Code (committed)` (up to, not including, `### Claude Desktop / Cowork (absolute path)`) with:

````markdown
## `DB_PATH` is required, and must be absolute (since 2026-09-23)

**PrisMCP refuses to start unless `DB_PATH` is set to an absolute path.** It
writes grading suggestions straight into SQLite and loads no dotenv, so the
path it is given *is* the database every write lands in — and every write
reports success. A wrong path is silent; on a disposable dev clone the work is
erased at the next `npm run db:refresh`.

A relative path is refused because it resolves against whichever directory
the client launched from. `:memory:` and `file:` URIs are accepted.

## Install

### Claude Code — once per machine, user-scoped

There is **no committed `.mcp.json`**. Claude Code ranks project scope
(`.mcp.json`) above user scope, so a committed `prism` entry would silently
override the route to the server's database on every machine. Configure it
once per machine instead:

**Before cutover** — the laptop is master and grades against its own clone:

```bash
claude mcp add prism -s user -e DB_PATH="$HOME/repos/prism/server/db/students.db" -- /usr/local/bin/node "$HOME/repos/prism/mcp/server.js"
```

**After cutover** — the cutover script prints both of these:

```bash
# on the mini: straight at prod
claude mcp remove prism -s user
claude mcp add prism -s user -e DB_PATH=/Users/gnolan/prism/data/students.db -- /usr/local/bin/node /Users/gnolan/prism/current/mcp/server.js

# on the laptop: over SSH to the mini (needs Remote Login on the mini)
claude mcp remove prism -s user
claude mcp add prism -s user -- ssh gnolan@macmini 'cd ~/prism/current && DB_PATH=$HOME/prism/data/students.db /usr/local/bin/node mcp/server.js'
```

The SSH command is single-quoted so `~` and `$HOME` expand **on the mini**.
`/usr/local/bin/node` is spelled out because a non-interactive SSH session's
`PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`. MCP is a stdio protocol and does
not care that the pipe runs through SSH; Claude, the grading plugin and the
prompts stay on the laptop.

Check with `claude mcp list`. **Local scope outranks user scope**, so if an old
per-project entry exists, remove it: `claude mcp remove prism -s local`.
PrisMCP logs the database it opened to stderr at startup
(`[prismcp] database: …`).

A machine with no `prism` entry simply has no prism tools — visible, not silent.
````

- [ ] **Step 7: Commit**

```bash
git add mcp/dbGuard.js mcp/dbGuard.test.js docs/prismcp-install-and-verify.md
git commit -m "feat: PrisMCP requires an absolute DB_PATH; drop the committed .mcp.json" \
  -m "Claude Code ranks project scope above user scope, so the committed prism entry would have silently beaten the user-scoped SSH route to the server's database after cutover. Each machine now configures prism once, user-scoped, with an absolute path." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a workflow **file named `ci.yml`** — the deploy gate queries `repos/ganolan/prism/actions/workflows/ci.yml/runs`. Renaming it stops deploys.

- [ ] **Step 1: Write the workflow**

```yaml
# The deploy gate. The mini's poller (scripts/deploy/deploy.js) deploys a
# commit only when this workflow's run for that exact sha concluded `success`,
# and it looks the workflow up by this FILE NAME — rename it and deploys stop.
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  # Every commit on main gets its own verdict; the poller needs one per sha.
  cancel-in-progress: false

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      # Every external service is mocked; CI never launches a browser.
      PRISM_SKIP_BROWSERS: '1'
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 25 # the mini runs v25.9.0
          cache: npm
          cache-dependency-path: |
            package-lock.json
            client/package-lock.json

      - name: Install (server)
        run: npm ci

      - name: Install (client)
        run: npm ci
        working-directory: client

      - name: Server, MCP and script tests
        run: npx vitest run

      - name: Client tests
        run: npx vitest run
        working-directory: client

      - name: Client build
        run: npm run build
```

- [ ] **Step 2: Commit it, then reproduce CI in a clean clone under UTC**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the test suites on every push to main and on PRs" \
  -m "This workflow is the deploy gate; the mini deploys a commit only when its ci.yml run is green." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"

T=$(mktemp -d) && git clone -q . "$T/ci" && cd "$T/ci" \
  && PRISM_SKIP_BROWSERS=1 npm ci 2>&1 | grep -E "PRISM_SKIP_BROWSERS|added" \
  && (cd client && npm ci >/dev/null) \
  && TZ=UTC npx vitest run 2>&1 | grep -E "Test Files|Tests " \
  && (cd client && TZ=UTC npx vitest run 2>&1 | grep -E "Test Files|Tests ") \
  && npm run build >/dev/null && echo BUILD-OK; cd - >/dev/null; rm -rf "$T"
```
Expected: the `PRISM_SKIP_BROWSERS set — skipping` line (no chromium download), both suites green **under `TZ=UTC`** (GitHub runners are UTC; the machines are UTC+8), and `BUILD-OK`. No `.env` exists in the clone — that is the point.

If a test passes in Hong Kong time and fails in UTC, that is a real CI failure. Ruling to apply: add `TZ: Asia/Hong_Kong` to the workflow's `env` block (Prism only ever runs in that timezone) rather than rewriting the test, ledger it, and amend nothing — commit the workflow change separately.

- [ ] **Step 3: Note what this cannot catch**

Linux's case-sensitive filesystem. An import whose case differs from the file name works on macOS and fails on the runner. The first real run (Part B, Task 12) is the check.

---

### Task 4: Deploy primitives — `scripts/deploy/lib.js`

**Files:**
- Create: `scripts/deploy/lib.js`, `scripts/deploy/lib.test.js`

**Interfaces:**
- Produces:
  - `KEEP_RELEASES = 3`, `LABELS = { server: 'com.prism.server', deploy: 'com.prism.deploy', backup: 'com.prism.backup' }`
  - `paths(root) => { root, repo, releases, current, data, db, env, logs, launchd, state, lock }`
  - `releaseId(sha: string, now?: Date) => string` — `YYYYMMDDTHHMMSSZ-<sha7>`
  - `listReleases(root) => string[]` (oldest first), `currentRelease(root) => string|null`, `releaseSha(root, id) => string|null`
  - `swapSymlink(link: string, target: string) => void`
  - `decide({ deployedSha, remoteSha, rejected, ci? }) => { action: 'noop'|'check-ci'|'wait'|'reject'|'deploy', reason?, stage? }`
  - `planPrune(releases: string[], currentId: string, keep?) => string[]` (ids to delete)
  - `readState(root) => object`, `writeState(root, state) => void`
  - `acquireLock(root) => boolean`, `releaseLock(root) => void`

- [ ] **Step 1: Write the failing test**

Create `scripts/deploy/lib.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readlinkSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  paths, releaseId, listReleases, currentRelease, releaseSha, swapSymlink, decide,
  planPrune, readState, writeState, acquireLock, releaseLock, KEEP_RELEASES, LABELS,
} from './lib.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prism-root-'));
  mkdirSync(join(root, 'releases'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeRelease(id, sha) {
  const dir = join(root, 'releases', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'release.json'), JSON.stringify({ sha }));
  return dir;
}

describe('paths / LABELS', () => {
  it('spells out the layout under the root', () => {
    const p = paths('/Users/x/prism');
    expect(p.db).toBe('/Users/x/prism/data/students.db');
    expect(p.env).toBe('/Users/x/prism/data/.env');
    expect(p.current).toBe('/Users/x/prism/current');
    expect(LABELS.server).toBe('com.prism.server');
  });
});

describe('releaseId', () => {
  it('stamps UTC time to the second and names the commit', () => {
    expect(releaseId('9f167c5abcdef', new Date('2026-09-23T06:12:05.123Z'))).toBe('20260923T061205Z-9f167c5');
  });

  it('sorts chronologically as plain strings', () => {
    const early = releaseId(SHA_B, new Date('2026-01-02T03:04:05Z'));
    const late = releaseId(SHA_A, new Date('2026-11-12T03:04:05Z'));
    expect([late, early].sort()).toEqual([early, late]);
  });
});

describe('listReleases / currentRelease / releaseSha', () => {
  it('lists release directories oldest first and ignores anything else', () => {
    makeRelease('20260923T060000Z-bbbbbbb', SHA_B);
    makeRelease('20260922T060000Z-aaaaaaa', SHA_A);
    mkdirSync(join(root, 'releases', 'scratch'));
    expect(listReleases(root)).toEqual(['20260922T060000Z-aaaaaaa', '20260923T060000Z-bbbbbbb']);
  });

  it('is empty before the first deploy', () => {
    rmSync(join(root, 'releases'), { recursive: true });
    expect(listReleases(root)).toEqual([]);
    expect(currentRelease(root)).toBe(null);
  });

  it('reads the live release and the sha it was built from', () => {
    makeRelease('20260923T060000Z-aaaaaaa', SHA_A);
    symlinkSync(join('releases', '20260923T060000Z-aaaaaaa'), join(root, 'current'));
    expect(currentRelease(root)).toBe('20260923T060000Z-aaaaaaa');
    expect(releaseSha(root, '20260923T060000Z-aaaaaaa')).toBe(SHA_A);
    expect(releaseSha(root, 'missing')).toBe(null);
    expect(releaseSha(root, null)).toBe(null);
  });
});

describe('swapSymlink', () => {
  it('creates the link on the first deploy', () => {
    makeRelease('r1', SHA_A);
    swapSymlink(join(root, 'current'), join('releases', 'r1'));
    expect(readlinkSync(join(root, 'current'))).toBe(join('releases', 'r1'));
  });

  it('replaces the link itself — never following it into the old release', () => {
    const r1 = makeRelease('r1', SHA_A);
    makeRelease('r2', SHA_B);
    swapSymlink(join(root, 'current'), join('releases', 'r1'));
    swapSymlink(join(root, 'current'), join('releases', 'r2'));
    expect(readlinkSync(join(root, 'current'))).toBe(join('releases', 'r2'));
    // `mv new current` onto a symlink-to-directory would drop `new` INSIDE r1.
    expect(readdirSync(r1)).toEqual(['release.json']);
    expect(readdirSync(root).filter((n) => n.startsWith('current'))).toEqual(['current']);
  });
});

describe('decide', () => {
  const base = { deployedSha: SHA_A, remoteSha: SHA_B, rejected: null };

  it('does nothing when main is what is live', () => {
    expect(decide({ ...base, remoteSha: SHA_A }).action).toBe('noop');
  });

  it('does nothing when the remote could not be read', () => {
    expect(decide({ ...base, remoteSha: null }).action).toBe('noop');
  });

  it('asks for the CI verdict only once there is something new', () => {
    expect(decide(base).action).toBe('check-ci');
  });

  it('waits while CI is running or has not started', () => {
    expect(decide({ ...base, ci: 'pending' }).action).toBe('wait');
    expect(decide({ ...base, ci: 'missing' }).action).toBe('wait');
  });

  it('rejects anything but a green run', () => {
    for (const ci of ['failure', 'cancelled', 'timed_out', 'skipped']) {
      expect(decide({ ...base, ci })).toMatchObject({ action: 'reject', stage: 'ci' });
    }
  });

  it('deploys a green commit, including the very first', () => {
    expect(decide({ ...base, ci: 'success' }).action).toBe('deploy');
    expect(decide({ ...base, deployedSha: null, ci: 'success' }).action).toBe('deploy');
  });

  it('re-checks a CI rejection, because a re-run can turn it green', () => {
    expect(decide({ ...base, ci: 'success', rejected: { sha: SHA_B, stage: 'ci' } }).action).toBe('deploy');
  });

  it('never retries a commit that failed to build, failed its health check, or was rolled back', () => {
    for (const stage of ['build', 'health', 'rollback']) {
      const d = decide({ ...base, rejected: { sha: SHA_B, stage } });
      expect(d.action).toBe('noop');
      expect(d.reason).toMatch(stage);
    }
  });

  it('lets a new commit past the rejection of an older one', () => {
    expect(decide({ ...base, rejected: { sha: SHA_A, stage: 'build' } }).action).toBe('check-ci');
  });
});

describe('planPrune', () => {
  it('keeps the newest three by default', () => {
    expect(KEEP_RELEASES).toBe(3);
    expect(planPrune(['r1', 'r2', 'r3', 'r4', 'r5'], 'r5')).toEqual(['r1', 'r2']);
  });

  it('never deletes the live release or its rollback target, even after a rollback', () => {
    expect(planPrune(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'], 'r3')).toEqual(['r1']);
  });

  it('has nothing to do with fewer releases than it keeps', () => {
    expect(planPrune(['r1', 'r2'], 'r2')).toEqual([]);
  });
});

describe('state', () => {
  it('round-trips', () => {
    writeState(root, { rejected: { sha: SHA_A, stage: 'build' } });
    expect(readState(root)).toEqual({ rejected: { sha: SHA_A, stage: 'build' } });
  });

  it('is empty when missing or unreadable', () => {
    expect(readState(root)).toEqual({});
    writeFileSync(paths(root).state, '{half');
    expect(readState(root)).toEqual({});
  });
});

describe('lock', () => {
  it('admits one deploy at a time', () => {
    expect(acquireLock(root)).toBe(true);
    expect(acquireLock(root)).toBe(false);
    releaseLock(root);
    expect(existsSync(paths(root).lock)).toBe(false);
    expect(acquireLock(root)).toBe(true);
    releaseLock(root);
  });

  // Review Focus 3: a deploy killed mid-run must not stop all later deploys.
  it('takes over a lock whose owner has died', () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(paths(root).lock, String(dead));
    expect(acquireLock(root)).toBe(true);
    releaseLock(root);
  });

  it('takes over an empty lock left by a crash between create and write', () => {
    writeFileSync(paths(root).lock, '');
    expect(acquireLock(root)).toBe(true);
    releaseLock(root);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run scripts/deploy/lib.test.js` → FAIL, module not found.

- [ ] **Step 3: Implement `scripts/deploy/lib.js`**

```js
/**
 * Deploy primitives: the layout, naming, the per-tick decision, pruning, the
 * atomic `current` swap, and the little state the poller keeps between ticks.
 * Pure where possible; filesystem helpers take the prism root so tests can run
 * against a temp directory.
 */
import {
  closeSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync,
  rmSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';

export const KEEP_RELEASES = 3;

export const LABELS = {
  server: 'com.prism.server',
  deploy: 'com.prism.deploy',
  backup: 'com.prism.backup',
};

const RELEASE_RE = /^\d{8}T\d{6}Z-[0-9a-f]{7}$/;

/** The one place the prod layout is spelled out. */
export function paths(root) {
  const data = join(root, 'data');
  return {
    root,
    repo: join(root, 'repo'),
    releases: join(root, 'releases'),
    current: join(root, 'current'),
    data,
    db: join(data, 'students.db'),
    env: join(data, '.env'),
    logs: join(root, 'logs'),
    launchd: join(root, 'launchd'),
    state: join(root, 'deploy-state.json'),
    lock: join(root, 'deploy.lock'),
  };
}

/** `20260923T061205Z-9f167c5` — sorts by time and names the commit. */
export function releaseId(sha, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${sha.slice(0, 7)}`;
}

/** Release directory names, oldest first. */
export function listReleases(root) {
  try {
    return readdirSync(paths(root).releases).filter((n) => RELEASE_RE.test(n)).sort();
  } catch {
    return [];
  }
}

/** The release `current` points at, or null before the first deploy. */
export function currentRelease(root) {
  try {
    return basename(readlinkSync(paths(root).current));
  } catch {
    return null;
  }
}

/** The full sha a release was built from, per its release.json. */
export function releaseSha(root, id) {
  if (!id) return null;
  try {
    return JSON.parse(readFileSync(join(paths(root).releases, id, 'release.json'), 'utf8')).sha ?? null;
  } catch {
    return null;
  }
}

/**
 * Point `link` at `target` atomically. rename(2) replaces the symlink itself,
 * so `current` is never missing — and unlike `mv`, it never follows the old
 * link and drops the new one *inside* the old release.
 */
export function swapSymlink(link, target) {
  const tmp = `${link}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

/**
 * What the poller should do this tick. Called once without `ci`; when it
 * answers 'check-ci' the caller asks GitHub and calls again with the verdict,
 * so the API is queried only when there is something new to deploy.
 *
 * `ci`: 'success' | 'pending' | 'missing' (no run yet) | any other conclusion.
 * `rejected`: { sha, stage: 'ci'|'build'|'health'|'rollback' } | null.
 *
 * A CI rejection is re-checked every tick, because a re-run can turn it green.
 * A commit that failed to build, failed its health check, or was rolled back by
 * hand is never retried automatically: retrying a heavy build every 30s is
 * worse than waiting for a fix, and redeploying a rollback undoes it within the
 * minute. `deploy.js --force` retries.
 */
export function decide({ deployedSha, remoteSha, rejected, ci }) {
  if (!remoteSha) return { action: 'noop', reason: 'no remote sha' };
  const short = remoteSha.slice(0, 7);
  if (remoteSha === deployedSha) return { action: 'noop', reason: `up to date at ${short}` };
  if (rejected?.sha === remoteSha && rejected.stage !== 'ci') {
    return { action: 'noop', reason: `${short} was rejected at ${rejected.stage}; push a fix or run deploy --force` };
  }
  if (ci === undefined) return { action: 'check-ci' };
  if (ci === 'pending' || ci === 'missing') return { action: 'wait', reason: `CI ${ci} for ${short}` };
  if (ci !== 'success') return { action: 'reject', stage: 'ci', reason: `CI ${ci} for ${short}` };
  return { action: 'deploy' };
}

/**
 * Release ids to delete: all but the newest `keep`, and never the live release
 * or the one before it (the rollback target) — which after a rollback are not
 * among the newest.
 */
export function planPrune(releases, currentId, keep = KEEP_RELEASES) {
  const sorted = [...releases].sort();
  const keepers = new Set(sorted.slice(-keep));
  keepers.add(currentId);
  const i = sorted.indexOf(currentId);
  if (i > 0) keepers.add(sorted[i - 1]);
  return sorted.filter((r) => !keepers.has(r));
}

export function readState(root) {
  try {
    return JSON.parse(readFileSync(paths(root).state, 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(root, state) {
  const file = paths(root).state;
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Take the deploy lock, or return false while a live deploy holds it. A lock
 * whose owner has died is taken over — otherwise one crash would silently
 * stop every deploy after it.
 */
export function acquireLock(root) {
  const file = paths(root).lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = Number(readFileSync(file, 'utf8').trim());
      if (holder && isAlive(holder)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

export function releaseLock(root) {
  rmSync(paths(root).lock, { force: true });
}
```

- [ ] **Step 4: Verify** — `npx vitest run scripts/deploy/lib.test.js` → PASS (24 tests). `npx vitest run` → green.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/lib.js scripts/deploy/lib.test.js
git commit -m "feat(deploy): release layout, the per-tick decision, pruning, atomic swap, lock" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Deploy side effects — `scripts/deploy/effects.js`

**Files:**
- Create: `scripts/deploy/effects.js`, `scripts/deploy/effects.test.js`

**Interfaces:**
- Consumes: `paths`, `LABELS` from `lib.js`.
- Produces: `REPO_SLUG`, `CI_WORKFLOW = 'ci.yml'`, `VERSION_URL`, `fetchMain(repoDir) => sha`, `exportTree(repoDir, sha, dest)`, `install(dir, logFile)`, `parseCiRuns(payload, sha) => 'success'|'pending'|'missing'|<conclusion>`, `ciStatus(sha)`, `healthCheck(expectSha, { url?, timeoutMs?, intervalMs? }) => Promise<boolean>`, `load(label)`, `unload(label)`, `restartServer()`, `launchAgentPath(label, home?)`, `certDomains() => string[]`, `keyExpiry() => string|null`, `sshListening() => boolean`, `serve(port?)`, `deployEffects(root)`, `cutoverEffects(root)`.

- [ ] **Step 1: Write the failing test**

Create `scripts/deploy/effects.test.js` (only the pure parser and the HTTP health check are unit-tested; the shell-outs are exercised in Part B):

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { parseCiRuns, healthCheck } from './effects.js';

const SHA = 'c'.repeat(40);

// Field names as observed from GET /repos/ganolan/prism/actions/workflows/<file>/runs, 2026-09-23.
const runFor = (overrides) => ({
  id: 1, name: 'CI', event: 'push', status: 'completed', conclusion: 'success',
  head_sha: SHA, head_branch: 'main', created_at: '2026-09-23T06:00:00Z', run_number: 1,
  ...overrides,
});

describe('parseCiRuns', () => {
  it('is missing when CI has not started', () => {
    expect(parseCiRuns({ total_count: 0, workflow_runs: [] }, SHA)).toBe('missing');
  });

  it('is pending while a run is queued or in progress', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'requested']) {
      expect(parseCiRuns({ workflow_runs: [runFor({ status, conclusion: null })] }, SHA)).toBe('pending');
    }
  });

  it("reports a finished run's conclusion", () => {
    expect(parseCiRuns({ workflow_runs: [runFor({})] }, SHA)).toBe('success');
    expect(parseCiRuns({ workflow_runs: [runFor({ conclusion: 'failure' })] }, SHA)).toBe('failure');
  });

  it('believes the newest run when there are several', () => {
    const runs = [runFor({ run_number: 1, conclusion: 'failure' }), runFor({ run_number: 2, conclusion: 'success' })];
    expect(parseCiRuns({ workflow_runs: runs }, SHA)).toBe('success');
  });

  it('ignores pull-request runs and runs for other commits', () => {
    const runs = [runFor({ event: 'pull_request' }), runFor({ head_sha: 'd'.repeat(40) })];
    expect(parseCiRuns({ workflow_runs: runs }, SHA)).toBe('missing');
  });
});

describe('healthCheck', () => {
  let server, url, served;
  beforeEach(async () => {
    served = 'old';
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sha: served, builtAt: null, mode: 'release' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/api/version`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  it('passes once the expected commit is the one answering', async () => {
    served = SHA;
    expect(await healthCheck(SHA, { url, timeoutMs: 1000, intervalMs: 50 })).toBe(true);
  });

  it('fails while a different commit is still answering', async () => {
    expect(await healthCheck(SHA, { url, timeoutMs: 300, intervalMs: 50 })).toBe(false);
  });

  it('fails when nothing is listening', async () => {
    const closed = url;
    await new Promise((resolve) => server.close(resolve));
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    expect(await healthCheck(SHA, { url: closed, timeoutMs: 300, intervalMs: 50 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run scripts/deploy/effects.test.js` → FAIL, module not found.

- [ ] **Step 3: Implement `scripts/deploy/effects.js`**

```js
/**
 * The deploy's side effects, kept apart from its logic so tests can replace
 * them. Everything here shells out to a real tool. Only parseCiRuns and
 * healthCheck are unit-tested; the rest is exercised by the live bring-up.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LABELS, paths } from './lib.js';

export const REPO_SLUG = process.env.PRISM_REPO || 'ganolan/prism';
export const CI_WORKFLOW = 'ci.yml';
export const VERSION_URL = 'http://127.0.0.1:3001/api/version';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

export function fetchMain(repoDir) {
  run('git', ['-C', repoDir, 'fetch', '--quiet', 'origin', 'main']);
  return run('git', ['-C', repoDir, 'rev-parse', 'origin/main']);
}

/** Write the tree at `sha` into `dest`: no .git, no untracked files, no .env. */
export function exportTree(repoDir, sha, dest) {
  mkdirSync(dest, { recursive: true });
  execFileSync(
    '/bin/bash',
    ['-o', 'pipefail', '-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'bash', repoDir, sha, dest],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** npm ci (root and client) and the client build; output goes to `logFile`. */
export function install(dir, logFile) {
  const fd = openSync(logFile, 'a');
  try {
    const opts = { cwd: dir, stdio: ['ignore', fd, fd] };
    execFileSync('npm', ['ci'], opts);
    execFileSync('npm', ['ci'], { ...opts, cwd: join(dir, 'client') });
    execFileSync('npm', ['run', 'build'], opts);
  } finally {
    closeSync(fd);
  }
}

/**
 * One word from GET /repos/{slug}/actions/workflows/{file}/runs?head_sha=.
 * Shape observed 2026-09-23: { total_count, workflow_runs: [{ id, name, event,
 * status, conclusion, head_sha, head_branch, created_at, run_number }] }.
 */
export function parseCiRuns(payload, sha) {
  const runs = (payload?.workflow_runs ?? [])
    .filter((r) => r.head_sha === sha && r.event === 'push')
    .sort((a, b) => b.run_number - a.run_number);
  const latest = runs[0];
  if (!latest) return 'missing';
  if (latest.status !== 'completed') return 'pending';
  return latest.conclusion || 'failure';
}

export function ciStatus(sha) {
  const out = run('gh', ['api', `repos/${REPO_SLUG}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&per_page=20`]);
  return parseCiRuns(JSON.parse(out), sha);
}

/** Poll /api/version until `expectSha` is the commit answering, or give up. */
export async function healthCheck(expectSha, { url = VERSION_URL, timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const res = await fetch(url);
      if (res.ok && (await res.json()).sha === expectSha) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return false;
}

// ---- launchd ----
const domain = () => `gui/${process.getuid()}`;

export function launchAgentPath(label, home = homedir()) {
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function isLoaded(label) {
  return spawnSync('launchctl', ['print', `${domain()}/${label}`], { stdio: 'ignore' }).status === 0;
}

export function load(label) {
  if (!isLoaded(label)) run('launchctl', ['bootstrap', domain(), launchAgentPath(label)]);
}

export function unload(label) {
  if (isLoaded(label)) run('launchctl', ['bootout', `${domain()}/${label}`]);
}

export function restartServer() {
  load(LABELS.server);
  run('launchctl', ['kickstart', '-k', `${domain()}/${LABELS.server}`]);
}

// ---- tailnet ----
function tailscaleSelfAndCerts() {
  try {
    return JSON.parse(run('tailscale', ['status', '--json']));
  } catch {
    return {};
  }
}

export function certDomains() {
  return tailscaleSelfAndCerts().CertDomains ?? [];
}

/**
 * The node's key expiry, or null. Both shapes observed 2026-09-23: enabled →
 * Self.KeyExpiry = "2027-03-12T15:11:00Z"; disabled → the field is absent.
 */
export function keyExpiry() {
  const value = tailscaleSelfAndCerts().Self?.KeyExpiry;
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function sshListening() {
  return spawnSync('lsof', ['-nP', '-iTCP:22', '-sTCP:LISTEN'], { stdio: 'ignore' }).status === 0;
}

export function serve(port = 3001) {
  run('tailscale', ['serve', '--bg', String(port)]);
}

// ---- bundles ----
export function deployEffects(root) {
  const p = paths(root);
  return {
    fetchMain: () => fetchMain(p.repo),
    ciStatus,
    exportTree: (sha, dest) => exportTree(p.repo, sha, dest),
    install: (dir) => install(dir, join(p.logs, 'deploy.log')),
    restart: restartServer,
    healthCheck: (sha) => healthCheck(sha),
  };
}

export function cutoverEffects(root) {
  const p = paths(root);
  return {
    certDomains,
    keyExpiry,
    sshListening,
    stopServer: () => unload(LABELS.server),
    startServer: () => load(LABELS.server),
    healthCheck: (sha) => healthCheck(sha),
    loadBackupAgent: () => {
      copyFileSync(join(p.launchd, `${LABELS.backup}.plist`), launchAgentPath(LABELS.backup));
      load(LABELS.backup);
    },
    serve: () => serve(3001),
  };
}
```

- [ ] **Step 4: Verify** — `npx vitest run scripts/deploy/effects.test.js` → PASS (8). Full suite green.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/effects.js scripts/deploy/effects.test.js
git commit -m "feat(deploy): real side effects — git, npm, gh, launchctl, tailscale, health check" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The deploy tick — `scripts/deploy/deploy.js`

**Files:**
- Create: `scripts/deploy/testing.js` (test-only fixture), `scripts/deploy/deploy.js`, `scripts/deploy/deploy.test.js`

**Interfaces:**
- Consumes: everything in `lib.js`; `fetchMain`, `exportTree`, `deployEffects` from `effects.js`; `isMain` from `server/lib/isMain.js`.
- Produces: `deploy({ root, force?, now?, fx, log? }) => Promise<{ action: 'locked'|'noop'|'wait'|'reject'|'failed'|'rolled-back'|'deployed', id?, to?, stage?, reason? }>`; `makeFixture()` (test-only).

- [ ] **Step 1: Write the shared fixture**

Create `scripts/deploy/testing.js`:

```js
/**
 * Test-only fixture: a throwaway `origin` repo, a prism root whose repo/ is a
 * clone of it, and scriptable effects. Real git does the fetching and
 * exporting; CI, npm, launchd and the health check are stand-ins.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentRelease, paths } from './lib.js';
import { exportTree, fetchMain } from './effects.js';

export const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=Prism Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

export function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'prism-deploy-'));
  const origin = join(tmp, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');

  const root = join(tmp, 'prism');
  const p = paths(root);

  const f = {
    tmp, origin, root, p,
    ci: 'success',
    buildFails: false,
    healthy: () => true,
    calls: [],
    logs: [],
    clock: Date.parse('2026-09-23T06:00:00Z'),

    commit(message) {
      writeFileSync(join(origin, 'CHANGELOG'), `${message}\n`, { flag: 'a' });
      git(origin, 'add', '-A');
      git(origin, 'commit', '-q', '-m', message);
      return git(origin, 'rev-parse', 'HEAD');
    },
    now: () => new Date((f.clock += 60_000)),
    log: (message) => f.logs.push(message),
    count: (kind) => f.calls.filter(([k]) => k === kind).length,
    fx: () => ({
      fetchMain: () => fetchMain(p.repo),
      ciStatus: (sha) => {
        f.calls.push(['ci', sha]);
        return f.ci;
      },
      exportTree: (sha, dest) => exportTree(p.repo, sha, dest),
      install: (dir) => {
        f.calls.push(['install', dir]);
        if (f.buildFails) throw new Error('npm ci exploded');
        writeFileSync(join(dir, '.installed'), '');
      },
      restart: () => f.calls.push(['restart', currentRelease(root)]),
      healthCheck: async (sha) => {
        f.calls.push(['health', sha]);
        return f.healthy(sha);
      },
    }),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };

  writeFileSync(join(origin, 'package.json'), '{"name":"fixture"}\n');
  f.commit('initial');
  for (const dir of [p.releases, p.data, p.logs]) mkdirSync(dir, { recursive: true });
  writeFileSync(p.env, 'SCHOOLOGY_CONSUMER_KEY=fixture\n');
  git(tmp, 'clone', '-q', origin, p.repo);
  return f;
}
```

- [ ] **Step 2: Write the failing test**

Create `scripts/deploy/deploy.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { deploy } from './deploy.js';
import { acquireLock, currentRelease, readState, releaseLock } from './lib.js';
import { git, makeFixture } from './testing.js';

let f;
beforeEach(() => {
  f = makeFixture();
});
afterEach(() => f.cleanup());

const run = (opts = {}) => deploy({ root: f.root, fx: f.fx(), now: f.now, log: f.log, ...opts });

describe('deploy', () => {
  it('deploys the first release: tree, release.json, .env, current, restart', async () => {
    const sha = git(f.origin, 'rev-parse', 'HEAD');
    const result = await run();

    expect(result.action).toBe('deployed');
    const dir = join(f.p.releases, result.id);
    expect(readlinkSync(f.p.current)).toBe(join('releases', result.id));
    expect(JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8')).sha).toBe(sha);
    expect(existsSync(join(dir, 'package.json'))).toBe(true);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('SCHOOLOGY_CONSUMER_KEY=fixture\n');
    expect(f.calls.filter(([k]) => k === 'restart')).toEqual([['restart', result.id]]);
    expect(readState(f.root).deployed.sha).toBe(sha);
  });

  it('does nothing — not even a CI query — when main is already live', async () => {
    await run();
    f.calls = [];
    expect((await run()).action).toBe('noop');
    expect(f.calls).toEqual([]);
  });

  it('waits for CI and builds nothing meanwhile', async () => {
    await run();
    f.commit('next');
    f.ci = 'pending';
    expect((await run()).action).toBe('wait');
    expect(f.count('install')).toBe(1);
  });

  it('refuses a red commit, says so once, and leaves prod alone', async () => {
    const first = await run();
    f.commit('broken');
    f.ci = 'failure';
    await run();
    await run();
    expect(currentRelease(f.root)).toBe(first.id);
    expect(f.logs.filter((m) => m.includes('CI failure'))).toHaveLength(1);
  });

  it('deploys a commit whose CI was re-run green', async () => {
    await run();
    const sha = f.commit('flaky');
    f.ci = 'failure';
    await run();
    f.ci = 'success';
    expect((await run()).action).toBe('deployed');
    expect(readState(f.root).deployed.sha).toBe(sha);
  });

  it('a failed build leaves the live release running and is not retried every tick', async () => {
    const first = await run();
    f.commit('bad deps');
    f.buildFails = true;

    expect(await run()).toMatchObject({ action: 'failed', stage: 'build' });
    expect(currentRelease(f.root)).toBe(first.id);
    expect(readdirSync(f.p.releases)).toEqual([first.id]);
    expect(f.count('restart')).toBe(1);

    expect((await run()).action).toBe('noop');
    expect(f.count('install')).toBe(2);
  });

  it('--force retries a commit that failed to build', async () => {
    await run();
    f.commit('bad deps');
    f.buildFails = true;
    await run();
    f.buildFails = false;
    expect((await run({ force: true })).action).toBe('deployed');
  });

  it('swaps back and restarts the previous release when the new one is unhealthy', async () => {
    const first = await run();
    const bad = f.commit('boots but crashes');
    f.healthy = (sha) => sha !== bad;

    expect(await run()).toMatchObject({ action: 'rolled-back', to: first.id });
    expect(currentRelease(f.root)).toBe(first.id);
    expect(f.calls.filter(([k]) => k === 'restart').at(-1)).toEqual(['restart', first.id]);
    expect(readState(f.root).rejected).toMatchObject({ sha: bad, stage: 'health' });
  });

  it('keeps only the newest three releases', async () => {
    for (let i = 0; i < 5; i++) {
      f.commit(`c${i}`);
      await run();
    }
    expect(readdirSync(f.p.releases)).toHaveLength(3);
    expect(readdirSync(f.p.releases)).toContain(currentRelease(f.root));
  });

  it('stands aside while another deploy holds the lock', async () => {
    expect(acquireLock(f.root)).toBe(true);
    expect((await run()).action).toBe('locked');
    expect(f.calls).toEqual([]);
    releaseLock(f.root);
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `npx vitest run scripts/deploy/deploy.test.js` → FAIL, `./deploy.js` not found.

- [ ] **Step 4: Implement `scripts/deploy/deploy.js`**

```js
#!/usr/bin/env node
/**
 * One tick of the deploy poller (spec §2, "CD"). launchd runs it every 30s from
 * ~/prism/current, so the deploy logic that runs is always the live, healthy
 * release's — a new deploy.js only takes effect once the old one deployed it.
 *
 * origin/main == live? stop. CI green for that exact sha? export the tree into
 * releases/<id>, npm ci + build, THEN swap `current` and restart. The new sha
 * must answer /api/version, or `current` swaps back. Prune to three.
 *
 * Logs only transitions, so a quiet tick costs one line of nothing.
 */
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMain } from '../../server/lib/isMain.js';
import {
  acquireLock, currentRelease, decide, listReleases, paths, planPrune, readState,
  releaseId, releaseLock, releaseSha, swapSymlink, writeState,
} from './lib.js';

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

export async function deploy({ root, force = false, now = () => new Date(), fx, log = () => {} }) {
  if (!acquireLock(root)) return { action: 'locked' };
  try {
    return await tick({ root, force, now, fx, log });
  } finally {
    releaseLock(root);
  }
}

async function tick({ root, force, now, fx, log }) {
  const p = paths(root);
  const state = readState(root);
  const previousId = currentRelease(root);
  const deployedSha = releaseSha(root, previousId);
  const remoteSha = fx.fetchMain();
  const facts = { deployedSha, remoteSha, rejected: force ? null : state.rejected ?? null };

  let d = decide(facts);
  if (d.action === 'check-ci') {
    try {
      d = decide({ ...facts, ci: fx.ciStatus(remoteSha) });
    } catch (err) {
      d = { action: 'wait', reason: `CI lookup failed for ${remoteSha.slice(0, 7)}: ${firstLine(err)}` };
    }
  }

  if (d.action !== 'deploy') {
    const note = `${d.action}: ${d.reason}`;
    const next = { ...state, lastNote: note };
    if (d.action === 'reject') next.rejected = { sha: remoteSha, stage: 'ci', at: now().toISOString() };
    if (state.lastNote !== note) log(note);
    if (JSON.stringify(next) !== JSON.stringify(state)) writeState(root, next);
    return d;
  }

  const at = now();
  const id = releaseId(remoteSha, at);
  const dir = join(p.releases, id);
  log(`deploying ${remoteSha.slice(0, 7)} as ${id}`);

  try {
    fx.exportTree(remoteSha, dir);
    writeFileSync(join(dir, 'release.json'), `${JSON.stringify({ sha: remoteSha, builtAt: at.toISOString() }, null, 2)}\n`);
    // Secrets live outside the release; dotenv reads .env from the working directory.
    symlinkSync(join('..', '..', 'data', '.env'), join(dir, '.env'));
    fx.install(dir);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    log(`build FAILED for ${remoteSha.slice(0, 7)}; live release untouched: ${firstLine(err)}`);
    writeState(root, { ...state, lastNote: null, rejected: { sha: remoteSha, stage: 'build', at: at.toISOString() } });
    return { action: 'failed', stage: 'build' };
  }

  swapSymlink(p.current, join('releases', id));
  fx.restart();

  if (!(await fx.healthCheck(remoteSha))) {
    log(`health check FAILED for ${id}`);
    if (previousId) {
      swapSymlink(p.current, join('releases', previousId));
      fx.restart();
      const back = await fx.healthCheck(deployedSha);
      log(back ? `rolled back to ${previousId}` : `ROLLBACK TO ${previousId} ALSO UNHEALTHY — prod is down`);
    } else {
      log('no previous release to roll back to — prod is down');
    }
    writeState(root, { ...state, lastNote: null, rejected: { sha: remoteSha, stage: 'health', at: at.toISOString() } });
    return { action: 'rolled-back', to: previousId };
  }

  for (const stale of planPrune(listReleases(root), id)) {
    rmSync(join(p.releases, stale), { recursive: true, force: true });
  }
  writeState(root, { rejected: null, lastNote: null, deployed: { sha: remoteSha, id, at: at.toISOString() } });
  log(`deployed ${id}`);
  return { action: 'deployed', id };
}

if (isMain(import.meta.url)) {
  const root = process.env.PRISM_ROOT || join(homedir(), 'prism');
  const { deployEffects } = await import('./effects.js');
  const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
  try {
    const result = await deploy({ root, force: process.argv.includes('--force'), fx: deployEffects(root), log });
    if (result.action === 'failed' || result.action === 'rolled-back') process.exitCode = 1;
  } catch (err) {
    log(`deploy crashed: ${err.stack || err}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 5: Verify** — `npx vitest run scripts/deploy/deploy.test.js` → PASS (10). Full suite green.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy/testing.js scripts/deploy/deploy.js scripts/deploy/deploy.test.js
git commit -m "feat(deploy): the poller tick — CI-gated build, swap, health check, swap back, prune" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Rollback that the poller respects — `scripts/deploy/rollback.js`

**Files:**
- Create: `scripts/deploy/rollback.js`, `scripts/deploy/rollback.test.js`

**Interfaces:**
- Consumes: `lib.js`; `deploy` (tests only); `makeFixture`.
- Produces: `rollback({ root, fx, now?, log? }) => Promise<{ from, to, healthy, pinned }>`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deploy } from './deploy.js';
import { rollback } from './rollback.js';
import { currentRelease, readState, releaseSha } from './lib.js';
import { makeFixture } from './testing.js';

let f;
beforeEach(() => {
  f = makeFixture();
});
afterEach(() => f.cleanup());

const run = (opts = {}) => deploy({ root: f.root, fx: f.fx(), now: f.now, log: f.log, ...opts });
const back = () => rollback({ root: f.root, fx: f.fx(), now: f.now, log: f.log });

describe('rollback', () => {
  it('points current at the previous release, restarts, and checks it answers', async () => {
    const a = await run();
    f.commit('b');
    const b = await run();

    const result = await back();

    expect(result).toMatchObject({ from: b.id, to: a.id, healthy: true });
    expect(currentRelease(f.root)).toBe(a.id);
    expect(f.calls.at(-1)).toEqual(['health', releaseSha(f.root, a.id)]);
  });

  // Review Focus 2.
  it('stops the poller redeploying the commit that was just rolled back', async () => {
    const a = await run();
    f.commit('b');
    await run();
    await back();

    expect((await run()).action).toBe('noop');
    expect(currentRelease(f.root)).toBe(a.id);
  });

  it('still holds after a second rollback', async () => {
    const a = await run();
    f.commit('b');
    await run();
    f.commit('c');
    await run();

    await back();
    await back();

    expect(currentRelease(f.root)).toBe(a.id);
    expect((await run()).action).toBe('noop');
  });

  it('lets a new commit on main deploy normally', async () => {
    await run();
    f.commit('b');
    await run();
    await back();
    const fix = f.commit('fix');

    expect((await run()).action).toBe('deployed');
    expect(readState(f.root).deployed.sha).toBe(fix);
  });

  it('deploy --force undoes the pause', async () => {
    await run();
    const b = f.commit('b');
    await run();
    await back();

    expect((await run({ force: true })).action).toBe('deployed');
    expect(readState(f.root).deployed.sha).toBe(b);
  });

  it('pins the commit it rolled away from when GitHub is unreachable', async () => {
    await run();
    const b = f.commit('b');
    await run();
    const fx = { ...f.fx(), fetchMain: () => { throw new Error('offline'); } };

    const result = await rollback({ root: f.root, fx, now: f.now, log: f.log });

    expect(result.pinned).toBe(b);
    expect(readState(f.root).rejected).toMatchObject({ sha: b, stage: 'rollback' });
  });

  it('refuses when there is nothing older', async () => {
    await run();
    await expect(back()).rejects.toThrow(/No release older/);
  });

  it('reports an unhealthy target instead of hiding it', async () => {
    await run();
    f.commit('b');
    await run();
    f.healthy = () => false;
    expect((await back()).healthy).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, `./rollback.js` not found.

- [ ] **Step 3: Implement `scripts/deploy/rollback.js`**

```js
#!/usr/bin/env node
/**
 * prism-rollback: point `current` at the release before it and restart —
 * for the case automation cannot catch, where CI passed and prod is still
 * wrong. ~2s, no rebuild.
 *
 * The rolled-back commit is CI-green, so the poller would redeploy it within
 * 30 seconds. Rollback therefore pins whatever origin/main is now; the poller
 * leaves it alone until a new commit lands or someone runs deploy --force.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMain } from '../../server/lib/isMain.js';
import {
  acquireLock, currentRelease, listReleases, paths, readState, releaseLock,
  releaseSha, swapSymlink, writeState,
} from './lib.js';

export async function rollback({ root, fx, now = () => new Date(), log = () => {} }) {
  if (!acquireLock(root)) throw new Error('A deploy is running. Try again in a minute.');
  try {
    const releases = listReleases(root);
    const from = currentRelease(root);
    const i = releases.indexOf(from);
    if (!from) throw new Error('Nothing is deployed.');
    if (i <= 0) throw new Error(`No release older than ${from} to roll back to.`);
    const to = releases[i - 1];

    let pinned;
    try {
      pinned = fx.fetchMain();
    } catch {
      pinned = releaseSha(root, from);
    }

    swapSymlink(paths(root).current, join('releases', to));
    fx.restart();
    const healthy = await fx.healthCheck(releaseSha(root, to));

    writeState(root, {
      ...readState(root),
      lastNote: null,
      rejected: { sha: pinned, stage: 'rollback', at: now().toISOString() },
    });
    log(`rolled back ${from} -> ${to}${healthy ? '' : ' — AND IT IS NOT ANSWERING'}; auto-deploy paused at ${pinned.slice(0, 7)}`);
    return { from, to, healthy, pinned };
  } finally {
    releaseLock(root);
  }
}

if (isMain(import.meta.url)) {
  const root = process.env.PRISM_ROOT || join(homedir(), 'prism');
  const { deployEffects } = await import('./effects.js');
  try {
    const r = await rollback({ root, fx: deployEffects(root), log: console.log });
    console.log(
      `\nAuto-deploy is paused at ${r.pinned.slice(0, 7)}. It resumes by itself when a new commit\n` +
        'lands on main, or now with: node ~/prism/current/scripts/deploy/deploy.js --force',
    );
    if (!r.healthy) process.exitCode = 1;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Verify** — `npx vitest run scripts/deploy/rollback.test.js` → PASS (8). Full suite green.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/rollback.js scripts/deploy/rollback.test.js
git commit -m "feat(deploy): prism-rollback, which pauses auto-deploy so it sticks" \
  -m "A rolled-back commit is CI-green; without a pin the poller redeploys it within 30s. Rollback pins origin/main until a new commit lands or deploy --force." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `restore()` can take a named snapshot

Cutover must restore the snapshot taken *at cutover*, not "the newest file in the folder" — the spec's Sep 22 warning.

**Files:**
- Modify: `scripts/db-restore.js` (the `restore` signature and its first lines), `scripts/db-restore.test.js`

**Interfaces:**
- Produces: `restore({ dbPath, srcDir?, snapshotFile?, force?, now?, onSafetyCopy? })` — `snapshotFile` wins over `srcDir`.

- [ ] **Step 1: Failing tests** — append to `scripts/db-restore.test.js`:

```js
describe('restoring a named snapshot', () => {
  it('uses the file it is given, not the newest in the folder', async () => {
    const chosen = writeSnapshot('students-20260101T000000Z.db', ['chosen']);
    writeSnapshot('students-20260301T000000Z.db', ['newer']);

    const result = await restore({ dbPath, snapshotFile: chosen, force: true });

    expect(result.snapshot).toBe('students-20260101T000000Z.db');
    expect(readRows(dbPath)).toEqual(['chosen']);
  });

  it('says so when the file does not exist', async () => {
    await expect(restore({ dbPath, snapshotFile: join(dir, 'nope.db'), force: true })).rejects.toThrow(/Snapshot not found/);
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run scripts/db-restore.test.js` → the two new tests FAIL.

- [ ] **Step 3: Implement** — in `scripts/db-restore.js` change the path import to `import { basename, join } from 'node:path';` and replace:

```js
export async function restore({ dbPath, srcDir, force = false, now = new Date(), onSafetyCopy }) {
  if (!srcDir) throw new Error('Set PRISM_BACKUP_DIR in .env first.');

  const [newest] = listSnapshots(srcDir);
  if (!newest) throw new Error(`No snapshots found in ${srcDir}. Run: npm run db:backup`);
  const src = join(srcDir, newest);
```
with:
```js
export async function restore({ dbPath, srcDir, snapshotFile, force = false, now = new Date(), onSafetyCopy }) {
  let newest;
  let src;
  if (snapshotFile) {
    // Named explicitly — cutover must restore the snapshot taken at cutover,
    // never whatever happens to be newest in a synced folder.
    if (!existsSync(snapshotFile)) throw new Error(`Snapshot not found: ${snapshotFile}`);
    src = snapshotFile;
    newest = basename(snapshotFile);
  } else {
    if (!srcDir) throw new Error('Set PRISM_BACKUP_DIR in .env first.');
    [newest] = listSnapshots(srcDir);
    if (!newest) throw new Error(`No snapshots found in ${srcDir}. Run: npm run db:backup`);
    src = join(srcDir, newest);
  }
```

- [ ] **Step 4: Verify** — `npx vitest run scripts/db-restore.test.js` → PASS (20). Full suite green.

- [ ] **Step 5: Commit**

```bash
git add scripts/db-restore.js scripts/db-restore.test.js
git commit -m "feat: restore() can take a named snapshot file" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Scripted cutover — `scripts/deploy/cutover.js`

**Files:**
- Create: `scripts/deploy/cutover.js`, `scripts/deploy/cutover.test.js`

**Interfaces:**
- Consumes: `lib.js`, `restore` (Task 8), `SNAPSHOT_RE` from `scripts/db-backup.js`, `cutoverEffects` (Task 5).
- Produces: `MAX_SNAPSHOT_AGE_MS`, `snapshotTime(name) => Date|null`, `cutoverProblems(facts) => string[]`, `cutoverWarnings({ keyExpiry }) => string[]`, `mcpCommands() => { mini: string, laptop: string }`, `cutover({ root, snapshotPath, allowOld?, dryRun?, now?, fx, log? })`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { deploy } from './deploy.js';
import { cutover, cutoverProblems, snapshotTime, mcpCommands, MAX_SNAPSHOT_AGE_MS } from './cutover.js';
import { releaseSha, currentRelease } from './lib.js';
import { snapshotName } from '../db-backup.js';
import { makeFixture } from './testing.js';

const NOW = new Date('2026-09-23T06:30:00Z');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

let f, facts, snapDir;
beforeEach(async () => {
  f = makeFixture();
  await deploy({ root: f.root, fx: f.fx(), now: f.now, log: f.log });
  f.calls = [];
  snapDir = join(f.tmp, '_prism-data');
  mkdirSync(snapDir);
  facts = { certDomains: ['macmini.swordtail-everest.ts.net'], ssh: true, keyExpiry: null };
});
afterEach(() => f.cleanup());

function sqliteWith(path, courses) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE courses (id INTEGER PRIMARY KEY, name TEXT)');
  for (const name of courses) db.prepare('INSERT INTO courses (name) VALUES (?)').run(name);
  db.close();
  return path;
}

const snapshotAt = (date, courses = ['AP CSP']) => sqliteWith(join(snapDir, snapshotName(date)), courses);

const cfx = () => ({
  certDomains: () => facts.certDomains,
  keyExpiry: () => facts.keyExpiry,
  sshListening: () => facts.ssh,
  stopServer: () => f.calls.push(['stop']),
  startServer: () => f.calls.push(['start']),
  healthCheck: async (sha) => {
    f.calls.push(['health', sha]);
    return f.healthy(sha);
  },
  loadBackupAgent: () => f.calls.push(['backup']),
  serve: () => f.calls.push(['serve']),
});

const go = (opts) => cutover({ root: f.root, now: () => NOW, fx: cfx(), log: f.log, ...opts });
const steps = () => f.calls.map(([k]) => k);

describe('snapshotTime', () => {
  it('reads the instant from a db:backup file name', () => {
    expect(snapshotTime('students-20260923T005328Z.db').toISOString()).toBe('2026-09-23T00:53:28.000Z');
    expect(snapshotTime('students.db')).toBe(null);
  });
});

describe('cutover', () => {
  it('stops, restores, verifies, restarts, then enables backups and publishes — in that order', async () => {
    const snap = snapshotAt(new Date('2026-09-23T06:20:00Z'), ['AP CSP', 'Robotics']);

    const result = await go({ snapshotPath: snap });

    expect(steps()).toEqual(['stop', 'start', 'health', 'backup', 'serve']);
    expect(f.calls[2]).toEqual(['health', releaseSha(f.root, currentRelease(f.root))]);
    expect(sha256(f.p.db)).toBe(sha256(snap));
    expect(result.restored).toBe(snapshotName(new Date('2026-09-23T06:20:00Z')));
  });

  // Review Focus 5 — the Sep 22 trap.
  it('refuses a snapshot that was not taken just now, and says how to override', async () => {
    const snap = snapshotAt(new Date('2026-09-22T05:41:06Z'));
    await expect(go({ snapshotPath: snap })).rejects.toThrow(/hours old[\s\S]*--allow-old/);
    expect(steps()).toEqual([]);
  });

  it('accepts an old snapshot only when told to', async () => {
    const snap = snapshotAt(new Date('2026-09-22T05:41:06Z'));
    await go({ snapshotPath: snap, allowOld: true });
    expect(steps()).toContain('serve');
  });

  it('never falls back to the newest snapshot in a folder', async () => {
    snapshotAt(new Date('2026-09-23T06:20:00Z'));
    await expect(go({})).rejects.toThrow(/--snapshot/);
  });

  it('refuses a file that is not a db:backup snapshot', async () => {
    const odd = sqliteWith(join(snapDir, 'students.db'), ['x']);
    await expect(go({ snapshotPath: odd })).rejects.toThrow(/not a db:backup snapshot/);
  });

  // Review Focus 5 — something already wrote real data to prod.
  it('refuses when the prod database already holds courses', async () => {
    sqliteWith(f.p.db, ['written before cutover']);
    const snap = snapshotAt(new Date('2026-09-23T06:20:00Z'));
    await expect(go({ snapshotPath: snap })).rejects.toThrow(/already holds 1 course/);
    expect(steps()).toEqual([]);
  });

  it('lists every blocker at once', async () => {
    facts.certDomains = [];
    facts.ssh = false;
    const snap = snapshotAt(new Date('2026-09-20T00:00:00Z'));
    const err = await go({ snapshotPath: snap }).catch((e) => e);
    expect(err.problems).toHaveLength(3);
    expect(err.message).toMatch(/HTTPS Certificates/);
    expect(err.message).toMatch(/Remote Login/);
  });

  it('a dry run checks everything and changes nothing', async () => {
    const snap = snapshotAt(new Date('2026-09-23T06:20:00Z'));
    const result = await go({ snapshotPath: snap, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(steps()).toEqual([]);
  });

  // Review Focus 5 — never publish or back up a server that did not come back.
  it('does not enable backups or publish when the server is unhealthy after the restore', async () => {
    f.healthy = () => false;
    const snap = snapshotAt(new Date('2026-09-23T06:20:00Z'));
    await expect(go({ snapshotPath: snap })).rejects.toThrow(/did not come back healthy/);
    expect(steps()).toEqual(['stop', 'start', 'health']);
  });

  it('warns — but does not refuse — while tailnet key expiry is on', async () => {
    facts.keyExpiry = '2027-03-12T15:11:00Z';
    const snap = snapshotAt(new Date('2026-09-23T06:20:00Z'));
    const result = await go({ snapshotPath: snap, dryRun: true });
    expect(result.warnings.join(' ')).toMatch(/2027-03-12/);
  });
});

describe('cutoverProblems', () => {
  it('passes a fresh snapshot on a ready machine', () => {
    expect(
      cutoverProblems({
        snapshotPath: '/x/students-20260923T062000Z.db', snapshotExists: true, nowMs: NOW.getTime(),
        allowOld: false, prodCourseCount: 0, certDomains: ['a'], sshListening: true,
      }),
    ).toEqual([]);
    expect(MAX_SNAPSHOT_AGE_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe('mcpCommands', () => {
  it('gives both machines an absolute DB_PATH and a spelled-out node', () => {
    const { mini, laptop } = mcpCommands();
    expect(mini).toMatch(/-e DB_PATH=\/Users\/gnolan\/prism\/data\/students\.db/);
    expect(laptop).toMatch(/ssh gnolan@macmini '.*\/usr\/local\/bin\/node mcp\/server\.js'/);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, `./cutover.js` not found.

- [ ] **Step 3: Implement `scripts/deploy/cutover.js`**

```js
#!/usr/bin/env node
/**
 * The cutover runbook as a script (spec §1 "Cutover"). Run on the mini, by the
 * owner, once the laptop is quiet:
 *
 *   1. on the laptop: stop the dev server and every Claude session with prism
 *      loaded; npm run db:backup; wait for OneDrive to sync it
 *   2. on the mini:   node ~/prism/current/scripts/deploy/cutover.js --snapshot <that file>
 *
 * It refuses to guess the snapshot, refuses one that was not taken just now
 * (restoring an old one silently drops every change since, and integrity_check
 * still passes), refuses to overwrite a prod database that already holds data,
 * and publishes nothing until the restored server answers.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { isMain } from '../../server/lib/isMain.js';
import { SNAPSHOT_RE } from '../db-backup.js';
import { restore } from '../db-restore.js';
import { currentRelease, paths, releaseSha } from './lib.js';

export const MAX_SNAPSHOT_AGE_MS = 6 * 60 * 60 * 1000;

/** `students-20260923T005328Z.db` → its instant; null for anything else. */
export function snapshotTime(name) {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  const s = m[1];
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
}

export function cutoverProblems({ snapshotPath, snapshotExists, nowMs, allowOld, prodCourseCount, certDomains, sshListening }) {
  const problems = [];
  if (!snapshotPath) {
    problems.push(
      'Pass --snapshot <file>: the snapshot taken on the laptop for this cutover. The script never picks ' +
        '"the newest in the folder" — an old one would silently drop every change made since.',
    );
  } else if (!snapshotExists) {
    problems.push(`Snapshot not found: ${snapshotPath}`);
  } else {
    const taken = snapshotTime(basename(snapshotPath));
    if (!taken) {
      problems.push(`${basename(snapshotPath)} is not a db:backup snapshot (students-YYYYMMDDTHHMMSSZ.db).`);
    } else if (nowMs - taken.getTime() > MAX_SNAPSHOT_AGE_MS && !allowOld) {
      const hours = Math.round((nowMs - taken.getTime()) / 3_600_000);
      problems.push(
        `That snapshot is ${hours} hours old. Cutover needs one taken just now: stop the laptop's writers, ` +
          'run npm run db:backup there, and pass the new file. --allow-old overrides.',
      );
    }
  }
  if (prodCourseCount > 0) {
    problems.push(
      `The prod database already holds ${prodCourseCount} course(s) — something wrote real data to it before ` +
        'cutover. Refusing to overwrite it; find out what first.',
    );
  }
  if (!certDomains?.length) {
    problems.push('HTTPS Certificates are not enabled on the tailnet: Tailscale admin console → DNS → enable HTTPS Certificates.');
  }
  if (!sshListening) {
    problems.push(
      'Remote Login is off, so the laptop cannot reach PrisMCP over SSH: System Settings → General → Sharing → Remote Login.',
    );
  }
  return problems;
}

export function cutoverWarnings({ keyExpiry }) {
  return keyExpiry
    ? [`Tailnet key expiry is on for this node (expires ${keyExpiry.slice(0, 10)}); when it lapses the mini drops off the tailnet. Admin console → Machines → macmini → Disable key expiry.`]
    : [];
}

export function mcpCommands() {
  return {
    mini:
      'claude mcp remove prism -s user; claude mcp add prism -s user -e DB_PATH=/Users/gnolan/prism/data/students.db ' +
      '-- /usr/local/bin/node /Users/gnolan/prism/current/mcp/server.js',
    laptop:
      'claude mcp remove prism -s user; claude mcp add prism -s user -- ssh gnolan@macmini ' +
      "'cd ~/prism/current && DB_PATH=$HOME/prism/data/students.db /usr/local/bin/node mcp/server.js'",
  };
}

function countCourses(dbPath) {
  if (!existsSync(dbPath)) return 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare('SELECT COUNT(*) AS n FROM courses').get().n;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function integrity(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.pragma('integrity_check', { simple: true });
  } finally {
    db.close();
  }
}

export async function cutover({ root, snapshotPath, allowOld = false, dryRun = false, now = () => new Date(), fx, log = () => {} }) {
  const p = paths(root);
  const problems = cutoverProblems({
    snapshotPath,
    snapshotExists: Boolean(snapshotPath) && existsSync(snapshotPath),
    nowMs: now().getTime(),
    allowOld,
    prodCourseCount: countCourses(p.db),
    certDomains: fx.certDomains(),
    sshListening: fx.sshListening(),
  });
  const warnings = cutoverWarnings({ keyExpiry: fx.keyExpiry() });
  if (problems.length) {
    const err = new Error(`Cutover preconditions failed:\n${problems.map((x) => `  - ${x}`).join('\n')}`);
    err.problems = problems;
    err.warnings = warnings;
    throw err;
  }

  const liveSha = releaseSha(root, currentRelease(root));
  if (!liveSha) throw new Error('No release is deployed yet — run npm run prism:install first.');

  if (dryRun) {
    return {
      dryRun: true,
      warnings,
      steps: ['stop the server', `restore ${basename(snapshotPath)} into ${p.db}`, 'verify sha-256 and integrity_check',
        'start the server and wait for it to answer', 'load the nightly backup agent', 'tailscale serve --bg 3001'],
    };
  }

  log('stopping the prod server');
  fx.stopServer();
  const restored = await restore({ dbPath: p.db, snapshotFile: snapshotPath, force: true });
  if (sha256(p.db) !== sha256(snapshotPath)) {
    throw new Error('The restored database does not match the snapshot byte for byte. The server is left STOPPED.');
  }
  const ic = integrity(p.db);
  if (ic !== 'ok') throw new Error(`integrity_check returned "${ic}". The server is left STOPPED.`);
  log(`restored ${restored.snapshot}; sha-256 and integrity_check ok`);

  log('starting the prod server');
  fx.startServer();
  if (!(await fx.healthCheck(liveSha))) {
    throw new Error('The server did not come back healthy after the restore. Nothing was published. See ~/prism/logs/server.log.');
  }

  fx.loadBackupAgent();
  log('nightly backup agent loaded');
  fx.serve();
  log('published on the tailnet');
  return { restored: restored.snapshot, warnings, mcp: mcpCommands() };
}

if (isMain(import.meta.url)) {
  const root = process.env.PRISM_ROOT || join(homedir(), 'prism');
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const { cutoverEffects } = await import('./effects.js');
  try {
    const r = await cutover({
      root,
      snapshotPath: arg('--snapshot'),
      allowOld: process.argv.includes('--allow-old'),
      dryRun: process.argv.includes('--dry-run'),
      fx: cutoverEffects(root),
      log: console.log,
    });
    for (const w of r.warnings) console.warn(`WARNING: ${w}`);
    if (r.dryRun) {
      console.log(`Preconditions pass. A real run would:\n${r.steps.map((s) => `  - ${s}`).join('\n')}`);
    } else {
      console.log(
        '\nThe mini is now master. The laptop copy is disposable dev data: do not run db:backup there again.\n' +
          `\nOn the mini:\n  ${r.mcp.mini}\n\nOn the laptop:\n  ${r.mcp.laptop}\n`,
      );
    }
  } catch (err) {
    console.error(err.message);
    for (const w of err.warnings ?? []) console.warn(`WARNING: ${w}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Verify** — `npx vitest run scripts/deploy/cutover.test.js` → PASS (13). Full suite green.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/cutover.js scripts/deploy/cutover.test.js
git commit -m "feat(deploy): the cutover runbook as a script, with a dry run" \
  -m "Refuses to guess the snapshot, refuses one not taken at cutover, refuses a prod DB that already holds data, verifies sha-256 and integrity_check, and publishes nothing until the restored server answers." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: launchd agents and the one-time install

**Files:**
- Create: `scripts/deploy/launchd.js`, `scripts/deploy/launchd.test.js`, `scripts/deploy/install.js`
- Modify: `package.json` (add `"prism:install": "node scripts/deploy/install.js"` after `db:refresh`)

**Interfaces:**
- Consumes: `paths`, `LABELS` (lib), `deploy`, `deployEffects`, `load`, `unload`, `launchAgentPath` (effects).
- Produces: `PATH_ENV`, `NODE_BIN = '/usr/local/bin/node'`, `renderPlist(dict) => string`, `agents({ home, node? }) => { server, deploy, backup }`, `installPlan({ home, node? }) => { dirs: string[], files: {path, content}[], reload: string[] }`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agents, installPlan, renderPlist, NODE_BIN } from './launchd.js';

const HOME = '/Users/gnolan';

const allStrings = (v) =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(allStrings) : v && typeof v === 'object' ? Object.values(v).flatMap(allStrings) : [];

describe('renderPlist', () => {
  it('renders a launchd property list, escaping XML', () => {
    const xml = renderPlist({ Label: 'a&b', Args: ['<x>'], N: 30, On: true, Env: { K: 'v' } });
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
    expect(xml).toContain('<key>Label</key>');
    expect(xml).toContain('<string>a&amp;b</string>');
    expect(xml).toContain('<string>&lt;x&gt;</string>');
    expect(xml).toContain('<integer>30</integer>');
    expect(xml).toContain('<true/>');
    expect(xml).toMatch(/<key>Env<\/key>\s*<dict>\s*<key>K<\/key>\s*<string>v<\/string>/);
  });
});

describe('agents', () => {
  const a = agents({ home: HOME });

  it('uses only absolute paths — launchd does not expand ~', () => {
    for (const agent of Object.values(a)) {
      for (const s of allStrings(agent).filter((x) => x.includes('/'))) {
        expect(s.startsWith('/'), s).toBe(true);
        expect(s.includes('~'), s).toBe(false);
      }
    }
  });

  it('runs node from the stable Homebrew link, not a versioned Cellar path', () => {
    expect(NODE_BIN).toBe('/usr/local/bin/node');
    expect(a.server.ProgramArguments[0]).toBe('/usr/local/bin/node');
  });

  it('keeps the server on loopback with everything stateful in ~/prism/data', () => {
    const env = a.server.EnvironmentVariables;
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PORT).toBe('3001');
    expect(env.DB_PATH).toBe(`${HOME}/prism/data/students.db`);
    expect(env.PRISM_SESSION_DIR).toBe(`${HOME}/prism/data/.playwright-session`);
    expect(env.INBOX_DIR).toBe(`${HOME}/prism/data/inbox`);
    expect(a.server.WorkingDirectory).toBe(`${HOME}/prism/current`);
    expect(a.server.KeepAlive).toBe(true);
  });

  it('polls every 30 seconds from the live release', () => {
    expect(a.deploy.StartInterval).toBe(30);
    expect(a.deploy.ProgramArguments[1]).toBe(`${HOME}/prism/current/scripts/deploy/deploy.js`);
  });

  it('backs up nightly from the live release', () => {
    expect(a.backup.StartCalendarInterval).toEqual({ Hour: 2, Minute: 0 });
    expect(a.backup.EnvironmentVariables.DB_PATH).toBe(`${HOME}/prism/data/students.db`);
  });
});

// Review Focus 4.
describe('installPlan', () => {
  const plan = installPlan({ home: HOME });

  it('installs the server and deploy agents into LaunchAgents', () => {
    const agentsDir = `${HOME}/Library/LaunchAgents/`;
    expect(plan.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([`${agentsDir}com.prism.server.plist`, `${agentsDir}com.prism.deploy.plist`]),
    );
  });

  it('stages the backup agent OUTSIDE LaunchAgents and never loads it before cutover', () => {
    const backup = plan.files.find((f) => f.path.endsWith('com.prism.backup.plist'));
    expect(backup.path).toBe(`${HOME}/prism/launchd/com.prism.backup.plist`);
    expect(plan.files.some((f) => f.path.includes('LaunchAgents') && f.path.includes('backup'))).toBe(false);
    expect(plan.reload).not.toContain('com.prism.backup');
  });
});

describe('plutil', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'prism-plist-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it.skipIf(process.platform !== 'darwin')('accepts all three plists', () => {
    for (const f of installPlan({ home: HOME }).files) {
      const file = join(tmp, f.path.split('/').pop());
      writeFileSync(file, f.content);
      const res = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
      expect(res.status, res.stdout + res.stderr).toBe(0);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, `./launchd.js` not found.

- [ ] **Step 3: Implement `scripts/deploy/launchd.js`**

```js
/**
 * The three launchd agents, rendered as property lists.
 *
 * Agents, not daemons: FileVault is on, so nothing runs until someone unlocks
 * the disk at startup — and that unlock logs them in, which starts the agents.
 * A daemon would start no sooner, and mastery re-login needs the GUI session.
 */
import { join } from 'node:path';
import { LABELS, paths } from './lib.js';

/** Homebrew's stable link. process.execPath resolves to Cellar/node/<version>, which the next upgrade deletes. */
export const NODE_BIN = '/usr/local/bin/node';

/** launchd starts agents with a bare PATH; npm, git, gh, tar and tailscale live in these. */
export const PATH_ENV = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function node(value, pad) {
  const inner = `${pad}  `;
  if (typeof value === 'string') return `${pad}<string>${esc(value)}</string>`;
  if (typeof value === 'number') return `${pad}<integer>${value}</integer>`;
  if (typeof value === 'boolean') return `${pad}<${value}/>`;
  if (Array.isArray(value)) return `${pad}<array>\n${value.map((v) => node(v, inner)).join('\n')}\n${pad}</array>`;
  const entries = Object.entries(value).map(([k, v]) => `${inner}<key>${esc(k)}</key>\n${node(v, inner)}`);
  return `${pad}<dict>\n${entries.join('\n')}\n${pad}</dict>`;
}

export function renderPlist(dict) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">\n${node(dict, '')}\n</plist>\n`
  );
}

export function agents({ home, node: nodeBin = NODE_BIN }) {
  const p = paths(join(home, 'prism'));
  const log = (name) => join(p.logs, name);
  return {
    server: {
      Label: LABELS.server,
      ProgramArguments: [nodeBin, join(p.current, 'server', 'index.js')],
      WorkingDirectory: p.current,
      EnvironmentVariables: {
        PATH: PATH_ENV,
        HOST: '127.0.0.1',
        PORT: '3001',
        DB_PATH: p.db,
        PRISM_SESSION_DIR: join(p.data, '.playwright-session'),
        INBOX_DIR: join(p.data, 'inbox'),
      },
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 10,
      StandardOutPath: log('server.log'),
      StandardErrorPath: log('server.log'),
    },
    deploy: {
      Label: LABELS.deploy,
      ProgramArguments: [nodeBin, join(p.current, 'scripts', 'deploy', 'deploy.js')],
      WorkingDirectory: p.root,
      EnvironmentVariables: { PATH: PATH_ENV, PRISM_ROOT: p.root },
      StartInterval: 30,
      RunAtLoad: true,
      StandardOutPath: log('deploy.log'),
      StandardErrorPath: log('deploy.log'),
    },
    backup: {
      Label: LABELS.backup,
      ProgramArguments: [nodeBin, join(p.current, 'scripts', 'db-backup.js')],
      // PRISM_BACKUP_DIR comes from data/.env, reached through the release's .env link.
      WorkingDirectory: p.current,
      EnvironmentVariables: { PATH: PATH_ENV, DB_PATH: p.db },
      StartCalendarInterval: { Hour: 2, Minute: 0 },
      StandardOutPath: log('backup.log'),
      StandardErrorPath: log('backup.log'),
    },
  };
}

export function installPlan({ home, node: nodeBin = NODE_BIN }) {
  const p = paths(join(home, 'prism'));
  const a = agents({ home, node: nodeBin });
  const agentsDir = join(home, 'Library', 'LaunchAgents');
  return {
    dirs: [p.releases, p.data, p.logs, p.launchd, agentsDir],
    files: [
      { path: join(agentsDir, `${LABELS.server}.plist`), content: renderPlist(a.server) },
      { path: join(agentsDir, `${LABELS.deploy}.plist`), content: renderPlist(a.deploy) },
      // Staged, NOT in LaunchAgents: anything there is loaded at the next login.
      // Before cutover prod's database is empty, and an empty nightly snapshot
      // would become the newest file in _prism-data — the one the laptop's
      // db:restore picks. cutover.js installs and loads it.
      { path: join(p.launchd, `${LABELS.backup}.plist`), content: renderPlist(a.backup) },
    ],
    reload: [LABELS.server, LABELS.deploy],
  };
}
```

- [ ] **Step 4: Verify** — `npx vitest run scripts/deploy/launchd.test.js` → PASS (10; the `plutil` test runs on macOS, skips on Linux).

- [ ] **Step 5: Implement `scripts/deploy/install.js`** (a CLI; exercised live in Part B)

```js
#!/usr/bin/env node
/**
 * One-time bring-up of prod on this Mac; safe to re-run. Run from a dev clone:
 *
 *   npm run prism:install -- --env-from ~/repos/prism/.env
 *
 * Creates ~/prism, clones the repo, copies the secrets to ~/prism/data/.env
 * (never overwriting), writes the launchd agents, deploys the current CI-green
 * main as the first release, and starts the server and the deploy poller.
 *
 * It does NOT restore a database, load the backup agent, or publish on the
 * tailnet — those are cutover (scripts/deploy/cutover.js).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isMain } from '../../server/lib/isMain.js';
import { deploy } from './deploy.js';
import { REPO_SLUG, deployEffects, load, unload } from './effects.js';
import { installPlan } from './launchd.js';
import { currentRelease, LABELS, paths } from './lib.js';

async function main() {
  const home = homedir();
  const root = join(home, 'prism');
  const p = paths(root);
  const i = process.argv.indexOf('--env-from');
  const envFrom = i > -1 ? process.argv[i + 1] : undefined;
  const log = (m) => console.log(m);

  const plan = installPlan({ home });
  for (const dir of plan.dirs) mkdirSync(dir, { recursive: true });

  if (!existsSync(p.repo)) {
    log(`cloning ${REPO_SLUG} into ${p.repo}`);
    execFileSync('git', ['clone', '--quiet', `https://github.com/${REPO_SLUG}.git`, p.repo], { stdio: 'inherit' });
  }

  if (!existsSync(p.env)) {
    if (!envFrom) throw new Error(`${p.env} does not exist. Re-run with --env-from <path to a .env with the Schoology keys>.`);
    copyFileSync(envFrom, p.env);
    chmodSync(p.env, 0o600);
    log(`secrets copied to ${p.env} (mode 600)`);
  }

  for (const f of plan.files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
  }
  log('launchd agents written');

  if (!currentRelease(root)) {
    log('first deploy (origin/main must be CI-green)');
    const r = await deploy({ root, fx: deployEffects(root), log });
    if (r.action !== 'deployed') throw new Error(`The first deploy did not complete: ${JSON.stringify(r)}`);
  } else {
    unload(LABELS.server);
    load(LABELS.server);
  }

  unload(LABELS.deploy);
  load(LABELS.deploy);

  log(
    `\nprod is up on http://127.0.0.1:3001 (loopback only) serving ${currentRelease(root)}` +
      '\nThe database is EMPTY until cutover. Nothing is published on the tailnet and the nightly backup is not loaded.' +
      '\nLogs: ~/prism/logs/{server,deploy}.log',
  );
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
```

Add to `package.json` scripts, after `"db:refresh"`:

```json
    "prism:install": "node scripts/deploy/install.js",
```

- [ ] **Step 6: Verify** — `node -e "import('./scripts/deploy/install.js')"` → exits 0 with no output (imports cleanly; `isMain` false, so nothing runs). Full suite green.

- [ ] **Step 7: Commit**

```bash
git add scripts/deploy/launchd.js scripts/deploy/launchd.test.js scripts/deploy/install.js package.json
git commit -m "feat(deploy): launchd agents and the one-time install on the mini" \
  -m "The backup agent is staged outside LaunchAgents and loaded only at cutover: an empty pre-cutover snapshot would otherwise become the newest file the laptop's db:restore picks." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Documentation

**Files:**
- Create: `docs/deploy.md`
- Modify: `AGENTS.md`, `CONTEXT.md`, `docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md`

- [ ] **Step 1: Write `docs/deploy.md`**

````markdown
# Deploying Prism

Operations guide for prod on the home Mac mini. Design and rationale:
`docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md`, ADR 0003.
Vocabulary: `CONTEXT.md`.

## How a change reaches prod

1. Push to `main`.
2. GitHub Actions runs `.github/workflows/ci.yml` — server, MCP, script and
   client tests, then the client build. **The file name matters**: the mini
   asks GitHub for *that workflow's* verdict on the exact commit.
3. Every 30s the `com.prism.deploy` agent fetches `origin/main`. A new,
   CI-green commit is exported into `~/prism/releases/<UTC stamp>-<sha7>/`,
   gets `npm ci` (root + client) and a client build, and only then becomes
   `~/prism/current`. The server agent restarts, and the new commit must
   answer `GET /api/version` within 30s — otherwise `current` swaps back.
4. The three newest releases are kept, plus the live one and its predecessor.

The sidebar badge shows the short sha that is answering `/api`.

A commit that fails CI is re-checked each tick (a re-run can turn it green).
A commit that fails to build, fails its health check, or is rolled back is
**not** retried; push a fix, or:

```bash
node ~/prism/current/scripts/deploy/deploy.js --force
```

## Rollback

```bash
node ~/prism/current/scripts/deploy/rollback.js
```

Points `current` at the previous release and restarts it (~2s, no rebuild).
It also **pauses auto-deploy** at whatever `main` is, so the poller does not
redeploy what you just rolled back. The pause lifts when a new commit lands
on `main`, or with `deploy.js --force`. If `rollback.js` in the live release
is itself broken, every release has its own copy:
`node ~/prism/releases/<older>/scripts/deploy/rollback.js`.

## Where things are

| | |
|---|---|
| `~/prism/current` | symlink to the live release — never edit anything under `releases/` |
| `~/prism/data/students.db` | the database (`DB_PATH`) |
| `~/prism/data/.env` | Schoology keys + `PRISM_BACKUP_DIR`, mode 600; linked into each release |
| `~/prism/data/.playwright-session` | Schoology browser session (`PRISM_SESSION_DIR`) |
| `~/prism/logs/{server,deploy,backup}.log` | logs; not rotated yet |
| `~/prism/deploy-state.json` | the poller's memory: last deploy, any rejection or pause |
| `~/Library/LaunchAgents/com.prism.{server,deploy}.plist` | the agents |
| `~/prism/launchd/com.prism.backup.plist` | staged; cutover installs it |

The server binds `127.0.0.1:3001`. A dev clone on the mini must use another
port: `PORT=3002 npm run dev`.

## Everyday commands

```bash
launchctl print gui/$(id -u)/com.prism.server | head -20   # state, pid, last exit
launchctl kickstart -k gui/$(id -u)/com.prism.server       # restart prod
curl -s 127.0.0.1:3001/api/version                          # what is live
tail -f ~/prism/logs/deploy.log
```

## Restarts

FileVault is on, so after a restart nothing runs until someone enters the
password at the startup screen; that unlock logs in, and the agents start.
For a planned restart (e.g. macOS updates) skip the prompt once with
`sudo fdesetup authrestart`.

## Schoology session expired

Mastery sync fails with a clear error; the rest of the app keeps working.
Screen-share into the mini and run:

```bash
cd ~/prism/current && PRISM_SESSION_DIR=$HOME/prism/data/.playwright-session npm run mastery:login
```

## First-time install

From a dev clone on the mini, with `origin/main` CI-green:

```bash
npm run prism:install -- --env-from ~/repos/prism/.env
```

Re-runnable. It brings prod up on an **empty** database, loopback only.

## Cutover

Makes the mini the master. Until then the laptop is master and the mini's
prod database is empty and unpublished.

**Once, beforehand:**
- Tailscale admin console → DNS → enable **HTTPS Certificates**. *(Done 2026-09-23.)*
- Tailscale admin console → Machines → macmini → **Disable key expiry**. *(Done 2026-09-23.)*
- On the mini: System Settings → General → Sharing → **Remote Login** on (the
  laptop reaches PrisMCP over SSH).

**On the day:**
1. Laptop: stop the dev server and every Claude session with `prism` loaded.
2. Laptop: `npm run db:backup`, and wait for OneDrive to sync the file to the mini.
3. Mini: check first, then run:
   ```bash
   node ~/prism/current/scripts/deploy/cutover.js --dry-run --snapshot ~/Library/CloudStorage/OneDrive-HongKongInternationalSchool/_prism-data/students-<stamp>.db
   node ~/prism/current/scripts/deploy/cutover.js           --snapshot ~/Library/CloudStorage/OneDrive-HongKongInternationalSchool/_prism-data/students-<stamp>.db
   ```
4. Run the two `claude mcp` commands it prints — one on the mini, one on the laptop.
5. From then on: open `https://macmini.swordtail-everest.ts.net`, and **never run
   `db:backup` on the laptop again** — its copy is disposable dev data, refreshed
   with `npm run db:refresh`.

The script refuses a snapshot older than 6 hours (`--allow-old` overrides), refuses
to overwrite a prod database that already has courses, verifies sha-256 and
`integrity_check`, and publishes nothing until the restored server answers.
````

- [ ] **Step 2: Update `AGENTS.md`**

Replace the Key References line that begins `- **Hosting + deploy topology — decided 2026-09-23, NOT yet built**:` (the whole bullet) with:

```markdown
- **Hosting + deploy — built 2026-09-23, pre-cutover**: `docs/deploy.md` (operations), `docs/adr/0003-prism-served-from-a-home-server-over-tailscale.md` and `docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md` (design). The pipeline runs on the Mac mini — push to `main` deploys — but until cutover prod's database is empty and unpublished and the **laptop is still master**. Don't write code or docs that assume the mini holds the real data yet. `CONTEXT.md` holds the vocabulary (prod / release / dev clone / snapshot / cutover).
```

Replace `Optional local overrides: \`PORT\`, \`DB_PATH\` (default \`server/db/students.db\`), \`INBOX_DIR\`, \`CONFIG_PATH\`.` with:

```markdown
Optional local overrides: `PORT`, `HOST` (default `127.0.0.1`), `DB_PATH` (default `server/db/students.db`), `PRISM_SESSION_DIR`, `INBOX_DIR`, `CONFIG_PATH`, `PRISM_SKIP_BROWSERS`. PrisMCP additionally **requires** an absolute `DB_PATH` and is configured per machine — see `docs/prismcp-install-and-verify.md`.
```

- [ ] **Step 3: Update `CONTEXT.md`** — replace `Once built, these terms are canonical:` with `These terms are canonical (the pipeline is built; cutover has not happened yet):`, and after the **snapshot** bullet add:

```markdown
- **cutover** — the one-time step that makes prod the master: the laptop's
  writers stop, it takes a fresh snapshot, and `scripts/deploy/cutover.js`
  restores exactly that snapshot into prod, verifies it, and publishes prod on
  the tailnet. Before cutover the laptop is master; after it, the laptop's copy
  is a disposable dev clone.
```

- [ ] **Step 4: Update the spec** — mark prerequisite rows 7 and 8 **Done** 2026-09-23 (row 8: "Node, not `deploy.sh`: `scripts/deploy/*.js`, testable with Vitest"); in **Open items** strike the resolved ones (prod root `~/prism/`; backups → OneDrive; agent, per the FileVault reasoning; the `.mcp.json` item, done by Task 2); in **Provisioning status** correct the auto-login paragraph to the FileVault reasoning and add the three cutover prerequisites (HTTPS certs, key expiry, Remote Login). Add a short "Found while building" list: the symlink-blind CLI guard, `INBOX_DIR` and `.env` living inside the release, and project-scope `.mcp.json` outranking user scope.

- [ ] **Step 5: Commit**

```bash
git add docs/deploy.md AGENTS.md CONTEXT.md docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md
git commit -m "docs: operations guide for the deploy pipeline; pre-cutover status everywhere" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**End of Part A.** Final whole-branch review (fresh reviewer, most capable model) and fix pass happen here, then the branch is merged fast-forward into `main` and pushed — the owner approved "merge to main and push" as the integration for this work.

---

# Part B — live, after the merge

### Task 12: CI green on GitHub

- [ ] **Step 1:** After the push, find and watch the run:

```bash
gh run list --workflow ci.yml --limit 1
gh run watch "$(gh run list --workflow ci.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```
Expected: green. This is the first run on Linux: a red run here (case-sensitive import, missing native build tool) is fixed forward with a commit on `main`, never by skipping a test.

- [ ] **Step 2:** Confirm what the poller will see: `node -e "import('./scripts/deploy/effects.js').then(m => console.log(m.ciStatus(process.argv[1])))" "$(git rev-parse origin/main)"` → `success`.

### Task 13: Bring prod up on the mini

- [ ] **Step 1:** From `~/repos/prism` (now at `main`): `npm run prism:install -- --env-from .env`. Expected: clone, secrets copied, agents written, first deploy logs `deployed <id>`, final message says loopback + empty DB.

- [ ] **Step 2: Verify, all of it:**

```bash
curl -s 127.0.0.1:3001/api/version                        # sha = origin/main, mode "release"
lsof -nP -iTCP:3001 -sTCP:LISTEN                          # 127.0.0.1:3001 only
launchctl print gui/$(id -u)/com.prism.server | grep -E "state|pid"
launchctl print gui/$(id -u)/com.prism.deploy | grep -E "state|run interval"
ls ~/Library/LaunchAgents/com.prism.*                      # server + deploy ONLY
ls ~/prism/launchd/                                        # backup staged here
stat -f "%Sp %N" ~/prism/data/.env                         # -rw-------
readlink ~/prism/releases/*/.env                           # ../../data/.env
tail -5 ~/prism/logs/deploy.log; tail -5 ~/prism/logs/server.log
tailscale serve status                                     # "No serve config"
```

- [ ] **Step 3:** Confirm the poller really runs through the symlink (Review Focus 1, live): within 60s `deploy.log` shows one `noop: up to date at <sha7>` line. No line at all means the entry guard is not firing — stop and debug.

### Task 14: Prove the pipeline end to end

- [ ] **Step 1: Auto-deploy.** Record Part B's results so far in `.claude/build-progress.md`, commit, push. Watch CI, then `deploy.log`. Expected: `deploying <new sha7>` within ~30s of CI finishing, then `deployed <id>`; `curl 127.0.0.1:3001/api/version` shows the new sha. Note the wall time from push to live.

- [ ] **Step 2: Rollback sticks.** `node ~/prism/current/scripts/deploy/rollback.js` → `/api/version` shows the previous sha. Wait 90s: still the previous sha, and `deploy.log` has one `rejected at rollback` line.

- [ ] **Step 3: Force resumes.** `node ~/prism/current/scripts/deploy/deploy.js --force` → `/api/version` back at `main`.

- [ ] **Step 4: Cutover dry run on real facts.**

```bash
node ~/prism/current/scripts/deploy/cutover.js --dry-run --snapshot "$(ls ~/Library/CloudStorage/OneDrive-HongKongInternationalSchool/_prism-data/students-*.db | sort | tail -1)"
```
Expected: refuses, listing exactly the blockers that are true today — the snapshot is hours old, and Remote Login is off (unless the owner has enabled it by then). HTTPS Certificates were enabled and key expiry disabled on 2026-09-23, so neither appears. Nothing is stopped or changed; `curl` still answers.

- [ ] **Step 5:** Append the results (timings, what each check showed) to `.claude/build-progress.md` and the spec's Provisioning status; commit and push — the poller deploys this commit too, one more live confirmation.
