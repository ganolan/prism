import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { runTaskSync } from './taskSyncRun.js';

describe('runTaskSync (Sync Assignment as a queued run)', () => {
  let db; let courseId; let taskId; let deps; let events;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('S1', 'C')`).run().lastInsertRowid;
    taskId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'A1', 'Essay')`).run(courseId).lastInsertRowid;
    deps = {
      syncAssignment: vi.fn().mockResolvedValue({ removed: false, submissions: { refreshed: 1, failed: [] }, comments: { queued: 2 } }),
      refreshAssignmentMastery: vi.fn().mockResolvedValue({ refreshed: true, syncedAt: 'x' }),
      now: () => Date.parse('2026-10-20T00:00:00.000Z'),
    };
    events = [];
  });
  const run = () => runTaskSync({ kind: 'task', courseId, assignmentId: 'A1' }, (e) => events.push(e), { db, deps });
  const task = () => db.prepare('SELECT task_synced_at, task_sync_attempted_at FROM assignments WHERE id = ?').get(taskId);
  const T = '2026-10-20T00:00:00.000Z';

  test('reads the task, then its mastery; stamps it when both succeeded', async () => {
    await run();
    expect(deps.syncAssignment).toHaveBeenCalledWith(courseId, 'A1', expect.objectContaining({ db }));
    expect(deps.refreshAssignmentMastery).toHaveBeenCalledWith(courseId, 'A1', expect.objectContaining({ force: true }));
    expect(task()).toEqual({ task_synced_at: T, task_sync_attempted_at: T });
    expect(events.at(-1)).toMatchObject({ type: 'summary', comments: { queued: 2 } });
    expect(events.filter((e) => e.phase).map((e) => `${e.phase}:${e.status}`)).toEqual(['assignment:running', 'assignment:done', 'mastery:running', 'mastery:done']);
  });

  test('a mastery failure: attempted, not synced; a sign-in failure is reported for the queue to hold', async () => {
    deps.refreshAssignmentMastery.mockResolvedValue({ refreshed: false, error: 'expired', signIn: true });
    await run();
    expect(task()).toEqual({ task_synced_at: null, task_sync_attempted_at: T });
    expect(events.at(-1)).toMatchObject({ type: 'summary', signIn: true, mastery: [{ status: 'error', errorKind: 'login' }] });
  });

  test('a task deleted in Schoology: logged, no mastery read, run completes', async () => {
    deps.syncAssignment.mockResolvedValue({ removed: true });
    await run();
    expect(deps.refreshAssignmentMastery).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'log' && /Deleted in Schoology/.test(e.message))).toBe(true);
    expect(task().task_synced_at).toBeNull();
  });
});
