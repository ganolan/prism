// The stale-suggestion banner (#131) measures the age of the data the grading session was GIVEN,
// at the moment get_assignment_context served it, not at write time: a grader reads the context
// once, grades a class, and writes suggestions at the end, often over 10 minutes later.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../server/db/index.js';
import { getAssignmentContextTool } from './handlers.js';
import { upsertStudentSuggestion } from '../server/services/suggestions.js';
import { withDataTime } from '../server/routes/feedback.js';

const T0 = new Date('2026-10-20T10:00:00.000Z');
const at = (ms) => new Date(T0.getTime() + ms).toISOString();
const MIN = 60 * 1000;
let courseId; let taskId;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const db = getDb();
  db.exec('DELETE FROM feedback; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'MGD')`).run().lastInsertRowid;
  taskId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`).run(courseId).lastInsertRowid;
  const student = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`).run().lastInsertRowid;
  db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(student, courseId);
});
afterEach(() => vi.useRealTimers());

const serve = (sync, useStored = false) => getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: 'sa-1', use_stored_data: useStored }, { sync });
const stampTask = (iso) => getDb().prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run(iso, taskId);
const write = () => upsertStudentSuggestion(getDb(), { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'Good.' });
const stored = () => withDataTime(getDb().prepare('SELECT * FROM feedback').get());
const columns = () => getDb().prepare('SELECT context_data_as_of, context_served_at FROM assignments WHERE id = ?').get(taskId);

describe('suggestion staleness is measured when the context is served', () => {
  test('serving a context records the data time and the serve time on the assignment', async () => {
    stampTask(at(-1 * MIN));
    await serve(async () => ({ state: 'synced', runId: 1, dataAsOf: at(-1 * MIN) }));
    expect(columns()).toEqual({ context_data_as_of: at(-1 * MIN), context_served_at: at(0) });
  });

  test('a fresh sync, then a write 30 minutes later, is NOT stale (the normal grading run)', async () => {
    stampTask(at(-1 * MIN));
    await serve(async () => ({ state: 'synced', runId: 1, dataAsOf: at(-1 * MIN) }));
    vi.setSystemTime(at(30 * MIN));
    write();
    expect(stored()).toMatchObject({ data_as_of: at(-1 * MIN), suggested_at: at(0), data_stale: false });
  });

  test('a fresh-state answer (grading-synced under 5 minutes ago), then a late write, is NOT stale', async () => {
    stampTask(at(-3 * MIN));
    await serve(async () => ({ state: 'fresh', dataAsOf: at(-3 * MIN) }));
    vi.setSystemTime(at(45 * MIN));
    write();
    expect(stored().data_stale).toBe(false);
  });

  test('stored data 3 days old is stale, even if a background sync stamps the task before the write', async () => {
    stampTask(at(-3 * 24 * 60 * MIN));
    await serve(async () => ({ state: 'stored', dataAsOf: at(-3 * 24 * 60 * MIN) }), true);
    vi.setSystemTime(at(5 * MIN));
    stampTask(at(4 * MIN)); // a background sync lands mid-session; the grader never saw that data
    write();
    expect(stored()).toMatchObject({ data_as_of: at(-3 * 24 * 60 * MIN), suggested_at: at(0), data_stale: true });
  });

  test("a task that was never synced is served as 'never' and stays stale", async () => {
    await serve(async () => ({ state: 'stored', dataAsOf: null }), true);
    expect(columns()).toEqual({ context_data_as_of: 'never', context_served_at: at(0) });
    vi.setSystemTime(at(MIN));
    stampTask(at(MIN));
    write();
    expect(stored()).toMatchObject({ data_as_of: 'never', data_stale: true });
  });

  test('a failed serve (sync error) records nothing', async () => {
    await expect(serve(async () => { throw new Error('SYNC_FAILED'); })).rejects.toThrow();
    expect(columns()).toEqual({ context_data_as_of: null, context_served_at: null });
  });

  test('a suggestion written without get_assignment_context falls back to task_synced_at and now', () => {
    stampTask(at(-20 * MIN));
    write();
    expect(stored()).toMatchObject({ data_as_of: at(-20 * MIN), suggested_at: at(0), data_stale: true });
  });
});
