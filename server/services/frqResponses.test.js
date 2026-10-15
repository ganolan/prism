import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { frqResponses, listWritebacks, levelsOf } from './frqResponses.js';
import { writeFrqSuggestions, setFrqMark } from './frqMarks.js';

const RUBRIC = { id: 'r1', title: 'FRQ', totalPoints: 4, rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth: all correct' },
  { points: 3, name: 'Exhibiting', descriptionHtml: 'Exhibiting: main ideas correct' },
  { points: 2, name: 'Developing', descriptionHtml: 'Developing: one part' },
  { points: 1, name: 'Emerging', descriptionHtml: 'Emerging: attempted' }] }] };

let db, g, q, qNoRubric, a1, a2;
const cellsOf = (row) => JSON.parse(row);
const mark = (attempt, question = q) => db.prepare('SELECT * FROM frq_marks WHERE attempt_id = ? AND question_id = ?').get(attempt, question);
const setSchoology = (attempt, points, comment) => db.prepare('UPDATE quiz_responses SET schoology_rubric_cells_json = ?, schoology_comment = ? WHERE attempt_id = ? AND question_id = ?')
  .run(points == null ? null : JSON.stringify({ 146: { points, comment: '' } }), comment, attempt, q);

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM frq_marks; DELETE FROM quiz_tag_texts; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'C')`).run().lastInsertRowid;
  const t = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'T', 1)`).run(c).lastInsertRowid;
  g = db.prepare(`INSERT INTO quiz_groups (course_id, title) VALUES (?, 'T')`).run(c).lastInsertRowid;
  db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)').run(g, t);
  q = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json) VALUES (?, 21, 'frq', 'Explain', 4, ?)`).run(g, JSON.stringify(RUBRIC)).lastInsertRowid;
  qNoRubric = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points) VALUES (?, 22, 'frq', 'Describe', 5)`).run(g).lastInsertRowid;
  const ids = [];
  for (const [uid, last] of [['u1', 'Lee'], ['u2', 'Ng']]) {
    const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Ana', ?)`).run(uid, last).lastInsertRowid;
    const a = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, ?, 'now')`).run(g, t, s, `9${uid}`).lastInsertRowid;
    for (const qq of [q, qNoRubric]) db.prepare('INSERT INTO quiz_responses (attempt_id, question_id, answer_html, max_points) VALUES (?, ?, ?, 4)').run(a, qq, '<p>answer</p>');
    ids.push(a);
  }
  [a1, a2] = ids;
});

test('one entry per attempt, sorted by name, with the Schoology copy and the Prism mark per FRQ', () => {
  setSchoology(a2, 3, 'Fine');
  writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Developing', comment: 'c' }] });
  const r = frqResponses(db, { groupId: g });
  expect(r.questions.map(x => x.position)).toEqual([21, 22]);
  expect(r.students.map(s => s.name)).toEqual(['Ana Lee', 'Ana Ng']);
  expect(r.students[0].attempt_url).toBe('https://schoology.hkis.edu.hk/assignment/900/assessment_results/student_stats/u1/9u1');
  expect(r.students[0].responses[21].mark.state).toBe('suggested');
  expect(r.students[1].responses[21]).toMatchObject({ answer_html: '<p>answer</p>', schoology: { cells: { 146: 3 }, comment: 'Fine' }, mark: null });
});

test('position limits the questions; an unknown position is NOT_FOUND', () => {
  expect(frqResponses(db, { groupId: g, position: 22 }).questions.map(x => x.position)).toEqual([22]);
  expect(() => frqResponses(db, { groupId: g, position: 3 })).toThrow(/no free-response question 3/);
});

test('levelsOf names each row\'s level', () => {
  expect(levelsOf(RUBRIC, { 146: 2 })).toEqual([{ row: 'Content Knowledge', level: 'Developing', points: 2 }]);
  expect(levelsOf(null, { points: 4 })).toEqual([{ row: 'Points', level: null, points: 4 }]);
});

test('listWritebacks lists waiting and failed marks only', () => {
  writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Developing', comment: 'c1' }, { student: 'u2', level: 'Emerging', comment: 'c2' }] });
  setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
  const { writebacks } = listWritebacks(db, { groupId: g });
  expect(writebacks).toEqual([expect.objectContaining({ name: 'Ana Lee', question: 21, comment: 'c1', status: 'pending', levels: [{ row: 'Content Knowledge', level: 'Developing', points: 2 }] })]);
});
