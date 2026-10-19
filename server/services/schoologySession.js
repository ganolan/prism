// The saved Schoology session (storage-state.json, from Settings → Log in to Schoology or
// npm run mastery:login): a cached "is it still live?" check for the Settings "Schoology
// connection" card, the Sync dialog and the Ask modal's unsubmit option, and its silent
// renewal through Microsoft (plain HTTP, #141). openSessionPage (a headless page with it)
// is kept only for the parity scripts.
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
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { sessionStateFile } from '../lib/sessionPaths.js';
import { cookieJar, getResource } from './schoologyWeb.js';
import { stateCookieJar, USER_AGENT } from '../lib/stateCookieJar.js';

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
// the liveness check and the LTI unsubmit (ltiUnsubmit.js) read the saved cookies through
// openJar, and they and the renewal fetch with fetch. openPage is left for the parity scripts.
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

// Silent renewal (#136, probed 18/10/2026; plain HTTP since #141, 19/10/2026, see
// scripts/probe-schoology-renew-http.js): GET /home with the saved state's cookies, redirects
// followed by hand. A lapsed Schoology session is sent to /login/external_accounts/send/microsoft,
// then login.windows.net and login.microsoftonline.com /oauth2/authorize, whose remembered sign-in
// (ESTSAUTHPERSISTENT in the same state) redirects straight back through app.schoology.com and the
// school's /login/external_accounts/receive/microsoft (new SESS… cookies) to /home, with no input.
// A Microsoft page that answers with an auto-submitting form instead is posted on only to a Schoology
// host. The jar drops the cookies Schoology expires (login_landing_dest=deleted would otherwise send
// the sign-in to /deleted). Landing on /home, the cookies, Microsoft's rotated ones included, replace
// the saved file's (temp file, then rename, so a reader never sees half a file). Answers false when it
// ends anywhere else (Microsoft wants a real sign-in), Schoology is not reached, or there is no saved
// session. Reads that expire together share one renewal.
const RENEW_WAIT_MS = 30000; // each request
const RENEW_HOPS = 15;
const MICROSOFT = /(^|\.)(microsoftonline\.com|windows\.net|live\.com)$/;
const SCHOOLOGY_HOST = /(^|\.)schoology\.com$|^schoology\.hkis\.edu\.hk$/;

// The form a Microsoft page asks the browser to submit: { action, fields } or null.
function formPost(html, base) {
  const form = html.match(/<form\b[^>]*\baction="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  const decode = (v) => v.replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const fields = [];
  for (const [tag] of form[2].matchAll(/<input\b[^>]*>/gi)) {
    const name = /type="hidden"/i.test(tag) ? tag.match(/\bname="([^"]*)"/i)?.[1] : null;
    if (name) fields.push([decode(name), decode(tag.match(/\bvalue="([^"]*)"/i)?.[1] ?? '')]);
  }
  return { action: new URL(decode(form[1]), base).href, fields };
}

// Write a browser's storage state over the saved session: a temp file, then rename,
// so a reader never sees half a file.
export function saveSessionState(stateFile, state) {
  const tmp = `${stateFile}.save-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateFile);
}
let renewing = null;
export function renewSession({ stateFile = sessionStateFile(), now = Date.now, fetchImpl = (...args) => sessionDeps.fetch(...args) } = {}) {
  renewing ??= (async () => {
    await null; // always settle after `renewing` is set, so the finally below clears it
    try {
      if (!existsSync(stateFile)) return false;
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      const jar = stateCookieJar(state.cookies, { now });
      const request = async (url, init = {}) => {
        const res = await fetchImpl(url, {
          ...init, redirect: 'manual', signal: AbortSignal.timeout(RENEW_WAIT_MS),
          headers: { cookie: jar.header(url), 'User-Agent': USER_AGENT, ...init.headers },
        });
        jar.take(res, url);
        const location = res.headers.get('location');
        return { status: res.status, url, location: location ? new URL(location, url).href : null, text: await res.text() };
      };
      let r = await request(`${SCHOOLOGY_BASE}/home`);
      for (let hops = 0; hops < RENEW_HOPS; hops++) {
        if (r.location) { r = await request(r.location); continue; }
        const host = new URL(r.url).host;
        if (r.status !== 200 || !MICROSOFT.test(host)) break;
        const form = formPost(r.text, r.url);
        if (!form || !SCHOOLOGY_HOST.test(new URL(form.action).host)) break;
        r = await request(form.action, {
          method: 'POST', body: new URLSearchParams(form.fields).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      }
      const landed = new URL(r.url);
      if (r.status !== 200 || !isLoggedInUrl(r.url) || landed.pathname !== '/home') {
        noteSessionLive('expired', 'Microsoft asked for a sign-in: log in to Schoology in Settings', now());
        return false;
      }
      saveSessionState(stateFile, { ...state, cookies: jar.cookies() });
      noteSessionLive('connected', null, now());
      console.log('[schoologySession] Session renewed through Microsoft sign-in');
      return true;
    } catch (err) {
      console.warn(`[schoologySession] Could not renew the session: ${err.message}`);
      return false;
    } finally {
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
