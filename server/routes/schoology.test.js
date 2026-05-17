import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

const h = vi.hoisted(() => ({ impl: null }));

vi.mock('../services/syncOrchestrator.js', () => ({
  runUnifiedSync: (opts, onEvent) => h.impl(opts, onEvent),
}));

import router from './schoology.js';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0);
  return { server, port: server.address().port };
}

async function readNdjson(res) {
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('POST /api/sync', () => {
  beforeEach(() => {
    h.impl = async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'done', records: 9 });
      onEvent({ type: 'summary', schoology: { records: 9 }, mastery: [], elapsedMs: 1 });
    };
  });

  test('streams newline-delimited JSON progress events', async () => {
    const { server, port } = startServer();
    try {
      const res = await fetch(`http://localhost:${port}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masteryCourseIds: [] }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/x-ndjson/);
      const events = await readNdjson(res);
      expect(events[0]).toMatchObject({ phase: 'schoology', status: 'done' });
      expect(events.at(-1)).toMatchObject({ type: 'summary' });
    } finally {
      server.close();
    }
  });

  test('returns 409 when a sync is already in progress', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    h.impl = async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'running' });
      await gate;
      onEvent({ type: 'summary', schoology: null, mastery: [], elapsedMs: 1 });
    };
    const { server, port } = startServer();
    try {
      const firstRes = await fetch(`http://localhost:${port}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const second = await fetch(`http://localhost:${port}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(second.status).toBe(409);
      release();
      await firstRes.text();
    } finally {
      server.close();
    }
  });

  test('streams an error event and resets syncInProgress when orchestrator throws', async () => {
    const { server, port } = startServer();
    try {
      h.impl = async (opts, onEvent) => {
        onEvent({ phase: 'schoology', status: 'running' });
        throw new Error('orchestrator blew up');
      };
      const res = await fetch(`http://localhost:${port}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const events = await readNdjson(res);
      expect(events.at(-1)).toMatchObject({ type: 'error', message: 'orchestrator blew up' });

      // Confirm syncInProgress was reset — a second request must succeed (200, not 409).
      h.impl = async (opts, onEvent) => {
        onEvent({ phase: 'schoology', status: 'done', records: 0 });
        onEvent({ type: 'summary', schoology: { records: 0 }, mastery: [], elapsedMs: 1 });
      };
      const second = await fetch(`http://localhost:${port}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(second.status).toBe(200);
      await second.text();
    } finally {
      server.close();
    }
  });
});
