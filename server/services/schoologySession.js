// The saved Schoology browser session (npm run mastery:login / POST /api/mastery/login):
// opening a headless page with it, and a cached "is it still live?" check for the
// Settings "Schoology connection" card, the Sync dialog and the Ask modal's unsubmit
// option (Phase 2, LTI unsubmit on Ask).
//
// Liveness is one cheap authenticated GET of {SCHOOLOGY_BASE}/home over plain HTTP
// with the saved cookies (schoologyWeb.getResource, #141: no browser), never the
// cookie-expiry timestamps, which read "expired" long before the Drupal session
// dies (AGENTS.md). When Schoology sends it to sign-in, getResource renews the
// session once through Microsoft (renewSession, below) and asks again, so a lapsed
// Schoology cookie with a remembered Microsoft sign-in reads 'connected'.
// Best-effort, never throws: a check that can't tell (Schoology not reached, or an
// error status) reports 'unknown' with a message; only a bounce to the login / SSO
// page that renewal cannot fix is 'expired'.
//
// Playwright is imported lazily (see masterySync.js: a top-level import can hang boot).
import { existsSync, writeFileSync, renameSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { sessionStateFile } from '../lib/sessionPaths.js';
import { cookieJar, getResource } from './schoologyWeb.js';

export const LIVE_CHECK_TTL_MS = 10 * 60 * 1000;

export const hasSessionFile = () => existsSync(sessionStateFile());

// A headless page carrying the saved session → { page, close }, or null when there is
// no saved session at all. The caller must await close().
export async function openSessionPage(file = sessionStateFile()) {
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

// Swappable for tests (never launch a real browser or reach the network there):
// every caller here and in ltiUnsubmit.js opens its page through sessionDeps.openPage;
// the liveness check reads the saved cookies through openJar and fetches with fetch.
export const sessionDeps = {
  openPage: openSessionPage,
  openJar: () => cookieJar(),
  fetch: (...args) => fetch(...args),
};

// → { live: 'connected' | 'expired' | 'unknown', message? }. 'connected' when /home
// answers 200 on the school domain; 'expired' when there is no saved session or
// Schoology sends it to the login / SSO page (after one renewal); 'unknown' when
// Schoology is not reached or answers another status. Throws only when the saved
// session file cannot be read.
export async function checkSessionLive() {
  const jar = sessionDeps.openJar();
  if (!jar) return { live: 'expired', message: 'No saved Schoology session' };
  try {
    const r = await getResource(jar, '/home', { fetchImpl: sessionDeps.fetch });
    if (r.status === 200 && isLoggedInUrl(r.url)) return { live: 'connected' };
    return { live: 'unknown', message: `Could not check the Schoology session (Schoology answered ${r.status})` };
  } catch (err) {
    if (err.code === 'SESSION_EXPIRED') return { live: 'expired', message: 'Schoology sent the saved session to the login page' };
    if (err.code === 'HTTP') return { live: 'unknown', message: err.message };
    throw err;
  }
}

// Silent renewal (#136, probed 18/10/2026): a headless browser with the saved state
// opens /home; when Schoology's own session has lapsed it is sent to Microsoft, whose
// remembered sign-in (ESTSAUTHPERSISTENT in the same state) sends it straight back
// signed in, with no input. The new cookies replace the saved file (temp file, then
// rename, so a reader never sees half a file), and plain-HTTP reads work again.
// Answers false when the browser stays at sign-in (Microsoft wants a real login),
// cannot start, or there is no saved session. Reads that expire together share one
// renewal.
const RENEW_WAIT_MS = 45000;

// Write a browser's storage state over the saved session: a temp file, then rename,
// so a reader never sees half a file.
export function saveSessionState(stateFile, state) {
  const tmp = `${stateFile}.save-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateFile);
}
let renewing = null;
export function renewSession({ stateFile = sessionStateFile(), now = Date.now } = {}) {
  renewing ??= (async () => {
    await null; // always settle after `renewing` is set, so the finally below clears it
    let s = null;
    try {
      s = await sessionDeps.openPage(stateFile);
      if (!s) return false;
      await s.page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: RENEW_WAIT_MS }).catch(() => {});
      await s.page.waitForURL((u) => isLoggedInUrl(String(u)), { timeout: RENEW_WAIT_MS }).catch(() => {});
      if (!isLoggedInUrl(s.page.url())) {
        noteSessionLive('expired', 'Microsoft asked for a sign-in: log in to Schoology in Settings', now());
        return false;
      }
      saveSessionState(stateFile, await s.page.context().storageState());
      noteSessionLive('connected', null, now());
      console.log('[schoologySession] Session renewed through Microsoft sign-in');
      return true;
    } catch (err) {
      console.warn(`[schoologySession] Could not renew the session: ${err.message}`);
      return false;
    } finally {
      await s?.close().catch(() => {});
      renewing = null;
    }
  })();
  return renewing;
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
//     checkedAt, message? }. 'none' = no saved session (nothing requested).
// The live check is cached for LIVE_CHECK_TTL_MS; refresh forces one; check: false
// never checks (live = the cached answer, or null if never checked).
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
