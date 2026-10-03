import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './triage.js';
import { getDb } from '../db/index.js';
import { addDays, todayLocal } from '../lib/schoolDays.js';
import { storeSchoolDays } from '../services/schoolCalendar.js';

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

let studentId, assignmentId, courseId;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM referrals; DELETE FROM extensions; DELETE FROM school_days; DELETE FROM mastery_alignments; DELETE FROM grades; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'AP CSP')`).run().lastInsertRowid;
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

  test('GET /calendar returns freshness only, without the full triage payload', async () => {
    const empty = await call('GET', '/api/triage/calendar');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ source: 'weekdays', totalSchoolDays: 0, syncedAt: null });

    storeSchoolDays(getDb(), [{ date: '2026-10-05', inSession: true, cycleLetter: 'A', raw: '{}' }], '2026-10-01T00:00:00Z');
    const loaded = await call('GET', '/api/triage/calendar');
    expect(loaded.status).toBe(200);
    expect(loaded.body).toEqual({ source: 'powerschool', totalSchoolDays: 1, syncedAt: '2026-10-01T00:00:00Z' });
    expect(loaded.body.lateWork).toBeUndefined();
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
    expect((await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'referred' })).status).toBe(409);
    expect((await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'exempt' })).body.code).toBe('BAD_ACTION');
  });

  test("POST 'referred' before the limit → 409 NOT_AT_LIMIT", async () => {
    // Due 3 calendar days ago → 1–2 weekdays late (weekday fallback): under the limit.
    const recent = getDb().prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, accepts_submissions) VALUES (?, 'a2', 'Recent', ?, 1)`)
      .run(courseId, `${addDays(todayLocal(), -3)} 15:30:00`).lastInsertRowid;
    getDb().prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('a2', 't1', ?)`).run(courseId);
    const res = await call('POST', '/api/triage/referrals', { studentId, assignmentId: recent, action: 'referred' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_AT_LIMIT');
  });

  test('POST extension → 201 with until; listed by course; the row carries it; DELETE undoes', async () => {
    const created = await call('POST', '/api/triage/extensions', { studentId, assignmentId, lessons: 3, note: 'sick' });
    expect(created.status).toBe(201);
    // Due Mon 06/01/2020, weekday fallback → until Thu 09/01/2020.
    expect(created.body).toMatchObject({ lessons: 3, note: 'sick', source: 'app', until: '2020-01-09', studentName: 'Maya Chen' });
    expect((await call('GET', `/api/triage/extensions?courseId=${courseId}`)).body).toHaveLength(1);
    expect((await call('GET', `/api/triage/extensions?courseId=${courseId + 1}`)).body).toEqual([]);
    const row = (await call('GET', '/api/triage')).body.lateWork[0];
    expect(row.extension).toMatchObject({ id: created.body.id, lessons: 3, until: '2020-01-09' });
    expect((await call('GET', '/api/triage')).body.historyCount).toBe(1);
    expect((await call('DELETE', `/api/triage/extensions/${created.body.id}`)).body).toEqual({ deleted: true });
    expect((await call('GET', '/api/triage/extensions')).body).toEqual([]);
  });

  test('PUT makeup-ignore/:assignmentId flips tracking for a test; errors map to status codes', async () => {
    const quiz = getDb().prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, is_test, test_fetch_status) VALUES (?, 'q1', 'Quiz', '2020-01-06 14:00:00', 1, 'ok')`)
      .run(courseId).lastInsertRowid;
    getDb().prepare(`INSERT INTO grades (student_id, assignment_id, test_attempt) VALUES (?, ?, 'none')`).run(studentId, quiz);
    expect((await call('GET', '/api/triage')).body.makeUps).toHaveLength(1);
    const res = await call('PUT', `/api/triage/makeup-ignore/${quiz}`, { ignored: true });
    expect(res).toMatchObject({ status: 200, body: { assignmentId: quiz, title: 'Quiz', ignored: true } });
    const t = (await call('GET', '/api/triage')).body;
    expect(t.makeUps).toEqual([]);
    expect(t.makeUpsIgnored).toBe(1);
    expect(await call('PUT', `/api/triage/makeup-ignore/${quiz}`, { ignored: 'no' })).toMatchObject({ status: 400, body: { code: 'BAD_VALUE' } });
    expect((await call('PUT', '/api/triage/makeup-ignore/999', { ignored: true })).status).toBe(404);
    expect(await call('PUT', `/api/triage/makeup-ignore/${assignmentId}`, { ignored: true })).toMatchObject({ status: 409, body: { code: 'NOT_ELIGIBLE' } });
  });

  test('POST extension errors map to status codes', async () => {
    const bad = await call('POST', '/api/triage/extensions', { studentId, assignmentId, lessons: 0 });
    expect(bad).toMatchObject({ status: 400, body: { code: 'BAD_LESSONS' } });
    expect((await call('POST', '/api/triage/extensions', { studentId: 999, assignmentId, lessons: 3 })).status).toBe(404);
    expect((await call('POST', '/api/triage/extensions', { studentId, assignmentId: 999, lessons: 3 })).status).toBe(404);
    getDb().prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
    expect((await call('POST', '/api/triage/extensions', { studentId, assignmentId, lessons: 3 })))
      .toMatchObject({ status: 409, body: { code: 'NOT_ELIGIBLE' } });
  });
});

describe('resubmission routes', () => {
  // The outer beforeEach already seeds an enrolled student + a current-course assignment.
  function seedPair() { return { s: studentId, a: assignmentId }; }

  test('ask → list → extend → close → undo', async () => {
    const { s, a } = seedPair();
    const asked = await call('POST', '/api/triage/resubmissions', { studentId: s, assignmentId: a, lessons: 2, note: 'redo' });
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ outcome: 'asked', lessons: 2, note: 'redo' });
    expect((await call('POST', '/api/triage/resubmissions', { studentId: s, assignmentId: a })).status).toBe(409);
    expect((await call('PUT', `/api/triage/resubmissions/${asked.body.id}`, { lessons: 4 })).body.lessons).toBe(4);
    expect((await call('PUT', `/api/triage/resubmissions/${asked.body.id}`, { close: true, note: 'stands' })).body.outcome).toBe('closed');
    expect((await call('GET', '/api/triage/resubmissions')).body).toHaveLength(1);
    expect((await call('DELETE', `/api/triage/resubmissions/${asked.body.id}`)).body).toEqual({ deleted: true });
  });

  test('review rejects a pair with nothing arrived (409)', async () => {
    const { s, a } = seedPair();
    expect((await call('POST', '/api/triage/resubmissions/review', { studentId: s, assignmentId: a })).status).toBe(409);
  });
});
