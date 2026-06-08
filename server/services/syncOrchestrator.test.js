import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';

// Shared mutable DB handle the mocked getDb() returns.
const h = vi.hoisted(() => ({ db: null }));

vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDb: () => h.db };
});
vi.mock('./sync.js', () => ({ fullSync: vi.fn() }));
vi.mock('./masterySync.js', () => ({ syncMasteryForCourse: vi.fn() }));
vi.mock('./blockNumberSync.js', () => ({ syncBlockNumbers: vi.fn() }));

import { fullSync } from './sync.js';
import { syncMasteryForCourse } from './masterySync.js';
import { syncBlockNumbers } from './blockNumberSync.js';
import { runUnifiedSync, classifyMasteryError } from './syncOrchestrator.js';

function seedCourse(db, name) {
  return db.prepare(
    `INSERT INTO courses (schoology_section_id, course_name) VALUES (?, ?)`
  ).run(`sec-${name}`, name).lastInsertRowid;
}

describe('classifyMasteryError', () => {
  test('login errors classified as login', () => {
    expect(classifyMasteryError(new Error('Not logged in to Schoology'))).toBe('login');
    expect(classifyMasteryError(new Error('Run `npm run mastery:login`'))).toBe('login');
  });
  test('other errors classified as other', () => {
    expect(classifyMasteryError(new Error('page load timeout'))).toBe('other');
  });
});

describe('runUnifiedSync', () => {
  beforeEach(() => {
    h.db = new Database(':memory:');
    migrate(h.db);
    fullSync.mockReset();
    syncMasteryForCourse.mockReset();
    syncBlockNumbers.mockReset();
    fullSync.mockResolvedValue({ success: true, records: 42 });
    syncMasteryForCourse.mockResolvedValue({ scoresCount: 7 });
    syncBlockNumbers.mockResolvedValue({ updated: 0, skipped: 0 });
  });

  test('runs Schoology before mastery and emits ordered events', async () => {
    const cid = seedCourse(h.db, 'Biology 9');
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid], syncBlocks: false }, (e) => events.push(e));

    const phases = events.filter((e) => e.phase);
    expect(phases[0]).toMatchObject({ phase: 'schoology', status: 'running' });
    expect(phases[1]).toMatchObject({ phase: 'schoology', status: 'done', records: 42 });
    expect(phases[2]).toMatchObject({ phase: 'mastery', status: 'running' });
    expect(phases.some((e) => e.phase === 'schoology' && e.status === 'done' && e.records === 42)).toBe(true);
    expect(phases.some((e) => e.phase === 'mastery' && e.status === 'done' && e.records === 7)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'summary' });

    const logRow = h.db.prepare(`SELECT status, completed_at FROM sync_log WHERE sync_type = 'mastery'`).get();
    expect(logRow.status).toBe('completed');
    expect(logRow.completed_at).not.toBeNull();
  });

  test('skipSchoology omits the Schoology phase', async () => {
    const cid = seedCourse(h.db, 'Chem 11');
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid], skipSchoology: true }, (e) => events.push(e));
    expect(fullSync).not.toHaveBeenCalled();
    expect(events.some((e) => e.phase === 'schoology')).toBe(false);
    expect(syncMasteryForCourse).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.phase === 'mastery' && e.status === 'done')).toBe(true);
  });

  test('one mastery course failing does not abort the others', async () => {
    const c1 = seedCourse(h.db, 'Course A');
    const c2 = seedCourse(h.db, 'Course B');
    syncMasteryForCourse
      .mockRejectedValueOnce(new Error('Not logged in to Schoology'))
      .mockResolvedValueOnce({ scoresCount: 3 });
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [c1, c2] }, (e) => events.push(e));

    const masteryDone = events.filter((e) => e.phase === 'mastery' && e.status === 'done');
    const masteryErr = events.filter((e) => e.phase === 'mastery' && e.status === 'error');
    expect(masteryDone).toHaveLength(1);
    expect(masteryErr).toHaveLength(1);
    expect(masteryErr[0].errorKind).toBe('login');

    const statuses = h.db.prepare(`SELECT status FROM sync_log WHERE sync_type = 'mastery' ORDER BY id`).all().map((r) => r.status);
    expect(statuses.sort()).toEqual(['completed', 'error']);
  });

  test('a Schoology failure skips the mastery phase', async () => {
    const cid = seedCourse(h.db, 'Bio');
    fullSync.mockRejectedValue(new Error('schoology API down'));
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => events.push(e));
    expect(syncMasteryForCourse).not.toHaveBeenCalled();
    expect(events.some((e) => e.phase === 'schoology' && e.status === 'error')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'summary', fatal: true });
  });

  test('runs the block phase by default, between schoology and mastery', async () => {
    const cid = seedCourse(h.db, 'Bio 9');
    syncBlockNumbers.mockResolvedValue({ updated: 2, skipped: 1 });
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => events.push(e));

    expect(syncBlockNumbers).toHaveBeenCalledOnce();
    const order = events.filter((e) => e.phase).map((e) => `${e.phase}:${e.status}`);
    expect(order).toEqual([
      'schoology:running', 'schoology:done',
      'blocks:running', 'blocks:done',
      'mastery:running', 'mastery:done',
    ]);
    expect(events.find((e) => e.phase === 'blocks' && e.status === 'done')).toMatchObject({ records: 2 });
  });

  test('syncBlocks:false skips the block phase entirely (no browser launch)', async () => {
    const cid = seedCourse(h.db, 'Bio 10');
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid], syncBlocks: false }, (e) => events.push(e));
    expect(syncBlockNumbers).not.toHaveBeenCalled();
    expect(events.some((e) => e.phase === 'blocks')).toBe(false);
  });

  test('a block-sync failure is non-fatal — mastery still runs', async () => {
    const cid = seedCourse(h.db, 'Bio 11');
    syncBlockNumbers.mockRejectedValue(new Error('PowerSchool session stale'));
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => events.push(e));

    expect(events.some((e) => e.phase === 'blocks' && e.status === 'error')).toBe(true);
    expect(events.some((e) => e.phase === 'mastery' && e.status === 'done')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'summary' });
    expect(events.at(-1).fatal).toBeUndefined();
  });
});
