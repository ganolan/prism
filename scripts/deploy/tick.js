#!/usr/bin/env node
/**
 * One supervision tick, run every 30s by watch.js as a fresh process from
 * ~/prism/current — so the logic here is always the live release's.
 *
 *   1. watchdog  — if /api/version misses three probes in a row, kickstart the server.
 *   2. deploy    — one deploy.js tick (CI-gated build, swap, health check).
 *   3. backup    — once a day from 02:00, kickstart the nightly backup.
 *
 * launchd does none of this itself: while the GUI domain is in on-demand-only
 * mode (observed on the mini, 2026-09-23) it holds back KeepAlive restarts and
 * timer launches, and starts a job only on explicit demand. Every launch here
 * is that kind of demand.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMain } from '../../server/lib/isMain.js';
import { acquireLock, paths, releaseLock } from './lib.js';

export const BACKUP_HOUR = 2;

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

/** YYYY-MM-DD in the machine's own timezone. */
export function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function backupDue({ now, lastBackupDate, hour = BACKUP_HOUR }) {
  return now.getHours() >= hour && lastBackupDate !== localDate(now);
}

function readWatchState(root) {
  try {
    return JSON.parse(readFileSync(paths(root).watchState, 'utf8'));
  } catch {
    return {};
  }
}

function writeWatchState(root, state) {
  writeFileSync(paths(root).watchState, `${JSON.stringify(state, null, 2)}\n`);
}

/** Missed probes in a row before a restart: a long sync can block one. */
export const MISSES_BEFORE_RESTART = 3;

/**
 * fx: { deploy, serverAnswers, restartServer, backupLoaded, startBackup }.
 * Never throws: the watcher that calls it is not restarted by launchd.
 *
 * The watchdog goes first: a deploy stuck on a stalled network is killed by
 * the watcher, and nothing after it in the tick would run.
 */
export async function superviseTick({ root, now = () => new Date(), fx, log = () => {} }) {
  const state = readWatchState(root);
  const result = {};

  // The lock keeps the watchdog out of a deploy's own restart and out of a
  // cutover that has stopped the server on purpose.
  if (!acquireLock(root)) {
    result.server = 'locked';
  } else {
    try {
      if (existsSync(paths(root).hold)) {
        result.server = 'held';
      } else if (await fx.serverAnswers()) {
        result.server = 'up';
        if (state.serverDown) log('server answering again');
        state.serverDown = false;
        state.misses = 0;
      } else {
        state.misses = (state.misses ?? 0) + 1;
        if (state.misses < MISSES_BEFORE_RESTART) {
          result.server = 'down';
        } else {
          if (!state.serverDown) log(`server not answering (${state.misses} probes) — restarting it`);
          state.serverDown = true;
          try {
            fx.restartServer();
          } catch (err) {
            log(`server restart failed: ${firstLine(err)}`);
          }
          result.server = 'restarted';
        }
      }
    } catch (err) {
      result.server = 'error';
      log(`watchdog failed: ${firstLine(err)}`);
    } finally {
      releaseLock(root);
    }
  }

  try {
    result.deploy = await fx.deploy();
  } catch (err) {
    result.deploy = { action: 'error' };
    log(`deploy tick crashed: ${firstLine(err)}`);
  }

  const today = now();
  try {
    // Loaded only by cutover: before it, prod's database is empty and an empty
    // snapshot would become the newest file the laptop's db:restore picks.
    if (!fx.backupLoaded()) {
      result.backup = 'not-loaded';
    } else if (!backupDue({ now: today, lastBackupDate: state.lastBackupDate })) {
      result.backup = 'not-due';
    } else {
      fx.startBackup();
      state.lastBackupDate = localDate(today);
      log('nightly backup started');
      result.backup = 'started';
    }
  } catch (err) {
    result.backup = 'error';
    log(`backup start failed: ${firstLine(err)}`);
  }

  writeWatchState(root, state);
  return result;
}

if (isMain(import.meta.url)) {
  const root = process.env.PRISM_ROOT || join(homedir(), 'prism');
  const { deploy } = await import('./deploy.js');
  const effects = await import('./effects.js');
  const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
  await superviseTick({
    root,
    fx: {
      deploy: () => deploy({ root, fx: effects.deployEffects(root), log }),
      serverAnswers: () => effects.serverAnswers(),
      restartServer: effects.restartServer,
      backupLoaded: effects.backupLoaded,
      startBackup: effects.startBackup,
    },
    log,
  });
}
