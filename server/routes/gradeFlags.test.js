import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
// The flag write reaches Schoology: never for real.
vi.mock('../services/schoology.js', () => ({ getSectionGrades: vi.fn(), pushGradeUpdates: vi.fn() }));

import router from './gradeFlags.js';
import { getDb } from '../db/index.js';
import { getSectionGrades, pushGradeUpdates } from '../services/schoology.js';

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/grade-flags', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

let s, a, record;
beforeEach(() => {
  vi.clearAllMocks();
  const db = getDb();
  db.exec(`DELETE FROM excused_grades; DELETE FROM assessment_drafts; DELETE FROM feedback_snapshots; DELETE FROM status_lines;
    DELETE FROM mastery_scores; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;`);
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec', 'AP CSP')`).run().lastInsertRowid;
  s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr')`).run(s, c);
  a = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa', 'CP2')`).run(c).lastInsertRowid;
  db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception, grade_comment, comment_status) VALUES (?, ?, 'enr', 75, 0, 'Good.', 1)`).run(s, a);
  record = { assignment_id: 'sa', enrollment_id: 'enr', grade: 75, exception: 0, max_points: 100, comment: 'Good.', comment_status: 1 };
  getSectionGrades.mockImplementation(async () => [{ ...record }]);
  pushGradeUpdates.mockImplementation(async (_section, [entry]) => {
    record = { ...record, ...entry, exception: Number(entry.exception) || 0 };
    if ([1, 2, 5, 6].includes(record.exception)) record.grade = null;
    return { status: 207, data: { grades: { grade: [{ response_code: 204 }] } } };
  });
});

describe('/api/grade-flags', () => {
  test('GET reads the pair\'s flag state fresh', async () => {
    const res = await call('GET', `/api/grade-flags?studentId=${s}&assignmentId=${a}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ exception: 0, score: 75, comment: 'Good.', commentStatus: 1, graded: true, savedGrade: null, openRecords: [], hasDraft: false });
  });

  test('GET without ids: 400', async () => {
    const res = await call('GET', '/api/grade-flags?studentId=1');
    expect(res.status).toBe(400);
  });

  test('POST sets a flag and returns the result', async () => {
    const res = await call('POST', '/api/grade-flags', { studentId: s, assignmentId: a, code: 1, expected: { exception: 0, score: 75 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ exception: 1, saved: true, withdrawn: [], line: null, restored: null });
    expect(pushGradeUpdates.mock.calls[0][1][0]).toMatchObject({ exception: 1, grade: '75', comment: 'Good.' });
  });

  test('POST clears with restore: false', async () => {
    await call('POST', '/api/grade-flags', { studentId: s, assignmentId: a, code: 1, expected: { exception: 0, score: 75 } });
    const res = await call('POST', '/api/grade-flags', { studentId: s, assignmentId: a, code: 0, expected: { exception: 1, score: null }, restore: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ exception: 0, restored: null });
  });

  test.each([
    ['BAD_VALUE', 400, () => ({ code: 4, expected: { exception: 0, score: 75 } })],
    ['CHANGED', 409, () => ({ code: 1, expected: { exception: 0, score: 50 } })],
    ['NOT_FOUND', 404, () => ({ studentId: 999, code: 1, expected: { exception: 0, score: 75 } })],
  ])('%s → %i with { error, code }', async (code, status, body) => {
    const res = await call('POST', '/api/grade-flags', { studentId: s, assignmentId: a, ...body() });
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: expect.any(String), code });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });

  test('NOT_ELIGIBLE → 409 (archived course)', async () => {
    getDb().prepare('UPDATE courses SET archived = 1').run();
    const res = await call('POST', '/api/grade-flags', { studentId: s, assignmentId: a, code: 1, expected: { exception: 0, score: 75 } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_ELIGIBLE');
  });

  test('SCHOOLOGY_WRITE_FAILED → 502', async () => {
    pushGradeUpdates.mockResolvedValueOnce({ status: 502, data: 'bad gateway' });
    const res = await call('POST', '/api/grade-flags', { studentId: s, assignmentId: a, code: 1, expected: { exception: 0, score: 75 } });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SCHOOLOGY_WRITE_FAILED');
  });

  test('READBACK_MISMATCH → 502', async () => {
    pushGradeUpdates.mockResolvedValueOnce({ status: 207, data: {} });
    const res = await call('POST', '/api/grade-flags', { studentId: s, assignmentId: a, code: 1, expected: { exception: 0, score: 75 } });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('READBACK_MISMATCH');
  });

  test('BUSY → 409', async () => {
    let release;
    getSectionGrades.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([{ ...record }]); }));
    const first = call('POST', '/api/grade-flags', { studentId: s, assignmentId: a, code: 1, expected: { exception: 0, score: 75 } });
    await vi.waitFor(() => expect(getSectionGrades).toHaveBeenCalledTimes(1));
    const res = await call('POST', '/api/grade-flags', { studentId: s, assignmentId: a, code: 6, expected: { exception: 0, score: 75 } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BUSY');
    release();
    expect((await first).status).toBe(200);
  });
});
