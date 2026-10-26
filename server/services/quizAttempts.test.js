import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { quizAttempts } from './quizAttempts.js';

const RUBRIC = { id: 'r1', title: 'FRQ', totalPoints: 4, rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'x' }, { points: 3, name: 'Exhibiting', descriptionHtml: 'x' },
  { points: 2, name: 'Developing', descriptionHtml: 'x' }, { points: 1, name: 'Emerging', descriptionHtml: 'x' }] }] };
const OPTS = JSON.stringify(['A', 'B', 'C', 'D'].map(l => ({ letter: l, html: `<p>${l}</p>`, is_key: l === 'C' })));

let db, c, g, std, copy, q1, q2, q21, att, stu;
const respond = (a, q, fields) => db.prepare(`INSERT INTO quiz_responses (attempt_id, question_id, chosen_letter, is_correct, points, max_points, answer_html, schoology_rubric_cells_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(a, q, fields.letter ?? null, fields.correct ?? null, fields.points ?? null, fields.max ?? null,
  fields.answer ?? null, fields.cells ? JSON.stringify(fields.cells) : null);

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM feedback; DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'AP CSP')`).run().lastInsertRowid;
  std = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'Ep 1', 1)`).run(c).lastInsertRowid;
  copy = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '901', 'Ep 1 *', 1)`).run(c).lastInsertRowid;
  g = db.prepare(`INSERT INTO quiz_groups (course_id, title, loaded_at) VALUES (?, 'Ep 1', '2026-10-13 01:00:00')`).run(c).lastInsertRowid;
  db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?), (?, ?)').run(g, std, g, copy);
  const addQ = (pos, kind, { tags = [], rubric = null, max = 1, opts = null } = {}) => db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, options_json, max_points, schoology_rubric_json, tags_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(g, pos, kind, `<p>Q${pos}</p>`, opts, max, rubric ? JSON.stringify(rubric) : null, JSON.stringify(tags)).lastInsertRowid;
  q2 = addQ(2, 'mcq', { opts: OPTS });
  q1 = addQ(1, 'mcq', { opts: OPTS, tags: ['AAP-1.A'] });
  q21 = addQ(21, 'frq', { rubric: RUBRIC, max: 4 });
  stu = {}; att = {};
  for (const [uid, last] of [['u1', 'Lee'], ['u2', 'Ng'], ['u3', 'Wu']]) {
    stu[uid] = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Ana', ?)`).run(uid, last).lastInsertRowid;
    db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(stu[uid], c);
  }
  att.u1 = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, started_at, completed_at, score, max_score, fetched_at)
    VALUES (?, ?, ?, '5u1', '2026-10-09 06:00:00', '2026-10-09 06:35:00', 5, 6, 'now')`).run(g, std, stu.u1).lastInsertRowid;
  att.u2 = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, '5u2', 'now')`).run(g, copy, stu.u2).lastInsertRowid;
  respond(att.u1, q1, { letter: 'C', correct: 1, points: 1, max: 1 });
  respond(att.u1, q2, { letter: 'B', correct: 0, points: 0, max: 1 });
  respond(att.u1, q21, { answer: '<p>x</p>', cells: { 146: { points: 3, comment: 'Good' } } });
  respond(att.u2, q1, { letter: null, correct: 0, points: 0, max: 1 });
  respond(att.u2, q2, { letter: 'C', correct: 1, points: 1, max: 1 });
  respond(att.u2, q21, { answer: '<p>y</p>' });
});

describe('quizAttempts', () => {
  test('every question in position order, MCQ options with the key and the class counts', () => {
    const r = quizAttempts(db, { groupId: g });
    expect(r.questions.map(q => [q.position, q.kind])).toEqual([[1, 'mcq'], [2, 'mcq'], [21, 'frq']]);
    const [first] = r.questions;
    expect(first).toMatchObject({ id: q1, stem_html: '<p>Q1</p>', max_points: 1, tags: ['AAP-1.A'], facility: 0.5, band: 'Divided' });
    expect(first.options.map(o => [o.letter, o.is_key, o.count])).toEqual([['A', false, 0], ['B', false, 0], ['C', true, 1], ['D', false, 0]]);
    expect(r.questions[2]).toMatchObject({ id: q21, kind: 'frq', max_points: 4, rubric: RUBRIC });
    expect(r.group).toMatchObject({ id: g, title: 'Ep 1', has_tags: true });
    expect(r.group.members.map(m => m.schoology_assignment_id)).toEqual(['900', '901']);
  });

  test('an MCQ response has the choice, correct or not, points and the key; a blank has chosen_letter null', () => {
    const [lee, ng] = quizAttempts(db, { groupId: g }).students;
    expect(lee.responses[2]).toEqual({ kind: 'mcq', chosen_letter: 'B', key_letter: 'C', is_correct: false, points: 0, max_points: 1 });
    expect(ng.responses[1]).toEqual({ kind: 'mcq', chosen_letter: null, key_letter: 'C', is_correct: false, points: 0, max_points: 1 });
  });

  test('an FRQ response carries the answer and the mark view the marking card uses', () => {
    const [lee] = quizAttempts(db, { groupId: g }).students;
    expect(lee.responses[21]).toMatchObject({ kind: 'frq', answer_html: '<p>x</p>', schoology: { cells: { 146: 3 } }, mark: null });
  });

  test('each student keeps the quiz results fields: the member test taken, score, times, the numbers', () => {
    const [lee, ng] = quizAttempts(db, { groupId: g }).students;
    expect(lee).toMatchObject({ name: 'Ana Lee', member: { schoology_assignment_id: '900', title: 'Ep 1' }, score: 5, max_score: 6,
      started_at: '2026-10-09 06:00:00', completed_at: '2026-10-09 06:35:00', mcq: { correct: 1, total: 2, percent: 50 }, ready: true });
    expect(lee.attempt_url).toMatch(/\/assignment\/900\//);
    expect(ng.member).toMatchObject({ schoology_assignment_id: '901', title: 'Ep 1 *' });
  });

  test('students with no attempt are in not_taken', () => {
    expect(quizAttempts(db, { groupId: g }).not_taken.map(s => s.name)).toEqual(['Ana Wu']);
  });

  test('a quiz with no FRQ, and one with no MCQ', () => {
    db.prepare('DELETE FROM quiz_responses WHERE question_id = ?').run(q21);
    db.prepare('DELETE FROM quiz_questions WHERE id = ?').run(q21);
    expect(quizAttempts(db, { groupId: g }).questions.map(q => q.kind)).toEqual(['mcq', 'mcq']);
    db.prepare('DELETE FROM quiz_responses').run();
    db.prepare(`DELETE FROM quiz_questions WHERE kind = 'mcq'`).run();
    const frqOnly = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json, tags_json) VALUES (?, 1, 'frq', 'S', 4, ?, '[]')`).run(g, JSON.stringify(RUBRIC)).lastInsertRowid;
    respond(att.u1, frqOnly, { answer: '<p>z</p>' });
    const r = quizAttempts(db, { groupId: g });
    expect(r.questions.map(q => q.kind)).toEqual(['frq']);
    expect(r.students[0].responses[1]).toMatchObject({ kind: 'frq', answer_html: '<p>z</p>' });
    expect(r.group.has_tags).toBe(false);
  });

  test('has_tags is false when no question has tags', () => {
    db.prepare(`UPDATE quiz_questions SET tags_json = '[]'`).run();
    expect(quizAttempts(db, { groupId: g }).group.has_tags).toBe(false);
  });
});
