#!/usr/bin/env node
/**
 * The deploy watcher: the one long-running process launchd keeps for Prism's
 * pipeline (com.prism.deploy). Every 30s it runs tick.js as a fresh process
 * from ~/prism/current — so each tick runs the live release's code — and a
 * tick that hangs is killed after ten minutes; the next tick's deploy finishes
 * or undoes whatever it was doing.
 *
 * Deliberately tiny and never exits. While the GUI domain is in on-demand-only
 * mode launchd will not restart it, so nothing a tick does may end the loop.
 * Changes to this file take effect at the next login or `npm run prism:install`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../server/lib/isMain.js';
import { paths } from './lib.js';
import { NODE_BIN } from './launchd.js';

export const TICK_MS = 30_000;
export const TICK_TIMEOUT_MS = 10 * 60_000;

/** This watcher's own tick.js — the stand-in when the live release has none. */
export const OWN_TICK = join(dirname(fileURLToPath(import.meta.url)), 'tick.js');

/**
 * The live release's tick.js, resolved afresh each time. A rollback to a release
 * from before the watcher existed would otherwise end supervision.
 */
export function tickScript(root, fallback = OWN_TICK) {
  const live = join(paths(root).current, 'scripts', 'deploy', 'tick.js');
  return existsSync(live) ? live : fallback;
}

export async function watch({ runTick, sleep, log, iterations = Infinity }) {
  for (let i = 0; i < iterations; i++) {
    try {
      await runTick();
    } catch (err) {
      log(`tick failed: ${String(err?.message ?? err).split('\n')[0]}`);
    }
    if (i + 1 < iterations) await sleep(TICK_MS);
  }
}

/**
 * Run one tick as its own process group, so a tick that overruns is killed
 * together with its npm and vite children — they would otherwise keep writing
 * into a release directory the next tick deletes.
 */
export function runTickProcess(script, { cwd, timeoutMs = TICK_TIMEOUT_MS, log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const node = existsSync(NODE_BIN) ? NODE_BIN : process.execPath;
    const child = spawn(node, [script], { cwd, env: process.env, stdio: 'inherit', detached: true });
    const timer = setTimeout(() => {
      log(`tick exceeded ${Math.round(timeoutMs / 1000)}s — killing it`);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`tick exited with ${signal ?? `code ${code}`}`));
    });
  });
}

if (isMain(import.meta.url)) {
  const root = process.env.PRISM_ROOT || join(homedir(), 'prism');
  const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
  log('deploy watcher started');
  await watch({
    runTick: () => runTickProcess(tickScript(root), { cwd: root, log }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
  });
}
