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

let db, c, g, result, q1, q2, q21, att, stu;
const respond = (a, q, fields) => db.prepare(`INSERT INTO quiz_responses (attempt_id, question_id, chosen_letter, is_correct, points, answer_html, schoology_rubric_cells_json, schoology_comment)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(a, q, fields.letter ?? null, fields.correct ?? null, fields.points ?? null, fields.answer ?? null,
  fields.cells ? JSON.stringify(fields.cells) : null, fields.comment ?? null);

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM context_serves; DELETE FROM feedback; DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
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

const latest = (studentId) => db.prepare(`SELECT * FROM feedback WHERE student_id = ? AND assignment_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`).get(studentId, result);

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
    const fj = JSON.parse(latest(stu.u1).feedback_json);
    expect(fj.narrative_feedback).toBe('Multiple choice: 1/2 (50%)\nFree response: Q21 Exhibiting\nA secure start on variables.\nOpen your attempt on the test to read the feedback on each free-response question.');
    expect(fj.rubric_scores).toEqual({ 'CSP.1.1': 'EX' });
    expect(fj.quiz_overall).toEqual({ group_id: g, impression: 'A secure start on variables.', built: fj.narrative_feedback });
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

  test('requires an impression', () => {
    const r = writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: {}, impression: '  ' }] });
    expect(r.results[0]).toMatchObject({ status: 'error', message: 'impression is required' });
  });

  test('passes on an unresolved topic and a numeric level as written-with-notes', () => {
    const r = writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.9.9': 'EX', 'CSP.1.1': '3' }, impression: 'Good.' }] });
    expect(r.results[0]).toMatchObject({ status: 'written', unresolved_topics: ['CSP.9.9'], message: expect.stringMatching(/numeric/) });
  });

  test('refuses the whole call for an unlinked or never-loaded group', () => {
    db.prepare('UPDATE quiz_groups SET loaded_at = NULL WHERE id = ?').run(g);
    expect(() => writeOverallSuggestions(db, { groupId: g, students: [] })).toThrow(/Load the results first/);
    db.prepare(`UPDATE quiz_groups SET loaded_at = 'x', result_assignment_id = NULL WHERE id = ?`).run(g);
    expect(() => writeOverallSuggestions(db, { groupId: g, students: [] })).toThrow(/Link this quiz group to its result task first/);
  });
});

describe('rebuildOverallSuggestion', () => {
  const write = () => writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.1.1': 'EX' }, impression: 'Good.', reviewer_flags_brief: ['Check Q2'] }] });

  test('rewrites the numbers with the stored impression, levels and flags; a used comment comes back revised', () => {
    write();
    db.prepare(`UPDATE feedback SET suggestion_state = 'used' WHERE id = ?`).run(latest(stu.u1).id);
    db.prepare('UPDATE quiz_responses SET is_correct = 1 WHERE attempt_id = ? AND question_id = ?').run(att.u1, q2);
    expect(quizResults(db, { groupId: g }).students[0].overall.stale).toBe(true);
    const s = rebuildOverallSuggestion(db, { groupId: g, studentId: stu.u1 });
    expect(s.overall).toMatchObject({ stale: false, impression: 'Good.', rubric_scores: { 'CSP.1.1': 'EX' }, suggestion_state: 'revised' });
    const fj = JSON.parse(latest(stu.u1).feedback_json);
    expect(fj.narrative_feedback.split('\n')[0]).toBe('Multiple choice: 2/2 (100%)');
    expect(fj.reviewer_flags_brief).toEqual(['Check Q2']);
  });

  test('a template edit makes it stale too', () => {
    write();
    db.prepare(`UPDATE quiz_groups SET comment_template = '{impression}\nMCQ {mcq_percent}%' WHERE id = ?`).run(g);
    expect(quizResults(db, { groupId: g }).students[0].overall.stale).toBe(true);
    expect(JSON.parse(latest(stu.u1).feedback_json).narrative_feedback).toMatch(/^Multiple choice/);
    rebuildOverallSuggestion(db, { groupId: g, studentId: stu.u1 });
    expect(JSON.parse(latest(stu.u1).feedback_json).narrative_feedback).toBe('Good.\nMCQ 50%');
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

describe('a teacher edit on the Feedback page', () => {
  // FeedbackPage saves { ...feedback_json, narrative_feedback } and keeps quiz_overall.
  const editNarrative = (text) => {
    const row = latest(stu.u1);
    const fj = JSON.parse(row.feedback_json);
    db.prepare(`UPDATE feedback SET feedback_json = ?, status = 'teacher_modified' WHERE id = ?`).run(JSON.stringify({ ...fj, narrative_feedback: text }), row.id);
  };
  const write = () => writeOverallSuggestions(db, { groupId: g, students: [{ student: 'u1', rubric_scores: { 'CSP.1.1': 'EX' }, impression: 'Good.' }] });

  test('the built comment is stored with the impression', () => {
    write();
    const fj = JSON.parse(latest(stu.u1).feedback_json);
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
    expect(JSON.parse(latest(stu.u1).feedback_json).narrative_feedback).toBe('My own words.');
  });

  test('a suggestion written before built was stored compares with its comment', () => {
    write();
    const row = latest(stu.u1);
    const fj = JSON.parse(row.feedback_json);
    delete fj.quiz_overall.built;
    db.prepare('UPDATE feedback SET feedback_json = ? WHERE id = ?').run(JSON.stringify(fj), row.id);
    expect(quizResults(db, { groupId: g }).students[0].overall).toMatchObject({ stale: false, edited: false });
  });
});

