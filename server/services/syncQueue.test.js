import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { enqueue, currentSync, resumeHeld, queueDeps, resetQueue, idle, ensure, SYNC_FRESH_MS } from './syncQueue.js';
import { markInterruptedRuns } from './syncRuns.js';

// A controllable run: each started run waits until the test finishes it.
function gatedRuns() {
  const started = [];
  queueDeps.runUnifiedSync = vi.fn((options, emit) => new Promise((resolve) => {
    started.push({ options, finish: (summary = { type: 'summary', mastery: [] }) => { emit(summary); resolve(); } });
  }));
  queueDeps.runTaskSync = vi.fn((request, emit) => new Promise((resolve) => {
    started.push({ request, finish: (summary = { type: 'summary', mastery: [] }) => { emit(summary); resolve(); } });
  }));
  return started;
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const status = (runId) => getDb().prepare('SELECT status FROM sync_runs WHERE id = ?').get(runId).status;

let a; let b;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM sync_run_events; DELETE FROM sync_runs; DELETE FROM assignments; DELETE FROM courses;');
  a = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sa', 'A')`).run().lastInsertRowid;
  b = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sb', 'B')`).run().lastInsertRowid;
  resetQueue();
  queueDeps.sessionStatus = vi.fn().mockResolvedValue({ loggedIn: true, live: 'connected' });
});

describe('the sync queue', () => {
  test('an idle queue starts a request at once and records the run', async () => {
    const runs = gatedRuns();
    const r = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    await tick();
    expect(status(r.runId)).toBe('running');
    expect(runs[0].options).toMatchObject({ courseIds: [a], masteryCourseIds: [a], syncBlocks: false });
    expect(currentSync().running).toMatchObject({ runId: r.runId, courseIds: [a] });
    runs[0].finish();
    await idle();
    expect(status(r.runId)).toBe('completed');
    expect(currentSync().running).toBeNull();
  });

  test('two pages asking for the same course while it syncs share one run', async () => {
    const runs = gatedRuns();
    const first = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    await tick();
    const second = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    expect(second).toMatchObject({ runId: first.runId, joined: true });
    runs[0].finish();
    await idle();
    expect(queueDeps.runUnifiedSync).toHaveBeenCalledTimes(1);
  });

  test('a button press never joins a running run; it goes ahead of queued page requests', async () => {
    const runs = gatedRuns();
    const running = enqueue({ kind: 'all', trigger: 'page' });
    await tick();
    const page = enqueue({ kind: 'courses', courseIds: [b], trigger: 'page', force: false });
    const button = enqueue({ kind: 'courses', courseIds: [a], trigger: 'button', force: true });
    expect(button.joined).toBe(false);
    expect(page.joined).toBe(true); // the running 'all' covers B for a page request
    expect(currentSync().queued.map((q) => q.runId)).toEqual([button.runId]);
    runs[0].finish();
    await tick();
    expect(runs[1].options.courseIds).toEqual([a]);
    expect(status(running.runId)).toBe('completed');
    runs[1].finish();
    await idle();
  });

  test('queued page requests run in order', async () => {
    const runs = gatedRuns();
    enqueue({ kind: 'courses', courseIds: [a], trigger: 'page', force: true });
    await tick();
    const q1 = enqueue({ kind: 'courses', courseIds: [b], trigger: 'page' });
    const q2 = enqueue({ kind: 'task', courseId: a, assignmentId: 'T9', trigger: 'page', force: true });
    expect(currentSync().queued.map((q) => q.runId)).toEqual([q1.runId, q2.runId]);
    runs[0].finish(); await tick();
    runs[1].finish(); await tick();
    expect(runs[2].request).toMatchObject({ kind: 'task', assignmentId: 'T9' });
    runs[2].finish();
    await idle();
  });

  test('an expired session holds the request; Schoology unreachable runs it; the nightly run never waits', async () => {
    const runs = gatedRuns();
    queueDeps.sessionStatus.mockResolvedValueOnce({ loggedIn: true, live: 'expired' });
    const held = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    await idle();
    expect(status(held.runId)).toBe('held');
    expect(currentSync().held.map((h) => h.runId)).toEqual([held.runId]);
    queueDeps.sessionStatus.mockResolvedValueOnce({ loggedIn: true, live: 'unknown' });
    const tried = enqueue({ kind: 'courses', courseIds: [b], trigger: 'page' });
    await tick();
    expect(status(tried.runId)).toBe('running');
    runs[0].finish(); await idle();
    queueDeps.sessionStatus.mockClear();
    const nightly = enqueue({ kind: 'all', trigger: 'scheduled' });
    await tick();
    expect(queueDeps.sessionStatus).not.toHaveBeenCalled();
    expect(status(nightly.runId)).toBe('running');
    runs[1].finish(); await idle();
  });

  test('a run whose mastery hit a sign-in error is held, and runs again after the sign-in', async () => {
    const runs = gatedRuns();
    const r = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    await tick();
    runs[0].finish({ type: 'summary', mastery: [{ courseId: a, status: 'error', errorKind: 'login' }] });
    await idle();
    expect(status(r.runId)).toBe('held');
    resumeHeld();
    await tick();
    expect(status(r.runId)).toBe('running');
    runs[1].finish();
    await idle();
    expect(status(r.runId)).toBe('completed');
  });

  test('a task request joins a course run covering its course; a forced one waits for its own', async () => {
    const runs = gatedRuns();
    const course = enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' });
    await tick();
    expect(enqueue({ kind: 'task', courseId: a, assignmentId: 'T1', trigger: 'page' })).toMatchObject({ runId: course.runId, joined: true });
    expect(enqueue({ kind: 'task', courseId: a, assignmentId: 'T1', trigger: 'button', force: true }).joined).toBe(false);
    runs[0].finish(); await tick();
    runs[1].finish(); await idle();
  });

  test('a mastery-only retry covers nothing', async () => {
    const runs = gatedRuns();
    enqueue({ kind: 'courses', courseIds: [a], masteryCourseIds: [a], skipSchoology: true, trigger: 'button', force: true });
    await tick();
    expect(enqueue({ kind: 'courses', courseIds: [a], trigger: 'page' }).joined).toBe(false);
    runs[0].finish(); await tick();
    runs[1].finish(); await idle();
  });

  test('a restart marks queued and held runs interrupted', () => {
    const db = getDb();
    for (const s of ['queued', 'held', 'running']) {
      db.prepare(`INSERT INTO sync_runs (started_at, status, options_json) VALUES (datetime('now'), ?, '{}')`).run(s);
    }
    markInterruptedRuns(db);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_runs WHERE status = 'interrupted'`).get().n).toBe(3);
  });

  describe('ensure: pages ask for their scope', () => {
    const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
    const setCourse = (id, cols) => getDb().prepare(`UPDATE courses SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(cols), id);

    test('a course synced within 10 minutes is fresh; an older one is queued', async () => {
      const runs = gatedRuns();
      setCourse(a, { course_synced_at: iso(60_000) });
      expect(ensure({ kind: 'courses', courseIds: [a] })).toEqual({ state: 'fresh' });
      setCourse(a, { course_synced_at: iso(SYNC_FRESH_MS + 1000) });
      const r = ensure({ kind: 'courses', courseIds: [a] });
      expect(r).toMatchObject({ state: 'queued', runId: expect.any(Number) });
      await tick();
      runs[0].finish(); await idle();
    });

    test('a failed attempt within the window counts too (a failing course is not retried on every visit)', () => {
      setCourse(a, { course_synced_at: null, sync_attempted_at: iso(60_000) });
      expect(ensure({ kind: 'courses', courseIds: [a] })).toEqual({ state: 'fresh' });
    });

    test('the dashboard queues only its stale courses', async () => {
      const runs = gatedRuns();
      setCourse(a, { course_synced_at: iso(60_000) });
      ensure({ kind: 'all' });
      await tick();
      expect(runs[0].options.courseIds).toEqual([b]);
      runs[0].finish(); await idle();
    });

    test('an archived course or its task is fresh for a page (only the button re-reads it)', () => {
      setCourse(a, { archived: 1 });
      const t = getDb().prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'TA', 'T')`).run(a).lastInsertRowid;
      expect(ensure({ kind: 'courses', courseIds: [a] })).toEqual({ state: 'fresh' });
      expect(ensure({ kind: 'task', courseId: a, assignmentId: 'TA' })).toEqual({ state: 'fresh' });
      expect(t).toBeGreaterThan(0);
    });

    test('a task synced by its course\'s sync is fresh; a stale one is queued as a task run', async () => {
      const runs = gatedRuns();
      getDb().prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, task_synced_at) VALUES (?, 'T1', 'T', ?)`).run(a, iso(1000));
      expect(ensure({ kind: 'task', courseId: a, assignmentId: 'T1' })).toEqual({ state: 'fresh' });
      getDb().prepare(`UPDATE assignments SET task_synced_at = ? WHERE schoology_assignment_id = 'T1'`).run(iso(SYNC_FRESH_MS + 1000));
      ensure({ kind: 'task', courseId: a, assignmentId: 'T1' });
      await tick();
      expect(runs[0].request).toMatchObject({ kind: 'task', assignmentId: 'T1', trigger: 'page' });
      runs[0].finish(); await idle();
    });

    test('a page whose scope is already syncing follows that run', async () => {
      const runs = gatedRuns();
      const r = enqueue({ kind: 'courses', courseIds: [a], trigger: 'button', force: true });
      await tick();
      setCourse(a, { course_synced_at: iso(60_000) });
      expect(ensure({ kind: 'courses', courseIds: [a] })).toEqual({ state: 'running', runId: r.runId });
      runs[0].finish(); await idle();
    });
  });
});

