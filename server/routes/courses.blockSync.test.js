import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

// Mock the Playwright-backed service — the route is what we're testing.
vi.mock('../services/blockNumberSync.js', () => ({ syncBlockNumbers: vi.fn() }));

import router from './courses.js';
import { syncBlockNumbers } from '../services/blockNumberSync.js';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/courses', router);
  const server = app.listen(0);
  return { server, port: server.address().port };
}

async function post(path, body) {
  const { server, port } = startServer();
  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('POST /api/courses/sync-block-numbers', () => {
  beforeEach(() => vi.clearAllMocks());

  test('returns the service summary on success', async () => {
    const summary = { processed: 2, updated: 1, unchanged: 1, skipped: 0, results: [] };
    syncBlockNumbers.mockResolvedValueOnce(summary);

    const { status, body } = await post('/api/courses/sync-block-numbers');
    expect(status).toBe(200);
    expect(body).toEqual(summary);
    expect(syncBlockNumbers).toHaveBeenCalledOnce();
  });

  test('forwards courseIds from the request body', async () => {
    syncBlockNumbers.mockResolvedValueOnce({ processed: 1, updated: 1, unchanged: 0, skipped: 0, results: [] });
    await post('/api/courses/sync-block-numbers', { courseIds: [7, 9] });
    expect(syncBlockNumbers).toHaveBeenCalledWith(expect.objectContaining({ courseIds: [7, 9] }));
  });

  test('maps a stale-session error to 401', async () => {
    syncBlockNumbers.mockRejectedValueOnce(new Error('No Schoology browser session — run `npm run mastery:login` first.'));
    const { status, body } = await post('/api/courses/sync-block-numbers');
    expect(status).toBe(401);
    expect(body.error).toMatch(/mastery:login/);
  });

  test('maps an unexpected error to 500', async () => {
    syncBlockNumbers.mockRejectedValueOnce(new Error('boom'));
    const { status, body } = await post('/api/courses/sync-block-numbers');
    expect(status).toBe(500);
    expect(body.error).toBe('boom');
  });

  test('rejects a concurrent run with 409', async () => {
    // Hold the first call open so the in-progress guard is set when the 2nd arrives.
    let release;
    syncBlockNumbers.mockImplementationOnce(() => new Promise((r) => { release = () => r({ processed: 0, updated: 0, unchanged: 0, skipped: 0, results: [] }); }));

    const { server, port } = startServer();
    try {
      const first = fetch(`http://localhost:${port}/api/courses/sync-block-numbers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      // Give the first request time to enter the handler and set the flag.
      await new Promise((r) => setTimeout(r, 50));
      const second = await fetch(`http://localhost:${port}/api/courses/sync-block-numbers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(second.status).toBe(409);
      release();
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
