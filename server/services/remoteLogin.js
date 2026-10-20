// Remote sign-in (#136): the server's own Microsoft sign-in, driven from Prism on
// any device. One headless browser, phone-sized, opens Schoology with the saved
// state; Prism shows its screen as a JPEG and forwards taps, typed text and a few
// keys. When the page lands signed in on Schoology, the state is saved over the
// session file and the browser closes. Nothing typed is stored or logged. One
// sign-in at a time; it closes itself after IDLE_MS without a request.
import { existsSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { sessionStateFile } from '../lib/sessionPaths.js';
import { saveSessionState, noteSessionLive } from './schoologySession.js';

export const VIEWPORT = { width: 400, height: 720 };
const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape']);
const MAX_TEXT = 500;

export class RemoteLoginError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const remoteLoginDeps = {
  launch: async () => (await import('playwright')).chromium.launch({ headless: true }),
  stateFile: () => sessionStateFile(),
  now: () => Date.now(),
  idleMs: 10 * 60 * 1000,
  settleMs: 400, // after a tap or key, let the page react before the next screen
  // Background sync: the syncs held for a sign-in run as soon as the teacher signs in.
  onSignedIn: async () => (await import('./syncQueue.js')).resumeHeld(),
};

let current = null; // { browser, page, status, lastActive, message }
let last = { status: 'none' };
let queue = Promise.resolve();
// Every action runs after the one before it: taps and text arrive in order.
const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };

export function remoteLoginState() {
  if (current) return { status: current.status, host: hostOf(current.page.url()), message: current.message ?? null };
  return { ...last, host: null };
}

async function close(status, message = null) {
  const c = current;
  current = null;
  last = { status, message };
  await c?.browser.close().catch(() => {});
}

// Signed in on Schoology → save, close, done. Answers true when done.
async function finishIfSignedIn() {
  if (!current || !isLoggedInUrl(current.page.url())) return false;
  saveSessionState(remoteLoginDeps.stateFile(), await current.context.storageState());
  noteSessionLive('connected');
  console.log('[remoteLogin] Signed in; session saved');
  await close('done');
  try { await remoteLoginDeps.onSignedIn(); } catch (err) { console.error('[remoteLogin] Could not resume held syncs:', err.message); }
  return true;
}

// The open sign-in, or NOT_ACTIVE; one left idle too long is closed here.
async function active() {
  if (current && remoteLoginDeps.now() - current.lastActive > remoteLoginDeps.idleMs) {
    await close('timed_out', 'The sign-in was left too long and closed');
  }
  if (!current) throw new RemoteLoginError('NOT_ACTIVE', 'No sign-in is open');
  current.lastActive = remoteLoginDeps.now();
  return current;
}

export function startRemoteLogin() {
  return serial(async () => {
    await close('stopped');
    const browser = await remoteLoginDeps.launch();
    try {
      const file = remoteLoginDeps.stateFile();
      const context = await browser.newContext({
        viewport: VIEWPORT, deviceScaleFactor: 1, ...(existsSync(file) ? { storageState: file } : {}),
      });
      const page = await context.newPage();
      current = { browser, context, page, status: 'active', lastActive: remoteLoginDeps.now() };
      await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await finishIfSignedIn();
    } catch (err) {
      await close('failed', `Could not open the sign-in: ${err.message}`);
      await browser.close().catch(() => {});
    }
    return remoteLoginState();
  });
}

// The page as a JPEG, or null once the sign-in has finished (read the state).
export function remoteLoginScreen() {
  return serial(async () => {
    const c = await active();
    if (await finishIfSignedIn()) return null;
    return c.page.screenshot({ type: 'jpeg', quality: 70 });
  });
}

async function act(fn) {
  const c = await active();
  await fn(c.page);
  if (remoteLoginDeps.settleMs) await c.page.waitForTimeout(remoteLoginDeps.settleMs);
  await finishIfSignedIn();
  return remoteLoginState();
}

export function remoteLoginClick(x, y) {
  return serial(async () => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RemoteLoginError('BAD_INPUT', 'A tap needs x and y');
    await active();
    if (x < 0 || y < 0 || x > VIEWPORT.width || y > VIEWPORT.height) throw new RemoteLoginError('BAD_INPUT', 'That tap is off the screen');
    return act((page) => page.mouse.click(x, y));
  });
}

export function remoteLoginType(text) {
  return serial(async () => {
    if (typeof text !== 'string' || !text || text.length > MAX_TEXT) throw new RemoteLoginError('BAD_INPUT', `Text must be 1 to ${MAX_TEXT} characters`);
    return act((page) => page.keyboard.type(text, { delay: 15 }));
  });
}

export function remoteLoginKey(key) {
  return serial(async () => {
    if (!KEYS.has(key)) throw new RemoteLoginError('BAD_INPUT', `Key must be one of ${[...KEYS].join(', ')}`);
    return act((page) => page.keyboard.press(key));
  });
}

export function stopRemoteLogin() {
  return serial(async () => {
    if (current) await close('stopped');
    return remoteLoginState();
  });
}
