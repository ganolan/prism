import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { writeOverallSuggestions, rebuildOverallSuggestion } from './quizOverall.js';
import { quizResults } from './quizResults.js';
import { recordServe } from './contextServes.js';
import { setFrqMark, writeFrqSuggestions } from './frqMarks.js';

const RUBRIC = { id: 'r1', title: 'FRQ', totalPoints: 4, rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'x' }, { points: 3, name: 'Exhibiting', descriptionHtml: 'x' },
  { points: 2, name: 'Developing', descriptionHtml: 'x' }, { points: 1, name: 'Emerging', descriptionHtml: 'x' }] }] };
const TWO_ROWS = { ...RUBRIC, rows: [RUBRIC.rows[0], { ...RUBRIC.rows[0], id: '147', title: 'Code' }] };

let db, c, g, result, testId, q1, q2, q21, att, stu;
const respond = (a, q, fields) => db.prepare(`INSERT INTO quiz_responses (attempt_id, question_id, chosen_letter, is_correct, points, answer_html, schoology_rubric_cells_json, schoology_comment)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(a, q, fields.letter ?? null, fields.correct ?? null, fields.points ?? null, fields.answer ?? null,
  fields.cells ? JSON.stringify(fields.cells) : null, fields.comment ?? null);

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM context_serves; DELETE FROM feedback; DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'AP CSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'CSP.1', 'Theory')`).run(c);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat', ?, 'CSP.1.1', 'Knowledge')`).run(c);
  const test = testId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'Ep 1', 1)`).run(c).lastInsertRowid;
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

const latestOn = (studentId, assignmentId) => db.prepare(`SELECT * FROM feedback WHERE student_id = ? AND assignment_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`).get(studentId, assignmentId);
// #200: the built comment is on the test the student took; the levels and the narrative on the result task.
const latest = (studentId) => latestOn(studentId, result);
const latestTest = (studentId) => latestOn(studentId, testId);
const fjOf = (row) => JSON.parse(row.feedback_json);

describe('writeOverallSuggestions', () => {
  test('builds the comment from the template; refuses the not-ready, the absent and the unknown per student', () => {
    const r = writeOverallSuggestions(db, { groupId: g, students: [
      { student: 'u1', rubric_scores: { 'CSP.1.1': 'Exhibiting' }, impression: 'A secure start on variables.' },
      { student: 'u2', rubric_scores: { 'CSP.1.1': 'Developing' }, impression: 'x' },
      { student: 'u3', rubric_scores: {}, impression: 'x' },
      { student: 'nobody', rubric_scores: {}, impression: 'x' },
    ] });
    expect(r.written).toBe(1);
    expect(r.results.map(x => [x.status, x.message ?? null])).toEqual([
      ['written', null],
      ['error', 'Not ready: Q21 not marked'],
      ['error', 'No attempt on this quiz'],
      ['error', 'Student not found: nobody'],
    ]);
    const fj = fjOf(latestTest(stu.u1));
    expect(fj.narrative_feedback).toBe('Multiple choice: 1/2 (50%)\nFree response: Q21 Exhibiting\nA secure start on variables.\nOpen your attempt on the test to read the feedback on each free-response question.');
    expect(fj.rubric_scores).toEqual({});
    expect(fj.quiz_overall).toEqual({ group_id: g, impression: 'A secure start on variables.', built: fj.narrative_feedback });
    const rj = fjOf(latest(stu.u1));
    expect(rj.rubric_scores).toEqual({ 'CSP.1.1': 'EX' });
    expect([rj.narrative_feedback, rj.quiz_overall ?? null]).toEqual(['', null]);
    expect(r.results[0]).toMatchObject({ test: { status: 'written' }, result: { status: 'written' } });
  });

  test('the built comment goes to the test the student took, the extra-time copy included', () => {
    const copy = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '901', 'Ep 1 *', 1)`).run(c).lastInsertRowid;
    db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)').run(g, copy);
    db.prepare('UPDATE quiz_attempts SET assignment_id = ? WHERE id = ?').run(copy, att.u1);
    writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', impression: 'Good.' }] });
    expect(fjOf(latestOn(stu.u1, copy)).quiz_overall.impression).toBe('Good.');
    expect(latestTest(stu.u1)).toBeUndefined();
    expect(latest(stu.u1)).toBeUndefined();
  });

  test('rubric_scores and a narrative write the result task', () => {
    const r = writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.1.1': 'EX' }, narrative: 'Revise part (a): explain why.' }] });
    expect(r.results[0]).toMatchObject({ status: 'written', test: null, result: { status: 'written' } });
    expect(fjOf(latest(stu.u1))).toMatchObject({ narrative_feedback: 'Revise part (a): explain why.', rubric_scores: { 'CSP.1.1': 'EX' } });
    expect(fjOf(latest(stu.u1)).quiz_overall).toBeUndefined();
    expect(latestTest(stu.u1)).toBeUndefined();
  });

  test('a narrative alone leaves an accepted test comment untouched', () => {
    writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', impression: 'Good.' }] });
    db.prepare(`UPDATE feedback SET suggestion_state = 'used' WHERE id = ?`).run(latestTest(stu.u1).id);
    const before = latestTest(stu.u1);
    writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', narrative: 'Revise part (a).' }] });
    expect(latestTest(stu.u1)).toEqual(before);
    expect(fjOf(latest(stu.u1)).narrative_feedback).toBe('Revise part (a).');
  });

  test('levels and a narrative written in separate calls keep each other', () => {
    writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.1.1': 'EX' } }] });
    writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', narrative: 'Revise part (a).' }] });
    expect(fjOf(latest(stu.u1))).toMatchObject({ narrative_feedback: 'Revise part (a).', rubric_scores: { 'CSP.1.1': 'EX' } });
    writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.1.1': 'D' } }] });
    expect(fjOf(latest(stu.u1))).toMatchObject({ narrative_feedback: 'Revise part (a).', rubric_scores: { 'CSP.1.1': 'D' } });
  });

  test('an empty narrative clears the result task comment and keeps the levels', () => {
    writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.1.1': 'EX' }, narrative: 'Revise part (a).' }] });
    writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', narrative: '' }] });
    expect(fjOf(latest(stu.u1))).toMatchObject({ narrative_feedback: '', rubric_scores: { 'CSP.1.1': 'EX' } });
  });

  test('a narrative is written for a student who is not ready; the impression and levels are refused', () => {
    const r = writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u2', impression: 'x', rubric_scores: { 'CSP.1.1': 'EX' }, narrative: 'Finish Q21.' }] });
    expect(r.results[0]).toMatchObject({ status: 'written', test: { status: 'error', message: 'Not ready: Q21 not marked' } });
    expect(fjOf(latest(stu.u2))).toMatchObject({ narrative_feedback: 'Finish Q21.', rubric_scores: {} });
    expect(r.results[0].result.message).toMatch(/levels were not written: Not ready: Q21 not marked/);
  });

  test('an unlinked group: the test comment is written and levels are refused', () => {
    db.prepare('UPDATE quiz_groups SET result_assignment_id = NULL WHERE id = ?').run(g);
    const r = writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', impression: 'Good.', rubric_scores: { 'CSP.1.1': 'EX' } }] });
    expect(r.results[0]).toMatchObject({ status: 'written', test: { status: 'written' }, result: { status: 'error', message: 'Link this quiz group to its result task first' } });
  });

  test('uses the fallback serve rule: the oldest serve in 3 hours, never an older one', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T10:00:00.000Z'));
    const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
    db.prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run(iso(7), result);
    recordServe(db, { assignmentId: result, dataAsOf: iso(5 * 24 * 60), now: iso(4 * 60) }); // 4 h old: ignored
    const write = () => writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.1.1': 'Exhibiting' }, impression: 'Good.' }] });
    write();
    expect(latest(stu.u1).data_as_of).toBe(iso(7));
    recordServe(db, { assignmentId: result, dataAsOf: iso(100), now: iso(90) });
    recordServe(db, { assignmentId: result, dataAsOf: iso(6), now: iso(5) });
    write();
    expect(latest(stu.u1)).toMatchObject({ data_as_of: iso(100), suggested_at: iso(90) });
    vi.useRealTimers();
  });

  test('refuses a student with nothing to write', () => {
    const r = writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: {}, impression: '  ' }] });
    expect(r.results[0]).toMatchObject({ status: 'error', message: 'Nothing to write: send an impression, rubric_scores or a narrative' });
  });

  test('passes on an unresolved topic and a numeric level as written-with-notes', () => {
    const r = writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.9.9': 'EX', 'CSP.1.1': '3' }, impression: 'Good.' }] });
    expect(r.results[0].result).toMatchObject({ status: 'written', unresolved_topics: ['CSP.9.9'], message: expect.stringMatching(/numeric/) });
  });

  test('refuses the whole call for a never-loaded group', () => {
    db.prepare('UPDATE quiz_groups SET loaded_at = NULL WHERE id = ?').run(g);
    expect(() => writeOverallSuggestions(db, { groupId: g, students: [] })).toThrow(/Load the results first/);
  });
});

describe('rebuildOverallSuggestion', () => {
  const write = () => writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.1.1': 'EX' }, impression: 'Good.', reviewer_flags_brief: ['Check Q2'] }] });

  test('rewrites the numbers with the stored impression, levels and flags; a used comment comes back revised', () => {
    write();
    db.prepare(`UPDATE feedback SET suggestion_state = 'used' WHERE id = ?`).run(latestTest(stu.u1).id);
    db.prepare('UPDATE quiz_responses SET is_correct = 1 WHERE attempt_id = ? AND question_id = ?').run(att.u1, q2);
    expect(quizResults(db, { groupId: g }).students[0].overall.stale).toBe(true);
    const resultBefore = latest(stu.u1);
    const s = rebuildOverallSuggestion(db, { groupId: g, studentId: stu.u1 });
    expect(s.overall).toMatchObject({ stale: false, impression: 'Good.', rubric_scores: { 'CSP.1.1': 'EX' }, suggestion_state: 'revised' });
    const fj = fjOf(latestTest(stu.u1));
    expect(fj.narrative_feedback.split('\n')[0]).toBe('Multiple choice: 2/2 (100%)');
    expect(fj.reviewer_flags_brief).toEqual(['Check Q2']);
    expect(latest(stu.u1)).toEqual(resultBefore);   // the result task is not touched
  });

  test('a template edit makes it stale too', () => {
    write();
    db.prepare(`UPDATE quiz_groups SET comment_template = '{impression}\nMCQ {mcq_percent}%' WHERE id = ?`).run(g);
    expect(quizResults(db, { groupId: g }).students[0].overall.stale).toBe(true);
    expect(fjOf(latestTest(stu.u1)).narrative_feedback).toMatch(/^Multiple choice/);
    rebuildOverallSuggestion(db, { groupId: g, studentId: stu.u1 });
    expect(fjOf(latestTest(stu.u1)).narrative_feedback).toBe('Good.\nMCQ 50%');
  });

  test('refused when the student is no longer ready, with no stale prompt', () => {
    write();
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Developing', comment: 'new' }] });
    expect(quizResults(db, { groupId: g }).students[0].overall.stale).toBe(false);
    expect(() => rebuildOverallSuggestion(db, { groupId: g, studentId: stu.u1 })).toThrow(/Not ready: Q21 to review/);
  });

  test('refused when there is no overall suggestion', () => {
    expect(() => rebuildOverallSuggestion(db, { groupId: g, studentId: stu.u1 })).toThrow(/no overall suggestion/i);
  });
});

describe('an edited overall comment', () => {
  // An edit replaces narrative_feedback and keeps quiz_overall. No page edits it since #122
  // retired /feedback, but the guard keeps any future edit from being overwritten.
  const editNarrative = (text) => {
    const row = latestTest(stu.u1);
    const fj = JSON.parse(row.feedback_json);
    db.prepare(`UPDATE feedback SET feedback_json = ?, status = 'teacher_modified' WHERE id = ?`).run(JSON.stringify({ ...fj, narrative_feedback: text }), row.id);
  };
  const write = () => writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.1.1': 'EX' }, impression: 'Good.' }] });

  test('the built comment is stored with the impression', () => {
    write();
    const fj = fjOf(latestTest(stu.u1));
    expect(fj.quiz_overall.built).toBe(fj.narrative_feedback);
  });

  test('an edit alone is not "numbers changed", and is reported as edited', () => {
    write();
    editNarrative('My own words.');
    expect(quizResults(db, { groupId: g }).students[0].overall).toMatchObject({ stale: false, edited: true });
  });

  test('after an edit, changed numbers are stale but Update numbers never overwrites the edit', () => {
    write();
    editNarrative('My own words.');
    db.prepare('UPDATE quiz_responses SET is_correct = 1 WHERE attempt_id = ? AND question_id = ?').run(att.u1, q2);
    expect(quizResults(db, { groupId: g }).students[0].overall).toMatchObject({ stale: true, edited: true });
    expect(() => rebuildOverallSuggestion(db, { groupId: g, studentId: stu.u1 })).toThrow(/edited/);
    expect(fjOf(latestTest(stu.u1)).narrative_feedback).toBe('My own words.');
  });

  test('a suggestion written before built was stored compares with its comment', () => {
    write();
    const row = latestTest(stu.u1);
    const fj = JSON.parse(row.feedback_json);
    delete fj.quiz_overall.built;
    db.prepare('UPDATE feedback SET feedback_json = ? WHERE id = ?').run(JSON.stringify(fj), row.id);
    expect(quizResults(db, { groupId: g }).students[0].overall).toMatchObject({ stale: false, edited: false });
  });
});

