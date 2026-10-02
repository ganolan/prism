import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import {
  startRun, appendEvent, finishRun, listRuns, getRun, getEvents, pruneRuns,
  markInterruptedRuns, classifyEvent,
} from './syncRuns.js';

const db = () => getDb();

beforeEach(() => {
  db().exec('DELETE FROM sync_run_events; DELETE FROM sync_runs;');
});

describe('classifyEvent', () => {
  test('errors: type error or status error', () => {
    expect(classifyEvent({ type: 'error', message: 'x' })).toBe('error');
    expect(classifyEvent({ phase: 'mastery', status: 'error', message: 'boom' })).toBe('error');
  });

  test('warnings: blocks not ready, and log lines that report a warning/failure', () => {
    expect(classifyEvent({ phase: 'blocks', status: 'done', records: 3, notReady: 2 })).toBe('warning');
    expect(classifyEvent({ type: 'log', message: '[Bio] Warning: rollup fetch failed: 500' })).toBe('warning');
    expect(classifyEvent({ type: 'log', message: 'Retrying 3 failed assignments...' })).toBe('warning');
    expect(classifyEvent({ type: 'log', message: "[blocks] Bio: grade-level read failed (x) — skipped" })).toBe('warning');
  });

  test('ordinary events are neither', () => {
    expect(classifyEvent({ phase: 'schoology', status: 'done', records: 9 })).toBe(null);
    expect(classifyEvent({ phase: 'blocks', status: 'done', records: 3, notReady: 0 })).toBe(null);
    expect(classifyEvent({ type: 'log', message: '[blocks] Done: 4 updated, 0 unchanged, 1 skipped (of 5).' })).toBe(null);
    expect(classifyEvent({ type: 'summary', elapsedMs: 1 })).toBe(null);
  });
});

describe('sync runs', () => {
  test('startRun creates a running run with its options', () => {
    const id = startRun(db(), { masteryCourseIds: [1, 2], recentOnly: true });
    const run = getRun(db(), id);
    expect(run).toMatchObject({ id, status: 'running', finished_at: null, error_count: 0, warning_count: 0 });
    expect(run.options).toEqual({ masteryCourseIds: [1, 2], recentOnly: true });
    expect(run.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('appendEvent assigns increasing seq per run and keeps live counts', () => {
    const a = startRun(db(), {});
    const b = startRun(db(), {});
    expect(appendEvent(db(), a, { phase: 'schoology', status: 'running' })).toBe(1);
    expect(appendEvent(db(), a, { type: 'log', message: 'Warning: x' })).toBe(2);
    expect(appendEvent(db(), b, { type: 'log', message: 'hello' })).toBe(1);
    expect(appendEvent(db(), a, { phase: 'mastery', courseId: 1, status: 'error', message: 'boom' })).toBe(3);
    const run = getRun(db(), a);
    expect(run.error_count).toBe(1);
    expect(run.warning_count).toBe(1);
    expect(run.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(run.events[2]).toMatchObject({ seq: 3, phase: 'mastery', status: 'error', level: 'error' });
    expect(run.events[1].level).toBe('warning');
    expect(run.events[0].level).toBe(null);
    expect(run.events[0].at).toMatch(/^\d{4}-/);
  });

  test('getEvents returns only events after the given seq', () => {
    const id = startRun(db(), {});
    for (let i = 0; i < 5; i++) appendEvent(db(), id, { type: 'log', message: `line ${i}` });
    expect(getEvents(db(), id, { afterSeq: 3 }).map((e) => e.message)).toEqual(['line 3', 'line 4']);
    expect(getEvents(db(), id).length).toBe(5);
  });

  test('finishRun: completed, completed_with_errors, failed', () => {
    const ok = startRun(db(), {});
    appendEvent(db(), ok, { type: 'summary', elapsedMs: 5 });
    finishRun(db(), ok, { status: 'completed', summary: { elapsedMs: 5 } });
    expect(getRun(db(), ok)).toMatchObject({ status: 'completed', summary: { elapsedMs: 5 } });
    expect(getRun(db(), ok).finished_at).toMatch(/^\d{4}-/);

    const withErr = startRun(db(), {});
    appendEvent(db(), withErr, { phase: 'mastery', status: 'error', message: 'boom' });
    finishRun(db(), withErr, { status: 'completed' });
    expect(getRun(db(), withErr).status).toBe('completed_with_errors');

    const failed = startRun(db(), {});
    appendEvent(db(), failed, { type: 'error', message: 'kaput' });
    finishRun(db(), failed, { status: 'failed' });
    expect(getRun(db(), failed).status).toBe('failed');
  });

  test('listRuns newest first, without events, respecting limit', () => {
    const ids = [startRun(db(), {}), startRun(db(), {}), startRun(db(), {})];
    appendEvent(db(), ids[0], { type: 'log', message: 'x' });
    const runs = listRuns(db(), { limit: 2 });
    expect(runs.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    expect(runs[0].events).toBeUndefined();
  });

  test('pruneRuns keeps the newest N runs and deletes older runs and their events', () => {
    const ids = [];
    for (let i = 0; i < 33; i++) {
      const id = startRun(db(), {});
      appendEvent(db(), id, { type: 'log', message: `run ${i}` });
      ids.push(id);
    }
    pruneRuns(db());
    const left = listRuns(db(), { limit: 100 }).map((r) => r.id);
    expect(left.length).toBe(30);
    expect(left).not.toContain(ids[0]);
    expect(left).toContain(ids[3]);
    const orphanEvents = db().prepare('SELECT COUNT(*) AS n FROM sync_run_events WHERE run_id IN (?, ?, ?)').get(ids[0], ids[1], ids[2]).n;
    expect(orphanEvents).toBe(0);
    pruneRuns(db(), 5);
    expect(listRuns(db(), { limit: 100 }).length).toBe(5);
  });

  test('an interrupted run ends at its last event, not at the next boot', () => {
    const stale = startRun(db(), {});
    appendEvent(db(), stale, { type: 'log', message: 'a' });
    db().prepare(`UPDATE sync_runs SET started_at = '2026-10-01T09:00:00.000Z' WHERE id = ?`).run(stale);
    db().prepare(`UPDATE sync_run_events SET at = '2026-10-01T09:04:10.000Z' WHERE run_id = ?`).run(stale);
    const silent = startRun(db(), {});
    db().prepare(`UPDATE sync_runs SET started_at = '2026-10-01T08:00:00.000Z' WHERE id = ?`).run(silent);
    markInterruptedRuns(db());
    expect(getRun(db(), stale).finished_at).toBe('2026-10-01T09:04:10.000Z');
    expect(getRun(db(), silent).finished_at).toBe('2026-10-01T08:00:00.000Z');
  });

  test('markInterruptedRuns flips leftover running runs to interrupted', () => {
    const stale = startRun(db(), {});
    const done = startRun(db(), {});
    finishRun(db(), done, { status: 'completed' });
    expect(markInterruptedRuns(db())).toBe(1);
    expect(getRun(db(), stale)).toMatchObject({ status: 'interrupted' });
    expect(getRun(db(), stale).finished_at).toMatch(/^\d{4}-/);
    expect(getRun(db(), done).status).toBe('completed');
  });

  test('getRun returns null for an unknown id', () => {
    expect(getRun(db(), 999999)).toBe(null);
  });
});
