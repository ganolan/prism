#!/usr/bin/env node
// Live parity check for #141: the Settings "Schoology connection" liveness check,
// browser vs plain HTTP, on the saved session. Read only: one GET of /home each way.
// "browser" = the pre-#141 checkSessionLive (kept here verbatim: a headless page
// with the saved state opens /home, still on the school domain = connected).
// "http" = the shipped checkSessionLive (schoologyWeb.getResource with the saved
// cookies; a bounce to sign-in renews once through Microsoft).
// Output: the answer and wall time each way, the final path and status. No cookies.
// Usage (repo root): PRISM_SESSION_DIR=<copy of the session dir> node --env-file=.env scripts/parity-session-live.js [runs]
import { existsSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';
import { sessionStateFile } from '../server/lib/sessionPaths.js';
import { checkSessionLive } from '../server/services/schoologySession.js';

if (!existsSync(sessionStateFile())) { console.error('No saved session'); process.exit(1); }
const runs = Math.max(1, Number(process.argv[2]) || 3);

// ── The pre-#141 browser check, verbatim from schoologySession.js ──
async function browserCheck() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: sessionStateFile() });
    const page = await context.newPage();
    let navError = null;
    await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => { navError = err; });
    const url = page.url();
    if (isLoggedInUrl(url)) return { live: 'connected' };
    if (navError || !url || url.startsWith('about:') || url.startsWith('chrome-error:')) {
      return { live: 'unknown', message: `Could not reach Schoology${navError ? ` (${navError.message})` : ''}` };
    }
    return { live: 'expired', message: 'Schoology sent the saved session to the login page' };
  } finally {
    await browser.close().catch(() => {});
  }
}

const time = async (fn) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };
const rows = { browser: [], http: [] };
for (let i = 0; i < runs; i++) {
  const b = await time(browserCheck);
  const h = await time(checkSessionLive);
  rows.browser.push(b); rows.http.push(h);
  console.log(`run ${i + 1}: browser ${b.r.live} ${b.ms} ms | http ${h.r.live} ${h.ms} ms${h.r.message ? ` (${h.r.message})` : ''}`);
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const same = rows.browser.every((b, i) => b.r.live === rows.http[i].r.live);
console.log(`median: browser ${median(rows.browser.map((x) => x.ms))} ms, http ${median(rows.http.map((x) => x.ms))} ms`);
console.log(same ? 'PARITY OK: same answer every run' : 'PARITY DIFFERS');
process.exit(same ? 0 : 1);
