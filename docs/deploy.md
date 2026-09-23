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
4. A release that fails its health check is deleted, like one that fails to
   build. The three newest releases that went live healthy are kept, plus the
   live one and its rollback target.
5. A deploy interrupted part-way (reboot, crash) is finished or undone by the
   next tick — `~/prism/deploy-state.json` records it before anything moves.

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
| `~/prism/deploy-state.json` | the poller's memory: last deploy, any rejection or pause |
| `~/Library/LaunchAgents/com.prism.{server,deploy}.plist` | the agents |
| `~/prism/launchd/com.prism.backup.plist` | staged; cutover installs it |

The server binds `127.0.0.1:3001`. A dev clone on the mini must use another
port: `PORT=3002 npm run dev` — the Vite proxy follows `PORT`, so that UI talks
to its own API. If the dev API ever fails with `EADDRINUSE`, stop: a dev UI
started without `PORT` on the mini would be proxying to **prod**.

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
