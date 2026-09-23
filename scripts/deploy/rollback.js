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
