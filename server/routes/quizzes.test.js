import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../services/quizLoader.js', () => ({ readQuestionLists: vi.fn(), loadGroup: vi.fn() }));
vi.mock('../services/quizWriteback.js', () => ({ postWritebacks: vi.fn(async () => ({ results: [], remaining: 0 })) }));
// Every flag is on unless a test turns it off (flagsOff), so a route's own gate can be checked.
const flagsOff = vi.hoisted(() => new Set());
vi.mock('../middleware/featureGate.js', async (orig) => ({ ...(await orig()),
  featureGate: (name) => (req, res, next) => (flagsOff.has(name) ? res.status(403).json({ error: `Feature "${name}" is not enabled` }) : next()) }));

import router from './quizzes.js';
import { getDb } from '../db/index.js';
import { readQuestionLists, loadGroup } from '../services/quizLoader.js';
import { QuizError } from '../services/quizError.js';
import { postWritebacks } from '../services/quizWriteback.js';

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
  db.exec('DELETE FROM quiz_tag_texts; DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM assignments; DELETE FROM courses;');
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

  test('an unreachable Schoology is 502, distinct from an expired session', async () => {
    vi.mocked(readQuestionLists).mockRejectedValueOnce(new QuizError('UNREACHABLE', 'Could not reach Schoology: try again'));
    const r = await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' });
    expect([r.status, r.body.code, r.body.error]).toEqual([502, 'UNREACHABLE', 'Could not reach Schoology: try again']);
  });

  test('load returns the summary; BUSY is 409', async () => {
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    vi.mocked(loadGroup).mockResolvedValueOnce({ attempts: 3 });
    expect((await call('POST', `/api/quizzes/${id}/load`)).body.summary).toEqual({ attempts: 3 });
    vi.mocked(loadGroup).mockRejectedValueOnce(new QuizError('BUSY', 'already loading'));
    expect((await call('POST', `/api/quizzes/${id}/load`)).status).toBe(409);
  });

  test('FRQ responses and a teacher action', async () => {
    const db = getDb();
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    const rubric = { id: 'r1', title: 'FRQ', totalPoints: 4, rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
      { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth: all' }, { points: 3, name: 'Exhibiting', descriptionHtml: 'Exhibiting: most' }] }] };
    const q = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json) VALUES (?, 21, 'frq', 'Explain', 4, ?)`).run(id, JSON.stringify(rubric)).lastInsertRowid;
    db.prepare(`INSERT OR IGNORE INTO students (schoology_uid, first_name, last_name) VALUES ('frq-route-1', 'Ana', 'Lee')`).run();
    const student = db.prepare(`SELECT id FROM students WHERE schoology_uid = 'frq-route-1'`).get().id;
    const t = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = '900'`).get().id;
    const a = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, '5001', 'now')`).run(id, t, student).lastInsertRowid;
    db.prepare('INSERT INTO quiz_responses (attempt_id, question_id, answer_html) VALUES (?, ?, ?)').run(a, q, '<p>because</p>');

    const r = await call('GET', `/api/quizzes/${id}/frq`);
    expect(r.status).toBe(200);
    expect(r.body.questions[0].position).toBe(21);
    const attemptId = r.body.students[0].attempt_id;
    const saved = await call('PUT', `/api/quizzes/${id}/frq/${attemptId}/21`, { action: 'save', cells: { 146: 3 }, comment: 'Good' });
    expect(saved.body.mark).toMatchObject({ state: 'edited', final: { cells: { 146: 3 }, comment: 'Good' }, writeback: { status: 'pending' } });
    expect((await call('PUT', `/api/quizzes/${id}/frq/${attemptId}/21`, { action: 'accept' })).status).toBe(400);
    expect((await call('GET', `/api/quizzes/${id}/frq?question=5`)).status).toBe(404);
  });

  test('stats, tags, attempt links, candidates and delete', async () => {
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    expect((await call('GET', `/api/quizzes/${id}/stats`)).body.questions).toHaveLength(1);
    expect((await call('PUT', `/api/quizzes/${id}/tags`, { tags: { 1: ['AAP-1.A'] } })).body).toEqual({ updated: 1, unknownPositions: [] });
    expect((await call('PUT', `/api/quizzes/${id}/tags`, { texts: { 'AAP-1.A': 'Represent a value with a variable.' } })).body)
      .toEqual({ updated: 0, unknownPositions: [], textsSaved: 1 });
    expect((await call('GET', '/api/quizzes/attempt-links?assignment_id=900')).body).toEqual({ links: {} });
    expect((await call('GET', `/api/quizzes/candidates?course_id=${course}`)).body.tests.map(t => t.schoology_assignment_id)).toEqual(['901']);
    expect((await call('DELETE', `/api/quizzes/${id}`)).body).toEqual({ ok: true });
    expect((await call('GET', `/api/quizzes/${id}/stats`)).status).toBe(404);
  });

  test('GET /tag-results: one tag across the course; a missing tag is 400, an unknown course 404', async () => {
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    await call('PUT', `/api/quizzes/${id}/tags`, { tags: { 1: ['AAP-1.A'] }, texts: { 'AAP-1.A': 'Represent a value with a variable.' } });
    const r = await call('GET', `/api/quizzes/tag-results?course_id=${course}&tag=${encodeURIComponent('AAP-1.A')}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tag: 'AAP-1.A', text: 'Represent a value with a variable.', courseTags: ['AAP-1.A'] });
    expect(r.body.tests).toEqual([expect.objectContaining({ group_id: id, title: 'T', takers: 0, percent: null })]);
    expect((await call('GET', `/api/quizzes/tag-results?course_id=${course}`)).status).toBe(400);
    expect((await call('GET', '/api/quizzes/tag-results?course_id=99999&tag=X')).status).toBe(404);
  });

  test('PUT /:id/template saves, refuses an unknown placeholder with 400', async () => {
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    const ok = await call('PUT', `/api/quizzes/${id}/template`, { template: '{impression}' });
    expect([ok.status, ok.body.group.comment_template]).toEqual([200, '{impression}']);
    const bad = await call('PUT', `/api/quizzes/${id}/template`, { template: '{score}' });
    expect([bad.status, bad.body.error]).toEqual([400, 'Unknown placeholder: {score}']);
  });

  test('GET /:id/results and POST rebuild', async () => {
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    const r = await call('GET', `/api/quizzes/${id}/results`);
    expect([r.status, r.body.students, r.body.group.result]).toEqual([200, [], null]);
    const rebuilt = await call('POST', `/api/quizzes/${id}/overall/1/rebuild`);
    expect([rebuilt.status, rebuilt.body.code]).toEqual([400, 'NOT_ELIGIBLE']);
  });

  test('creating or checking a group refuses bad input before reading Schoology', async () => {
    vi.mocked(readQuestionLists).mockClear();
    const results = [
      await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['950'], title: 'T' }),
      await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900', '900'], title: 'T' }),
      await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['999'], title: 'T' }),
      await call('POST', '/api/quizzes/check-parity', { assignment_ids: ['999'] }),
      await call('POST', '/api/quizzes/check-parity', { assignment_ids: ['950'] }),
      await call('POST', '/api/quizzes', { assignment_ids: ['900'], title: 'T' }),
    ];
    expect(results.map(r => [r.status, r.body.code])).toEqual([[400, 'NOT_ELIGIBLE'], [400, 'NOT_ELIGIBLE'], [404, 'NOT_FOUND'], [404, 'NOT_FOUND'], [400, 'NOT_ELIGIBLE'], [400, 'NOT_ELIGIBLE']]);
    expect(vi.mocked(readQuestionLists)).not.toHaveBeenCalled();
  });

  test('POST /:id/writeback with quiz_writeback off: 403, nothing posted', async () => {
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    vi.mocked(postWritebacks).mockClear();
    flagsOff.add('quiz_writeback');
    try {
      const r = await call('POST', `/api/quizzes/${id}/writeback`, {});
      expect(r.status).toBe(403);
      expect(vi.mocked(postWritebacks)).not.toHaveBeenCalled();
    } finally { flagsOff.delete('quiz_writeback'); }
  });

  test('PUT /:id/template with no template in the body: 400, the stored template kept', async () => {
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    expect((await call('PUT', `/api/quizzes/${id}/template`, { template: 'Well done. {impression}' })).status).toBe(200);
    const r = await call('PUT', `/api/quizzes/${id}/template`, {});
    expect([r.status, r.body.code]).toEqual([400, 'NOT_ELIGIBLE']);
    expect(getDb().prepare('SELECT comment_template FROM quiz_groups WHERE id = ?').get(id).comment_template).toBe('Well done. {impression}');
    const reset = await call('PUT', `/api/quizzes/${id}/template`, { template: '' });
    expect([reset.status, reset.body.group.comment_template]).toEqual([200, null]);
  });

  test('POST /:id/writeback posts with the limit given', async () => {
    const id = (await call('POST', '/api/quizzes', { course_id: course, assignment_ids: ['900'], title: 'T' })).body.group.id;
    const r = await call('POST', `/api/quizzes/${id}/writeback`, { limit: 1 });
    expect([r.status, r.body]).toEqual([200, { results: [], remaining: 0 }]);
    expect(vi.mocked(postWritebacks)).toHaveBeenCalledWith(expect.anything(), { groupId: String(id), limit: 1 });
  });
});
