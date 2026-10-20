import { describe, test, expect, afterEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { mountMcp } from '../server/routes/mcp.js';
import { checkEndpoint } from './check-mcp-endpoint.js';

const open = [];
afterEach(async () => { await Promise.all(open.splice(0).map((close) => close())); });

async function start({ devCopy }) {
  const app = express();
  mountMcp(app, { devCopy });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  open.push(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

describe('check-mcp-endpoint', () => {
  test('a prod endpoint passes, and reports counts only', async () => {
    const r = await checkEndpoint(await start({ devCopy: false }));
    expect(r.ok).toBe(true);
    expect(r.line).toMatch(/: \d+ tools; list_courses \d+ courses; prod$/);
  });

  test('a dev copy fails unless --expect-dev, and prod fails with it', async () => {
    const dev = await start({ devCopy: true });
    expect(await checkEndpoint(dev)).toMatchObject({ ok: false, line: expect.stringContaining('dev copy (expected prod)') });
    expect(await checkEndpoint(dev, { expectDev: true })).toMatchObject({ ok: true, line: expect.stringContaining('dev copy') });
    const prod = await start({ devCopy: false });
    expect(await checkEndpoint(prod, { expectDev: true })).toMatchObject({ ok: false, line: expect.stringContaining('(expected a dev copy)') });
  });

  test('an endpoint that does not answer fails with the reason', async () => {
    const r = await checkEndpoint('http://127.0.0.1:1/mcp');
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/^http:\/\/127\.0\.0\.1:1\/mcp: /);
  });
});
