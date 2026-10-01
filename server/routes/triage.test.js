import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './triage.js';
import { getDb } from '../db/index.js';

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/triage', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

let studentId, assignmentId;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM referrals; DELETE FROM school_days; DELETE FROM mastery_alignments; DELETE FROM grades; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'AP CSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'X', 'C')`).run(courseId);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat', ?, 'X.1', 'T')`).run(courseId);
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(studentId, courseId);
  // Due long ago (weekday fallback, no calendar) → well past the limit.
  assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, accepts_submissions) VALUES (?, 'a1', 'CP2', '2020-01-06 15:30:00', 1)`).run(courseId).lastInsertRowid;
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('a1', 't1', ?)`).run(courseId);
});

describe('/api/triage', () => {
  test('GET returns both lists', async () => {
    const { status, body } = await call('GET', '/api/triage');
    expect(status).toBe(200);
    expect(body.lateWork).toHaveLength(1);
    expect(body.feedbackOwed).toEqual([]);
    expect(body.calendar.source).toBe('weekdays');
  });

  test('POST referral → 201; it then leaves the list; DELETE undoes', async () => {
    const created = await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'referred' });
    expect(created.status).toBe(201);
    expect((await call('GET', '/api/triage')).body.lateWork).toEqual([]);
    expect((await call('GET', '/api/triage/referrals')).body).toHaveLength(1);
    expect((await call('DELETE', `/api/triage/referrals/${created.body.id}`)).body).toEqual({ deleted: true });
  });

  test('POST errors map to status codes', async () => {
    expect((await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/triage/referrals', { studentId, assignmentId: 999, action: 'referred' })).status).toBe(404);
    await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'referred' });
    expect((await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'exempt' })).status).toBe(409);
  });
});
