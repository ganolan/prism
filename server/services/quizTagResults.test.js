import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { courseTagResults } from './quizTagResults.js';
import { groupStats } from './quizStats.js';
import { QuizError } from './quizError.js';

let db, course, other, g1, g2, students;
const OPTS = JSON.stringify(['A', 'B', 'C', 'D'].map(l => ({ letter: l, html: l, is_key: l === 'B' })));

function test_(courseId, sid, title, due) {
  return db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test, due_date) VALUES (?, ?, ?, 1, ?)`)
    .run(courseId, sid, title, due).lastInsertRowid;
}
function group(courseId, title, memberIds) {
  const g = db.prepare('INSERT INTO quiz_groups (course_id, title) VALUES (?, ?)').run(courseId, title).lastInsertRowid;
  for (const m of memberIds) db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)').run(g, m);
  return g;
}
function question(g, position, kind, tags) {
  return db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, options_json, max_points, tags_json) VALUES (?, ?, ?, 'Q', ?, 1, ?)`)
    .run(g, position, kind, kind === 'mcq' ? OPTS : null, JSON.stringify(tags)).lastInsertRowid;
}
// answers: { questionId: true (correct) | false (wrong) | null (blank) }
function attempt(g, assignmentId, studentId, answers, completedAt = '2026-10-01 09:00:00') {
  const a = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, completed_at, fetched_at) VALUES (?, ?, ?, ?, ?, 'now')`)
    .run(g, assignmentId, studentId, `att-${g}-${studentId}`, completedAt).lastInsertRowid;
  for (const [qid, ok] of Object.entries(answers)) {
    db.prepare('INSERT INTO quiz_responses (attempt_id, question_id, chosen_letter, is_correct, points, max_points) VALUES (?, ?, ?, ?, ?, 1)')
      .run(a, Number(qid), ok == null ? null : ok ? 'B' : 'C', ok ? 1 : 0, ok ? 1 : 0);
  }
}

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM quiz_tag_texts; DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  course = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'CSP')`).run().lastInsertRowid;
  other = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s2', 'Other')`).run().lastInsertRowid;
  students = ['Ana', 'Ben', 'Cy'].map((n, i) => {
    const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, 'Lee')`).run(`u${i}`, n).lastInsertRowid;
    db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(s, course);
    return s;
  });
  const [ana, ben, cy] = students;

  // Ep 2 (due later) and Ep 1, listed in the course out of date order.
  const t2 = test_(course, '920', 'Ep 2 Theory Test', '2026-10-10');
  g2 = group(course, 'Ep 2', [t2]);
  const t1 = test_(course, '910', 'Ep 1 Theory Test', '2026-09-20');
  const t1b = test_(course, '911', 'Ep 1 Theory Test *', '2026-09-22');
  g1 = group(course, 'Ep 1', [t1, t1b]);

  // Ep 1: Q1 and Q3 carry the tag; Q2 does not; the FRQ Q4 carries it too but is never counted.
  const e1q1 = question(g1, 1, 'mcq', ['CRD-2.G']);
  const e1q2 = question(g1, 2, 'mcq', ['AAP-1.A']);
  const e1q3 = question(g1, 3, 'mcq', ['CRD-2.G', 'AAP-1.A']);
  const e1q4 = question(g1, 4, 'frq', ['CRD-2.G']);
  attempt(g1, t1, ana, { [e1q1]: true, [e1q2]: true, [e1q3]: true, [e1q4]: null });
  attempt(g1, t1, ben, { [e1q1]: false, [e1q2]: true, [e1q3]: null, [e1q4]: null });
  attempt(g1, t1b, cy, { [e1q1]: true, [e1q2]: false, [e1q3]: false, [e1q4]: null }, '2026-09-23 10:00:00');

  // Ep 2: Q5 carries the tag. Cy did not sit it.
  const e2q5 = question(g2, 5, 'mcq', ['CRD-2.G']);
  attempt(g2, t2, ana, { [e2q5]: true });
  attempt(g2, t2, ben, { [e2q5]: false });

  // Another course with the same tag: never counted.
  const tx = test_(other, '990', 'Other test', '2026-09-01');
  const gx = group(other, 'Other', [tx]);
  const xq = question(gx, 1, 'mcq', ['CRD-2.G']);
  attempt(gx, tx, ana, { [xq]: false });

  db.prepare(`INSERT INTO quiz_tag_texts (course_id, tag, text) VALUES (?, 'CRD-2.G', 'Describe the purpose of a code segment.')`).run(course);
  db.prepare(`INSERT INTO quiz_tag_texts (course_id, tag, text) VALUES (?, 'CRD-2.G', 'Another course wording.')`).run(other);
});

describe('courseTagResults', () => {
  test('the tag, its text for this course, and the course total over MCQs only', () => {
    const r = courseTagResults(db, { courseId: course, tag: 'CRD-2.G' });
    expect(r).toMatchObject({ course_id: course, tag: 'CRD-2.G', text: 'Describe the purpose of a code segment.' });
    // Ep 1 Q1 2/3, Q3 1/3 (a blank counts as wrong), Ep 2 Q5 1/2. The FRQ and the other course are left out.
    expect(r.overall).toEqual({ correct: 4, total: 8, percent: 50 });
  });

  test('one row per quiz group with the tag, in date order, with its questions', () => {
    const r = courseTagResults(db, { courseId: course, tag: 'CRD-2.G' });
    expect(r.tests.map(t => t.title)).toEqual(['Ep 1', 'Ep 2']);
    expect(r.tests[0]).toEqual({
      group_id: g1, title: 'Ep 1', date: '2026-09-20', takers: 3, correct: 3, total: 6, percent: 50,
      questions: [{ position: 1, correct: 2, total: 3, percent: 67 }, { position: 3, correct: 1, total: 3, percent: 33 }],
    });
    expect(r.tests[1]).toMatchObject({ group_id: g2, date: '2026-10-10', takers: 2, correct: 1, total: 2, percent: 50 });
  });

  test("a test's numbers match the group view's tag row", () => {
    const r = courseTagResults(db, { courseId: course, tag: 'CRD-2.G' });
    const row = groupStats(db, { groupId: g1 }).byTag.find(t => t.tag === 'CRD-2.G');
    expect([r.tests[0].correct, r.tests[0].total, r.tests[0].percent]).toEqual([row.correct, row.total, row.percent]);
  });

  test('each student across the course, lowest first, with their result per test', () => {
    const [ana, ben, cy] = students;
    const r = courseTagResults(db, { courseId: course, tag: 'CRD-2.G' });
    expect(r.students).toEqual([
      { student_id: ben, name: 'Ben Lee', correct: 0, total: 3, percent: 0, tests: { [g1]: { correct: 0, total: 2 }, [g2]: { correct: 0, total: 1 } } },
      { student_id: cy, name: 'Cy Lee', correct: 1, total: 2, percent: 50, tests: { [g1]: { correct: 1, total: 2 } } },
      { student_id: ana, name: 'Ana Lee', correct: 3, total: 3, percent: 100, tests: { [g1]: { correct: 2, total: 2 }, [g2]: { correct: 1, total: 1 } } },
    ]);
  });

  test('a group with the tag but no results loaded shows with no percent', () => {
    const t3 = test_(course, '930', 'Ep 3 Theory Test', '2026-10-20');
    const g3 = group(course, 'Ep 3', [t3]);
    question(g3, 2, 'mcq', ['CRD-2.G']);
    const r = courseTagResults(db, { courseId: course, tag: 'CRD-2.G' });
    expect(r.tests.at(-1)).toEqual({ group_id: g3, title: 'Ep 3', date: '2026-10-20', takers: 0, correct: 0, total: 0, percent: null,
      questions: [{ position: 2, correct: 0, total: 0, percent: null }] });
    expect(r.overall).toEqual({ correct: 4, total: 8, percent: 50 });
  });

  test("the result task's due date dates a linked group", () => {
    const res = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test, due_date) VALUES (?, '925', 'Ep 2 Result', 0, '2026-10-12')`).run(course).lastInsertRowid;
    db.prepare('UPDATE quiz_groups SET result_assignment_id = ? WHERE id = ?').run(res, g2);
    expect(courseTagResults(db, { courseId: course, tag: 'CRD-2.G' }).tests[1].date).toBe('2026-10-12');
  });

  test('with no due dates, the first completed attempt dates the group', () => {
    db.prepare('UPDATE assignments SET due_date = NULL').run();
    const r = courseTagResults(db, { courseId: course, tag: 'CRD-2.G' });
    expect(r.tests.map(t => t.date)).toEqual(['2026-09-23 10:00:00', '2026-10-01 09:00:00']);
  });

  test('a tag no question carries returns empty lists; the tag is matched after trimming', () => {
    expect(courseTagResults(db, { courseId: course, tag: 'NOPE-1.A' })).toMatchObject({ tests: [], students: [], overall: { correct: 0, total: 0, percent: null }, text: null });
    expect(courseTagResults(db, { courseId: course, tag: '  CRD-2.G ' }).tests).toHaveLength(2);
  });

  test('every tag in the course comes back for switching, most questions first', () => {
    expect(courseTagResults(db, { courseId: course, tag: 'CRD-2.G' }).courseTags).toEqual(['CRD-2.G', 'AAP-1.A']);
  });

  test('a missing tag or course is refused', () => {
    expect(() => courseTagResults(db, { courseId: course, tag: ' ' })).toThrow(QuizError);
    expect(() => courseTagResults(db, { courseId: null, tag: 'X' })).toThrow(QuizError);
    expect(() => courseTagResults(db, { courseId: 99999, tag: 'X' })).toThrow(/No course/);
  });
});
