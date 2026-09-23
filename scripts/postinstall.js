#!/usr/bin/env node
/**
 * Install the chromium build the browser-session services need.
 *
 * CI does not need it: every external service is mocked there, and the
 * download is ~150MB per run. `npm ci --ignore-scripts` is not the way out —
 * better-sqlite3 needs its own install script to produce the native binary —
 * so the opt-out is PRISM_SKIP_BROWSERS, read here.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MEANS_FALSE = new Set(['', '0', 'false', 'no']);

export function shouldInstallBrowsers(env = process.env) {
  const raw = env.PRISM_SKIP_BROWSERS;
  if (raw === undefined || raw === null) return true;
  return MEANS_FALSE.has(String(raw).trim().toLowerCase());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!shouldInstallBrowsers()) {
    console.log('PRISM_SKIP_BROWSERS set — skipping `playwright install chromium`.');
    process.exit(0);
  }
  const result = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
