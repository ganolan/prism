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
export const HISTORY_MAX = 20;

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
    // The watcher's own memory, apart from deploy-state.json (which a deploy rewrites whole).
    watchState: join(root, 'watch-state.json'),
    // Present while the server must stay down (a cutover in progress, or one that failed).
    hold: join(root, 'server.hold'),
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
 * Where a rollback from `currentId` goes: the release that was live before it,
 * per the deploy history — never merely the previous directory by name, which
 * may be a release that failed its health check or was itself rolled back.
 * When the live release is not in the history, the newest one that is.
 */
export function rollbackTarget(history = [], currentId) {
  const i = history.lastIndexOf(currentId);
  if (i > 0) return history[i - 1];
  if (i === -1 && history.length) return history[history.length - 1];
  return null;
}

/** Record `id` as the newest release that went live and answered healthy. */
export function appendHistory(history = [], id) {
  return [...history.filter((h) => h !== id), id].slice(-HISTORY_MAX);
}

/**
 * Release ids to delete. Keeps the live release, its rollback target, and the
 * newest `keep` releases that were ever live and healthy; everything else goes,
 * including directories that never became live (a build interrupted by a crash,
 * a release that failed its health check). Deciding by history rather than by
 * name is what stops a run of failed deploys from pruning away the last release
 * that actually worked.
 */
export function planPrune(releases, { currentId, history = [], keep = KEEP_RELEASES }) {
  const keepers = new Set(history.slice(-keep));
  keepers.add(currentId);
  const target = rollbackTarget(history, currentId);
  if (target) keepers.add(target);
  return [...releases].sort().filter((r) => !keepers.has(r));
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
