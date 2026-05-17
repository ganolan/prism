import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './courses.js';
import { getDb } from '../db/index.js';

function startServer() {
  const app = express();
  app.use('/api/courses', router);
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

let courseId;
let studentId;
let assignmentId;

beforeEach(() => {
  const db = getDb();
  db.exec(
    'DELETE FROM flags; DELETE FROM grades; DELETE FROM enrolments; ' +
    'DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
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
  assignmentId = db.prepare(
    `INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'sa-1', 'Project', 1)`
  ).run(courseId).lastInsertRowid;
  db.prepare(
    `INSERT INTO grades (student_id, assignment_id, score, max_score) VALUES (?, ?, 75, 100)`
  ).run(studentId, assignmentId);
});

describe('GET /api/courses/:id/gradebook — resubmit_requested', () => {
  test('cell resubmit_requested is false with no flag', async () => {
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].resubmit_requested).toBe(false);
  });

  test('cell resubmit_requested is true when the flag exists', async () => {
    getDb().prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type) VALUES (?, ?, 'resubmit_requested')`
    ).run(studentId, assignmentId);
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].resubmit_requested).toBe(true);
  });

  test('a review_needed flag does not set resubmit_requested', async () => {
    getDb().prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
       VALUES (?, ?, 'review_needed', 'check it')`
    ).run(studentId, assignmentId);
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].resubmit_requested).toBe(false);
  });
});
