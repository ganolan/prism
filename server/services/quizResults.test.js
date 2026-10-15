import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { quizResults, confirmedMark } from './quizResults.js';
import { writeFrqSuggestions, setFrqMark } from './frqMarks.js';
import { upsertStudentSuggestion } from './suggestions.js';

const RUBRIC = { id: 'r1', title: 'FRQ', totalPoints: 4, rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'x' }, { points: 3, name: 'Exhibiting', descriptionHtml: 'x' },
  { points: 2, name: 'Developing', descriptionHtml: 'x' }, { points: 1, name: 'Emerging', descriptionHtml: 'x' }] }] };
const TWO_ROWS = { ...RUBRIC, rows: [RUBRIC.rows[0], { ...RUBRIC.rows[0], id: '147', title: 'Code' }] };

let db, c, g, result, q1, q2, q21, att, stu;
const respond = (a, q, fields) => db.prepare(`INSERT INTO quiz_responses (attempt_id, question_id, chosen_letter, is_correct, points, answer_html, schoology_rubric_cells_json, schoology_comment)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(a, q, fields.letter ?? null, fields.correct ?? null, fields.points ?? null, fields.answer ?? null,
  fields.cells ? JSON.stringify(fields.cells) : null, fields.comment ?? null);

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM feedback; DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'AP CSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'CSP.1', 'Theory')`).run(c);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat', ?, 'CSP.1.1', 'Knowledge')`).run(c);
  const test = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'Ep 1', 1)`).run(c).lastInsertRowid;
  result = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, '950', 'Ep 1 - Result (S)')`).run(c).lastInsertRowid;
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('950', 't1', ?)`).run(c);
  g = db.prepare(`INSERT INTO quiz_groups (course_id, title, result_assignment_id, loaded_at) VALUES (?, 'Ep 1', ?, '2026-10-13 01:00:00')`).run(c, result).lastInsertRowid;
  db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)').run(g, test);
  const addQ = (pos, kind, tags, rubric = null, max = 1) => db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json, tags_json) VALUES (?, ?, ?, 'S', ?, ?, ?)`)
    .run(g, pos, kind, max, rubric ? JSON.stringify(rubric) : null, JSON.stringify(tags)).lastInsertRowid;
  q1 = addQ(1, 'mcq', ['AAP-1.A']);
  q2 = addQ(2, 'mcq', ['AAP-1.A', 'CRD-2.G']);
  q21 = addQ(21, 'frq', [], RUBRIC, 4);
  stu = {}; att = {};
  for (const [uid, last] of [['u1', 'Lee'], ['u2', 'Ng'], ['u3', 'Wu']]) {
    stu[uid] = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Ana', ?)`).run(uid, last).lastInsertRowid;
    db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(stu[uid], c);
  }
  for (const uid of ['u1', 'u2']) {
    att[uid] = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, ?, 'now')`).run(g, test, stu[uid], `5${uid}`).lastInsertRowid;
  }
  respond(att.u1, q1, { letter: 'a', correct: 1 });
  respond(att.u1, q2, { letter: 'b', correct: 0 });
  respond(att.u1, q21, { answer: '<p>x</p>', cells: { 146: { points: 3, comment: '' } } });   // marked in Schoology
  respond(att.u2, q1, { letter: null, correct: 0 });                                         // blank
  respond(att.u2, q2, { letter: 'a', correct: 1 });
  respond(att.u2, q21, { answer: '<p>y</p>' });                                             // not marked
});

describe('confirmedMark', () => {
  const sch = (cells) => ({ cells, comment: '' });
  test('Prism final wins; suggested is to review; Schoology needs every row', () => {
    expect(confirmedMark({ state: 'edited', final_cells_json: '{"146":2}' }, sch({ 146: 3 }), RUBRIC)).toEqual({ source: 'prism', cells: { 146: 2 } });
    expect(confirmedMark({ state: 'suggested', final_cells_json: null }, sch({ 146: 3 }), RUBRIC)).toEqual({ reason: 'to review' });
    expect(confirmedMark(null, sch({ 146: 3 }), RUBRIC)).toEqual({ source: 'schoology', cells: { 146: 3 } });
    expect(confirmedMark(null, sch({ 146: 3 }), TWO_ROWS)).toEqual({ reason: 'not marked' });
    expect(confirmedMark(null, null, RUBRIC)).toEqual({ reason: 'not marked' });
    expect(confirmedMark(null, sch({ points: 3 }), null)).toEqual({ source: 'schoology', cells: { points: 3 } });
  });
});

describe('confirmedMark: points off the rubric', () => {
  test('a cell whose points match no level is not confirmed, from either source', () => {
    expect(confirmedMark(null, { cells: { 146: 2.5 }, comment: '' }, RUBRIC)).toEqual({ reason: 'not on the rubric' });
    expect(confirmedMark({ state: 'accepted', final_cells_json: '{"146":7}' }, null, RUBRIC)).toEqual({ reason: 'not on the rubric' });
  });
});

describe('quizResults', () => {
  test('numbers per student, by tag with blanks as wrong, readiness and not taken', () => {
    const r = quizResults(db, { groupId: g });
    expect(r.group).toMatchObject({ id: g, template_is_default: true, result: { schoology_assignment_id: '950', topics: [{ external_id: 'CSP.1.1', title: 'Knowledge' }] } });
    expect(r.questions).toEqual({ mcq: 2, frq: [{ position: 21, has_rubric: true, max_points: 4 }] });
    const [lee, ng] = r.students;
    expect(lee).toMatchObject({ name: 'Ana Lee', mcq: { correct: 1, total: 2, percent: 50 }, ready: true, blocked: [],
      by_tag: [{ tag: 'AAP-1.A', correct: 1, total: 2, percent: 50 }, { tag: 'CRD-2.G', correct: 0, total: 1, percent: 0 }],
      comment_values: { mcq_correct: 1, mcq_total: 2, mcq_percent: 50, frq_levels: 'Q21 Exhibiting' }, overall: null });
    expect(lee.attempt_url).toMatch(/\/assignment\/900\/assessment_results\/student_stats\/u1\/5u1$/);
    expect(lee.frq[0]).toMatchObject({ question: 21, confirmed: true, source: 'schoology', levels: [{ row: 'Content Knowledge', level: 'Exhibiting', points: 3 }], points: 3 });
    expect(ng).toMatchObject({ ready: false, blocked: ['Q21 not marked'], by_tag: [{ tag: 'AAP-1.A', correct: 1, total: 2 }, { tag: 'CRD-2.G', correct: 1, total: 1 }] });
    expect(r.not_taken.map(s => s.name)).toEqual(['Ana Wu']);
  });

  test('a Prism suggestion blocks until the teacher accepts it', () => {
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u2', level: 'Developing', comment: 'c' }] });
    expect(quizResults(db, { groupId: g }).students[1].blocked).toEqual(['Q21 to review']);
    setFrqMark(db, { groupId: g, attemptId: att.u2, position: 21, action: 'accept' });
    const ng = quizResults(db, { groupId: g }).students[1];
    expect([ng.ready, ng.frq[0].source, ng.comment_values.frq_levels]).toEqual([true, 'prism', 'Q21 Developing']);
  });

  test('an MCQ-only group has every student ready and null FRQ values', () => {
    db.prepare('DELETE FROM quiz_responses WHERE question_id = ?').run(q21);
    db.prepare('DELETE FROM quiz_questions WHERE id = ?').run(q21);
    const r = quizResults(db, { groupId: g });
    expect(r.students.every(s => s.ready)).toBe(true);
    expect(r.students[0].comment_values.frq_levels).toBeNull();
    expect(r.group.template).toBe('Multiple choice: {mcq_correct}/{mcq_total} ({mcq_percent}%)\n{impression}');
  });

  test('an existing overall suggestion shows its impression, and stale when the comment would now differ', () => {
    const built = 'Multiple choice: 1/2 (50%)\nFree response: Q21 Exhibiting\nGood.\nOpen your attempt on the test to read the feedback on each free-response question.';
    upsertStudentSuggestion(db, { assignmentId: '950', student: 'u1', narrative_feedback: built, rubric_scores: { 'CSP.1.1': 'EX' }, quiz_overall: { group_id: g, impression: 'Good.' } });
    expect(quizResults(db, { groupId: g }).students[0].overall).toMatchObject({ impression: 'Good.', rubric_scores: { 'CSP.1.1': 'EX' }, stale: false });
    db.prepare(`UPDATE quiz_responses SET is_correct = 1 WHERE attempt_id = ? AND question_id = ?`).run(att.u1, q2);
    expect(quizResults(db, { groupId: g }).students[0].overall.stale).toBe(true);
  });

  test('a suggestion written without quiz_overall, or for another group, is not this quiz\'s overall', () => {
    upsertStudentSuggestion(db, { assignmentId: '950', student: 'u1', narrative_feedback: 'by hand', rubric_scores: {} });
    expect(quizResults(db, { groupId: g }).students[0].overall).toBeNull();
  });

  test('an unlinked group has result null and no overall', () => {
    db.prepare('UPDATE quiz_groups SET result_assignment_id = NULL WHERE id = ?').run(g);
    const r = quizResults(db, { groupId: g });
    expect([r.group.result, r.students[0].overall]).toEqual([null, null]);
  });
});
