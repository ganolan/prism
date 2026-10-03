import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sessionStatus, sessionDeps, noteSessionLive, resetSessionStatusCache, LIVE_CHECK_TTL_MS, openSessionPage,
} from './schoologySession.js';

// A fake page: goto lands on `landing` (the school domain = logged in, SSO = expired).
function fakeSession(landing) {
  const page = { url: vi.fn(() => landing), goto: vi.fn(async () => {}) };
  return { page, close: vi.fn(async () => {}) };
}

const realOpen = sessionDeps.openPage;
let t;
const now = () => t;

beforeEach(() => {
  resetSessionStatusCache();
  t = 1_000_000;
});
afterEach(() => { sessionDeps.openPage = realOpen; });

describe('sessionStatus (Settings card / Sync dialog live status)', () => {
  test("no saved session → 'none', no browser opened", async () => {
    sessionDeps.openPage = vi.fn();
    expect(await sessionStatus({ hasSession: () => false, now })).toEqual({ loggedIn: false, live: 'none', checkedAt: null });
    expect(sessionDeps.openPage).not.toHaveBeenCalled();
  });

  test("a live session → 'connected', checked via /home, page closed", async () => {
    const s = fakeSession('https://schoology.hkis.edu.hk/home');
    sessionDeps.openPage = vi.fn(async () => s);
    const r = await sessionStatus({ hasSession: () => true, now });
    expect(r).toEqual({ loggedIn: true, live: 'connected', checkedAt: new Date(t).toISOString() });
    expect(s.page.goto).toHaveBeenCalledWith('https://schoology.hkis.edu.hk/home', expect.any(Object));
    expect(s.close).toHaveBeenCalled();
  });

  test("bounced to SSO → 'expired' with a message", async () => {
    sessionDeps.openPage = vi.fn(async () => fakeSession('https://login.microsoftonline.com/abc'));
    const r = await sessionStatus({ hasSession: () => true, now });
    expect(r.live).toBe('expired');
    expect(r.message).toMatch(/login page/);
  });

  test("a check that throws → 'unknown' with the error, never throws", async () => {
    sessionDeps.openPage = vi.fn(async () => { throw new Error('chromium missing'); });
    const r = await sessionStatus({ hasSession: () => true, now });
    expect(r).toMatchObject({ loggedIn: true, live: 'unknown' });
    expect(r.message).toMatch(/chromium missing/);
  });

  test("a navigation error or about:blank → 'unknown' (not expired)", async () => {
    const s = fakeSession('about:blank');
    s.page.goto.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'));
    sessionDeps.openPage = vi.fn(async () => s);
    const r = await sessionStatus({ hasSession: () => true, now });
    expect(r).toMatchObject({ live: 'unknown', message: expect.stringMatching(/ERR_INTERNET_DISCONNECTED/) });
    expect(s.close).toHaveBeenCalled();
    sessionDeps.openPage = vi.fn(async () => fakeSession('about:blank'));
    expect((await sessionStatus({ hasSession: () => true, now, refresh: true })).live).toBe('unknown');
  });

  test('cached for 10 minutes; refresh forces a re-check; stale → re-check', async () => {
    sessionDeps.openPage = vi.fn(async () => fakeSession('https://schoology.hkis.edu.hk/home'));
    await sessionStatus({ hasSession: () => true, now });
    t += LIVE_CHECK_TTL_MS - 1;
    await sessionStatus({ hasSession: () => true, now });
    expect(sessionDeps.openPage).toHaveBeenCalledTimes(1);
    await sessionStatus({ hasSession: () => true, now, refresh: true });
    expect(sessionDeps.openPage).toHaveBeenCalledTimes(2);
    t += LIVE_CHECK_TTL_MS;
    const r = await sessionStatus({ hasSession: () => true, now });
    expect(sessionDeps.openPage).toHaveBeenCalledTimes(3);
    expect(r.checkedAt).toBe(new Date(t).toISOString());
  });

  test('check: false never opens a browser (cached answer or null)', async () => {
    sessionDeps.openPage = vi.fn();
    expect(await sessionStatus({ hasSession: () => true, check: false, now })).toEqual({ loggedIn: true, live: null, checkedAt: null });
    noteSessionLive('expired', 'bounced', t);
    expect(await sessionStatus({ hasSession: () => true, check: false, now })).toMatchObject({ live: 'expired', message: 'bounced' });
    expect(sessionDeps.openPage).not.toHaveBeenCalled();
  });

  test('concurrent callers share one check', async () => {
    let release;
    sessionDeps.openPage = vi.fn(() => new Promise((r) => { release = () => r(fakeSession('https://schoology.hkis.edu.hk/home')); }));
    const a = sessionStatus({ hasSession: () => true, now });
    const b = sessionStatus({ hasSession: () => true, now, refresh: true });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    expect((await a).live).toBe('connected');
    expect((await b).live).toBe('connected');
    expect(sessionDeps.openPage).toHaveBeenCalledTimes(1);
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
