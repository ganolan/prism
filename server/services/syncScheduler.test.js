import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { updateSyncScheduleSettings } from './settings.js';
import { SyncBusyError } from './syncRunner.js';
import { nextRunAt, scheduledSyncOptions, createSyncScheduler, readLastScheduledRun } from './syncScheduler.js';

// Local-time dates, so the tests hold in any timezone.
const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s);

beforeEach(() => {
  getDb().exec("DELETE FROM settings; DELETE FROM courses; DELETE FROM sync_runs;");
});

describe('nextRunAt', () => {
  test('later today when the time has not passed yet', () => {
    expect(nextRunAt(at(2026, 10, 5, 1, 0), '03:00')).toEqual(at(2026, 10, 5, 3, 0));
  });

  test('tomorrow once the time has passed, or at exactly the time', () => {
    expect(nextRunAt(at(2026, 10, 5, 14, 0), '03:00')).toEqual(at(2026, 10, 6, 3, 0));
    expect(nextRunAt(at(2026, 10, 5, 3, 0), '03:00')).toEqual(at(2026, 10, 6, 3, 0));
  });

  test('rolls over the end of a month', () => {
    expect(nextRunAt(at(2026, 10, 31, 23, 0), '03:00')).toEqual(at(2026, 11, 1, 3, 0));
  });
});

describe('scheduledSyncOptions', () => {
  function addCourse(sid, { hidden = 0, archived = 0, excluded = 0 } = {}) {
    return Number(getDb().prepare(
      'INSERT INTO courses (schoology_section_id, course_name, hidden, archived, excluded) VALUES (?, ?, ?, ?, ?)'
    ).run(sid, sid, hidden, archived, excluded).lastInsertRowid);
  }

  test('mastery "all" = active visible courses, like the Sync dialog default', () => {
    const live = addCourse('live');
    addCourse('hidden', { hidden: 1 });
    addCourse('archived', { archived: 1 });
    addCourse('excluded', { excluded: 1 });
    const opts = scheduledSyncOptions(getDb(), {
      mastery: 'all', includeHidden: false, recentOnly: false, recentDays: 30, syncBlocks: true,
    });
    expect(opts).toEqual({
      masteryCourseIds: [live], skipSchoology: false, includeHidden: false, recentOnly: false, recentDays: 30,
      syncBlocks: true, trigger: 'scheduled',
    });
  });

  test('includes hidden courses only when hidden courses are included', () => {
    const live = addCourse('live');
    const hidden = addCourse('hidden', { hidden: 1 });
    const opts = scheduledSyncOptions(getDb(), { mastery: 'all', includeHidden: true, recentOnly: true, recentDays: 7, syncBlocks: false });
    expect(opts).toMatchObject({ masteryCourseIds: [live, hidden], includeHidden: true, recentOnly: true, recentDays: 7, syncBlocks: false });
  });

  test('mastery "none" pulls no mastery', () => {
    addCourse('live');
    expect(scheduledSyncOptions(getDb(), { mastery: 'none', includeHidden: false, recentOnly: false, recentDays: 30, syncBlocks: true }).masteryCourseIds).toEqual([]);
  });
});

describe('createSyncScheduler', () => {
  function setup({ active = true, clock = at(2026, 10, 5, 14, 0), launch } = {}) {
    let t = clock;
    const scheduler = createSyncScheduler({
      db: getDb(),
      active,
      launch: launch ?? vi.fn(() => ({ runId: 7, done: Promise.resolve('completed') })),
      now: () => t,
      setIntervalFn: vi.fn(() => ({ unref() {} })),
      clearIntervalFn: vi.fn(),
      log: () => {},
    });
    return { scheduler, setNow: (d) => { t = d; } };
  }

  test('arms for the next 03:00 by default', () => {
    const { scheduler } = setup();
    scheduler.start();
    expect(scheduler.status()).toMatchObject({ active: true, nextRunAt: at(2026, 10, 6, 3, 0).toISOString() });
  });

  test('does not arm or run without PRISM_SCHEDULED_SYNC (dev clones)', async () => {
    const launch = vi.fn();
    const { scheduler, setNow } = setup({ active: false, launch });
    scheduler.start();
    expect(scheduler.status()).toMatchObject({ active: false, nextRunAt: null });
    setNow(at(2026, 10, 6, 3, 1));
    await scheduler.tick();
    expect(launch).not.toHaveBeenCalled();
  });

  test('does not arm when disabled in Settings', () => {
    updateSyncScheduleSettings(getDb(), { enabled: false });
    const { scheduler } = setup();
    scheduler.start();
    expect(scheduler.status().nextRunAt).toBeNull();
  });

  test('never fires early; fires once due with the schedule options; then re-arms for tomorrow', async () => {
    const launch = vi.fn(() => ({ runId: 7, done: Promise.resolve('completed') }));
    const { scheduler, setNow } = setup({ launch });
    scheduler.start();

    setNow(at(2026, 10, 6, 2, 59, 59));
    await scheduler.tick();
    expect(launch).not.toHaveBeenCalled();

    setNow(at(2026, 10, 6, 3, 0, 10));
    await scheduler.tick();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0]).toMatchObject({ trigger: 'scheduled', skipSchoology: false, syncBlocks: true });
    expect(readLastScheduledRun(getDb())).toEqual({ at: at(2026, 10, 6, 3, 0, 10).toISOString(), status: 'completed', runId: 7 });
    expect(scheduler.status().nextRunAt).toBe(at(2026, 10, 7, 3, 0).toISOString());

    await scheduler.tick();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  test('records the final run status (e.g. completed with errors)', async () => {
    const { scheduler, setNow } = setup({ launch: () => ({ runId: 9, done: Promise.resolve('completed_with_errors') }) });
    scheduler.start();
    setNow(at(2026, 10, 6, 3, 0, 5));
    await scheduler.tick();
    expect(readLastScheduledRun(getDb())).toMatchObject({ status: 'completed_with_errors', runId: 9 });
  });

  test('skips (and records it) when a sync is already running', async () => {
    const { scheduler, setNow } = setup({ launch: () => { throw new SyncBusyError(4); } });
    scheduler.start();
    setNow(at(2026, 10, 6, 3, 0, 5));
    await scheduler.tick();
    expect(readLastScheduledRun(getDb())).toMatchObject({ status: 'skipped', runId: 4 });
    expect(scheduler.status().nextRunAt).toBe(at(2026, 10, 7, 3, 0).toISOString());
  });

  test('a scheduled run cut off by a restart reads as interrupted, not running', () => {
    const runId = Number(getDb().prepare(
      "INSERT INTO sync_runs (started_at, status) VALUES ('2026-10-05T19:00:00Z', 'interrupted')"
    ).run().lastInsertRowid);
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('syncScheduleState.lastRun', ?)")
      .run(JSON.stringify({ at: '2026-10-05T19:00:00Z', status: 'running', runId }));
    expect(readLastScheduledRun(getDb())).toMatchObject({ status: 'interrupted', runId });
  });

  test('reschedule picks up a new time from Settings', () => {
    const { scheduler } = setup();
    scheduler.start();
    updateSyncScheduleSettings(getDb(), { time: '22:15' });
    scheduler.reschedule();
    expect(scheduler.status().nextRunAt).toBe(at(2026, 10, 5, 22, 15).toISOString());
  });
});
