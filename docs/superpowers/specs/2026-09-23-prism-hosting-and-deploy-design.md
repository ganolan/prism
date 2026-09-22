# Prism hosting + deploy pipeline — design

**Date:** 2026-09-23
**Status:** Approved, not yet implemented
**Tracks:** #121 (move Prism out of OneDrive)
**Decision record:** `docs/adr/0003-prism-served-from-a-home-server-over-tailscale.md`

## Context

Prism has been developed and run out of a OneDrive-synced folder, with the work
laptop as master and the home machine holding a drifted second copy. #121
documents why that is unsafe. On 2026-09-23 the last blocker on that issue
(work VPN vs Tailscale) cleared: Tailscale from the work network to a home Mac
mini is reliable.

That makes a single always-on instance possible, which in turn dissolves the
two-master database problem the issue has been managing around all year.

Two facts observed in the code shape everything below:

- **Prism has no authentication.** No auth middleware; `app.use(cors())` with no
  origin restriction; `app.listen(PORT)` with no host argument, so Express binds
  every interface. Acceptable for a process started and stopped on a laptop;
  not acceptable for a service running continuously.
- **The test suite is fully self-contained.** All external services are mocked
  (`vi.mock` on `syncOrchestrator`, `masterySync`, `schoology`); the only
  credential reference is `SCHOOLOGY_CONSUMER_KEY ||= 'test-key'`. 471 server
  tests run in ~5s with no `.env`, no network, no browser session. This is what
  makes a cloud test gate viable.

## Decisions

1. The Mac mini at home is the single production instance and holds the one
   authoritative database.
2. The tailnet is the security perimeter. No application auth is added. The
   server binds loopback and is published by `tailscale serve`, so the tailnet
   is the only route in.
3. Push to `main` deploys automatically, gated on CI passing.
4. Tests run on GitHub's cloud runners, never on the mini. The mini polls and
   pulls; it accepts no inbound connections and runs no GitHub-dispatched code.
5. The production checkout is machine-owned. Deploys write it; humans never
   edit it.
6. PrisMCP runs on the mini over SSH (option A). Migrating it to an HTTP client
   (option B) is explicitly wanted later — see "Deferred".

## Section 1 — the production service

### Layout

```
~/prism/
  repo/                        git clone, only ever fetched into
  releases/
    20260923-1e96c01/          checkout + node_modules + client/dist
    20260922-716b36e/          previous release, retained for rollback
  current -> releases/20260923-1e96c01
  data/
    students.db                DB_PATH points here
    .playwright-session/       PRISM_SESSION_DIR points here
  logs/
    server.log, deploy.log
```

`data/` sitting outside `releases/` is load-bearing. A deploy swaps the
`current` symlink; the database and the Schoology browser session are never in
the blast radius. Rollback is the symlink pointed back one release plus a
restart — no rebuild, ~2s.

Dev clones live at `~/repos/prism` — the same path on every machine, so
docs and configs need no per-machine branching. Deliberately **not** under
`~/Documents`: the work laptop is school-managed, where OneDrive Known Folder
Move redirects `~/Documents` into OneDrive, which would silently undo this whole
migration behind a path that still looks local. `readlink ~/Documents` on a new
machine says whether it is redirected. `~/repos` sits at the home-directory root
where neither OneDrive KFM nor iCloud Desktop & Documents sync reaches.

The production root is likewise **not** under `~/Documents`. That folder is a real
local directory today (verified: not a symlink into iCloud, no CloudDocs
xattrs, no `.icloud` placeholders), but the `CLOUDDESKTOP` data class is active
on the account, so Desktop & Documents sync is one settings toggle away from
turning it into a synced folder — re-arming the exact failure #121 documents.

### Service

A launchd **agent** (`com.prism.server`) runs `node ~/prism/current/server/index.js`
with `KeepAlive`, `DB_PATH=/Users/gnolan/prism/data/students.db`,
`PRISM_SESSION_DIR=/Users/gnolan/prism/data/.playwright-session`, `PORT=3001`,
`HOST=127.0.0.1`. **Absolute paths throughout** — launchd does not expand `~`,
and a plist that silently resolves `DB_PATH` to a relative path is the
open-the-wrong-database failure this design is trying to eliminate.

An agent rather than a daemon, deliberately: mastery re-login needs a real GUI
session for headed Chromium. The mini therefore needs auto-login and
`pmset` configured never to sleep — one decision serving both.

### Network

- `server/index.js`: `app.listen(PORT, HOST)` with `HOST` defaulting to
  `127.0.0.1`, overridable by env.
- `tailscale serve` publishes it at `https://<mini>.<tailnet>.ts.net` with a
  real certificate — HTTPS the app would not otherwise have.
- Disable key expiry on the mini's tailnet node, or it silently drops off the
  tailnet in ~180 days.

### Cutover

First deploy restores the verified snapshot
(`_prism-data/students-20260922T054106Z.db`, `integrity_check` ok, SHA-256
verified) into `~/prism/data/students.db`. From that moment the mini is master,
the laptop copy demotes to disposable dev data, and the OneDrive master on the
work laptop can be retired — the last unticked box on #121.

### Backups

Nightly `npm run db:backup` on a launchd timer, `PRISM_BACKUP_DIR` pointed at
OneDrive on the mini. This is not a contradiction of "the database never lives
in a cloud-synced folder": a *snapshot* is a consistent single-file copy with no
`-wal`/`-shm` sidecars and nothing writing to it, which is exactly what sync
tools handle safely. The prohibition is on the **live** trio. This keeps the data inside the school's M365 boundary and
lets the laptop pick up fresh snapshots through existing machinery. If OneDrive
is not signed in on the mini, fall back to a local folder plus Time Machine and
have the laptop pull over Tailscale.

## Section 2 — the deploy pipeline

### CI (GitHub-hosted)

`.github/workflows/ci.yml`, on push to `main` and on PRs: install, run the 471
server tests and 432 client tests on `ubuntu-latest`. Free — the repo is public.
GitHub's default failure email covers notification.

**Gotcha:** `postinstall` runs `npx playwright install chromium` (~150MB), which
CI does not need — every external service is mocked. It cannot be skipped with
`--ignore-scripts`, because `better-sqlite3` needs its install script for the
native binary. Add a `PRISM_SKIP_BROWSERS` guard to `postinstall` and set it in
the workflow.

Pin `setup-node` to the same Node major the mini runs.

### CD (mini-side poller)

launchd job `com.prism.deploy`, `StartInterval 30`:

1. `git ls-remote origin main` → SHA. Same as deployed? Exit.
2. Different? Query GitHub for that SHA's CI conclusion. Pending → exit, retry
   next tick. Failed → log, change nothing.
3. Green → check out into `releases/<date>-<sha>/`, `npm ci` (root + client),
   build the client, **then** swap `current` and restart.
4. Health-check `http://127.0.0.1:3001/api/features`. No healthy response within
   a few seconds → repoint the symlink, restart, log loudly.
5. Prune to the last three releases.

Building before the swap means a commit that passes cloud tests but fails to
build on the mini never becomes live.

Poll authenticated (`gh auth` on the mini): unauthenticated GitHub API is 60
requests/hour, and a 30s interval is 120.

### Observability

Add `GET /api/version` returning the deployed SHA and build time, surfaced small
in the UI. Without it, "is my push live?" is answered by squinting at behaviour;
it also makes a failed deploy visible in the app rather than only in a log.

### Rollback

`prism-rollback`: repoint `current` to the previous release, restart. For the
case automation cannot catch — tests pass and it is still wrong.

## Section 3 — the development workflow

```
work laptop                          mac mini (home)
─────────────────                    ─────────────────────────────
~/repos/prism                        ~/prism/current      :3001  ← prod, tailnet only
  npm run dev        :3001+:5173     ~/prism/data/        students.db + session
  own disposable DB                  ~/repos/prism           :3002 ← optional dev clone
  works offline
        │                                        │
        └──── git push main ──→ GitHub ──────────┘  (CI green → mini pulls)
```

**Mode 1 — local loop (default).** Full stack on the laptop against its own
database, works offline, cannot touch prod. Refresh from the nightly snapshot.

**Mode 2 — editing on the mini.** A separate clone at `~/repos/prism`
on the mini, `PORT=3002`, its own DB copy, driven by a Claude Code
remote-control session. Reach it with `ssh -L 3002:localhost:3002` — ephemeral,
and it keeps the dev server off the tailnet surface. `~/prism/` is never
hand-edited.

**Mode 3 — local UI against live prod.** Vite locally, `/api` proxied to the
tailnet URL. Real current data for frontend work. **Writes land in real student
records** — use knowingly.

### `db:refresh`

`db:restore` refuses when the local DB is newer than the snapshot. Correct for a
two-master handoff; wrong now that the laptop is disposable, and it would fire
on every refresh. Add `npm run db:refresh` (restore, no guard) for dev machines
and leave `db:restore` guarded for genuine handoffs.

**Blocking bug:** `db-restore.js` copies the snapshot over `students.db` without
removing `students.db-wal` / `-shm`. SQLite may then replay a WAL belonging to a
different database over the restored file; the documented outcome is corruption.
The mtime guard does not cover it — a stale *older* local DB passes the guard and
keeps its foreign WAL. Must be fixed before `db:refresh` ships, since it moves
from a once-a-year operation to a weekly one.

### When the Schoology session expires

Syncs run on the mini regardless of which machine clicked the button — one
session, one database, no coordination. On expiry the sync fails with the
existing clear error; both orchestrated paths already pass
`allowInteractiveLogin: false` (`server/services/sync.js:599`,
`server/services/syncOrchestrator.js:103`), so nothing opens an invisible
browser window. Only mastery sync is affected; the rest of the app is fine.

To fix: screen-share into the mini over Tailscale and run `npm run mastery:login`
with `PRISM_SESSION_DIR` set to the prod path.

### Failure modes

| Failure | Response |
|---|---|
| Bad deploy | `prism-rollback` — 2s, no rebuild |
| Session expired | Sync fails loudly; rest of app unaffected; re-login when convenient |
| Mini down or asleep | Laptop's dev copy is a working Prism on last night's data — degraded but usable |

## Section 4 — PrisMCP

PrisMCP reads and writes the database **directly** (`mcp/server.js:5` imports
`getDb`); it never uses HTTP. Nothing in `mcp/` loads dotenv, so `DB_PATH` is not
read from `.env` — it resolves to the default relative to whatever repo the
process was launched from.

Left alone, the grading workflow would fail silently and destructively: an MCP
server on the laptop would open the laptop's **disposable dev database**,
`write_student_suggestions` and `upsert_assessment_analysis` would report
success, and `db:refresh` would overwrite the results.

SQLite's multi-process safety is a same-host guarantee — WAL lets the prod
server and a grading process share one file safely, and offers nothing over a
network mount. So the process moves to the data, not the reverse.

**Decision: run PrisMCP on the mini over SSH.** MCP is a stdio protocol and does
not care that the pipe runs through SSH:

```json
{
  "command": "ssh",
  "args": ["<mini-tailnet-name>", "cd ~/prism/current && DB_PATH=$HOME/prism/data/students.db node mcp/server.js"]
}
```

(`<mini-tailnet-name>` is the mini's MagicDNS name or an SSH host alias; unlike
the launchd plist, this command runs through a login shell, so `~` and `$HOME`
do expand.)

Claude, the grading plugin and the prompts all stay on the laptop; only the
database-touching process moves. Writes land in prod. PrisMCP never touches
Express, so **grading works while prod is down or mid-deploy**.

Configure this **user-scoped on the laptop**, not by editing the committed
`.mcp.json` — that file is the correct default for a clone running beside its own
database, and rewriting it would make a session on the mini SSH to itself.

Costs: ~1s spawn latency; a tailnet drop kills the MCP server and needs a
restart; `DB_PATH` must be explicit in the command.

**Guard, regardless:** PrisMCP should fail loudly at startup rather than open a
database nobody meant — require `DB_PATH` explicitly, or check the resolved path
against an expected marker. The silent-write-to-scratch-copy failure is the worst
outcome in this design and deserves a guard rather than a convention.

## Prerequisite code changes

| # | Change | Why |
|---|---|---|
| 1 | `server/index.js`: `HOST` env, default `127.0.0.1` | Tailnet becomes the only route in |
| 2 | `masterySync.js:31`: `PRISM_SESSION_DIR` env | Session currently resolves via `process.cwd()`, so it lives inside a release and is lost on every deploy |
| 3 | `scripts/db-restore.js`: remove stale `-wal`/`-shm` before copy, with a test | Foreign-WAL corruption |
| 4 | `package.json`: `db:refresh`; `PRISM_SKIP_BROWSERS` guard in `postinstall` | Dev refresh ergonomics; CI speed |
| 5 | `GET /api/version` + UI surface | Know what is live |
| 6 | `mcp/server.js`: explicit-`DB_PATH` startup guard | Prevent silent writes to a scratch DB |
| 7 | `.github/workflows/ci.yml` | The test gate |
| 8 | `scripts/deploy.sh` + launchd plists (server, deploy poller, nightly backup) | The pipeline |

## Deferred

- **PrisMCP as an HTTP client over the tailnet (option B).** The architecturally
  correct end state: no SSH hop, works from any machine on the tailnet, and the
  MCP server stops needing filesystem access to student data. Requires HTTP
  endpoints for `write_student_suggestions`, `upsert_assessment_analysis`,
  `write_rubric` and `attach_rubric` — some of which do not exist yet — plus
  tests. **Wanted; own project.**
- Automated parity probes against a live Schoology session. Cannot run on cloud
  runners (no session, and those credentials should not be in Actions secrets).
  If wanted, they run as a scheduled job on the mini.
- Application-level auth. Not needed while the tailnet is the perimeter.
  Revisit only if Prism is ever reachable from outside it.

## Open items

- Production root path: `~/prism/` (assumed), `~/services/prism/`, or
  `/usr/local/var/prism`.
- `PRISM_BACKUP_DIR` on the mini: OneDrive (preferred) or local + Time Machine,
  depending on whether OneDrive is signed in there.
