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
import { queueDeps, resetQueue, idle } from '../services/syncQueue.js';

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

beforeEach(() => {
  getDb().exec('DELETE FROM sync_run_events; DELETE FROM sync_runs; DELETE FROM courses;');
  resetQueue();
  queueDeps.sessionStatus = vi.fn().mockResolvedValue({ loggedIn: true, live: 'connected' });
  h.impl = async (opts, onEvent) => { onEvent({ type: 'summary', schoology: null, mastery: [], elapsedMs: 1 }); };
});

async function api(port, method, path, body) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /api/sync (the queue, background sync)', () => {
  test('queues a button run and answers its runId at once', async () => {
    const { server, port } = startServer();
    try {
      const r = await api(port, 'POST', '/api/sync', { courseIds: [3, '4'] });
      expect(r).toMatchObject({ status: 200, body: { runId: expect.any(Number), joined: false } });
      await idle();
      const run = await api(port, 'GET', `/api/sync/runs/${r.body.runId}`);
      expect(run.body).toMatchObject({ status: 'completed', options: { kind: 'courses', courseIds: [3, 4], trigger: 'button', force: true } });
    } finally {
      server.close();
    }
  });

  test('every sync is full: recent-only fields are ignored, mastery for every course read', async () => {
    let seen;
    h.impl = async (opts, onEvent) => { seen = opts; onEvent({ type: 'summary', mastery: [], elapsedMs: 1 }); };
    const { server, port } = startServer();
    try {
      await api(port, 'POST', '/api/sync', { courseIds: [3], recentOnly: true, recentDays: 2 });
      await idle();
      expect(seen).toMatchObject({ courseIds: [3], masteryCourseIds: [3] });
      expect(seen.recentOnly).toBeUndefined();
    } finally {
      server.close();
    }
  });

  test('an empty course list is refused', async () => {
    const { server, port } = startServer();
    try {
      expect((await api(port, 'POST', '/api/sync', { courseIds: [] })).status).toBe(400);
    } finally {
      server.close();
    }
  });

  test('GET /sync/current shows the running run with its courses; /sync/status keeps its shape', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    h.impl = async (opts, onEvent) => { onEvent({ phase: 'schoology', status: 'running' }); await gate; onEvent({ type: 'summary', mastery: [], elapsedMs: 1 }); };
    const { server, port } = startServer();
    try {
      const r = await api(port, 'POST', '/api/sync', { courseIds: [7] });
      await new Promise((res) => setTimeout(res, 20));
      const cur = await api(port, 'GET', '/api/sync/current');
      expect(cur.body).toMatchObject({ runId: r.body.runId, running: { runId: r.body.runId, courseIds: [7] }, queued: [], held: [] });
      expect((await api(port, 'GET', '/api/sync/status')).body).toMatchObject({ syncing: true, runId: r.body.runId });
      const inc = await api(port, 'GET', `/api/sync/runs/${r.body.runId}/events?after=0`);
      expect(inc.body).toMatchObject({ status: 'running', finished: false });
      release();
      await idle();
      expect((await api(port, 'GET', '/api/sync/current')).body).toMatchObject({ running: null, runId: null });
    } finally {
      server.close();
    }
  });

  test('POST /sync/resume runs held requests after a sign-in', async () => {
    queueDeps.sessionStatus.mockResolvedValueOnce({ loggedIn: true, live: 'expired' });
    const { server, port } = startServer();
    try {
      const r = await api(port, 'POST', '/api/sync', { courseIds: [7] });
      await idle();
      expect((await api(port, 'GET', `/api/sync/runs/${r.body.runId}`)).body.status).toBe('held');
      expect((await api(port, 'POST', '/api/sync/resume', {})).body).toEqual({ resumed: 1 });
      await idle();
      expect((await api(port, 'GET', `/api/sync/runs/${r.body.runId}`)).body.status).toBe('completed');
    } finally {
      server.close();
    }
  });
});

describe('sync runs + events', () => {
  test('a run is recorded with every event and finished', async () => {
    h.impl = async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'done', records: 9 });
      onEvent({ phase: 'mastery', courseId: 1, courseName: 'Bio', status: 'error', message: 'boom' });
      onEvent({ type: 'log', message: 'Warning: rollup fetch failed' });
      onEvent({ type: 'summary', schoology: { records: 9 }, mastery: [], elapsedMs: 1 });
    };
    const { server, port } = startServer();
    try {
      const { runId } = (await api(port, 'POST', '/api/sync', { courseIds: [1] })).body;
      await idle();
      const list = (await api(port, 'GET', '/api/sync/runs?limit=5')).body;
      expect(list[0]).toMatchObject({ id: runId, status: 'completed_with_errors', error_count: 1, warning_count: 1 });
      const run = (await api(port, 'GET', `/api/sync/runs/${runId}`)).body;
      expect(run.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      const inc = (await api(port, 'GET', `/api/sync/runs/${runId}/events?after=2`)).body;
      expect(inc).toMatchObject({ status: 'completed_with_errors', finished: true });
      expect(inc.events.map((e) => e.seq)).toEqual([3, 4]);
    } finally {
      server.close();
    }
  });

  test('a thrown orchestrator marks the run failed', async () => {
    h.impl = async () => { throw new Error('kaput'); };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { server, port } = startServer();
    try {
      const { runId } = (await api(port, 'POST', '/api/sync', {})).body;
      await idle();
      expect((await api(port, 'GET', `/api/sync/runs/${runId}`)).body).toMatchObject({ status: 'failed', error_count: 1 });
    } finally {
      errSpy.mockRestore();
      server.close();
    }
  });

  test('a fatal summary marks the run failed', async () => {
    h.impl = async (opts, onEvent) => {
      onEvent({ phase: 'schoology', status: 'error', message: 'down' });
      onEvent({ type: 'summary', schoology: null, mastery: [], elapsedMs: 1, fatal: true });
    };
    const { server, port } = startServer();
    try {
      const { runId } = (await api(port, 'POST', '/api/sync', {})).body;
      await idle();
      expect((await api(port, 'GET', `/api/sync/runs/${runId}`)).body.status).toBe('failed');
    } finally {
      server.close();
    }
  });

  test('a failing event log never stops the run', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.failAppend = true;
    const { server, port } = startServer();
    try {
      const { runId } = (await api(port, 'POST', '/api/sync', {})).body;
      await idle();
      h.failAppend = false;
      expect((await api(port, 'GET', `/api/sync/runs/${runId}`)).body.status).toBe('completed');
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

  test('GET /sync/metrics returns the per-phase times (#143)', async () => {
    getDb().prepare(`
      INSERT INTO sync_metrics (started_at, duration_ms, schoology_ms, blocks_ms, mastery_ms, quizzes_ms, total_ms, failed_assignment_ids)
      VALUES ('2026-10-17T00:00:00Z', 59000, 60000, 8500, NULL, 4000, 72500, '[]')
    `).run();
    const { server, port } = startServer();
    try {
      const m = (await api(port, 'GET', '/api/sync/metrics')).body;
      expect(m).toMatchObject({ schoology_ms: 60000, blocks_ms: 8500, mastery_ms: null, quizzes_ms: 4000, total_ms: 72500, failed_assignment_ids: [] });
    } finally {
      server.close();
    }
  });

  test('keeps only the newest 30 runs', async () => {
    const { server, port } = startServer();
    try {
      for (let i = 0; i < 32; i++) { await api(port, 'POST', '/api/sync', { courseIds: [i + 1] }); await idle(); }
      expect((await api(port, 'GET', '/api/sync/runs?limit=100')).body.length).toBe(30);
    } finally {
      server.close();
    }
  });
});

describe('POST /api/sync/ensure (background sync)', () => {
  test('a page asks for its scope: fresh, or queued with a runId', async () => {
    const db = getDb();
    const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, course_synced_at) VALUES ('se', 'E', ?)`).run(new Date().toISOString()).lastInsertRowid;
    const { server, port } = startServer();
    try {
      expect((await api(port, 'POST', '/api/sync/ensure', { scope: { kind: 'courses', courseIds: [c] } })).body).toEqual({ state: 'fresh' });
      db.prepare('UPDATE courses SET course_synced_at = NULL WHERE id = ?').run(c);
      const r = (await api(port, 'POST', '/api/sync/ensure', { scope: { kind: 'courses', courseIds: [c] } })).body;
      expect(r).toMatchObject({ state: 'queued', runId: expect.any(Number) });
      await idle();
      expect((await api(port, 'GET', `/api/sync/runs/${r.runId}`)).body.options).toMatchObject({ kind: 'courses', courseIds: [c], trigger: 'page' });
      expect((await api(port, 'POST', '/api/sync/ensure', { scope: { kind: 'nonsense' } })).status).toBe(400);
    } finally {
      server.close();
    }
  });
});

