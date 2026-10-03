import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './students.js';
import { getDb } from '../db/index.js';
import { captureFeedbackSnapshots } from '../services/feedbackSnapshots.js';

async function get(path) {
  const app = express();
  app.use('/api/students', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

let studentId, assignmentId;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM feedback_snapshots; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AIML')`).run().lastInsertRowid;
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(studentId, courseId);
  assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'a1', 'Project', 1)`).run(courseId).lastInsertRowid;
  db.prepare(`INSERT INTO grades (student_id, assignment_id, score, submitted_at, latest_revision_at) VALUES (?, ?, 80, 1000, 2000)`).run(studentId, assignmentId);
});

describe('GET /api/students/:id — resubmitted follows arrivedKeys', () => {
  const resubmitted = async () => (await get(`/api/students/${studentId}`)).body.grades.find((g) => g.assignment_id === assignmentId).resubmitted;

  test('false before a snapshot, true once captured as arrived, false once regraded', async () => {
    const db = getDb();
    expect(await resubmitted()).toBe(false);
    captureFeedbackSnapshots(db);
    expect(await resubmitted()).toBe(true);
    db.prepare('UPDATE grades SET score = 90').run();
    expect(await resubmitted()).toBe(false);
  });
});
