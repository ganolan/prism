import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { syncAssignment } from './assignmentSync.js';

const NOW = Date.parse('2026-10-20T00:00:00.000Z');

describe('syncAssignment (#58)', () => {
  let db;
  let courseId;
  let localId;
  let deps;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('S1', 'C')`).run().lastInsertRowid;
    localId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date) VALUES (?, 'A1', 'Essay', '2026-10-10 15:30:00')`).run(courseId).lastInsertRowid;
    deps = {
      getSectionAssignment: vi.fn().mockResolvedValue({ id: 'A1', title: 'Essay', due: '2026-10-31 15:30:00', allow_dropbox: '1' }),
      refreshTasks: vi.fn().mockResolvedValue({ refreshed: 1, readAt: 'x', failed: [] }),
      refreshComments: vi.fn().mockReturnValue({ queued: 3, done: Promise.resolve({ refreshed: 3, failed: 0 }) }),
      now: () => NOW,
    };
  });
  const task = () => db.prepare('SELECT due_date, removed_at, task_synced_at FROM assignments WHERE id = ?').get(localId);

  test('reads the task\'s details, then its submissions and grades, then its comment threads', async () => {
    const r = await syncAssignment(courseId, 'A1', { db, deps });
    expect(deps.getSectionAssignment).toHaveBeenCalledWith('S1', 'A1');
    expect(task().due_date).toBe('2026-10-31 15:30:00');
    expect(deps.refreshTasks).toHaveBeenCalledWith([localId], expect.objectContaining({ force: true, mastery: false }));
    expect(deps.refreshComments).toHaveBeenCalledWith(db, localId, { maxAgeSec: 0 });
    expect(r).toMatchObject({ removed: false, comments: { queued: 3 } });
    // The grading sync (#131) waits on the threads: the job's promise comes back with the count.
    await expect(r.comments.done).resolves.toEqual({ refreshed: 3, failed: 0 });
    expect(task().task_synced_at).toBeNull(); // the task run stamps it, after the mastery read
  });

  test('a task deleted in Schoology (404) is marked removed and nothing else is read', async () => {
    deps.getSectionAssignment.mockRejectedValue(Object.assign(new Error('Schoology API 404'), { status: 404 }));
    expect(await syncAssignment(courseId, 'A1', { db, deps })).toEqual({ removed: true });
    expect(task().removed_at).toBe(new Date(NOW).toISOString());
    expect(deps.refreshTasks).not.toHaveBeenCalled();
  });

  test('a failed submissions read leaves the task without a new stamp', async () => {
    deps.refreshTasks.mockResolvedValue({ refreshed: 0, readAt: null, failed: [localId], error: '503' });
    const r = await syncAssignment(courseId, 'A1', { db, deps });
    expect(task().task_synced_at).toBeNull();
  });

  test('#170 item 3: a grading sync whose submissions read failed (or lost the sign-in) starts no thread read', async () => {
    for (const sub of [{ refreshed: 0, readAt: null, failed: [localId], error: '503' }, { refreshed: 1, readAt: 'x', failed: [], signIn: true }]) {
      deps.refreshComments.mockClear();
      deps.refreshTasks.mockResolvedValue(sub);
      const r = await syncAssignment(courseId, 'A1', { db, deps, grading: true });
      expect(deps.refreshComments).not.toHaveBeenCalled();
      expect(r.comments).toEqual({ queued: 0, skipped: true });
    }
    // A plain run starts the threads whatever happened (unchanged).
    await syncAssignment(courseId, 'A1', { db, deps });
    expect(deps.refreshComments).toHaveBeenCalledTimes(1);
  });

  test('an archived course\'s task: no stamp (its submissions are not read), and a 404 removes nothing', async () => {
    db.prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
    deps.refreshTasks.mockResolvedValue({ refreshed: 0, readAt: null, failed: [] });
    const r = await syncAssignment(courseId, 'A1', { db, deps });
    // An archived course's task is read too: only the button reaches it.
    expect(deps.refreshTasks).toHaveBeenCalledWith([localId], expect.objectContaining({ includeArchived: true }));
    expect(task().task_synced_at).toBeNull();
    deps.getSectionAssignment.mockRejectedValue(Object.assign(new Error('Schoology API 404'), { status: 404 }));
    await expect(syncAssignment(courseId, 'A1', { db, deps })).rejects.toThrow(/404/);
    expect(task().removed_at).toBeNull();
  });
});

