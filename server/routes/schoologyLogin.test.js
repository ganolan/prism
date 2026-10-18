import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import router from './schoologyLogin.js';
import { remoteLoginDeps, stopRemoteLogin } from '../services/remoteLogin.js';
import { sessionStatus, resetSessionStatusCache } from '../services/schoologySession.js';

function fakeBrowser(url) {
  const page = {
    current: url, typed: [],
    url() { return this.current; },
    goto: async () => {},
    screenshot: async () => Buffer.from([0xff, 0xd8, 0xff]),
    mouse: { click: async () => {} },
    keyboard: { type: async (t) => page.typed.push(t), press: async () => {} },
    waitForTimeout: async () => {},
  };
  const context = { newPage: async () => page, storageState: async () => ({ cookies: [], origins: [] }) };
  return { page, browser: { newContext: async () => context, close: vi.fn(async () => {}) } };
}

const realDeps = { ...remoteLoginDeps };
let fake;
let server;
let base;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-login-route-'));
  const file = join(dir, 'storage-state.json');
  writeFileSync(file, '{"cookies":[]}');
  fake = fakeBrowser('https://login.microsoftonline.com/common/oauth2/authorize');
  Object.assign(remoteLoginDeps, { launch: async () => fake.browser, stateFile: () => file, settleMs: 0 });
  const app = express();
  app.use(express.json());
  app.use('/api/schoology-login', router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/schoology-login`;
});
afterEach(async () => {
  server.close();
  await stopRemoteLogin();
  Object.assign(remoteLoginDeps, realDeps);
});

const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

describe('/api/schoology-login', () => {
  test('start, then the screen is a fresh JPEG', async () => {
    expect(await (await post('/start')).json()).toMatchObject({ status: 'active', host: 'login.microsoftonline.com' });
    const r = await fetch(`${base}/screen`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await r.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  test('text goes to the page and is never echoed back', async () => {
    await post('/start');
    const r = await post('/type', { text: 'secret-pass' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).not.toContain('secret-pass');
    expect(fake.page.typed).toEqual(['secret-pass']);
  });

  test('finished: the screen answers 409 with the done state', async () => {
    await post('/start');
    fake.page.current = 'https://schoology.hkis.edu.hk/home';
    const r = await fetch(`${base}/screen`);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ status: 'done' });
    expect(await (await fetch(base)).json()).toMatchObject({ status: 'done' });
  });

  test('Microsoft still remembers the teacher: start finishes at once and the status reads connected', async () => {
    resetSessionStatusCache();
    fake.page.current = 'https://schoology.hkis.edu.hk/home';
    expect(await (await post('/start')).json()).toMatchObject({ status: 'done' });
    expect((await sessionStatus({ check: false, hasSession: () => true })).live).toBe('connected');
  });

  test('bad input is 400; input with nothing open is 409', async () => {
    expect((await post('/click', { x: 5, y: 5 })).status).toBe(409);
    await post('/start');
    expect((await post('/click', { x: 'a' })).status).toBe(400);
    expect((await post('/key', { key: 'F5' })).status).toBe(400);
    expect((await post('/stop')).status).toBe(200);
    expect(fake.browser.close).toHaveBeenCalled();
  });
});
