/**
 * The deploy's side effects, kept apart from its logic so tests can replace
 * them. Everything here shells out to a real tool. Only parseCiRuns and
 * healthCheck are unit-tested; the rest is exercised by the live bring-up.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, openSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LABELS, paths } from './lib.js';

export const REPO_SLUG = process.env.PRISM_REPO || 'ganolan/prism';
export const CI_WORKFLOW = 'ci.yml';
export const VERSION_URL = 'http://127.0.0.1:3001/api/version';
/** Bound on every network call a tick makes, so a stalled connection cannot hang it. */
export const NET_TIMEOUT_MS = 60_000;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

export function fetchMain(repoDir) {
  run('git', ['-C', repoDir, 'fetch', '--quiet', 'origin', 'main'], { timeout: NET_TIMEOUT_MS });
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
  const out = run('gh', ['api', `repos/${REPO_SLUG}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&per_page=20`], {
    timeout: NET_TIMEOUT_MS,
  });
  return parseCiRuns(JSON.parse(out), sha);
}

/** True if anything answers /api/version at all — the watchdog's liveness check. */
export async function serverAnswers({ url = VERSION_URL, timeoutMs = 10_000 } = {}) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).ok;
  } catch {
    return false;
  }
}

/** Poll /api/version until `expectSha` is the commit answering, or give up. */
export async function healthCheck(expectSha, { url = VERSION_URL, timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      // Each request is bounded too: a server that accepts and never replies
      // would otherwise hold this past its deadline.
      const signal = AbortSignal.timeout(Math.max(250, Math.min(5000, deadline - Date.now())));
      const res = await fetch(url, { signal });
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

/** Unload and wait until launchd has let go — bootout can return before it has. */
export function unload(label) {
  if (!isLoaded(label)) return;
  run('launchctl', ['bootout', `${domain()}/${label}`]);
  for (let i = 0; i < 50 && isLoaded(label); i++) spawnSync('sleep', ['0.2']);
}

/**
 * Load and start. The start is an explicit kickstart because, while the GUI
 * domain is in on-demand-only mode (observed on the mini, 2026-09-23), launchd
 * holds back RunAtLoad, KeepAlive and timer launches — only demand starts a job.
 */
export function start(label) {
  load(label);
  run('launchctl', ['kickstart', `${domain()}/${label}`]);
}

export function restartServer() {
  load(LABELS.server);
  run('launchctl', ['kickstart', '-k', `${domain()}/${LABELS.server}`]);
}

export const backupLoaded = () => isLoaded(LABELS.backup);

export function isRunning(label) {
  const r = spawnSync('launchctl', ['print', `${domain()}/${label}`], { encoding: 'utf8' });
  return r.status === 0 && /\bstate = running\b/.test(r.stdout);
}

export function startBackup() {
  run('launchctl', ['kickstart', `${domain()}/${LABELS.backup}`]);
}

// ---- tailnet ----
function tailscaleStatus() {
  try {
    return JSON.parse(run('tailscale', ['status', '--json']));
  } catch {
    return {};
  }
}

export function certDomains() {
  return tailscaleStatus().CertDomains ?? [];
}

/**
 * The node's key expiry, or null. Both shapes observed 2026-09-23: enabled →
 * Self.KeyExpiry = "2027-03-12T15:11:00Z"; disabled → the field is absent.
 */
export function keyExpiry() {
  const value = tailscaleStatus().Self?.KeyExpiry;
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** True if something on `host` accepts a TCP connection on `port`. */
export function portAccepts(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Is Remote Login (sshd) on? Checked with a real connection: launchd starts
 * sshd on demand as root, and an unprivileged `lsof` never sees that socket —
 * it reported "off" while Remote Login was on (observed 2026-09-24).
 */
export function sshListening() {
  return portAccepts(22);
}

/** The Tailscale Service prod is published as: https://prism.<tailnet>.ts.net. */
export const TAILNET_SERVICE = 'svc:prism';

/**
 * Publish prod on the tailnet as its own Tailscale Service (since 2026-09-25),
 * not on the machine's own name. Needs the host tagged (tag:server) and the
 * service defined + the host approved in the admin console — see docs/deploy.md.
 */
export function serve(port = 3001) {
  run('tailscale', ['serve', `--service=${TAILNET_SERVICE}`, '--https=443', `127.0.0.1:${port}`]);
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
    // A bare bootstrap never starts a job while the domain is on-demand-only.
    startServer: () => start(LABELS.server),
    healthCheck: (sha) => healthCheck(sha),
    loadBackupAgent: () => {
      copyFileSync(join(p.launchd, `${LABELS.backup}.plist`), launchAgentPath(LABELS.backup));
      load(LABELS.backup);
    },
    serve: () => serve(3001),
  };
}
