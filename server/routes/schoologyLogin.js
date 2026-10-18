import { Router } from 'express';
import {
  startRemoteLogin, remoteLoginState, remoteLoginScreen, remoteLoginClick,
  remoteLoginType, remoteLoginKey, stopRemoteLogin, RemoteLoginError,
} from '../services/remoteLogin.js';

// Remote sign-in to Schoology (#136): drive the server's own Microsoft sign-in from
// Prism on any device (server/services/remoteLogin.js). Each answer is the state
// { status: 'none' | 'active' | 'done' | 'stopped' | 'timed_out' | 'failed', host,
// message }; typed text is never echoed or logged.
const router = Router();
const STATUS = { NOT_ACTIVE: 409, BAD_INPUT: 400 };

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof RemoteLoginError) return res.status(STATUS[err.code] || 500).json({ ...remoteLoginState(), error: err.message, code: err.code });
    console.error('[schoology-login]', err.message);
    res.status(500).json({ ...remoteLoginState(), error: 'The sign-in browser failed' });
  }
};

// GET /api/schoology-login → the state
router.get('/', (req, res) => res.json(remoteLoginState()));

// POST /start → opens (or reopens) the sign-in
router.post('/start', handle(() => startRemoteLogin()));

// GET /screen → image/jpeg of the sign-in page; 409 + state once it is not open
// (finished, stopped, timed out).
router.get('/screen', async (req, res) => {
  try {
    const jpeg = await remoteLoginScreen();
    if (!jpeg) return res.status(409).json(remoteLoginState());
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).send(jpeg);
  } catch (err) {
    if (err instanceof RemoteLoginError) return res.status(409).json({ ...remoteLoginState(), code: err.code });
    console.error('[schoology-login] screen:', err.message);
    res.status(500).json({ ...remoteLoginState(), error: 'Could not show the sign-in page' });
  }
});

// POST /click { x, y } in page pixels (VIEWPORT), /type { text }, /key { key }
router.post('/click', handle((req) => remoteLoginClick(Number(req.body?.x), Number(req.body?.y))));
router.post('/type', handle((req) => remoteLoginType(req.body?.text)));
router.post('/key', handle((req) => remoteLoginKey(req.body?.key)));
router.post('/stop', handle(() => stopRemoteLogin()));

export default router;
