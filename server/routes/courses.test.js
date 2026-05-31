import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

vi.mock('../services/archivedCourses.js', () => ({ getArchivedSections: vi.fn() }));

import router from './courses.js';
import { getDb } from '../db/index.js';
import { getArchivedSections } from '../services/archivedCourses.js';

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

describe('GET /api/courses/:id/gradebook — resubmitted', () => {
  test('cell resubmitted is true when the latest revision is newer than the grade', async () => {
    const db = getDb();
    db.prepare('UPDATE grades SET submitted_at = 1000, latest_revision_at = 2000 WHERE student_id = ? AND assignment_id = ?')
      .run(studentId, assignmentId);
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].resubmitted).toBe(true);
  });

  test('cell resubmitted is false when the grade postdates the revision', async () => {
    const db = getDb();
    db.prepare('UPDATE grades SET submitted_at = 2000, latest_revision_at = 1000 WHERE student_id = ? AND assignment_id = ?')
      .run(studentId, assignmentId);
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].resubmitted).toBe(false);
  });
});

describe('GET /api/courses/:id/gradebook — review_needed', () => {
  test('cell review_needed is an empty array with no flag', async () => {
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].review_needed).toEqual([]);
  });

  test('an unresolved review_needed flag surfaces with its id and reason', async () => {
    getDb().prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
       VALUES (?, ?, 'review_needed', 'rescore Q3')`
    ).run(studentId, assignmentId);
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    const reviews = body.grades[studentId][assignmentId].review_needed;
    expect(reviews).toHaveLength(1);
    expect(reviews[0].flag_reason).toBe('rescore Q3');
    expect(typeof reviews[0].id).toBe('number');
  });

  test('a resolved review_needed flag is excluded', async () => {
    getDb().prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason, resolved)
       VALUES (?, ?, 'review_needed', 'old note', 1)`
    ).run(studentId, assignmentId);
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].review_needed).toEqual([]);
  });
});

describe('GET /api/courses/:id/gradebook — individually assigned (#54)', () => {
  test('open-to-all assignments expose no assignees field', async () => {
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0].assignees).toBeUndefined();
  });

  test('individually-targeted assignment exposes assignees list of enrolled student ids', async () => {
    const db = getDb();
    const otherStudentId = db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-2', 'Bob', 'Smith')`
    ).run().lastInsertRowid;
    db.prepare(
      `INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-2')`
    ).run(otherStudentId, courseId);
    const targetedId = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, published, num_assignees) VALUES (?, 'sa-2', 'Targeted', 1, 1)`
    ).run(courseId).lastInsertRowid;
    db.prepare(
      `INSERT INTO assignment_assignees (assignment_id, schoology_uid) VALUES (?, 'uid-1')`
    ).run(targetedId);

    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    const targeted = body.assignments.find(a => a.id === targetedId);
    expect(targeted).toBeDefined();
    expect(targeted.assignees).toEqual([studentId]);
  });

  test('assignment relevant to nobody enrolled is dropped from gradebook', async () => {
    const db = getDb();
    const targetedId = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, published, num_assignees) VALUES (?, 'sa-3', 'Phantom', 1, 1)`
    ).run(courseId).lastInsertRowid;
    db.prepare(
      `INSERT INTO assignment_assignees (assignment_id, schoology_uid) VALUES (?, 'uid-not-enrolled')`
    ).run(targetedId);

    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.assignments.find(a => a.id === targetedId)).toBeUndefined();
  });
});

describe('GET /api/courses/:id/students — individually-assigned aggregate (#54)', () => {
  test('an assignment individually targeted at others does not count toward this student\'s avg', async () => {
    const db = getDb();
    // Add a second assignment, individually targeted at a different uid, with
    // a grade row for our student (simulating stale data). The aggregate must
    // ignore that grade because the assignment isn't relevant to this student.
    const otherTargetedId = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, published, num_assignees) VALUES (?, 'sa-4', 'NotMine', 1, 1)`
    ).run(courseId).lastInsertRowid;
    db.prepare(
      `INSERT INTO assignment_assignees (assignment_id, schoology_uid) VALUES (?, 'uid-other')`
    ).run(otherTargetedId);
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, score, max_score) VALUES (?, ?, 0, 100)`
    ).run(studentId, otherTargetedId);

    const { body } = await get(`/api/courses/${courseId}/students`);
    const row = body.find(s => s.id === studentId);
    // Without the filter, avg would be (75 + 0) / 2 = 37.5. With the filter
    // applied, only the open-to-all 75/100 counts.
    expect(row.avg_pct).toBe(75);
    expect(row.graded_count).toBe(1);
  });
});

describe('GET /api/courses/archived/discover', () => {
  test('no session → { available: false }', async () => {
    getArchivedSections.mockResolvedValue(null);
    const { status, body } = await get('/api/courses/archived/discover');
    expect(status).toBe(200);
    expect(body).toEqual({ available: false, reason: 'no_session' });
  });

  test('annotates imported (already in DB) and noCourseCode', async () => {
    // beforeEach already seeded a course with schoology_section_id 'sec-1'.
    // Add one matching a discovered section so it reads as imported.
    getDb().prepare(
      `INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('7001', 'Digital Design 9', 1)`
    ).run();
    getArchivedSections.mockResolvedValue([
      { courseId: '1001', courseTitle: 'Digital Design 9', courseCode: 'DSGN9', sectionId: '7001', sectionTitle: null },
      { courseId: '1003', courseTitle: 'MASTER Art', courseCode: null, sectionId: '7004', sectionTitle: null },
    ]);

    const { status, body } = await get('/api/courses/archived/discover');
    expect(status).toBe(200);
    expect(body.available).toBe(true);

    const imported = body.sections.find((s) => s.sectionId === '7001');
    const master = body.sections.find((s) => s.sectionId === '7004');
    expect(imported.imported).toBe(true);
    expect(imported.noCourseCode).toBe(false);
    expect(master.imported).toBe(false);
    expect(master.noCourseCode).toBe(true);
  });

  test('unexpected rejection → 500', async () => {
    getArchivedSections.mockRejectedValue(new Error('boom'));
    const { status } = await get('/api/courses/archived/discover');
    expect(status).toBe(500);
  });

  test('empty discovery → { available: true, sections: [] }', async () => {
    getArchivedSections.mockResolvedValue([]);
    const { status, body } = await get('/api/courses/archived/discover');
    expect(status).toBe(200);
    expect(body).toEqual({ available: true, sections: [] });
  });
});
