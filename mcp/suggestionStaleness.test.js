// The stale-suggestion banner (#131) measures the age of the data the grading session was GIVEN,
// at the moment get_assignment_context served it, not at write time: a grader reads the context
// once, grades a class, and writes suggestions at the end, often over 10 minutes later. Each
// answer carries a context_id (a context_serves row, #170); the grader passes it back on write.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../server/db/index.js';
import { getAssignmentContextTool } from './handlers.js';
import { upsertStudentSuggestion, writeStudentSuggestions } from '../server/services/suggestions.js';
import { withDataTime } from '../server/routes/feedback.js';

const T0 = new Date('2026-10-20T10:00:00.000Z');
const at = (ms) => new Date(T0.getTime() + ms).toISOString();
const MIN = 60 * 1000;
let courseId; let taskId;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const db = getDb();
  db.exec('DELETE FROM context_serves; DELETE FROM feedback; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'MGD')`).run().lastInsertRowid;
  taskId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`).run(courseId).lastInsertRowid;
  const student = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`).run().lastInsertRowid;
  db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(student, courseId);
});
afterEach(() => vi.useRealTimers());

const serve = (sync, useStored = false) => getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: 'sa-1', use_stored_data: useStored }, { sync });
const stampTask = (iso) => getDb().prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run(iso, taskId);
const write = (contextId) => upsertStudentSuggestion(getDb(), { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'Good.', contextId });
const stored = () => withDataTime(getDb().prepare('SELECT * FROM feedback').get());
const serves = () => getDb().prepare('SELECT id, assignment_id, data_as_of, served_at FROM context_serves ORDER BY id').all();

describe('suggestion staleness is measured when the context is served', () => {
  test('serving a context records a serve and answers with its context_id', async () => {
    stampTask(at(-1 * MIN));
    const answer = await serve(async () => ({ state: 'synced', runId: 1, dataAsOf: at(-1 * MIN) }));
    expect(serves()).toEqual([{ id: answer.context_id, assignment_id: taskId, data_as_of: at(-1 * MIN), served_at: at(0) }]);
  });

  test('a fresh-state and a stored answer both carry a context_id', async () => {
    stampTask(at(-3 * MIN));
    const fresh = await serve(async () => ({ state: 'fresh', dataAsOf: at(-3 * MIN) }));
    const stored = await serve(async () => ({ state: 'stored', dataAsOf: at(-3 * MIN) }), true);
    expect(fresh.context_id).toEqual(expect.any(Number));
    expect(stored.context_id).toEqual(expect.any(Number));
    expect(stored.context_id).not.toBe(fresh.context_id);
  });

  test('the assignment columns from the first #131 design are no longer written', async () => {
    await serve(async () => ({ state: 'synced', runId: 1, dataAsOf: at(-1 * MIN) }));
    expect(getDb().prepare('SELECT context_data_as_of, context_served_at FROM assignments WHERE id = ?').get(taskId))
      .toEqual({ context_data_as_of: null, context_served_at: null });
  });

  test('a fresh sync, then a write 30 minutes later with its context_id, is NOT stale (the normal grading run)', async () => {
    stampTask(at(-1 * MIN));
    const { context_id } = await serve(async () => ({ state: 'synced', runId: 1, dataAsOf: at(-1 * MIN) }));
    vi.setSystemTime(at(30 * MIN));
    write(context_id);
    expect(stored()).toMatchObject({ data_as_of: at(-1 * MIN), suggested_at: at(0), data_stale: false });
  });

  test('a fresh-state answer (grading-synced under 5 minutes ago), then a late write, is NOT stale', async () => {
    stampTask(at(-3 * MIN));
    const { context_id } = await serve(async () => ({ state: 'fresh', dataAsOf: at(-3 * MIN) }));
    vi.setSystemTime(at(45 * MIN));
    write(context_id);
    expect(stored().data_stale).toBe(false);
  });

  test('stored data 3 days old is stale, even if a background sync stamps the task before the write', async () => {
    stampTask(at(-3 * 24 * 60 * MIN));
    const { context_id } = await serve(async () => ({ state: 'stored', dataAsOf: at(-3 * 24 * 60 * MIN) }), true);
    vi.setSystemTime(at(5 * MIN));
    stampTask(at(4 * MIN)); // a background sync lands mid-session; the grader never saw that data
    write(context_id);
    expect(stored()).toMatchObject({ data_as_of: at(-3 * 24 * 60 * MIN), suggested_at: at(0), data_stale: true });
  });

  test("a task that was never synced is served as 'never' and stays stale", async () => {
    const { context_id } = await serve(async () => ({ state: 'stored', dataAsOf: null }), true);
    expect(serves()[0]).toMatchObject({ data_as_of: 'never', served_at: at(0) });
    vi.setSystemTime(at(MIN));
    stampTask(at(MIN));
    write(context_id);
    expect(stored()).toMatchObject({ data_as_of: 'never', data_stale: true });
  });

  test('a failed serve (sync error) records nothing', async () => {
    await expect(serve(async () => { throw new Error('SYNC_FAILED'); })).rejects.toThrow();
    expect(serves()).toEqual([]);
  });

  test('an unknown task (no context) records nothing', async () => {
    const answer = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: 'nope' }, { sync: async () => ({ state: 'synced', dataAsOf: at(0) }) });
    expect(answer).toBeFalsy();
    expect(serves()).toEqual([]);
  });

  test('two grading sessions on one task, one stored and one fresh, each keep their own times', async () => {
    stampTask(at(-3 * 24 * 60 * MIN));
    const storedSession = await serve(async () => ({ state: 'stored', dataAsOf: at(-3 * 24 * 60 * MIN) }), true);
    vi.setSystemTime(at(MIN));
    const freshSession = await serve(async () => ({ state: 'synced', runId: 2, dataAsOf: at(MIN) }));
    vi.setSystemTime(at(20 * MIN));
    write(storedSession.context_id);
    expect(stored()).toMatchObject({ data_as_of: at(-3 * 24 * 60 * MIN), suggested_at: at(0), data_stale: true });
    write(freshSession.context_id);
    expect(stored()).toMatchObject({ data_as_of: at(MIN), suggested_at: at(MIN), data_stale: false });
  });

  test('a write with no context_id falls back to the oldest serve in the last 3 hours', async () => {
    stampTask(at(-1 * MIN));
    await serve(async () => ({ state: 'synced', runId: 1, dataAsOf: at(-1 * MIN) }));
    vi.setSystemTime(at(30 * MIN));
    await serve(async () => ({ state: 'synced', runId: 2, dataAsOf: at(30 * MIN) }));
    vi.setSystemTime(at(45 * MIN));
    write();
    expect(stored()).toMatchObject({ data_as_of: at(-1 * MIN), suggested_at: at(0) });
  });

  test('a write 4 hours after the only serve falls back to task_synced_at and now', async () => {
    stampTask(at(-1 * MIN));
    await serve(async () => ({ state: 'synced', runId: 1, dataAsOf: at(-1 * MIN) }));
    vi.setSystemTime(at(4 * 60 * MIN));
    stampTask(at(4 * 60 * MIN - 20 * MIN));
    write();
    expect(stored()).toMatchObject({ data_as_of: at(4 * 60 * MIN - 20 * MIN), suggested_at: at(4 * 60 * MIN), data_stale: true });
  });

  test('a restart between the read and the write keeps the id valid (the serve is in the database)', async () => {
    const { context_id } = await serve(async () => ({ state: 'synced', runId: 1, dataAsOf: at(-1 * MIN) }));
    // Nothing is held in memory: the write resolves the id from context_serves alone.
    vi.setSystemTime(at(25 * MIN));
    const { results } = writeStudentSuggestions(getDb(), { assignmentId: 'sa-1', contextId: context_id, students: [{ student: 'uid-1', narrative_feedback: 'Good.' }] });
    expect(results[0].status).toBe('written');
    expect(stored()).toMatchObject({ data_as_of: at(-1 * MIN), suggested_at: at(0) });
  });

  test('a suggestion written without get_assignment_context falls back to task_synced_at and now', () => {
    stampTask(at(-20 * MIN));
    write();
    expect(stored()).toMatchObject({ data_as_of: at(-20 * MIN), suggested_at: at(0), data_stale: true });
  });
});
