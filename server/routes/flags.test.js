import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './flags.js';
import { getDb } from '../db/index.js';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/flags', router);
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
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = text; }
    }
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

let studentId;
let assignmentId;

beforeEach(() => {
  const db = getDb();
  db.exec(
    'DELETE FROM flags; DELETE FROM enrolments; DELETE FROM assignments; ' +
    'DELETE FROM students; DELETE FROM courses;'
  );
  const courseId = db.prepare(
    `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'Course')`
  ).run().lastInsertRowid;
  studentId = db.prepare(
    `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`
  ).run().lastInsertRowid;
  assignmentId = db.prepare(
    `INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`
  ).run(courseId).lastInsertRowid;
});

describe('POST /api/flags validation', () => {
  test('resubmit_requested flag is created without a flag_reason', async () => {
    const { status, body } = await call('POST', '/api/flags', {
      student_id: studentId,
      assignment_id: assignmentId,
      flag_type: 'resubmit_requested',
    });
    expect(status).toBe(201);
    expect(body.flag_type).toBe('resubmit_requested');
    expect(body.flag_reason).toBeNull();
  });

  test('resubmit_requested flag requires an assignment_id', async () => {
    const { status } = await call('POST', '/api/flags', {
      student_id: studentId,
      flag_type: 'resubmit_requested',
    });
    expect(status).toBe(400);
  });

  test('review_needed flag still requires a flag_reason', async () => {
    const { status } = await call('POST', '/api/flags', {
      student_id: studentId,
      assignment_id: assignmentId,
      flag_type: 'review_needed',
    });
    expect(status).toBe(400);
  });

  test('a flag with no student_id is rejected', async () => {
    const { status } = await call('POST', '/api/flags', {
      assignment_id: assignmentId,
      flag_type: 'resubmit_requested',
    });
    expect(status).toBe(400);
  });

  test('review_needed flag is created with a flag_reason', async () => {
    const { status, body } = await call('POST', '/api/flags', {
      student_id: studentId,
      assignment_id: assignmentId,
      flag_type: 'review_needed',
      flag_reason: '  Check the citations  ',
    });
    expect(status).toBe(201);
    expect(body.flag_type).toBe('review_needed');
    expect(body.flag_reason).toBe('Check the citations');
  });
});

describe('removed flag lifecycle routes', () => {
  test('PUT /:id/resolve is gone', async () => {
    const { status } = await call('PUT', '/api/flags/1/resolve');
    expect(status).toBe(404);
  });

  test('PUT /:id/reopen is gone', async () => {
    const { status } = await call('PUT', '/api/flags/1/reopen');
    expect(status).toBe(404);
  });
});

describe('DELETE /api/flags/:id', () => {
  test('removes a resubmit_requested flag', async () => {
    const created = await call('POST', '/api/flags', {
      student_id: studentId,
      assignment_id: assignmentId,
      flag_type: 'resubmit_requested',
    });
    const { status } = await call('DELETE', `/api/flags/${created.body.id}`);
    expect(status).toBe(200);
    expect(getDb().prepare('SELECT COUNT(*) c FROM flags').get().c).toBe(0);
  });
});
