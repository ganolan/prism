import { describe, test, expect, beforeEach } from 'vitest';

import { getDb } from '../db/index.js';
import { gradeSummary, waitingCopies } from './savedGrades.js';

const GAS = {
  name: 'General Academic Scale (Unaligned)',
  levels: [
    { code: 'ED', label: 'Exhibiting Depth', points: 100, cutoff: 87.5 },
    { code: 'EX', label: 'Exhibiting', points: 75, cutoff: 62.5 },
    { code: 'D', label: 'Developing', points: 50, cutoff: 37.5 },
  ],
};

describe('gradeSummary: the words for a kept grade (#40)', () => {
  test('a score-scale overall reads as its level with the points', () => {
    expect(gradeSummary(GAS, { score: 75, max_points: 100, topics: {}, rows: {} })).toBe('Exhibiting (75)');
  });

  test('points with no scale read as score / max, then the topic levels', () => {
    expect(gradeSummary(null, { score: 87.5, max_points: 100, topics: { t1: 'ED', t2: 'EX' }, rows: {} }))
      .toBe('87.5 / 100 and 2 topic levels');
  });

  test('one topic level, no score', () => {
    expect(gradeSummary(null, { score: null, topics: { t1: 'ED' }, rows: {} })).toBe('1 topic level');
  });

  test('a scale level, rubric rows: three parts join with a comma and "and"', () => {
    expect(gradeSummary(GAS, { score: 50, topics: { t1: 'D' }, rows: { Code: 'D', Testing: 'EX' } }))
      .toBe('Developing (50), 1 topic level and 2 rubric row levels');
  });

  test('nothing graded: null', () => {
    expect(gradeSummary(GAS, { score: null, topics: {}, rows: {} })).toBeNull();
    expect(gradeSummary(null, null)).toBeNull();
  });
});

describe('waitingCopies', () => {
  let db, c, s, a;
  beforeEach(() => {
    db = getDb();
    db.exec(`DELETE FROM excused_grades; DELETE FROM mastery_alignments; DELETE FROM mastery_scores; DELETE FROM grades;
      DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;`);
    c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec', 'AP CSP')`).run().lastInsertRowid;
    s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
    a = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa', 'CP2')`).run(c).lastInsertRowid;
    db.prepare(`INSERT INTO excused_grades (student_id, assignment_id, flag, saved_json, saved_at) VALUES (?, ?, 1, ?, '2026-10-21 02:00:00')`)
      .run(s, a, JSON.stringify({ score: 90, max_points: 100, topics: {}, rows: {} }));
  });

  test('a waiting copy by "student:assignment", with its summary, flag and time', () => {
    const copies = waitingCopies(db, { courseId: c });
    expect(copies.get(`${s}:${a}`)).toMatchObject({ flag: 1, savedAt: '2026-10-21 02:00:00', summary: '90 / 100', saved: { score: 90 } });
    expect(waitingCopies(db, { studentId: s }).get(`${s}:${a}`).summary).toBe('90 / 100');
    expect(waitingCopies(db, { assignmentId: a }).size).toBe(1);
  });

  test('a restored copy is not waiting', () => {
    db.prepare(`UPDATE excused_grades SET restored_at = '2026-10-22 00:00:00'`).run();
    expect(waitingCopies(db, { courseId: c }).size).toBe(0);
  });
});
