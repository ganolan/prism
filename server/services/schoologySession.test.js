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

describe('renewSession (silent sign-in through Microsoft)', () => {
  // A fake headless page: goto follows the SSO round trip and lands on `landing`;
  // the context then holds `cookies`.
  function renewalPage(landing, cookies = [{ name: 'SESSnew', value: 'v2', domain: '.schoology.hkis.edu.hk' }]) {
    const page = {
      url: vi.fn(() => landing),
      goto: vi.fn(async () => {}),
      waitForURL: vi.fn(async () => { if (!landing.includes('schoology.hkis.edu.hk/home')) throw new Error('timeout'); }),
      context: () => ({ storageState: async () => ({ cookies, origins: [] }) }),
    };
    return { page, close: vi.fn(async () => {}) };
  }
  const tmpState = () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-renew-'));
    const file = join(dir, 'storage-state.json');
    writeFileSync(file, JSON.stringify({ cookies: [{ name: 'SESSold', value: 'v1', domain: '.schoology.hkis.edu.hk' }], origins: [] }));
    return { dir, file };
  };

  test('lands signed in: saves the new cookies over the state file and notes the session live', async () => {
    const { dir, file } = tmpState();
    const s = renewalPage('https://schoology.hkis.edu.hk/home');
    sessionDeps.openPage = vi.fn(async () => s);
    expect(await renewSession({ stateFile: file, now })).toBe(true);
    expect(sessionDeps.openPage).toHaveBeenCalledWith(file);
    expect(JSON.parse(readFileSync(file, 'utf8')).cookies.map((c) => c.name)).toEqual(['SESSnew']);
    expect(readdirSync(dir)).toEqual(['storage-state.json']); // the temp file was renamed into place
    expect(s.close).toHaveBeenCalled();
    expect((await sessionStatus({ check: false, hasSession: () => true, now })).live).toBe('connected');
  });

  test('stuck at Microsoft sign-in: leaves the file alone, notes expired, answers false', async () => {
    const { file } = tmpState();
    const before = readFileSync(file, 'utf8');
    const s = renewalPage('https://login.microsoftonline.com/common/oauth2/authorize');
    sessionDeps.openPage = vi.fn(async () => s);
    expect(await renewSession({ stateFile: file, now })).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(s.close).toHaveBeenCalled();
    expect((await sessionStatus({ check: false, hasSession: () => true, now })).live).toBe('expired');
  });

  test('reads that expire together share one renewal', async () => {
    const { file } = tmpState();
    let release;
    const gate = new Promise((r) => { release = r; });
    const s = renewalPage('https://schoology.hkis.edu.hk/home');
    sessionDeps.openPage = vi.fn(async () => { await gate; return s; });
    const both = Promise.all([renewSession({ stateFile: file, now }), renewSession({ stateFile: file, now })]);
    release();
    expect(await both).toEqual([true, true]);
    expect(sessionDeps.openPage).toHaveBeenCalledTimes(1);
  });

  test('no saved session or no browser: false, nothing thrown', async () => {
    const { file } = tmpState();
    sessionDeps.openPage = vi.fn(async () => null);
    expect(await renewSession({ stateFile: file, now })).toBe(false);
    sessionDeps.openPage = vi.fn(async () => { throw new Error('browser failed to start'); });
    expect(await renewSession({ stateFile: file, now })).toBe(false);
  });
});
