// Test-only: a fake logged-in Schoology browser page for the LTI unsubmit path
// (server/services/ltiUnsubmit.js). `evaluate(fn, arg)` runs the REAL in-page function
// against a stub window (Drupal CSRF settings) + fetch, so a test sees exactly what
// would go over the wire. Never launches a browser.
import { vi } from 'vitest';

export const SCHOOLOGY = 'https://schoology.hkis.edu.hk';

// post / inProgress: (respond) => response, respond(status, body). Defaults: the
// verified 200 {"data":[]} and an in-progress list holding `uid`.
export function fakeSchoologyPage({
  uid, aid, landing = `${SCHOOLOGY}/assignments/${aid}/info`, csrf = { csrf_token: 'tok', csrf_key: 'key' }, post, inProgress,
} = {}) {
  const requests = [];
  const respond = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchStub = vi.fn(async (url, init = {}) => {
    requests.push({ url, ...init });
    if (init.method === 'POST') return (post || (() => respond(200, { data: [] })))(respond);
    return (inProgress || (() => respond(200, { data: [{ id: /^\d+$/.test(String(uid)) ? Number(uid) : uid, revisionCreated: true }] })))(respond);
  });
  const page = {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => landing),
    waitForFunction: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async (fn, arg) => {
      const prevWindow = globalThis.window;
      const prevFetch = globalThis.fetch;
      globalThis.window = { Drupal: { settings: { s_common: csrf } } };
      globalThis.fetch = fetchStub;
      try { return await fn(arg); } finally { globalThis.window = prevWindow; globalThis.fetch = prevFetch; }
    }),
  };
  return { session: { page, close: vi.fn(async () => {}) }, requests, page };
}
