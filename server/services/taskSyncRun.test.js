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
      refreshFiles: vi.fn(),
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

  test('a OneDrive or test read that needs a sign-in is reported for the queue to hold', async () => {
    deps.syncAssignment.mockResolvedValue({ removed: false, submissions: { refreshed: 1, failed: [], signIn: true }, comments: { queued: 0 } });
    await run();
    expect(events.at(-1)).toMatchObject({ type: 'summary', signIn: true });
    expect(task().task_synced_at).toBeNull();
  });

  describe('grading sync (#131)', () => {
    const runGrading = () => runTaskSync({ kind: 'task', courseId, assignmentId: 'A1', grading: true, trigger: 'button' }, (e) => events.push(e), { db, deps });
    beforeEach(() => {
      deps.syncAssignment.mockResolvedValue({
        removed: false, submissions: { refreshed: 1, failed: [] },
        comments: { queued: 3, done: Promise.resolve({ refreshed: 3, failed: 0 }) },
      });
      deps.refreshFiles.mockReturnValue({ queued: 2, done: Promise.resolve({ refreshed: 2, failed: 0 }) });
    });

    test('waits for the comment threads and reads the files; both in the summary', async () => {
      await runGrading();
      expect(deps.refreshFiles).toHaveBeenCalledWith(db, taskId, { maxAgeSec: 0 });
      expect(events.at(-1)).toMatchObject({ type: 'summary', comments: { refreshed: 3, failed: 0 }, files: { refreshed: 2, failed: 0 } });
      expect(events.at(-1).comments).not.toHaveProperty('done');
      expect(task()).toEqual({ task_synced_at: T, task_sync_attempted_at: T });
      expect(events.filter((e) => e.phase).map((e) => `${e.phase}:${e.status}`)).toEqual(['assignment:running', 'assignment:done', 'mastery:running', 'mastery:done']);
    });

    test('the files are read only after the threads finish', async () => {
      let release;
      deps.syncAssignment.mockResolvedValue({
        removed: false, submissions: { refreshed: 1, failed: [] },
        comments: { queued: 1, done: new Promise((r) => { release = () => r({ refreshed: 1, failed: 0 }); }) },
      });
      const p = runGrading();
      await new Promise((r) => setTimeout(r, 5));
      expect(deps.refreshFiles).not.toHaveBeenCalled();
      release();
      await p;
      expect(deps.refreshFiles).toHaveBeenCalledTimes(1);
    });

    test('a OneDrive task (files NOT_NATIVE) still completes and is stamped', async () => {
      deps.refreshFiles.mockImplementation(() => { throw Object.assign(new Error('OneDrive'), { code: 'NOT_NATIVE' }); });
      await runGrading();
      expect(events.at(-1)).toMatchObject({ type: 'summary', files: { notNative: true }, comments: { refreshed: 3, failed: 0 } });
      expect(events.at(-1).files).not.toHaveProperty('error');
      expect(task()).toEqual({ task_synced_at: T, task_sync_attempted_at: T });
    });

    test('a failed thread read fails the run (no stamp)', async () => {
      const rejected = Promise.reject(new Error('threads 503'));
      rejected.catch(() => {});
      deps.syncAssignment.mockResolvedValue({ removed: false, submissions: { refreshed: 1, failed: [] }, comments: { queued: 3, done: rejected } });
      await runGrading();
      expect(events.at(-1).comments).toMatchObject({ error: 'threads 503' });
      expect(events.find((e) => e.phase === 'assignment' && e.status !== 'running')).toMatchObject({ status: 'error' });
      expect(task()).toEqual({ task_synced_at: null, task_sync_attempted_at: T });
    });

    test('threads or files that did not all read fail the run (no stamp)', async () => {
      deps.refreshFiles.mockReturnValue({ queued: 2, done: Promise.resolve({ refreshed: 1, failed: 1 }) });
      await runGrading();
      expect(events.at(-1).files).toMatchObject({ refreshed: 1, failed: 1 });
      expect(task().task_synced_at).toBeNull();
    });

    test('a failed file read fails the run (no stamp)', async () => {
      deps.refreshFiles.mockReturnValue({ queued: 2, done: Promise.reject(new Error('files 503')) });
      await runGrading();
      expect(events.at(-1).files).toMatchObject({ error: 'files 503' });
      expect(task().task_synced_at).toBeNull();
    });
  });

  test('a plain task run does not wait for threads or read files (unchanged)', async () => {
    const never = new Promise(() => {});
    deps.syncAssignment.mockResolvedValue({ removed: false, submissions: { refreshed: 1, failed: [] }, comments: { queued: 2, done: never } });
    await run();
    expect(deps.refreshFiles).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'summary', comments: { queued: 2 } }));
    expect(events.at(-1)).not.toHaveProperty('files');
    expect(task()).toEqual({ task_synced_at: T, task_sync_attempted_at: T });
  });
});
