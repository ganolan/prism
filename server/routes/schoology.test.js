import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

const h = vi.hoisted(() => { process.env.DB_PATH = ':memory:'; return { impl: null, failAppend: false }; });

vi.mock('../services/syncOrchestrator.js', () => ({
  runUnifiedSync: (opts, onEvent) => h.impl(opts, onEvent),
}));

// Wrap the real service so a test can make appendEvent throw (a DB hiccup).
vi.mock('../services/syncRuns.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    appendEvent: (...args) => {
      if (h.failAppend) throw new Error('database is locked');
      return actual.appendEvent(...args);
    },
  };
});

import router from './schoology.js';
import { getDb } from '../db/index.js';

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
      expect(events[0]).toMatchObject({ type: 'run', runId: expect.any(Number) });
      expect(events[1]).toMatchObject({ phase: 'schoology', status: 'done', seq: 1 });
      expect(events.at(-1)).toMatchObject({ type: 'summary', seq: 2 });
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
      const body = await second.json();
      expect(body).toMatchObject({ error: 'Sync already in progress', runId: expect.any(Number) });
      const current = await (await fetch(`http://localhost:${port}/api/sync/current`)).json();
      expect(current).toEqual({ running: true, runId: body.runId });
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

describe('POST /api/sync — recent-only params (#55)', () => {
  let captured;
  beforeEach(() => {
    captured = null;
    h.impl = async (opts, onEvent) => {
      captured = opts;
      onEvent({ type: 'summary', schoology: null, mastery: [], elapsedMs: 1 });
    };
  });

  async function post(body) {
    const { server, port } = startServer();
    try {
      const res = await fetch(`http://localhost:${port}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await res.text(); // drain the ndjson stream
    } finally {
      server.close();
    }
  }

  test('defaults to recentOnly false / 30 days when omitted', async () => {
    await post({ masteryCourseIds: [] });
    expect(captured.recentOnly).toBe(false);
    expect(captured.recentDays).toBe(30);
  });

  test('passes through recentOnly and clamps recentDays into 1..365', async () => {
    await post({ recentOnly: true, recentDays: 9999 });
    expect(captured.recentOnly).toBe(true);
    expect(captured.recentDays).toBe(365);
  });

  test('coerces a non-numeric recentDays to the default', async () => {
    await post({ recentOnly: true, recentDays: 'abc' });
    expect(captured.recentDays).toBe(30);
  });

  test('defaults an explicit null recentDays to 30', async () => {
    await post({ recentOnly: true, recentDays: null });
    expect(captured.recentDays).toBe(30);
  });
});

describe('sync runs + events', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM sync_run_events; DELETE FROM sync_runs;');
  });

  async function runOnce(port, body = {}) {
    const res = await fetch(`http://localhost:${port}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return readNdjson(res);
  }

  test('a run is recorded with every streamed event and finished', async () => {
    h.impl = async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'done', records: 9 });
      onEvent({ phase: 'mastery', courseId: 1, courseName: 'Bio', status: 'error', message: 'boom' });
      onEvent({ type: 'log', message: 'Warning: rollup fetch failed' });
      onEvent({ type: 'summary', schoology: { records: 9 }, mastery: [], elapsedMs: 1 });
    };
    const { server, port } = startServer();
    try {
      const streamed = await runOnce(port, { masteryCourseIds: [1] });
      const runId = streamed[0].runId;
      const list = await (await fetch(`http://localhost:${port}/api/sync/runs?limit=5`)).json();
      expect(list[0]).toMatchObject({ id: runId, status: 'completed_with_errors', error_count: 1, warning_count: 1 });
      expect(list[0].options).toMatchObject({ masteryCourseIds: [1] });
      expect(list[0].summary).toMatchObject({ elapsedMs: 1 });

      const run = await (await fetch(`http://localhost:${port}/api/sync/runs/${runId}`)).json();
      expect(run.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      expect(run.events[1]).toMatchObject({ level: 'error', message: 'boom' });

      const inc = await (await fetch(`http://localhost:${port}/api/sync/runs/${runId}/events?after=2`)).json();
      expect(inc.status).toBe('completed_with_errors');
      expect(inc.finished).toBe(true);
      expect(inc.events.map((e) => e.seq)).toEqual([3, 4]);
      expect(inc.events[1]).toMatchObject({ type: 'summary' });

      const status = await (await fetch(`http://localhost:${port}/api/sync/status`)).json();
      expect(status).toMatchObject({ syncing: false, runId: null });
      const current = await (await fetch(`http://localhost:${port}/api/sync/current`)).json();
      expect(current).toEqual({ running: false, runId: null });
    } finally {
      server.close();
    }
  });

  test('events?after= reports an unfinished run while it is running', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    h.impl = async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'running' });
      await gate;
      onEvent({ type: 'summary', schoology: null, mastery: [], elapsedMs: 1 });
    };
    const { server, port } = startServer();
    try {
      const pending = fetch(`http://localhost:${port}/api/sync`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const res = await pending;
      const reader = res.body.getReader();
      await reader.read(); // headers + first event(s) are flushed
      const { runId } = await (await fetch(`http://localhost:${port}/api/sync/current`)).json();
      const inc = await (await fetch(`http://localhost:${port}/api/sync/runs/${runId}/events?after=0`)).json();
      expect(inc).toMatchObject({ status: 'running', finished: false });
      expect(inc.events[0]).toMatchObject({ seq: 1, phase: 'schoology', status: 'running' });
      release();
      while (!(await reader.read()).done) { /* drain */ }
    } finally {
      server.close();
    }
  });

  test('a thrown orchestrator marks the run failed', async () => {
    h.impl = async () => { throw new Error('kaput'); };
    const { server, port } = startServer();
    try {
      const streamed = await runOnce(port);
      expect(streamed.at(-1)).toMatchObject({ type: 'error', message: 'kaput', seq: 1 });
      const run = await (await fetch(`http://localhost:${port}/api/sync/runs/${streamed[0].runId}`)).json();
      expect(run).toMatchObject({ status: 'failed', error_count: 1 });
    } finally {
      server.close();
    }
  });

  test('a fatal summary (Schoology step failed, sync stopped) marks the run failed', async () => {
    h.impl = async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'error', message: 'down' });
      onEvent({ type: 'summary', schoology: null, mastery: [], elapsedMs: 1, fatal: true });
    };
    const { server, port } = startServer();
    try {
      const streamed = await runOnce(port);
      const run = await (await fetch(`http://localhost:${port}/api/sync/runs/${streamed[0].runId}`)).json();
      expect(run.status).toBe('failed');
    } finally {
      server.close();
    }
  });

  test('a failing event log never breaks the stream; the lock still resets', async () => {
    h.impl = async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'done', records: 1 });
      onEvent({ type: 'summary', schoology: { records: 1 }, mastery: [], elapsedMs: 1 });
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.failAppend = true;
    const { server, port } = startServer();
    try {
      const streamed = await runOnce(port);
      expect(streamed[0]).toMatchObject({ type: 'run' });
      expect(streamed.slice(1)).toEqual([
        { phase: 'schoology', status: 'done', records: 1 },
        { type: 'summary', schoology: { records: 1 }, mastery: [], elapsedMs: 1 },
      ]);
      h.failAppend = false;
      const again = await runOnce(port); // 200 + a fresh run, not 409
      expect(again[0]).toMatchObject({ type: 'run' });
      expect(again[0].runId).not.toBe(streamed[0].runId);
      expect((await (await fetch(`http://localhost:${port}/api/sync/current`)).json()).running).toBe(false);
    } finally {
      h.failAppend = false;
      errSpy.mockRestore();
      server.close();
    }
  });

  test('404 for an unknown run', async () => {
    const { server, port } = startServer();
    try {
      expect((await fetch(`http://localhost:${port}/api/sync/runs/999999`)).status).toBe(404);
      expect((await fetch(`http://localhost:${port}/api/sync/runs/999999/events?after=0`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  test('keeps only the newest 30 runs', async () => {
    h.impl = async (opts, onEvent) => { onEvent({ type: 'summary', mastery: [], elapsedMs: 1 }); };
    const { server, port } = startServer();
    try {
      for (let i = 0; i < 32; i++) await runOnce(port);
      const list = await (await fetch(`http://localhost:${port}/api/sync/runs?limit=100`)).json();
      expect(list.length).toBe(30);
    } finally {
      server.close();
    }
  });
});
