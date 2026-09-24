# Deploying Prism

Operations guide for prod on the home Mac mini. Design and rationale:
`docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md`, ADR 0003.
Vocabulary: `CONTEXT.md`.

## How a change reaches prod

1. Push to `main`.
2. GitHub Actions runs `.github/workflows/ci.yml` — server, MCP, script and
   client tests, then the client build. **The file name matters**: the mini
   asks GitHub for *that workflow's* verdict on the exact commit.
3. Every 30s the deploy watcher (`com.prism.deploy`, `watch.js`) runs a tick
   from the live release, which fetches `origin/main`. A new,
   CI-green commit is exported into `~/prism/releases/<UTC stamp>-<sha7>/`,
   gets `npm ci` (root + client) and a client build, and only then becomes
   `~/prism/current`. The server agent restarts, and the new commit must
   answer `GET /api/version` within 30s — otherwise `current` swaps back.
4. A release that fails its health check is deleted, like one that fails to
   build. The three newest releases that went live healthy are kept, plus the
   live one and its rollback target.
5. A deploy interrupted part-way (reboot, crash) is finished or undone by the
   next tick — `~/prism/deploy-state.json` records it before anything moves.

The sidebar badge shows the short sha that is answering `/api`.

## The watcher, and why launchd isn't trusted to supervise

Observed on the mini (2026-09-23): while it sits unattended, launchd puts the
GUI domain in **on-demand-only mode** (`log show … | grep "on-demand-only"`).
In that mode it holds back `RunAtLoad`, `KeepAlive` restarts and timer launches,
and starts a job only on explicit demand. So nothing here relies on those:

- the watcher is the one long-running process; each 30s tick deploys, then
  **restarts the server if `/api/version` stops answering**, then (after
  cutover) starts the nightly backup once a day from 02:00 — every launch a
  `launchctl kickstart`, which is demand;
- the watchdog restarts only after **three missed probes in a row** (~90s): a
  long sync can block the server for one, and restarting would kill it;
- the watchdog keeps its hands off while a deploy or cutover holds
  `~/prism/deploy.lock`, and while `~/prism/server.hold` exists (cutover writes
  it and removes it only on success). **Deploys and rollbacks refuse while the
  hold exists, too** — it means the database has not been vouched for.
- a tick that runs past ten minutes is killed with its whole process tree; a
  build interrupted twice is not retried until a new commit or `--force`.

**If the watcher is not running**, nothing deploys or restarts:
`launchctl kickstart gui/$(id -u)/com.prism.deploy`. Changes to `watch.js`
take effect at the next login or `npm run prism:install`; everything a tick
does (`tick.js`, `deploy.js`) updates with each deploy.

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

Points `current` at the release that was live before this one — per the
deploy history, so never one that failed its health check or was itself rolled
back from — and restarts it (~2s, no rebuild).
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
| `~/prism/deploy-state.json` | the deploy's memory: history, last deploy, any rejection or pause, an interrupted deploy |
| `~/prism/watch-state.json` | the watcher's memory: server down?, last backup date |
| `~/prism/server.hold` | while present, the watchdog will not restart the server |
| `~/Library/LaunchAgents/com.prism.{server,deploy}.plist` | the agents |
| `~/prism/launchd/com.prism.backup.plist` | staged; cutover installs it |

The server binds `127.0.0.1:3001`. A dev clone on the mini must use another
port: `PORT=3002 npm run dev` — the Vite proxy follows `PORT`, so that UI talks
to its own API. If the dev API ever fails with `EADDRINUSE`, stop: a dev UI
started without `PORT` on the mini would be proxying to **prod**.

## The address: a Tailscale Service

Prod is published as **`https://prism.swordtail-everest.ts.net`** — a Tailscale
Service with its own tailnet address, not the machine's own name (since
2026-09-25). What that rests on, all in the Tailscale admin console:

- the mini is a **tagged** device (`tag:server`) — Services can only be hosted
  by tagged devices. (Consequence: Taildrop to the mini no longer works.)
- the policy file has `"tag:server": ["autogroup:admin"]` in `tagOwners`, and
  grants `autogroup:member` → `svc:prism` on 443 and → `tag:server` on `*`
  (the second keeps SSH to the mini working for PrisMCP from the laptop);
- the `prism` service is defined (Services → Advertise → Define a Service,
  port `tcp:443`) and macmini is **approved** as its host.

On the mini: `tailscale serve --service=svc:prism --https=443 127.0.0.1:3001`
(`tailscale serve status` shows it). Prism has **no login**: whoever is on the
tailnet can see student data, so never add other users or share the mini, and
never `tailscale funnel` it.

## Everyday commands

```bash
launchctl print gui/$(id -u)/com.prism.server | head -20   # state, pid, last exit
launchctl print gui/$(id -u)/com.prism.deploy | grep -E "state|pid"  # the watcher is alive
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

Re-runnable. It brings prod up on an **empty** database, loopback only, and
fails loudly if the deploy watcher does not stay running.

**Upgrading an install from before the watcher** (a live release with no
`scripts/deploy/watch.js`): first let the old agent deploy the new commit —
`launchctl kickstart gui/$(id -u)/com.prism.deploy`, wait for `deployed` in
`~/prism/logs/deploy.log` and the new sha from `curl -s 127.0.0.1:3001/api/version`
— then re-run install from a dev clone at that same commit. Install refuses
until the live release has the watcher.

## Cutover

**Done 2026-09-24.** The mini is master. Kept here as a record, and for a
rebuild onto new hardware.

**Once, beforehand:**
- **Prove the mini comes back on its own:** `sudo fdesetup authrestart`, then
  after it is back check `launchctl print gui/$(id -u)/com.prism.deploy` and
  `…/com.prism.server` both say `state = running`, and `curl` answers. If either
  is not running after the restart, stop — see "If the watcher is not running"
  above — and fix that before cutover.
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
5. From then on: open `https://prism.swordtail-everest.ts.net`, and **never run
   `db:backup` on the laptop again** — its copy is disposable dev data, refreshed
   with `npm run db:refresh`.

The script refuses a snapshot older than 6 hours (`--allow-old` overrides), refuses
to overwrite a prod database that already has courses, verifies sha-256 and
`integrity_check`, and publishes nothing until the restored server answers.
