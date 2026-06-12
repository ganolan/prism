import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './assessment-drafts.js';
import { getDb } from '../db/index.js';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/assessment-drafts', router);
  const server = app.listen(0);
  return { server, port: server.address().port };
}

async function call(method, path, payload) {
  const { server, port } = startServer();
  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

let assignmentId, studentId;

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM assessment_drafts; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AIML')`).run().lastInsertRowid;
  assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, max_points) VALUES (?, 'sa-1', 'Project', 100)`).run(courseId).lastInsertRowid;
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-1')`).run(studentId, courseId);
});

describe('assessment-drafts route', () => {
  test('POST upserts a draft and GET returns it keyed by student_id', async () => {
    const draft = { pending: { 'topic-1': 'ED' }, comment: 'wip', display: true, displayTouched: false, base: 'b1' };
    const post = await call('POST', '/api/assessment-drafts', { assignment_id: 'sa-1', student_id: studentId, enrollment_id: 'enr-1', draft });
    expect(post.status).toBe(200);
    const get = await call('GET', '/api/assessment-drafts?assignment_id=sa-1');
    expect(get.status).toBe(200);
    expect(get.body[String(studentId)]).toEqual(draft);
  });

  test('POST a second time replaces the existing draft (upsert, not duplicate)', async () => {
    await call('POST', '/api/assessment-drafts', { assignment_id: 'sa-1', student_id: studentId, enrollment_id: 'enr-1', draft: { pending: { 'topic-1': 'ED' }, comment: 'one' } });
    await call('POST', '/api/assessment-drafts', { assignment_id: 'sa-1', student_id: studentId, enrollment_id: 'enr-1', draft: { pending: {}, comment: 'two' } });
    const get = await call('GET', '/api/assessment-drafts?assignment_id=sa-1');
    expect(Object.keys(get.body)).toHaveLength(1);
    expect(get.body[String(studentId)].comment).toBe('two');
  });

  test('DELETE removes the draft', async () => {
    await call('POST', '/api/assessment-drafts', { assignment_id: 'sa-1', student_id: studentId, enrollment_id: 'enr-1', draft: { pending: {}, comment: 'x' } });
    const del = await call('DELETE', `/api/assessment-drafts?assignment_id=sa-1&student_id=${studentId}`);
    expect(del.status).toBe(200);
    const get = await call('GET', '/api/assessment-drafts?assignment_id=sa-1');
    expect(get.body).toEqual({});
  });

  test('GET returns {} for an unknown assignment', async () => {
    const get = await call('GET', '/api/assessment-drafts?assignment_id=no-such');
    expect(get.body).toEqual({});
  });

  test('POST 404s when the student cannot be resolved', async () => {
    const post = await call('POST', '/api/assessment-drafts', { assignment_id: 'sa-1', student_id: 999999, draft: { pending: {} } });
    expect(post.status).toBe(404);
  });

  test('POST 400s when assignment_id or draft is missing', async () => {
    const post = await call('POST', '/api/assessment-drafts', { student_id: studentId });
    expect(post.status).toBe(400);
  });
});
