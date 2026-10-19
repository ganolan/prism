// #52: mastery read from Schoology on demand, after a page loads. Fresh data is not read again; a refresh
// already running is shared; a failure is reported, never thrown.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { refreshCourseMastery, refreshAssignmentMastery, FRESH_MS } from './masteryRefresh.js';

const NOW = Date.parse('2026-10-19T06:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
let db;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO courses (id, schoology_section_id, course_name) VALUES (5, 'S5', 'AP CSP')`).run();
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (5, '900', 'Task')`).run();
});
// A sync that stamps the row as the real ones do.
const courseSync = (at = NOW) => vi.fn(async () => {
  db.prepare('UPDATE courses SET mastery_synced_at = ? WHERE id = 5').run(iso(at));
  return { scoresCount: 3 };
});
const assignmentSync = (at = NOW) => vi.fn(async () => {
  db.prepare(`UPDATE assignments SET mastery_synced_at = ? WHERE schoology_assignment_id = '900'`).run(iso(at));
  return { scoresCount: 2 };
});
const deps = (over) => ({ db, now: () => NOW, afterPull: vi.fn(), ...over });

describe('refreshCourseMastery', () => {
  test('never read: reads it, then answers refreshed with the new stamp', async () => {
    const d = deps({ syncCourse: courseSync() });
    expect(await refreshCourseMastery(5, d)).toEqual({ refreshed: true, syncedAt: iso(NOW), result: { scoresCount: 3 } });
    expect(d.syncCourse).toHaveBeenCalledWith(5);
    expect(d.afterPull).toHaveBeenCalledWith(db, 5);
  });

  test('read under FRESH_MS ago: not read again', async () => {
    db.prepare('UPDATE courses SET mastery_synced_at = ? WHERE id = 5').run(iso(NOW - FRESH_MS + 1000));
    const d = deps({ syncCourse: courseSync() });
    expect(await refreshCourseMastery(5, d)).toEqual({ refreshed: false, syncedAt: iso(NOW - FRESH_MS + 1000) });
    expect(d.syncCourse).not.toHaveBeenCalled();
  });

  test('older than FRESH_MS, or force: read again', async () => {
    db.prepare('UPDATE courses SET mastery_synced_at = ? WHERE id = 5').run(iso(NOW - FRESH_MS - 1000));
    let d = deps({ syncCourse: courseSync() });
    expect((await refreshCourseMastery(5, d)).refreshed).toBe(true);
    d = deps({ syncCourse: courseSync() });
    expect((await refreshCourseMastery(5, { ...d, force: true })).refreshed).toBe(true);
    expect(d.syncCourse).toHaveBeenCalledTimes(1);
  });

  test('two pages at once share one read', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const sync = vi.fn(async () => { await gate; db.prepare('UPDATE courses SET mastery_synced_at = ? WHERE id = 5').run(iso(NOW)); return {}; });
    const both = Promise.all([refreshCourseMastery(5, deps({ syncCourse: sync })), refreshCourseMastery(5, deps({ syncCourse: sync, force: true }))]);
    release();
    const [a, b] = await both;
    expect(sync).toHaveBeenCalledTimes(1);
    expect([a.refreshed, b.refreshed]).toEqual([true, true]);
  });

  test('a failed read: refreshed false with the error and the old stamp; the next call tries again', async () => {
    db.prepare('UPDATE courses SET mastery_synced_at = ? WHERE id = 5').run(iso(NOW - 3600000));
    const fail = vi.fn(async () => { throw new Error('Not logged in to Schoology: the mastery session has expired. Log in to Schoology in Settings, then retry.'); });
    const d = deps({ syncCourse: fail });
    expect(await refreshCourseMastery(5, d)).toEqual({
      refreshed: false, syncedAt: iso(NOW - 3600000), error: expect.stringMatching(/Log in to Schoology/), signIn: true,
    });
    expect(d.afterPull).not.toHaveBeenCalled();
    await refreshCourseMastery(5, d);
    expect(fail).toHaveBeenCalledTimes(2);
  });

  test('an unknown course: NOT_FOUND', async () => {
    await expect(refreshCourseMastery(99, deps({ syncCourse: courseSync() }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('refreshAssignmentMastery', () => {
  test('reads the assignment (scores and comments) when its own stamp is old; the course stamp does not count', async () => {
    db.prepare('UPDATE courses SET mastery_synced_at = ? WHERE id = 5').run(iso(NOW));
    const d = deps({ syncAssignment: assignmentSync() });
    expect(await refreshAssignmentMastery(5, '900', d)).toEqual({ refreshed: true, syncedAt: iso(NOW), result: { scoresCount: 2 } });
    expect(d.syncAssignment).toHaveBeenCalledWith(5, '900');
    expect(d.afterPull).toHaveBeenCalledWith(db, 5);
  });

  test('fresh: not read again; shares a running read; NOT_FOUND for an unknown assignment', async () => {
    db.prepare(`UPDATE assignments SET mastery_synced_at = ? WHERE schoology_assignment_id = '900'`).run(iso(NOW - 1000));
    const d = deps({ syncAssignment: assignmentSync() });
    expect(await refreshAssignmentMastery(5, '900', d)).toEqual({ refreshed: false, syncedAt: iso(NOW - 1000) });
    expect(d.syncAssignment).not.toHaveBeenCalled();
    await expect(refreshAssignmentMastery(5, '1', d)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('a failed read reports the error with the last stamp, falling back to the course stamp', async () => {
    db.prepare('UPDATE courses SET mastery_synced_at = ? WHERE id = 5').run(iso(NOW - 7200000));
    const d = deps({ syncAssignment: vi.fn(async () => { throw new Error('HTTP 500 for x'); }) });
    expect(await refreshAssignmentMastery(5, '900', d)).toEqual({ refreshed: false, syncedAt: iso(NOW - 7200000), error: 'HTTP 500 for x', signIn: false });
  });
});
