import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../services/quizLoader.js', () => ({ readQuestionLists: vi.fn(), loadGroup: vi.fn() }));
vi.mock('../middleware/featureGate.js', async (orig) => ({ ...(await orig()), featureGate: () => (req, res, next) => next() }));

import router from './quizzes.js';
import { getDb } from '../db/index.js';
import { readQuestionLists, loadGroup } from '../services/quizLoader.js';
import { QuizError } from '../services/quizError.js';

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/quizzes', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

const Q = (qid, stem) => ({ qid, stemHtml: stem, kind: 'mcq', points: 1, delta: 0, number: 1 });
let course;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM assignments; DELETE FROM courses;');
  course = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'C')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'X', 'C')`).run(course);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t', 'cat', ?, 'X.1', 'T')`).run(course);
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'T', 1), (?, '901', 'T *', 1), (?, '950', 'T - Result (S)', 0)`).run(course, course, course);
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('950', 't', ?)`).run(course);
  vi.mocked(readQuestionLists).mockImplementation(async (db2, { assignmentRefs }) => assignmentRefs.map((ref) => {
    const a = db2.prepare('SELECT id, title FROM assignments WHERE schoology_assignment_id = ?').get(String(ref));
    return { assignmentId: a.id, schoologyId: String(ref), title: a.title, questions: [Q(`${ref}1`, 'Same question')] };
  }));
});

describe('/api/quizzes', () => {
  test('combine, link, find by either assignment, list', async () => {
    const created = await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900', '901'], title: 'T' });
    expect(created.status).toBe(200);
    const id = created.body.group.id;
    expect((await call('PUT', `/api/quizzes/${id}/link`, { result_assignment_id: '950' })).body.group.canonical_schoology_id).toBe('950');
    expect((await call('GET', '/api/quizzes/for-assignment/901')).body.group.id).toBe(id);
    expect((await call('GET', `/api/quizzes?course_id=${course}`)).body.groups).toHaveLength(1);
    expect((await call('PUT', `/api/quizzes/${id}/link`, { result_assignment_id: null })).body.group.result).toBeNull();
  });

  test('a parity mismatch is 409 with the differences', async () => {
    vi.mocked(readQuestionLists).mockResolvedValueOnce([
      { assignmentId: 1, schoologyId: '900', title: 'T', questions: [Q('1', 'One')] },
      { assignmentId: 2, schoologyId: '901', title: 'T *', questions: [Q('2', 'Two')] },
    ]);
    const r = await call('POST', '/api/quizzes/check-parity', { assignment_ids: ['900', '901'] });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.differences[0].title).toBe('T *');
  });

  test('a create that finds a parity mismatch is 409 with the differences', async () => {
    vi.mocked(readQuestionLists).mockImplementationOnce(async (db2, { assignmentRefs }) => assignmentRefs.map((ref, i) => {
      const a = db2.prepare('SELECT id, title FROM assignments WHERE schoology_assignment_id = ?').get(String(ref));
      return { assignmentId: a.id, schoologyId: String(ref), title: a.title, questions: [Q(`q${i}`, i ? 'Two' : 'One')] };
    }));
    const r = await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900', '901'], title: 'T' });
    expect([r.status, r.body.code]).toEqual([409, 'PARITY']);
    expect(r.body.differences[0].title).toBe('T *');
  });

  test('check-parity with no tests is 400 NOT_ELIGIBLE, not a crash', async () => {
    const r = await call('POST', '/api/quizzes/check-parity', { assignment_ids: [] });
    expect([r.status, r.body.code]).toEqual([400, 'NOT_ELIGIBLE']);
  });

  test('no session is 503', async () => {
    vi.mocked(readQuestionLists).mockRejectedValueOnce(new QuizError('NO_SESSION', 'No saved Schoology session'));
    const r = await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' });
    expect([r.status, r.body.code]).toEqual([503, 'NO_SESSION']);
  });

  test('load returns the summary; BUSY is 409', async () => {
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    vi.mocked(loadGroup).mockResolvedValueOnce({ attempts: 3 });
    expect((await call('POST', `/api/quizzes/${id}/load`)).body.summary).toEqual({ attempts: 3 });
    vi.mocked(loadGroup).mockRejectedValueOnce(new QuizError('BUSY', 'already loading'));
    expect((await call('POST', `/api/quizzes/${id}/load`)).status).toBe(409);
  });

  test('stats, tags, attempt links, candidates and delete', async () => {
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    expect((await call('GET', `/api/quizzes/${id}/stats`)).body.questions).toHaveLength(1);
    expect((await call('PUT', `/api/quizzes/${id}/tags`, { tags: { 1: ['AAP-1.A'] } })).body).toEqual({ updated: 1, unknownPositions: [] });
    expect((await call('GET', '/api/quizzes/attempt-links?assignment_id=900')).body).toEqual({ links: {} });
    expect((await call('GET', `/api/quizzes/candidates?course_id=${course}`)).body.tests.map(t => t.schoology_assignment_id)).toEqual(['901']);
    expect((await call('DELETE', `/api/quizzes/${id}`)).body).toEqual({ ok: true });
    expect((await call('GET', `/api/quizzes/${id}/stats`)).status).toBe(404);
  });
});
