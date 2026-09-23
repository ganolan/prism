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
  releaseSha, rollbackTarget, swapSymlink, writeState,
} from './lib.js';

export async function rollback({ root, fx, now = () => new Date(), log = () => {} }) {
  if (!acquireLock(root)) throw new Error('A deploy is running. Try again in a minute.');
  try {
    const state = readState(root);
    const history = state.history ?? [];
    const from = currentRelease(root);
    if (!from) throw new Error('Nothing is deployed.');

    // The release that was live before this one — never a directory that
    // failed its health check or was itself rolled back from.
    let to = rollbackTarget(history, from);
    if (!to && history.length === 0) {
      // No deploy history (state lost): fall back to directory order.
      const releases = listReleases(root);
      const i = releases.indexOf(from);
      to = i > 0 ? releases[i - 1] : null;
      if (to) log('WARNING: no deploy history; rolling back to the previous directory by name');
    }
    if (!to) throw new Error(`No release older than ${from} to roll back to.`);

    // Pin what main is now. Offline, keep an existing rollback pin — a second
    // rollback must not unpin the commit the first one rolled away from.
    let pinned;
    try {
      pinned = fx.fetchMain();
    } catch {
      pinned = state.rejected?.stage === 'rollback' ? state.rejected.sha : releaseSha(root, from);
    }

    swapSymlink(paths(root).current, join('releases', to));
    let healthy = false;
    try {
      fx.restart();
      healthy = await fx.healthCheck(releaseSha(root, to));
    } catch (err) {
      log(`restart failed: ${String(err?.message ?? err).split('\n')[0]}`);
    }

    writeState(root, {
      ...state,
      history: history.filter((id) => id !== from),
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
