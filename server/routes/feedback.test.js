import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './feedback.js';
import { getDb } from '../db/index.js';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/feedback', router);
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

let courseId, assignmentSchoolId, localAssignmentId, s1, s2;

beforeEach(() => {
  const db = getDb();
  db.exec(
    'DELETE FROM assessment_analysis; DELETE FROM feedback; DELETE FROM assignments; ' +
    'DELETE FROM students; DELETE FROM courses;'
  );
  courseId = db.prepare(
    `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'Course')`
  ).run().lastInsertRowid;
  assignmentSchoolId = 'sa-1';
  localAssignmentId = db.prepare(
    `INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, ?, 'Project')`
  ).run(courseId, assignmentSchoolId).lastInsertRowid;
  s1 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1','Ada','Lovelace')`).run().lastInsertRowid;
  s2 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u2','Alan','Turing')`).run().lastInsertRowid;
});

function insertFeedback(studentId, status, json) {
  return getDb().prepare(
    `INSERT INTO feedback (student_id, assignment_id, status, feedback_json) VALUES (?, ?, ?, ?)`
  ).run(studentId, localAssignmentId, status, JSON.stringify(json)).lastInsertRowid;
}

describe('GET /api/feedback/for-assignment/:assignmentId', () => {
  test('returns draft + teacher_modified rows keyed by student_id with parsed feedback', async () => {
    insertFeedback(s1, 'draft', { narrative_feedback: 'Great', rubric_scores: { 'X1': 'ED' } });
    insertFeedback(s2, 'teacher_modified', { narrative_feedback: 'Good', reviewer_flags: 'placeholder remains' });
    const { status, body } = await call('GET', `/api/feedback/for-assignment/${assignmentSchoolId}`);
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([String(s1), String(s2)].sort());
    expect(body[s1].feedback_parsed.rubric_scores).toEqual({ X1: 'ED' });
    expect(body[s2].feedback_parsed.reviewer_flags).toBe('placeholder remains');
  });

  test('excludes approved rows', async () => {
    insertFeedback(s1, 'approved', { narrative_feedback: 'done' });
    const { body } = await call('GET', `/api/feedback/for-assignment/${assignmentSchoolId}`);
    expect(body[s1]).toBeUndefined();
  });

  test('returns an empty object for an unknown assignment', async () => {
    const { status, body } = await call('GET', '/api/feedback/for-assignment/nope');
    expect(status).toBe(200);
    expect(body).toEqual({});
  });
});

describe('GET /api/feedback/for-assignment/:assignmentId - data time', () => {
  // data_as_of and suggested_at are ISO strings; null on both is a row written before they existed.
  function suggestion(studentId, { dataAsOf, suggestedAt, status = 'draft', state = null }) {
    return getDb().prepare(
      `INSERT INTO feedback (student_id, assignment_id, status, feedback_json, data_as_of, suggested_at, suggestion_state)
       VALUES (?, ?, ?, '{}', ?, ?, ?)`
    ).run(studentId, localAssignmentId, status, dataAsOf, suggestedAt, state).lastInsertRowid;
  }
  const get = async () => (await call('GET', `/api/feedback/for-assignment/${assignmentSchoolId}`)).body;

  test('carries data_as_of and flags a suggestion made from data over 10 minutes older than itself', async () => {
    suggestion(s1, { dataAsOf: '2026-10-20T09:00:00.000Z', suggestedAt: '2026-10-20T10:30:00.000Z' });
    const body = await get();
    expect(body[s1]).toMatchObject({ data_as_of: '2026-10-20T09:00:00.000Z', data_stale: true });
  });

  test('a 9 minute gap is current and an 11 minute gap is stale, whatever the server time zone', async () => {
    const was = process.env.TZ;
    process.env.TZ = 'Asia/Hong_Kong';
    try {
      suggestion(s1, { dataAsOf: '2026-10-20T10:21:00.000Z', suggestedAt: '2026-10-20T10:30:00.000Z' });
      suggestion(s2, { dataAsOf: '2026-10-20T10:19:00.000Z', suggestedAt: '2026-10-20T10:30:00.000Z' });
      const body = await get();
      expect(body[s1].data_stale).toBe(false);
      expect(body[s2].data_stale).toBe(true);
    } finally {
      if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
    }
  });

  test("'never' (written for a task that was never synced) is stale", async () => {
    suggestion(s1, { dataAsOf: 'never', suggestedAt: '2026-10-20T10:30:00.000Z' });
    const body = await get();
    expect(body[s1]).toMatchObject({ data_as_of: 'never', data_stale: true });
  });

  test('a row from before data times were recorded (null) is not judged', async () => {
    suggestion(s1, { dataAsOf: null, suggestedAt: null });
    suggestion(s2, { dataAsOf: '2026-10-20T09:00:00.000Z', suggestedAt: null });
    const body = await get();
    expect(body[s1]).toMatchObject({ data_as_of: null, data_stale: false });
    expect(body[s2].data_stale).toBe(false);
  });

  test('a teacher\'s own saved grade (teacher_modified) is never stale', async () => {
    suggestion(s1, { dataAsOf: 'never', suggestedAt: '2026-10-20T10:30:00.000Z', status: 'teacher_modified' });
    const body = await get();
    expect(body[s1].data_stale).toBe(false);
  });

  test('a teacher edit after the suggestion does not make it stale', async () => {
    // Made from data 1 minute old, years ago. The edit below moves updated_at to now, long after.
    const id = suggestion(s1, { dataAsOf: '2020-01-01T10:29:00.000Z', suggestedAt: '2020-01-01T10:30:00.000Z' });
    expect((await call('PUT', `/api/feedback/${id}`, { teacher_notes: 'checked the sources' })).status).toBe(200);
    const body = await get();
    expect(body[s1].data_stale).toBe(false);
  });

  test('a suggestion the teacher used or ignored no longer counts; revised and untouched still do', async () => {
    const stale = { dataAsOf: '2026-10-20T09:00:00.000Z', suggestedAt: '2026-10-20T10:30:00.000Z' };
    const used = suggestion(s1, stale);
    suggestion(s2, { ...stale, state: 'revised' });
    expect((await call('PUT', `/api/feedback/${used}/suggestion-state`, { state: 'used' })).status).toBe(200);
    let body = await get();
    expect(body[s1].data_stale).toBe(false);
    expect(body[s2].data_stale).toBe(true);
    expect((await call('PUT', `/api/feedback/${used}/suggestion-state`, { state: 'ignored' })).status).toBe(200);
    expect((await get())[s1].data_stale).toBe(false);
    expect((await call('PUT', `/api/feedback/${used}/suggestion-state`, { state: null })).status).toBe(200);
    body = await get();
    expect(body[s1].data_stale).toBe(true);
    expect(body[s2].data_stale).toBe(true); // the revised one counted throughout
  });
});

describe('GET /api/feedback/analysis/:assignmentId', () => {
  test('returns the parsed analysis record when present', async () => {
    const analysis = { noticings: [{ title: 'AI use', body: 'half the class' }], moderation_note: 'spot-check' };
    getDb().prepare(
      'INSERT INTO assessment_analysis (assignment_id, analysis_json) VALUES (?, ?)'
    ).run(localAssignmentId, JSON.stringify(analysis));
    const { status, body } = await call('GET', `/api/feedback/analysis/${assignmentSchoolId}`);
    expect(status).toBe(200);
    expect(body.analysis_parsed).toEqual(analysis);
  });

  test('returns null when no analysis exists', async () => {
    const { status, body } = await call('GET', `/api/feedback/analysis/${assignmentSchoolId}`);
    expect(status).toBe(200);
    expect(body).toBeNull();
  });

  test('returns null for an unknown assignment', async () => {
    const { status, body } = await call('GET', '/api/feedback/analysis/nope');
    expect(status).toBe(200);
    expect(body).toBeNull();
  });
});

describe('PUT /api/feedback/:id/suggestion-state', () => {
  test('records the teacher\'s handling of the suggested feedback (used / ignored / cleared)', async () => {
    const id = insertFeedback(s1, 'draft', { narrative_feedback: 'Nice work' });
    for (const state of ['ignored', 'used', null]) {
      const { status, body } = await call('PUT', `/api/feedback/${id}/suggestion-state`, { state });
      expect(status).toBe(200);
      expect(body).toEqual({ id, suggestion_state: state });
      expect(getDb().prepare('SELECT suggestion_state FROM feedback WHERE id = ?').get(id).suggestion_state).toBe(state);
    }
  });

  test('is served with the suggestion on /for-assignment', async () => {
    const id = insertFeedback(s1, 'draft', { narrative_feedback: 'Nice work' });
    await call('PUT', `/api/feedback/${id}/suggestion-state`, { state: 'ignored' });
    const { body } = await call('GET', `/api/feedback/for-assignment/${assignmentSchoolId}`);
    expect(body[s1].suggestion_state).toBe('ignored');
  });

  test('rejects an unknown state and an unknown row', async () => {
    const id = insertFeedback(s1, 'draft', { narrative_feedback: 'x' });
    expect((await call('PUT', `/api/feedback/${id}/suggestion-state`, { state: 'revised' })).status).toBe(400);
    expect((await call('PUT', `/api/feedback/${id}/suggestion-state`, { state: 'banana' })).status).toBe(400);
    expect((await call('PUT', '/api/feedback/999999/suggestion-state', { state: 'used' })).status).toBe(404);
  });
});
