import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import {
  createGroup, linkResult, unlinkResult, deleteGroup, getGroup, listGroups, groupForAssignment,
  setQuestionTags, listCandidates, attemptLinks, attemptLinksForStudent,
} from './quizGroups.js';

const Q = (qid, stem, kind = 'mcq', points = 1, delta = 0) => ({ qid, stemHtml: stem, kind, points, delta, number: delta + 1 });
const LIST = [Q('1001', 'Which is true?', 'mcq', 1, 0), Q('1002', 'Which is true?', 'mcq', 1, 1), Q('1003', 'Explain', 'frq', 4, 2)];
const COPY = [Q('2003', 'Explain', 'frq', 4, 0), Q('2001', 'Which is true?', 'mcq', 1, 1), Q('2002', 'Which is true?', 'mcq', 1, 2)];

let db, course, std, ext, result, other, formative, stu;
beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  course = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'AP CSP')`).run().lastInsertRowid;
  // Foreign keys are on (server/db/index.js), so an alignment needs a real topic.
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'X', 'C')`).run(course);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat', ?, 'X.1', 'T')`).run(course);
  const other_course = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s2', 'Other')`).run().lastInsertRowid;
  const add = (cid, sid, title, isTest) => db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, ?, ?, ?)`).run(cid, sid, title, isTest).lastInsertRowid;
  std = add(course, '900', 'Ep 1 Theory Test', 1);
  ext = add(course, '901', 'Ep 1 Theory Test *', 1);
  result = add(course, '950', 'Ep 1 Theory Test - Result (S)', 0);
  formative = add(course, '960', 'Practice', 0);
  other = add(other_course, '990', 'Elsewhere', 1);
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('950', 't1', ?)`).run(course);
  stu = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'A', 'B')`).run().lastInsertRowid;
});

const make = () => createGroup(db, {
  courseId: course, assignmentRefs: ['900', '901'], title: 'Ep 1 Theory Test',
  questionLists: [{ assignmentId: std, questions: LIST }, { assignmentId: ext, questions: COPY }],
});

describe('createGroup', () => {
  test('stores members, logical questions from the first list, and every copy id', () => {
    const g = make();
    expect(g.members.map(m => m.schoology_assignment_id)).toEqual(['900', '901']);
    expect(g.canonical_schoology_id).toBe('900');
    const qs = db.prepare('SELECT position, kind, max_points FROM quiz_questions WHERE group_id = ? ORDER BY position').all(g.id);
    expect(qs).toEqual([{ position: 1, kind: 'mcq', max_points: 1 }, { position: 2, kind: 'mcq', max_points: 1 }, { position: 3, kind: 'frq', max_points: 4 }]);
    const copies = db.prepare(`SELECT qq.position, c.schoology_question_id FROM quiz_question_copies c JOIN quiz_questions qq ON qq.id = c.question_id WHERE c.assignment_id = ? ORDER BY qq.position`).all(ext);
    expect(copies.map(c => [c.position, c.schoology_question_id])).toEqual([[1, '2001'], [2, '2002'], [3, '2003']]);
  });
  test('refuses a parity mismatch and stores nothing', () => {
    expect(() => createGroup(db, { courseId: course, assignmentRefs: ['900', '901'], title: 'X',
      questionLists: [{ assignmentId: std, questions: LIST }, { assignmentId: ext, questions: COPY.slice(1) }] }))
      .toThrow(expect.objectContaining({ code: 'PARITY' }));
    expect(db.prepare('SELECT COUNT(*) n FROM quiz_groups').get().n).toBe(0);
  });
  test('refuses an aligned item, a non-test, another course, or a test already grouped', () => {
    const one = (ref) => createGroup(db, { courseId: course, assignmentRefs: [ref], title: 'X', questionLists: [{ assignmentId: 0, questions: LIST }] });
    expect(() => one('950')).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(() => one('960')).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(() => one('990')).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    make();
    expect(() => one('900')).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
  });
  test('refuses an empty selection, a list count that does not match, or the same test twice', () => {
    expect(() => createGroup(db, { courseId: course, assignmentRefs: [], title: 'X', questionLists: [] }))
      .toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(() => createGroup(db, { courseId: course, assignmentRefs: ['900', '901'], title: 'X', questionLists: [{ assignmentId: std, questions: LIST }] }))
      .toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(() => createGroup(db, { courseId: course, assignmentRefs: ['900', '900'], title: 'X',
      questionLists: [{ assignmentId: std, questions: LIST }, { assignmentId: std, questions: LIST }] }))
      .toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(db.prepare('SELECT COUNT(*) n FROM quiz_groups').get().n).toBe(0);
  });
});

describe('links', () => {
  test('link an aligned summative; the result task becomes canonical; unlink keeps the group', () => {
    const g = make();
    const linked = linkResult(db, { groupId: g.id, resultRef: '950' });
    expect([linked.result.schoology_assignment_id, linked.canonical_schoology_id]).toEqual(['950', '950']);
    expect(groupForAssignment(db, '950').id).toBe(g.id);
    expect(groupForAssignment(db, '901').id).toBe(g.id);
    expect(unlinkResult(db, { groupId: g.id }).result).toBeNull();
  });
  test('refuses an unaligned task, another course, or a task linked elsewhere', () => {
    const g = make();
    expect(() => linkResult(db, { groupId: g.id, resultRef: '960' })).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(() => linkResult(db, { groupId: g.id, resultRef: '990' })).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
  });
  test('deleteGroup removes the group and frees its tests', () => {
    const g = make();
    deleteGroup(db, { groupId: g.id });
    expect(groupForAssignment(db, '900')).toBeNull();
    expect(listGroups(db, { courseId: course })).toEqual([]);
  });
});

test('setQuestionTags trims, drops blanks, and reports unknown positions', () => {
  const g = make();
  expect(setQuestionTags(db, { groupId: g.id, tags: { 1: [' CRD-2.G ', ''], 9: ['X'] } })).toEqual({ updated: 1, unknownPositions: [9] });
  expect(JSON.parse(db.prepare('SELECT tags_json FROM quiz_questions WHERE group_id = ? AND position = 1').get(g.id).tags_json)).toEqual(['CRD-2.G']);
});

test('listCandidates: ungrouped unaligned tests with similar-title suggestions, and unlinked aligned tasks', () => {
  const c = listCandidates(db, { courseId: course });
  expect(c.tests.map(t => [t.schoology_assignment_id, t.suggestedWith])).toEqual([['900', ['901']], ['901', ['900']]]);
  expect(c.summatives.map(s => s.schoology_assignment_id)).toEqual(['950']);
  make();
  expect(listCandidates(db, { courseId: course }).tests).toEqual([]);
});

test('attemptLinks: by member test, by result task, and by student', () => {
  const g = linkResult(db, { groupId: make().id, resultRef: '950' });
  db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, completed_at, fetched_at) VALUES (?, ?, ?, '5002', '2026-10-10 09:35', 'now')`).run(g.id, ext, stu);
  const want = { url: 'https://schoology.hkis.edu.hk/assignment/901/assessment_results/student_stats/701/5002', completedAt: '2026-10-10 09:35' };
  expect(attemptLinks(db, { assignmentRef: '901' })).toEqual({ [stu]: want });
  expect(attemptLinks(db, { assignmentRef: '950' })).toEqual({ [stu]: want });
  expect(attemptLinks(db, { assignmentRef: '960' })).toEqual({});
  expect(attemptLinksForStudent(db, { studentId: stu })).toEqual({ 901: want, 950: want });
});
