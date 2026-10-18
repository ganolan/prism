import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  remoteLoginDeps, startRemoteLogin, remoteLoginState, remoteLoginScreen, remoteLoginClick,
  remoteLoginType, remoteLoginKey, stopRemoteLogin, RemoteLoginError, VIEWPORT,
} from './remoteLogin.js';
import { sessionStatus, resetSessionStatusCache } from './schoologySession.js';

// A fake headless browser: the page sits on `url` until a test moves it (as a
// sign-in would), records the input it gets, and saves `cookies` as its state.
function fakeBrowser(url) {
  const page = {
    current: url,
    input: [],
    url() { return this.current; },
    goto: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from('jpeg')),
    mouse: { click: vi.fn(async (x, y) => page.input.push(['click', x, y])) },
    keyboard: {
      type: vi.fn(async (t) => page.input.push(['type', t])),
      press: vi.fn(async (k) => page.input.push(['key', k])),
    },
    waitForTimeout: vi.fn(async () => {}),
  };
  const context = { newPage: vi.fn(async () => page), storageState: vi.fn(async () => ({ cookies: [{ name: 'SESSnew', value: 'v' }], origins: [] })) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  return { browser, context, page };
}

const MS = 'https://login.microsoftonline.com/common/oauth2/authorize?client_id=x';
const HOME = 'https://schoology.hkis.edu.hk/home';
const realDeps = { ...remoteLoginDeps };
let dir;
let file;
let fake;

beforeEach(async () => {
  resetSessionStatusCache();
  dir = mkdtempSync(join(tmpdir(), 'prism-remote-login-'));
  file = join(dir, 'storage-state.json');
  writeFileSync(file, JSON.stringify({ cookies: [{ name: 'SESSold', value: 'v' }], origins: [] }));
  fake = fakeBrowser(MS);
  Object.assign(remoteLoginDeps, { launch: vi.fn(async () => fake.browser), stateFile: () => file, settleMs: 0 });
});
afterEach(async () => {
  await stopRemoteLogin();
  Object.assign(remoteLoginDeps, realDeps);
});

describe('remote sign-in', () => {
  test('start opens Schoology in a phone-sized headless browser with the saved state, and waits at Microsoft', async () => {
    const s = await startRemoteLogin();
    expect(s).toMatchObject({ status: 'active', host: 'login.microsoftonline.com' });
    expect(fake.browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ viewport: VIEWPORT, deviceScaleFactor: 1, storageState: file }));
    expect(fake.page.goto).toHaveBeenCalledWith('https://schoology.hkis.edu.hk/home', expect.anything());
    expect(await remoteLoginScreen()).toEqual(Buffer.from('jpeg'));
    expect(fake.page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'jpeg' }));
  });

  test('taps, text and keys reach the page', async () => {
    await startRemoteLogin();
    await remoteLoginClick(120, 300);
    await remoteLoginType('teacher@school.edu');
    await remoteLoginKey('Enter');
    expect(fake.page.input).toEqual([['click', 120, 300], ['type', 'teacher@school.edu'], ['key', 'Enter']]);
  });

  test('landing signed in on Schoology saves the session, closes the browser and notes it live', async () => {
    await startRemoteLogin();
    fake.page.current = HOME; // the teacher finished the Microsoft sign-in
    expect(await remoteLoginScreen()).toBeNull();
    expect(remoteLoginState()).toMatchObject({ status: 'done' });
    expect(JSON.parse(readFileSync(file, 'utf8')).cookies.map((c) => c.name)).toEqual(['SESSnew']);
    expect(readdirSync(dir)).toEqual(['storage-state.json']);
    expect(fake.browser.close).toHaveBeenCalled();
    expect((await sessionStatus({ check: false, hasSession: () => true })).live).toBe('connected');
  });

  test('already signed in (Microsoft remembered): done at once', async () => {
    fake = fakeBrowser(HOME);
    remoteLoginDeps.launch = vi.fn(async () => fake.browser);
    expect(await startRemoteLogin()).toMatchObject({ status: 'done' });
  });

  test('a second start replaces the first browser', async () => {
    await startRemoteLogin();
    const first = fake.browser;
    fake = fakeBrowser(MS);
    remoteLoginDeps.launch = vi.fn(async () => fake.browser);
    await startRemoteLogin();
    expect(first.close).toHaveBeenCalled();
    expect(remoteLoginState().status).toBe('active');
  });

  test('input with no sign-in open, a tap off the screen, an unknown key or long text are refused', async () => {
    await expect(remoteLoginClick(1, 1)).rejects.toMatchObject({ code: 'NOT_ACTIVE' });
    await startRemoteLogin();
    await expect(remoteLoginClick(VIEWPORT.width + 1, 10)).rejects.toBeInstanceOf(RemoteLoginError);
    await expect(remoteLoginClick('a', 10)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(remoteLoginKey('Delete')).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(remoteLoginType('x'.repeat(501))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(fake.page.input).toEqual([]);
  });

  test('left alone too long, it closes itself', async () => {
    let t = 1_000_000;
    remoteLoginDeps.now = () => t;
    await startRemoteLogin();
    t += remoteLoginDeps.idleMs + 1;
    await expect(remoteLoginScreen()).rejects.toMatchObject({ code: 'NOT_ACTIVE' });
    expect(remoteLoginState()).toMatchObject({ status: 'timed_out' });
    expect(fake.browser.close).toHaveBeenCalled();
  });

  test('stop closes the browser and leaves the saved session alone', async () => {
    const before = readFileSync(file, 'utf8');
    await startRemoteLogin();
    await stopRemoteLogin();
    expect(fake.browser.close).toHaveBeenCalled();
    expect(remoteLoginState().status).toBe('stopped');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
