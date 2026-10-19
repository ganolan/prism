import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';

vi.mock('./schoology.js', () => ({ getAssignmentSubmissions: vi.fn() }));

import { getAssignmentSubmissions } from './schoology.js';
import { readTaskSubmissions } from './taskSubmissions.js';

const NOW = '2026-10-19T15:00:00.000Z';

describe('readTaskSubmissions (#108)', () => {
  let db;
  let ids;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    getAssignmentSubmissions.mockReset();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('S1', 'CSP')`).run().lastInsertRowid;
    const studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'Ada', 'L')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, '801')`).run(studentId, courseId);
    const add = (ext, cols) => db.prepare(`
      INSERT INTO assignments (course_id, schoology_assignment_id, title, accepts_submissions, is_lti_submission, is_test)
      VALUES (?, ?, ?, ?, ?, ?)`).run(courseId, ext, ext, cols.dropbox ?? 0, cols.lti ?? 0, cols.test ?? 0).lastInsertRowid;
    ids = {
      courseId, studentId,
      native: add('D1', { dropbox: 1 }),
      lti: add('L1', { dropbox: 1, lti: 1 }),
      test: add('T1', { test: 1 }),
    };
  });

  const read = (opts) => readTaskSubmissions(db, {
    sectionId: 'S1', now: NOW, students: [{ id: '801', uid: '701' }],
    native: ['D1'], lti: ['L1'], tests: ['T1'], backoffMs: 0, ...opts,
  });
  const stamp = (id) => db.prepare('SELECT submissions_read_at FROM assignments WHERE id = ?').get(id).submissions_read_at;
  const statuses = () => db.prepare('SELECT lti_fetch_status AS lti, test_fetch_status AS test FROM assignments WHERE id IN (?, ?) ORDER BY id').all(ids.lti, ids.test);

  test('stamps submissions_read_at only for tasks read in full', async () => {
    getAssignmentSubmissions.mockResolvedValue([{ revision_id: 9, uid: '701', created: 3000, late: 1, draft: 0 }]);
    const r = await read({ fetchDocuments: async () => null, fetchTestAttempts: async () => null });
    expect([...r.readInFull]).toEqual([ids.native]);
    expect(stamp(ids.native)).toBe(NOW);
    expect(stamp(ids.lti)).toBeNull();
    expect(stamp(ids.test)).toBeNull();
    const g = db.prepare('SELECT late, submission_type FROM grades WHERE student_id = ? AND assignment_id = ?').get(ids.studentId, ids.native);
    expect(g).toEqual({ late: 1, submission_type: 'drop' });
  });

  test('stamps the lti and test tasks when their reads answer', async () => {
    getAssignmentSubmissions.mockResolvedValue([]);
    const r = await read({
      fetchDocuments: async () => ({ states: new Map([['701', 'submitted']]), details: new Map() }),
      fetchTestAttempts: async () => new Map([['701', new Map([['T1', { took: true }]])]]),
    });
    expect(new Set(r.readInFull)).toEqual(new Set([ids.native, ids.lti, ids.test]));
    expect(stamp(ids.lti)).toBe(NOW);
    expect(stamp(ids.test)).toBe(NOW);
  });

  test('keepStatusOnFailure leaves lti_fetch_status and test_fetch_status as they were', async () => {
    getAssignmentSubmissions.mockResolvedValue([]);
    db.prepare(`UPDATE assignments SET lti_fetch_status = 'ok', test_fetch_status = 'ok'`).run();
    const failing = { fetchDocuments: async () => null, fetchTestAttempts: async () => null };
    await read({ ...failing, keepStatusOnFailure: true });
    expect(statuses()).toEqual([{ lti: 'ok', test: 'ok' }, { lti: 'ok', test: 'ok' }]);
    await read(failing);
    expect(statuses()).toEqual([{ lti: 'failed', test: 'ok' }, { lti: 'ok', test: 'failed' }]);
  });

  test('a transient native error leaves that task\'s grades rows unchanged', async () => {
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, late, draft, latest_revision_at, submission_type)
      VALUES (?, ?, '801', 1, 0, 3000, 'drop')`).run(ids.studentId, ids.native);
    const before = db.prepare('SELECT * FROM grades WHERE assignment_id = ?').get(ids.native);
    getAssignmentSubmissions.mockRejectedValue(Object.assign(new Error('503'), { transient: true }));
    const r = await read({ lti: [], tests: [] });
    expect(r.failedAssignmentIds).toEqual(['D1']);
    expect(db.prepare('SELECT * FROM grades WHERE assignment_id = ?').get(ids.native)).toEqual(before);
    expect(stamp(ids.native)).toBeNull();
  });
});
