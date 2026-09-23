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
  acquireLock, appendHistory, currentRelease, decide, listReleases, paths, planPrune,
  readState, releaseId, releaseLock, releaseSha, swapSymlink, writeState,
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
  let state = readState(root);

  // A deploy that was interrupted (reboot, bootout, Ctrl-C, a crash) is
  // finished or cleaned up before anything else — otherwise a release that
  // was swapped in but never health-checked looks "up to date" forever.
  if (state.pending) {
    const resumed = await resumePending({ root, state, fx, now, log });
    if (resumed) return resumed;
    state = readState(root);
  }

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

  // Recorded before anything touches disk, so the next tick can finish or undo it.
  const pending = { id, sha: remoteSha, previousId, previousSha: deployedSha };
  state = { ...state, pending };
  writeState(root, state);

  try {
    fx.exportTree(remoteSha, dir);
    writeFileSync(join(dir, 'release.json'), `${JSON.stringify({ sha: remoteSha, builtAt: at.toISOString() }, null, 2)}\n`);
    // Secrets live outside the release; dotenv reads .env from the working directory.
    symlinkSync(join('..', '..', 'data', '.env'), join(dir, '.env'));
    fx.install(dir);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    log(`build FAILED for ${remoteSha.slice(0, 7)}; live release untouched: ${firstLine(err)}`);
    writeState(root, { ...state, pending: null, lastNote: null, rejected: { sha: remoteSha, stage: 'build', at: at.toISOString() } });
    return { action: 'failed', stage: 'build' };
  }

  swapSymlink(p.current, join('releases', id));
  return verify({ root, state, fx, now, log, ...pending });
}

/** Restart and wait for `sha` to answer. A restart that throws counts as unhealthy. */
async function restartAndCheck(fx, sha, log) {
  try {
    fx.restart();
    return await fx.healthCheck(sha);
  } catch (err) {
    log(`restart failed: ${firstLine(err)}`);
    return false;
  }
}

/**
 * `current` already points at `id`: keep it only if `sha` answers, otherwise put
 * `previousId` back and delete `id` — a release that failed its health check
 * must never be a rollback target.
 */
async function verify({ root, state, fx, now, log, id, sha, previousId, previousSha }) {
  const p = paths(root);
  const at = now().toISOString();

  if (await restartAndCheck(fx, sha, log)) {
    const history = appendHistory(state.history ?? [], id);
    for (const stale of planPrune(listReleases(root), { currentId: id, history })) {
      rmSync(join(p.releases, stale), { recursive: true, force: true });
    }
    writeState(root, { history, rejected: null, pending: null, lastNote: null, deployed: { sha, id, at } });
    log(`deployed ${id}`);
    return { action: 'deployed', id };
  }

  log(`health check FAILED for ${id}`);
  if (previousId) {
    swapSymlink(p.current, join('releases', previousId));
    const back = await restartAndCheck(fx, previousSha, log);
    log(back ? `rolled back to ${previousId}` : `ROLLBACK TO ${previousId} ALSO UNHEALTHY — prod is down`);
    rmSync(join(p.releases, id), { recursive: true, force: true });
  } else {
    log('no previous release to roll back to — prod is down');
  }
  writeState(root, { ...state, pending: null, lastNote: null, rejected: { sha, stage: 'health', at } });
  return { action: 'rolled-back', to: previousId };
}

async function resumePending({ root, state, fx, now, log }) {
  const pending = state.pending;
  if (currentRelease(root) === pending.id) {
    log(`resuming the interrupted deploy of ${pending.id}`);
    return verify({ root, state, fx, now, log, ...pending });
  }
  // Interrupted before the swap: that directory was never live.
  rmSync(join(paths(root).releases, pending.id), { recursive: true, force: true });
  writeState(root, { ...state, pending: null });
  log(`discarded ${pending.id}, left behind by an interrupted deploy`);
  return null;
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
