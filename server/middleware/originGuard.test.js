import { describe, test, expect } from 'vitest';
import express from 'express';
import { isAllowedOrigin, originGuard } from './originGuard.js';

const PROD = 'https://prism.swordtail-everest.ts.net';

describe('isAllowedOrigin', () => {
  const req = (origin, host = '127.0.0.1:3001', forwardedHost) => ({ origin, host, forwardedHost, allowed: [PROD] });
  test('no Origin header (curl, PrisMCP, a same-origin GET) is allowed', () => {
    expect(isAllowedOrigin(req(undefined))).toBe(true);
  });
  test('the page Prism served: Origin matches the Host or X-Forwarded-Host', () => {
    expect(isAllowedOrigin(req('http://localhost:5173', 'localhost:5173'))).toBe(true);
    expect(isAllowedOrigin(req(PROD, '127.0.0.1:3001', 'prism.swordtail-everest.ts.net'))).toBe(true);
  });
  test('the configured prod address, even when the proxy rewrote the Host', () => {
    expect(isAllowedOrigin(req(PROD, '127.0.0.1:3001'))).toBe(true);
  });
  test('any other site is refused, including another port on the same machine and "null"', () => {
    expect(isAllowedOrigin(req('https://evil.example', 'prism.swordtail-everest.ts.net'))).toBe(false);
    expect(isAllowedOrigin(req('http://localhost:8080', 'localhost:5173'))).toBe(false);
    expect(isAllowedOrigin(req('http://prism.swordtail-everest.ts.net', '127.0.0.1:3001'))).toBe(false); // http, not https
    expect(isAllowedOrigin(req('null'))).toBe(false);
    expect(isAllowedOrigin(req('not a url'))).toBe(false);
  });
});

describe('originGuard middleware', () => {
  async function call(method, headers) {
    const app = express();
    app.use(originGuard({ allowed: [PROD] }));
    app.all('/api/x', (req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/x`, { method, headers });
      return { status: res.status, body: await res.json() };
    } finally { server.close(); }
  }

  test('a write from another site is refused with 403 before it reaches a route', async () => {
    const r = await call('POST', { Origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/another site/);
  });
  test('a write from Prism itself, or with no Origin, goes through', async () => {
    expect((await call('POST', { Origin: PROD })).status).toBe(200);
    expect((await call('PUT', {})).status).toBe(200);
  });
  test('reads are not checked (a browser hides the answer from other sites without CORS headers)', async () => {
    expect((await call('GET', { Origin: 'https://evil.example' })).status).toBe(200);
  });
});
