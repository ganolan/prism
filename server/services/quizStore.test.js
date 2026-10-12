import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { readFileSync } from 'fs';
import { getDb } from '../db/index.js';
import { createGroup } from './quizGroups.js';
import { storeAttempt, pruneOlderDuplicates, finishLoad } from './quizStore.js';
import { parseQuizAttempt } from '../lib/parseQuizAttempt.js';

const ATTEMPT = parseQuizAttempt(readFileSync(new URL('../lib/__fixtures__/quiz/attempt.html', import.meta.url), 'utf8'));
const Q = (qid, stem, kind, points, delta) => ({ qid, stemHtml: stem, kind, points, delta, number: delta + 1 });
const LIST = [Q('1001', 'Which protocol sends web pages?', 'mcq', 1, 0), Q('1002', 'Which is a lossless format?', 'mcq', 1, 1), Q('1003', 'Explain the program.', 'frq', 4, 2)];
const COPY = LIST.map(q => ({ ...q, qid: String(Number(q.qid) + 1000) }));
const RUBRIC = { id: '55233026', title: 'FRQ', totalPoints: 4, rows: [{ id: '146012384', title: 'Row', maxPoints: 4, levels: [{ points: 2, name: 'Developing', descriptionHtml: 'Developing: x' }] }] };

let db, groupId, std, ext, s1;
beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'C')`).run().lastInsertRowid;
  std = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'T', 1)`).run(c).lastInsertRowid;
  ext = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '901', 'T *', 1)`).run(c).lastInsertRowid;
  s1 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'A', 'B')`).run().lastInsertRowid;
  groupId = createGroup(db, { courseId: c, assignmentRefs: ['900', '901'], title: 'T',
    questionLists: [{ assignmentId: std, questions: LIST }, { assignmentId: ext, questions: COPY }] }).id;
});

const store = (assignmentId, parsed, extra = {}) => storeAttempt(db, {
  groupId, assignmentId, studentId: s1,
  attempt: { attemptId: '5002', startedAt: '2026-10-10 09:00', completedAt: '2026-10-10 09:35', score: 3, maxScore: 6, ...extra },
  attemptCount: 1, parsed, rubrics: { 55233026: RUBRIC },
  gradeInfo: { 1003: { 146012384: { points: 2, comment: '' } } },
});

describe('storeAttempt', () => {
  test('stores the attempt and one response per logical question; fills options and rubric once', () => {
    expect(store(std, ATTEMPT)).toEqual({ stored: true, mismatches: [] });
    const rows = db.prepare(`SELECT qq.position, r.chosen_letter, r.is_correct, r.points, r.answer_html IS NOT NULL AS has_answer, r.schoology_rubric_cells_json
      FROM quiz_responses r JOIN quiz_questions qq ON qq.id = r.question_id ORDER BY qq.position`).all();
    expect(rows.map(r => [r.position, r.chosen_letter, r.is_correct, r.points, r.has_answer])).toEqual([
      [1, 'B', 1, 1, 0], [2, 'D', 0, 0, 0], [3, null, null, 2, 1],
    ]);
    expect(JSON.parse(rows[2].schoology_rubric_cells_json)).toEqual({ 146012384: { points: 2, comment: '' } });
    const q1 = db.prepare('SELECT options_json FROM quiz_questions WHERE group_id = ? AND position = 1').get(groupId);
    expect(JSON.parse(q1.options_json).map(o => [o.letter, o.is_key])).toEqual([['A', false], ['B', true], ['C', false], ['D', false]]);
    expect(JSON.parse(db.prepare('SELECT schoology_rubric_json FROM quiz_questions WHERE group_id = ? AND position = 3').get(groupId).schoology_rubric_json).id).toBe('55233026');
  });

  test('reloading replaces the attempt instead of adding one', () => {
    store(std, ATTEMPT);
    store(std, ATTEMPT);
    expect(db.prepare('SELECT COUNT(*) n FROM quiz_attempts').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM quiz_responses').get().n).toBe(3);
  });

  test('a copy with a different key is reported as a mismatch', () => {
    store(std, ATTEMPT);
    const changed = structuredClone(ATTEMPT);
    changed.questions.forEach(q => { q.qid = String(Number(q.qid) + 1000); });
    changed.questions[0].options = changed.questions[0].options.map(o => ({ ...o, isKey: o.letter === 'A' }));
    const s2 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('702', 'C', 'D')`).run().lastInsertRowid;
    const r = storeAttempt(db, { groupId, assignmentId: ext, studentId: s2, attempt: { attemptId: '6001' }, attemptCount: 1, parsed: changed, rubrics: {}, gradeInfo: {} });
    expect(r.mismatches).toEqual(['Question 1: a different key']);
  });
});

test('refuses an attempt for a test that is not a member of the group', () => {
  const courseId = db.prepare('SELECT course_id FROM quiz_groups WHERE id = ?').get(groupId).course_id;
  const stranger = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '777', 'Other', 1)`).run(courseId).lastInsertRowid;
  expect(() => store(stranger, ATTEMPT)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  expect(db.prepare('SELECT COUNT(*) n FROM quiz_attempts').get().n).toBe(0);
});

test('a question the group does not know is reported, not silently dropped', () => {
  const extra = structuredClone(ATTEMPT);
  extra.questions.push({ ...extra.questions[0], qid: '9999' });
  const r = store(std, extra);
  expect(r.mismatches).toEqual(['Schoology question 9999: not in this quiz']);
  expect(db.prepare('SELECT COUNT(*) n FROM quiz_responses').get().n).toBe(3);
});

test('pruneOlderDuplicates keeps the later attempt when a student sat two copies', () => {
  store(std, ATTEMPT, { completedAt: '2026-10-09 09:00' });
  const copy = structuredClone(ATTEMPT);
  copy.questions.forEach(q => { q.qid = String(Number(q.qid) + 1000); });
  store(ext, copy, { attemptId: '6001', completedAt: '2026-10-10 09:00' });
  expect(pruneOlderDuplicates(db, { groupId })).toBe(1);
  expect(db.prepare('SELECT assignment_id FROM quiz_attempts').all()).toEqual([{ assignment_id: ext }]);
  expect(db.prepare('SELECT COUNT(*) n FROM quiz_responses').get().n).toBe(3);
});

test('finishLoad records the summary and parity', () => {
  finishLoad(db, { groupId, summary: { attempts: 1 }, mismatches: ['Question 1: a different key'] });
  const g = db.prepare('SELECT * FROM quiz_groups WHERE id = ?').get(groupId);
  expect([g.parity_status, JSON.parse(g.parity_detail_json), JSON.parse(g.load_summary_json)]).toEqual(['mismatch', ['Question 1: a different key'], { attempts: 1 }]);
  expect(g.loaded_at).toBeTruthy();
});
