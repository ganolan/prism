import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { queueDeps, resetQueue, currentSync, enqueue, TOOL_WAIT_MS } from './syncQueue.js';
import { markInterruptedRuns } from './syncRuns.js';
import { gradingSync, GradingSyncError, GRADING_FRESH_MS, GRADING_WAIT_MS, SIGN_IN_URL } from './gradingSync.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const runs = () => getDb().prepare('SELECT * FROM sync_runs ORDER BY id').all();
const NOW = Date.parse('2026-10-20T10:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

let course; let task;
const stamp = (at) => getDb().prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run(at, task);
const stampGrading = (at) => getDb().prepare('UPDATE assignments SET task_synced_at = ?, grading_synced_at = ? WHERE id = ?').run(at, at, task);
const summary = { type: 'summary', mastery: [{ status: 'done' }], comments: { refreshed: 3, failed: 0 }, files: { refreshed: 2, failed: 0 } };

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM sync_run_events; DELETE FROM sync_runs; DELETE FROM assignments; DELETE FROM courses;');
  course = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'C')`).run().lastInsertRowid;
  task = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'A1', 'Essay')`).run(course).lastInsertRowid;
  resetQueue();
  queueDeps.sessionStatus = vi.fn().mockResolvedValue({ loggedIn: true, live: 'connected' });
  // A grading run that succeeds: it stamps the task, as taskSyncRun.js does.
  queueDeps.runTaskSync = vi.fn(async (request, emit) => {
    const at = new Date().toISOString();
    db.prepare('UPDATE assignments SET task_synced_at = ?, grading_synced_at = ? WHERE id = ?').run(at, at, task);
    emit(summary);
  });
});

describe('gradingSync', () => {
  test('exports the wait as the tool wait and the 5 minute window', () => {
    expect(GRADING_WAIT_MS).toBe(TOOL_WAIT_MS);
    expect(GRADING_FRESH_MS).toBe(5 * 60 * 1000);
  });

  test('a task grading-synced under 5 minutes ago is fresh: nothing queued, no session check', async () => {
    stampGrading(ago(4 * 60 * 1000));
    const r = await gradingSync(getDb(), 'A1', { now: NOW });
    expect(r).toEqual({ state: 'fresh', dataAsOf: ago(4 * 60 * 1000) });
    expect(runs()).toHaveLength(0);
    expect(queueDeps.sessionStatus).not.toHaveBeenCalled();
  });

  test('a plain task run 1 minute ago does not make a grading call fresh: a grading run is queued', async () => {
    stamp(ago(60 * 1000));
    const r = await gradingSync(getDb(), 'A1', { now: NOW });
    expect(r.state).toBe('synced');
    expect(queueDeps.runTaskSync).toHaveBeenCalledWith(expect.objectContaining({ grading: true }), expect.any(Function));
  });

  test('a grading run 1 minute ago does', async () => {
    stampGrading(ago(60 * 1000));
    const r = await gradingSync(getDb(), 'A1', { now: NOW });
    expect(r).toEqual({ state: 'fresh', dataAsOf: ago(60 * 1000) });
    expect(queueDeps.runTaskSync).not.toHaveBeenCalled();
  });

  test('a sync 5 minutes old or more is not fresh', async () => {
    stampGrading(ago(GRADING_FRESH_MS));
    const r = await gradingSync(getDb(), 'A1', { now: NOW });
    expect(r.state).toBe('synced');
  });

  test('otherwise a grading run is queued ahead of page runs and awaited → synced', async () => {
    let release;
    queueDeps.runUnifiedSync = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    enqueue({ kind: 'courses', courseIds: [course], trigger: 'page' });
    await tick();
    const other = getDb().prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s2', 'D')`).run().lastInsertRowid;
    enqueue({ kind: 'courses', courseIds: [other], trigger: 'page' });

    const pending = gradingSync(getDb(), 'A1', { waitMs: 2000 });
    await tick();
    expect(queueDeps.runTaskSync).not.toHaveBeenCalled();
    expect(currentSync().queued.map((q) => q.kind)).toEqual(['task', 'courses']);

    release();
    const r = await pending;
    expect(r).toMatchObject({ state: 'synced', summary });
    expect(r.runId).toEqual(expect.any(Number));
    expect(r.dataAsOf).toEqual(expect.any(String));
    expect(queueDeps.runTaskSync).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task', courseId: course, assignmentId: 'A1', grading: true, trigger: 'button' }),
      expect.any(Function),
    );
  });

  test('a local id and a Schoology id both resolve to the same task; an unknown one is NOT_FOUND and queues nothing', async () => {
    for (const ref of ['A1', task, String(task)]) {
      stamp(null);
      await gradingSync(getDb(), ref);
      expect(queueDeps.runTaskSync).toHaveBeenLastCalledWith(
        expect.objectContaining({ courseId: course, assignmentId: 'A1', grading: true }), expect.any(Function),
      );
    }
    queueDeps.runTaskSync.mockClear();
    queueDeps.sessionStatus.mockClear();
    const before = runs().length;
    const err = await gradingSync(getDb(), 'nope').catch((e) => e);
    expect(err).toBeInstanceOf(GradingSyncError);
    expect(err.code).toBe('NOT_FOUND');
    expect(runs()).toHaveLength(before);
    expect(queueDeps.sessionStatus).not.toHaveBeenCalled();
  });

  test('a lapsed session answers SESSION_LAPSED with the sign-in link and task_synced_at, and queues nothing', async () => {
    stamp(ago(60 * 60 * 1000));
    for (const live of ['expired', 'none']) {
      queueDeps.sessionStatus.mockResolvedValue({ loggedIn: false, live });
      const err = await gradingSync(getDb(), 'A1', { now: NOW }).catch((e) => e);
      expect(err).toMatchObject({ code: 'SESSION_LAPSED', signInUrl: SIGN_IN_URL, lastSyncedAt: ago(60 * 60 * 1000) });
      expect(err.message).toContain(SIGN_IN_URL);
      expect(err.message).toContain('use_stored_data');
    }
    expect(SIGN_IN_URL).toBe('https://prism.swordtail-everest.ts.net/settings#schoology-signin');
    expect(runs()).toHaveLength(0);
    expect(currentSync().queued).toEqual([]);
  });

  test('an unknown session state runs the sync (it fails visibly if Schoology is down)', async () => {
    queueDeps.sessionStatus.mockRejectedValue(new Error('offline'));
    const r = await gradingSync(getDb(), 'A1');
    expect(r.state).toBe('synced');
  });

  test('use_stored_data skips the session check and the sync → stored, dataAsOf = task_synced_at', async () => {
    stamp(ago(60 * 60 * 1000));
    queueDeps.sessionStatus.mockResolvedValue({ loggedIn: false, live: 'expired' });
    const r = await gradingSync(getDb(), 'A1', { useStoredData: true, now: NOW });
    expect(r).toEqual({ state: 'stored', dataAsOf: ago(60 * 60 * 1000) });
    expect(queueDeps.sessionStatus).not.toHaveBeenCalled();
    expect(runs()).toHaveLength(0);
  });

  test('use_stored_data on a task never fully synced → stored, dataAsOf null', async () => {
    const r = await gradingSync(getDb(), 'A1', { useStoredData: true, now: NOW });
    expect(r).toEqual({ state: 'stored', dataAsOf: null });
  });

  test('a run held mid-way (sign-in lost) answers SESSION_LAPSED', async () => {
    stamp(ago(60 * 60 * 1000));
    queueDeps.runTaskSync = vi.fn(async (request, emit) => {
      emit({ type: 'summary', mastery: [{ status: 'error', errorKind: 'login' }], signIn: true });
    });
    const err = await gradingSync(getDb(), 'A1', { now: NOW, waitMs: 2000 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'SESSION_LAPSED', signInUrl: SIGN_IN_URL, lastSyncedAt: ago(60 * 60 * 1000) });
    expect(currentSync().held).toHaveLength(1);
    expect(runs()[0].status).toBe('held');
  });

  test('after a held run, a call with a working session resumes it instead of waiting on nothing', async () => {
    stamp(ago(60 * 60 * 1000));
    let calls = 0;
    queueDeps.runTaskSync = vi.fn(async (request, emit) => {
      calls++;
      if (calls === 1) return emit({ type: 'summary', mastery: [{ status: 'error', errorKind: 'login' }], signIn: true });
      return emit(summary);
    });
    await expect(gradingSync(getDb(), 'A1', { now: NOW, waitMs: 2000 })).rejects.toMatchObject({ code: 'SESSION_LAPSED' });
    expect(currentSync().held).toHaveLength(1);
    const heldRun = runs()[0].id;

    // The teacher signed in (no hook ran): the session is connected again.
    const r = await gradingSync(getDb(), 'A1', { now: NOW, waitMs: 2000 });
    expect(r).toMatchObject({ state: 'synced', runId: heldRun });
    expect(queueDeps.runTaskSync).toHaveBeenCalledTimes(2);
    expect(currentSync().held).toEqual([]);
  });

  test('a failed run answers SYNC_FAILED with its run id and the reason', async () => {
    queueDeps.runTaskSync = vi.fn(async () => { throw new Error('Schoology 503'); });
    const err = await gradingSync(getDb(), 'A1', { waitMs: 2000 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'SYNC_FAILED', runId: runs()[0].id });
    expect(err.message).toContain('Schoology 503');
    expect(err.message).toContain(`run ${runs()[0].id}`);
  });

  test('a run that finished with errors is SYNC_FAILED, never stale data', async () => {
    queueDeps.runTaskSync = vi.fn(async (request, emit) => {
      emit({ phase: 'assignment', status: 'error', title: 'Essay', message: '1 comment thread(s) not read' });
      emit({ type: 'summary', mastery: [{ status: 'done' }], comments: { refreshed: 2, failed: 1 } });
    });
    const err = await gradingSync(getDb(), 'A1', { waitMs: 2000 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'SYNC_FAILED', runId: runs()[0].id });
    expect(err.message).toContain('1 comment thread(s) not read');
  });

  test('a deploy restart: the interrupted run is SYNC_FAILED, and the next call starts a fresh run', async () => {
    queueDeps.runTaskSync = vi.fn(() => new Promise(() => {})); // the process dies mid-run
    const restart = async () => { await tick(); markInterruptedRuns(getDb()); resetQueue(); return 'interrupted'; };
    const err = await gradingSync(getDb(), 'A1', { deps: { whenDone: restart } }).catch((e) => e);
    expect(err).toMatchObject({ code: 'SYNC_FAILED' });
    expect(err.message).toMatch(/interrupted/);
    const first = err.runId;
    expect(runs().find((r) => r.id === first).status).toBe('interrupted');

    queueDeps.runTaskSync = vi.fn(async (request, emit) => emit(summary));
    const r = await gradingSync(getDb(), 'A1', { waitMs: 2000 });
    expect(r.state).toBe('synced');
    expect(r.runId).not.toBe(first);
    expect(queueDeps.runTaskSync).toHaveBeenCalledTimes(1);
  });

  test('a wait past waitMs answers SYNC_PENDING; calling again follows the same run', async () => {
    let release;
    queueDeps.runTaskSync = vi.fn((request, emit) => new Promise((resolve) => {
      release = () => { emit(summary); resolve(); };
    }));
    const err = await gradingSync(getDb(), 'A1', { waitMs: 20 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'SYNC_PENDING', runId: runs()[0].id });

    const again = gradingSync(getDb(), 'A1', { waitMs: 2000 });
    await tick();
    release();
    const r = await again;
    expect(r).toMatchObject({ state: 'synced', runId: err.runId });
    expect(queueDeps.runTaskSync).toHaveBeenCalledTimes(1);
    expect(runs()).toHaveLength(1);
  });

  test('onProgress is called while waiting, and stops when the wait ends', async () => {
    let release;
    queueDeps.runTaskSync = vi.fn((request, emit) => new Promise((resolve) => {
      release = () => { emit(summary); resolve(); };
    }));
    const onProgress = vi.fn();
    const pending = gradingSync(getDb(), 'A1', { waitMs: 2000, onProgress, progressMs: 10 });
    await tick(55);
    release();
    await pending;
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onProgress).toHaveBeenCalledWith({ runId: runs()[0].id, waitedMs: expect.any(Number) });
    const calls = onProgress.mock.calls.length;
    await tick(40);
    expect(onProgress).toHaveBeenCalledTimes(calls);
  });
});
