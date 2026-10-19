import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sessionStatus, sessionDeps, noteSessionLive, resetSessionStatusCache, LIVE_CHECK_TTL_MS, openSessionPage, renewSession, checkSessionLive,
} from './schoologySession.js';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';

// The liveness check is one plain-HTTP GET of /home (#141): a fake Schoology web
// surface answers it. `home` is the /home route spec (fakeSchoologyWeb): 200 =
// signed in, { login: true } = sent to sign-in, { throws } = network failure.
function fakeHome(home = { status: 200, text: '<html>home</html>' }, { renew } = {}) {
  const web = fakeSchoologyWeb({ routes: { '/home': home } });
  if (renew) web.jar.renew = renew;
  sessionDeps.openJar = vi.fn(() => web.jar);
  sessionDeps.fetch = web.fetchImpl;
  return web;
}
const homeLoads = (web) => web.requests.filter((r) => r.path === '/home').length;

const real = { ...sessionDeps };
let t;
const now = () => t;

beforeEach(() => {
  resetSessionStatusCache();
  t = 1_000_000;
  sessionDeps.openPage = vi.fn(() => { throw new Error('the liveness check must not open a browser'); });
});
afterEach(() => { Object.assign(sessionDeps, real); });

describe('checkSessionLive (plain HTTP, no browser)', () => {
  test("no saved session → 'expired', nothing requested", async () => {
    sessionDeps.openJar = vi.fn(() => null);
    sessionDeps.fetch = vi.fn();
    expect(await checkSessionLive()).toEqual({ live: 'expired', message: 'No saved Schoology session' });
    expect(sessionDeps.fetch).not.toHaveBeenCalled();
  });

  test("/home answers 200 on the school domain → 'connected', with the session cookie, no browser", async () => {
    const web = fakeHome();
    expect(await checkSessionLive()).toEqual({ live: 'connected' });
    expect(web.requests).toEqual([expect.objectContaining({ method: 'GET', path: '/home', headers: expect.objectContaining({ cookie: 'SESS=old' }) })]);
    expect(sessionDeps.openPage).not.toHaveBeenCalled();
  });

  test("sent to sign-in and the renewal fails → 'expired' with the login-page message", async () => {
    const renew = vi.fn(async () => false);
    fakeHome({ login: true }, { renew });
    const r = await checkSessionLive();
    expect(r).toEqual({ live: 'expired', message: expect.stringMatching(/login page/) });
    expect(renew).toHaveBeenCalledTimes(1);
  });

  test("sent to sign-in, renewed through Microsoft → asked again → 'connected'", async () => {
    let signedIn = false;
    const web = fakeHome(() => (signedIn ? { status: 200, text: 'home' } : { login: true }), { renew: vi.fn(async () => { signedIn = true; return true; }) });
    expect(await checkSessionLive()).toEqual({ live: 'connected' });
    expect(homeLoads(web)).toBe(2);
  });

  test("a network failure → 'unknown' (not expired), with the reason", async () => {
    fakeHome({ throws: new Error('getaddrinfo ENOTFOUND') });
    const r = await checkSessionLive();
    expect(r).toEqual({ live: 'unknown', message: expect.stringMatching(/Could not reach Schoology.*ENOTFOUND/) });
  });

  test("Schoology answers an error status → 'unknown' with the status", async () => {
    fakeHome({ status: 503, text: 'down' });
    expect(await checkSessionLive()).toEqual({ live: 'unknown', message: expect.stringMatching(/503/) });
  });
});

describe('sessionStatus (Settings card / Sync dialog live status)', () => {
  test("no saved session → 'none', nothing requested", async () => {
    const web = fakeHome();
    expect(await sessionStatus({ hasSession: () => false, now })).toEqual({ loggedIn: false, live: 'none', checkedAt: null });
    expect(web.requests).toEqual([]);
  });

  test("a live session → 'connected', checked via /home", async () => {
    const web = fakeHome();
    const r = await sessionStatus({ hasSession: () => true, now });
    expect(r).toEqual({ loggedIn: true, live: 'connected', checkedAt: new Date(t).toISOString() });
    expect(homeLoads(web)).toBe(1);
  });

  test("bounced to SSO → 'expired' with a message", async () => {
    fakeHome({ login: true });
    const r = await sessionStatus({ hasSession: () => true, now });
    expect(r.live).toBe('expired');
    expect(r.message).toMatch(/login page/);
  });

  test("a check that throws → 'unknown' with the error, never throws", async () => {
    sessionDeps.openJar = vi.fn(() => { throw new Error('state file is not JSON'); });
    const r = await sessionStatus({ hasSession: () => true, now });
    expect(r).toMatchObject({ loggedIn: true, live: 'unknown' });
    expect(r.message).toMatch(/not JSON/);
  });

  test("a network error → 'unknown' (not expired)", async () => {
    fakeHome({ throws: new Error('ERR_INTERNET_DISCONNECTED') });
    const r = await sessionStatus({ hasSession: () => true, now });
    expect(r).toMatchObject({ live: 'unknown', message: expect.stringMatching(/ERR_INTERNET_DISCONNECTED/) });
  });

  test('cached for 10 minutes; refresh forces a re-check; stale → re-check', async () => {
    const web = fakeHome();
    await sessionStatus({ hasSession: () => true, now });
    t += LIVE_CHECK_TTL_MS - 1;
    await sessionStatus({ hasSession: () => true, now });
    expect(homeLoads(web)).toBe(1);
    await sessionStatus({ hasSession: () => true, now, refresh: true });
    expect(homeLoads(web)).toBe(2);
    t += LIVE_CHECK_TTL_MS;
    const r = await sessionStatus({ hasSession: () => true, now });
    expect(homeLoads(web)).toBe(3);
    expect(r.checkedAt).toBe(new Date(t).toISOString());
  });

  test('check: false never checks (cached answer or null)', async () => {
    const web = fakeHome();
    expect(await sessionStatus({ hasSession: () => true, check: false, now })).toEqual({ loggedIn: true, live: null, checkedAt: null });
    noteSessionLive('expired', 'bounced', t);
    expect(await sessionStatus({ hasSession: () => true, check: false, now })).toMatchObject({ live: 'expired', message: 'bounced' });
    expect(web.requests).toEqual([]);
  });

  test('concurrent callers share one check', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const web = fakeHome(async () => { await gate; return { status: 200, text: 'home' }; });
    const a = sessionStatus({ hasSession: () => true, now });
    const b = sessionStatus({ hasSession: () => true, now, refresh: true });
    await vi.waitFor(() => expect(homeLoads(web)).toBe(1));
    release();
    expect((await a).live).toBe('connected');
    expect((await b).live).toBe('connected');
    expect(homeLoads(web)).toBe(1);
  });
});

describe('openSessionPage', () => {
  test('no saved session file → null (no browser launched)', async () => {
    const prev = process.env.PRISM_SESSION_DIR;
    process.env.PRISM_SESSION_DIR = '/nonexistent/prism-test-session';
    try {
      expect(await openSessionPage()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.PRISM_SESSION_DIR; else process.env.PRISM_SESSION_DIR = prev;
    }
  });
});

describe('renewSession (silent sign-in through Microsoft, plain HTTP)', () => {
  const SGY = 'https://schoology.hkis.edu.hk';
  const AUTH = 'https://login.microsoftonline.com/common/oauth2/authorize';
  const SAVED = [
    { name: 'SESSold', value: 'v1', domain: '.schoology.hkis.edu.hk', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'ESTSAUTHPERSISTENT', value: 'p', domain: '.login.microsoftonline.com', path: '/', expires: 1800000000, httpOnly: true, secure: true, sameSite: 'None' },
  ];
  const tmpState = () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-renew-'));
    const file = join(dir, 'storage-state.json');
    writeFileSync(file, JSON.stringify({ cookies: SAVED, origins: [{ origin: SGY, localStorage: [] }] }));
    return { dir, file };
  };
  // The chain observed 2026-10-19: /home → send/microsoft → authorize → receive (app.schoology.com,
  // then the school) → /home. `authorize` answers the Microsoft step (a redirect when the remembered
  // sign-in is enough). Records requests; never reaches the network.
  function chain({ authorize } = {}) {
    const requests = [];
    const signedIn = (cookie) => String(cookie).includes('SESSnew=v2');
    const routes = {
      [`GET schoology.hkis.edu.hk/home`]: (q) => (signedIn(q.headers.cookie) ? { status: 200, body: 'home' }
        : { status: 302, location: '/login/external_accounts/send/microsoft', setCookie: ['login_landing_dest=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; Max-Age=0; path=/'] }),
      [`GET schoology.hkis.edu.hk/login/external_accounts/send/microsoft`]: () => ({ status: 302, location: `${AUTH}?x=1` }),
      [`GET login.microsoftonline.com/common/oauth2/authorize`]: authorize ?? ((q) => (String(q.headers.cookie).includes('ESTSAUTHPERSISTENT=p')
        ? { status: 302, location: 'https://app.schoology.com/login/external_accounts/receive/microsoft?code=c', setCookie: ['ESTSAUTH=rotated; domain=.login.microsoftonline.com; path=/; secure; HttpOnly'] }
        : { status: 200, body: '<html><script>$Config={"pgid":"Login"}</script></html>' })),
      [`GET app.schoology.com/login/external_accounts/receive/microsoft`]: () => ({ status: 302, location: `${SGY}/login/external_accounts/receive/microsoft?s=1` }),
      [`POST app.schoology.com/login/external_accounts/receive/microsoft`]: () => ({ status: 302, location: `${SGY}/login/external_accounts/receive/microsoft?s=1` }),
      [`GET schoology.hkis.edu.hk/login/external_accounts/receive/microsoft`]: (q) => ({
        status: 302, location: String(q.headers.cookie).includes('login_landing_dest=deleted') ? `${SGY}/deleted` : `${SGY}/home`,
        setCookie: ['SESSold=; expires=Thu, 01-Jan-1970 00:00:01 GMT; path=/; domain=.schoology.hkis.edu.hk', 'SESSnew=v2; path=/; domain=.schoology.hkis.edu.hk; secure; HttpOnly'],
      }),
    };
    const fetchImpl = async (url, init = {}) => {
      const u = new URL(url);
      const q = { key: `${init.method || 'GET'} ${u.host}${u.pathname}`, headers: init.headers || {}, body: init.body };
      requests.push(q);
      const r = routes[q.key]?.(q) ?? { status: 404 };
      const headers = new Headers();
      if (r.location) headers.set('location', new URL(r.location, url).href);
      for (const c of r.setCookie ?? []) headers.append('set-cookie', c);
      return new Response(r.body ?? '', { status: r.status, headers });
    };
    return { fetchImpl, requests };
  }

  test('follows the sign-in to /home and saves the new cookies (Microsoft\'s rotated ones too) over the file', async () => {
    const { dir, file } = tmpState();
    const c = chain();
    expect(await renewSession({ stateFile: file, now, fetchImpl: c.fetchImpl })).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.cookies.map((x) => `${x.name}=${x.value}`)).toEqual(['ESTSAUTHPERSISTENT=p', 'ESTSAUTH=rotated', 'SESSnew=v2']);
    expect(saved.origins).toEqual([{ origin: SGY, localStorage: [] }]);
    expect(readdirSync(dir)).toEqual(['storage-state.json']); // the temp file was renamed into place
    expect((await sessionStatus({ check: false, hasSession: () => true, now })).live).toBe('connected');
    // No browser, and a browser-like User-Agent on every request.
    for (const q of c.requests) expect(q.headers['User-Agent']).toMatch(/^Mozilla\/5\.0 /);
    // Schoology's cookies never went to Microsoft.
    expect(c.requests.find((q) => q.key.includes('microsoftonline')).headers.cookie).toBe('ESTSAUTHPERSISTENT=p');
  });

  test('Microsoft wants a real sign-in (a page, no form): leaves the file alone, notes expired, answers false', async () => {
    const { file } = tmpState();
    const before = readFileSync(file, 'utf8');
    const c = chain({ authorize: () => ({ status: 200, body: '<html><script>$Config={"pgid":"Login"}</script></html>' }) });
    expect(await renewSession({ stateFile: file, now, fetchImpl: c.fetchImpl })).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect((await sessionStatus({ check: false, hasSession: () => true, now })).live).toBe('expired');
  });

  test('a Microsoft form is posted on only to a Schoology host', async () => {
    const form = (action) => () => ({ status: 200, body: `<form method="POST" action="${action}"><input type="hidden" name="code" value="c" /><input type="hidden" name="state" value="s" /></form>` });
    const { file } = tmpState();
    let c = chain({ authorize: form('https://app.schoology.com/login/external_accounts/receive/microsoft') });
    expect(await renewSession({ stateFile: file, now, fetchImpl: c.fetchImpl })).toBe(true);
    const post = c.requests.find((q) => q.key.startsWith('POST'));
    expect(Object.fromEntries(new URLSearchParams(post.body))).toEqual({ code: 'c', state: 's' });
    const other = tmpState();
    c = chain({ authorize: form('https://evil.example/collect') });
    expect(await renewSession({ stateFile: other.file, now, fetchImpl: c.fetchImpl })).toBe(false);
    expect(c.requests.some((q) => q.key.startsWith('POST'))).toBe(false);
  });

  test('reads that expire together share one renewal', async () => {
    const { file } = tmpState();
    const c = chain();
    const both = Promise.all([renewSession({ stateFile: file, now, fetchImpl: c.fetchImpl }), renewSession({ stateFile: file, now, fetchImpl: c.fetchImpl })]);
    expect(await both).toEqual([true, true]);
    expect(c.requests.filter((q) => q.key.endsWith('send/microsoft'))).toHaveLength(1);
  });

  test('no saved session, or Schoology not reached: false, nothing thrown, the file untouched', async () => {
    expect(await renewSession({ stateFile: '/nonexistent/prism/storage-state.json', now, fetchImpl: chain().fetchImpl })).toBe(false);
    const { file } = tmpState();
    const before = readFileSync(file, 'utf8');
    expect(await renewSession({ stateFile: file, now, fetchImpl: async () => { throw new TypeError('fetch failed'); } })).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
