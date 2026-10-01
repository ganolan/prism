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
