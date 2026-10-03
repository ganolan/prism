// The saved Schoology browser session (npm run mastery:login / POST /api/mastery/login):
// opening a headless page with it, and a cached "is it still live?" check for the
// Settings "Schoology connection" card, the Sync dialog and the Ask modal's unsubmit
// option (Phase 2, LTI unsubmit on Ask).
//
// Liveness is one cheap authenticated page load ({SCHOOLOGY_BASE}/home → still on the
// school domain, not bounced to SSO), as the probes do — never the cookie-expiry
// timestamps, which read "expired" long before the Drupal session dies (AGENTS.md).
// Best-effort, never throws: a check that can't tell (the page didn't load, the browser
// didn't start) reports 'unknown' with a message — only a bounce to the login / SSO page
// is 'expired'.
//
// Playwright is imported lazily (see masterySync.js: a top-level import can hang boot).
import { existsSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { sessionStateFile } from '../lib/sessionPaths.js';

export const LIVE_CHECK_TTL_MS = 10 * 60 * 1000;

export const hasSessionFile = () => existsSync(sessionStateFile());

// A headless page carrying the saved session → { page, close }, or null when there is
// no saved session at all. The caller must await close().
export async function openSessionPage() {
  const file = sessionStateFile();
  if (!existsSync(file)) return null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: file });
    const page = await context.newPage();
    return { page, close: () => browser.close() };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

// Swappable for tests (never launch a real browser there): every caller here and in
// ltiUnsubmit.js opens its page through sessionDeps.openPage.
export const sessionDeps = { openPage: openSessionPage };

// → { live: 'connected' | 'expired' | 'unknown', message? }. 'expired' only when the
// saved session (or its absence) lands on a real non-school page (login / SSO);
// a navigation error or about:blank is 'unknown'. Throws if the browser can't start.
export async function checkSessionLive() {
  const s = await sessionDeps.openPage();
  if (!s) return { live: 'expired', message: 'No saved Schoology session' };
  try {
    let navError = null;
    await s.page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => { navError = err; });
    const url = s.page.url();
    if (isLoggedInUrl(url)) return { live: 'connected' };
    if (navError || !url || url.startsWith('about:') || url.startsWith('chrome-error:')) {
      return { live: 'unknown', message: `Could not reach Schoology${navError ? ` (${navError.message})` : ''}` };
    }
    return { live: 'expired', message: 'Schoology sent the saved session to the login page' };
  } finally {
    await s.close().catch(() => {});
  }
}

let cache = null; // { live: 'connected' | 'expired', checkedAt (ISO), at (ms), message }
let inflight = null;

// Record what a real Schoology call just learned about the session (e.g. an unsubmit
// bounced to SSO → 'expired'), so the cards don't keep saying "Connected".
export function noteSessionLive(live, message = null, now = Date.now()) {
  cache = { live, checkedAt: new Date(now).toISOString(), at: now, message };
}

export function resetSessionStatusCache() {
  cache = null;
  inflight = null;
}

const view = (loggedIn) => ({
  loggedIn,
  live: cache?.live ?? null,
  checkedAt: cache?.checkedAt ?? null,
  ...(cache?.message ? { message: cache.message } : {}),
});

// → { loggedIn (session file exists), live: 'connected' | 'expired' | 'unknown' | 'none' | null,
//     checkedAt, message? }. 'none' = no saved session (no browser launched).
// The live check is cached for LIVE_CHECK_TTL_MS; refresh forces one; check: false
// never launches a browser (live = the cached answer, or null if never checked).
// Concurrent callers share one in-flight check. Never throws.
export async function sessionStatus({ refresh = false, check = true, hasSession = hasSessionFile, now = Date.now } = {}) {
  let loggedIn = false;
  try { loggedIn = Boolean(hasSession()); } catch { loggedIn = false; }
  if (!loggedIn) return { loggedIn: false, live: 'none', checkedAt: null };
  const fresh = cache && now() - cache.at < LIVE_CHECK_TTL_MS;
  if (!check || (fresh && !refresh)) return view(true);
  if (!inflight) {
    inflight = (async () => {
      try {
        const r = await checkSessionLive();
        noteSessionLive(r.live, r.message ?? null, now());
      } catch (err) {
        noteSessionLive('unknown', `Could not check the Schoology session: ${err.message}`, now());
      } finally {
        inflight = null;
      }
    })();
  }
  await inflight;
  return view(true);
}
