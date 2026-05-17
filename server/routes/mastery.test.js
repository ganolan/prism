import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';

const h = vi.hoisted(() => {
  process.env.DB_PATH = ':memory:';
  return { loggedIn: true };
});

vi.mock('../services/masterySync.js', () => ({
  hasMasterySession: () => h.loggedIn,
  // Other named exports the route imports — unused in this test.
  syncMasteryForCourse: vi.fn(),
  syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn(),
  writeMasteryOverride: vi.fn(),
  getMasteryForCourse: vi.fn(),
  getRubricScoresForStudent: vi.fn(),
  interactiveLogin: vi.fn(),
}));
vi.mock('../services/schoology.js', () => ({
  pushGradeComments: vi.fn(),
  getSectionGrades: vi.fn(),
}));

import router from './mastery.js';
import { getDb } from '../db/index.js';

function startServer() {
  const app = express();
  app.use('/api/mastery', router);
  const server = app.listen(0);
  return { server, port: server.address().port };
}

async function get(path) {
  const { server, port } = startServer();
  try {
    const res = await fetch(`http://localhost:${port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('GET /api/mastery/:courseId/assignment/:assignmentId — review and resubmit flags', () => {
  let courseId;
  let studentId;
  let assignmentInternalId;

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM flags; DELETE FROM enrolments; DELETE FROM assignments; ' +
      'DELETE FROM students; DELETE FROM courses;'
    );
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'Course')`
    ).run().lastInsertRowid;
    studentId = db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`
    ).run().lastInsertRowid;
    db.prepare(
      `INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-1')`
    ).run(studentId, courseId);
    assignmentInternalId = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`
    ).run(courseId).lastInsertRowid;
  });

  test('review_flag is null when the student has no review flag', async () => {
    const { status, body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(status).toBe(200);
    expect(body.students).toHaveLength(1);
    expect(body.students[0].review_flag).toBeNull();
  });

  test('review_flag carries id and reason for a review_needed flag', async () => {
    const db = getDb();
    const flagId = db.prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
       VALUES (?, ?, 'review_needed', 'Check the citations')`
    ).run(studentId, assignmentInternalId).lastInsertRowid;

    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].review_flag).toEqual({
      id: flagId,
      flag_reason: 'Check the citations',
    });
  });

  test('a non-review flag on the same submission is ignored', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
       VALUES (?, ?, 'custom', 'something else')`
    ).run(studentId, assignmentInternalId);

    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].review_flag).toBeNull();
  });

  test('does not throw for an unknown assignment id', async () => {
    const { status, body } = await get(`/api/mastery/${courseId}/assignment/no-such-assignment`);
    expect(status).toBe(200);
    expect(body.students.every(s => s.review_flag === null)).toBe(true);
  });

  test('resubmit_flag is null when the student has no resubmit flag', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmit_flag).toBeNull();
  });

  test('resubmit_flag carries the id for a resubmit_requested flag', async () => {
    const db = getDb();
    const flagId = db.prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type)
       VALUES (?, ?, 'resubmit_requested')`
    ).run(studentId, assignmentInternalId).lastInsertRowid;
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmit_flag).toEqual({ id: flagId });
  });
});

describe('GET /api/mastery/login-status', () => {
  beforeEach(() => { h.loggedIn = true; });

  test('reports loggedIn true when a session file exists', async () => {
    h.loggedIn = true;
    const { status, body } = await get('/api/mastery/login-status');
    expect(status).toBe(200);
    expect(body).toEqual({ loggedIn: true });
  });

  test('reports loggedIn false when no session file exists', async () => {
    h.loggedIn = false;
    const { status, body } = await get('/api/mastery/login-status');
    expect(status).toBe(200);
    expect(body).toEqual({ loggedIn: false });
  });
});
