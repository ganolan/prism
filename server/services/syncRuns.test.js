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
    expect(classifyEvent({ type: 'log', message: "[blocks] Bio: grade-level read failed (x), skipped" })).toBe('warning');
  });

  test('ordinary events are neither', () => {
    expect(classifyEvent({ phase: 'schoology', status: 'done', records: 9 })).toBe(null);
    expect(classifyEvent({ phase: 'blocks', status: 'done', records: 3, notReady: 0 })).toBe(null);
    expect(classifyEvent({ type: 'log', message: '[blocks] Done: 4 updated, 0 unchanged, 1 skipped (of 5).' })).toBe(null);
    // A count of zero failures is not a failure (the grade-level line, every nightly run since 18/10/2026).
    expect(classifyEvent({ type: 'log', message: '[blocks] Grade levels: 96 students updated (96 seen; sections: 9 from the student list, 0 from section_attendance, 0 failed; 629 ms).' })).toBe(null);
    expect(classifyEvent({ type: 'summary', elapsedMs: 1 })).toBe(null);
  });
});

describe('sync runs', () => {
  test('startRun creates a running run with its options', () => {
    const id = startRun(db(), { masteryCourseIds: [1, 2], includeHidden: true });
    const run = getRun(db(), id);
    expect(run).toMatchObject({ id, status: 'running', finished_at: null, error_count: 0, warning_count: 0 });
    expect(run.options).toEqual({ masteryCourseIds: [1, 2], includeHidden: true });
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
      finishRun(db(), id, { status: 'completed' });
      ids.push(id);
    }
    // A queued, held or running run is never pruned, however old (the queue still holds it).
    db().prepare(`UPDATE sync_runs SET status = 'held' WHERE id = ?`).run(ids[1]);
    pruneRuns(db());
    const left = listRuns(db(), { limit: 100 }).map((r) => r.id);
    expect(left.length).toBe(31);
    expect(left).toContain(ids[1]);
    db().prepare(`UPDATE sync_runs SET status = 'completed' WHERE id = ?`).run(ids[1]);
    expect(left).not.toContain(ids[0]);
    expect(left).toContain(ids[3]);
    const orphanEvents = db().prepare('SELECT COUNT(*) AS n FROM sync_run_events WHERE run_id IN (?, ?)').get(ids[0], ids[2]).n;
    expect(orphanEvents).toBe(0);
    pruneRuns(db(), 5);
    expect(listRuns(db(), { limit: 100 }).length).toBe(5);
  });

  test('#170: pruneRuns counts full syncs and task/quiz runs separately, and never deletes an active row', () => {
    const mk = (options) => {
      const id = startRun(db(), options);
      appendEvent(db(), id, { type: 'log', message: 'x' });
      finishRun(db(), id, { status: 'completed' });
      return id;
    };
    const full = [];
    const small = [];
    // Oldest first: 35 full runs (a mix of the three shapes) under 40 task and quiz runs.
    for (let i = 0; i < 35; i++) full.push(mk(i % 3 === 0 ? {} : { kind: i % 3 === 1 ? 'all' : 'courses' }));
    for (let i = 0; i < 40; i++) small.push(mk(i % 3 === 0 ? { kind: 'quiz' } : { kind: 'task', grading: i % 2 === 0 }));
    // An old running full row and an old held task row survive, outside the kept 30.
    db().prepare(`UPDATE sync_runs SET status = 'running' WHERE id = ?`).run(full[0]);
    db().prepare(`UPDATE sync_runs SET status = 'held' WHERE id = ?`).run(small[0]);
    pruneRuns(db());
    const left = new Set(listRuns(db(), { limit: 200 }).map((r) => r.id));
    expect([...left].length).toBe(30 + 30 + 2);
    for (const id of full.slice(-30)) expect(left.has(id)).toBe(true);
    for (const id of small.slice(-30)) expect(left.has(id)).toBe(true);
    expect(left.has(full[0])).toBe(true);
    expect(left.has(small[0])).toBe(true);
    for (const id of [...full.slice(1, 5), ...small.slice(1, 10)]) {
      expect(left.has(id)).toBe(false);
      expect(db().prepare('SELECT COUNT(*) AS n FROM sync_run_events WHERE run_id = ?').get(id).n).toBe(0);
    }
  });

  test('#171: a past-course import run counts with the small runs', () => {
    const mk = (options) => {
      const id = startRun(db(), options);
      finishRun(db(), id, { status: 'completed' });
      return id;
    };
    const full = mk({ kind: 'all' });
    const imports = [];
    for (let i = 0; i < 4; i++) imports.push(mk({ kind: 'import', sectionId: String(i) }));
    pruneRuns(db(), 3);
    const left = new Set(listRuns(db(), { limit: 200 }).map((r) => r.id));
    expect(left.has(full)).toBe(true);
    expect(left.has(imports[0])).toBe(false);
    for (const id of imports.slice(1)) expect(left.has(id)).toBe(true);
  });

  test('#170: a run whose options_json cannot be read counts as a full sync', () => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const id = startRun(db(), {});
      finishRun(db(), id, { status: 'completed' });
      ids.push(id);
    }
    db().prepare(`UPDATE sync_runs SET options_json = 'not json' WHERE id = ?`).run(ids[0]);
    db().prepare(`UPDATE sync_runs SET options_json = NULL WHERE id = ?`).run(ids[1]);
    const tasks = [];
    for (let i = 0; i < 5; i++) {
      const id = startRun(db(), { kind: 'task' });
      finishRun(db(), id, { status: 'completed' });
      tasks.push(id);
    }
    pruneRuns(db(), 3);
    const left = listRuns(db(), { limit: 100 }).map((r) => r.id).sort((a, b) => a - b);
    // Full group (the unreadable and null rows are full): newest 3 of 4 kept; task group: newest 3 of 5.
    expect(left).toEqual([...ids.slice(1), ...tasks.slice(2)]);
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

  // #165: Settings → Recent syncs reads a run's time per phase from its stored
  // events, so each phase's elapsedMs and the summary's phaseMs must survive.
  test('getRun keeps each phase elapsedMs and the summary phaseMs', () => {
    const id = startRun(db(), {});
    const phaseMs = { schoology: 61000, blocks: 8500, alerts: null, mastery: 30000, comments: null, quizzes: null };
    appendEvent(db(), id, { phase: 'schoology', status: 'done', records: 4, elapsedMs: 61000 });
    appendEvent(db(), id, { phase: 'mastery', courseId: 5, courseName: 'Course A', status: 'done', records: 7, elapsedMs: 30000 });
    appendEvent(db(), id, { type: 'summary', elapsedMs: 104000, phaseMs });
    finishRun(db(), id, { status: 'completed', summary: { type: 'summary', elapsedMs: 104000, phaseMs } });
    const run = getRun(db(), id);
    expect(run.events.map((e) => e.elapsedMs)).toEqual([61000, 30000, 104000]);
    expect(run.events.at(-1).phaseMs).toEqual(phaseMs);
    expect(run.summary.phaseMs).toEqual(phaseMs);
  });

  test('getRun returns null for an unknown id', () => {
    expect(getRun(db(), 999999)).toBe(null);
  });
});
