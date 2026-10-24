import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../server/db/index.js';
import { removeCourse } from './remove-course.js';

let db;
let gone;
let kept;
const count = (sql, ...p) => db.prepare(sql).get(...p).n;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  const course = (sid) => db.prepare('INSERT INTO courses (schoology_section_id, course_name) VALUES (?, ?)').run(sid, sid).lastInsertRowid;
  const student = (uid) => db.prepare("INSERT INTO students (first_name, last_name, schoology_uid) VALUES ('F', 'L', ?)").run(uid).lastInsertRowid;
  const enrol = (s, c) => db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(s, c);
  gone = course('member-section');
  kept = course('own-section');
  const onlyHere = student('u-only');
  const both = student('u-both');
  enrol(onlyHere, gone);
  enrol(both, gone);
  enrol(both, kept);
  const taskGone = db.prepare("INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 't1', 'T1')").run(gone).lastInsertRowid;
  const taskKept = db.prepare("INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 't2', 'T2')").run(kept).lastInsertRowid;
  for (const [s, a] of [[onlyHere, taskGone], [both, taskGone], [both, taskKept]]) {
    db.prepare('INSERT INTO grades (student_id, assignment_id, score) VALUES (?, ?, 1)').run(s, a);
  }
  db.prepare("INSERT INTO parents (student_id, first_name, last_name) VALUES (?, 'P', 'L')").run(onlyHere);
  db.prepare("INSERT INTO measurement_topics (id, course_id, title) VALUES ('x', ?, 'Shared topic')").run(gone);
  db.prepare("INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points) VALUES ('u-both', 't1', 'x', 1)").run();
  db.prepare("INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points) VALUES ('u-both', 't2', 'x', 1)").run();
  db.prepare("INSERT INTO mastery_rollups (student_uid, course_id, objective_id, is_category, grade_percentage) VALUES ('u-both', ?, 'c', 1, 50)").run(kept);
  db.prepare("INSERT INTO mastery_rollups (student_uid, course_id, objective_id, is_category, grade_percentage) VALUES ('u-both', ?, 'c', 1, 50)").run(gone);
});

describe('removeCourse', () => {
  test('a dry run counts and changes nothing', () => {
    const r = removeCourse(db, gone);
    expect(r).toMatchObject({ tasks: 1, studentsRemoved: 1 });
    expect(r.counts).toEqual(expect.arrayContaining([
      { table: 'grades', rows: 2 }, { table: 'enrolments', rows: 2 }, { table: 'students', rows: 1 },
      { table: 'parents', rows: 1 }, { table: 'courses', rows: 1 }, { table: 'mastery_rollups', rows: 1 },
    ]));
    expect(count('SELECT COUNT(*) AS n FROM courses')).toBe(2);
  });

  test('apply removes the course, its tasks and rows, and students with no other course; others keep theirs', () => {
    removeCourse(db, gone, { apply: true });
    expect(count('SELECT COUNT(*) AS n FROM courses WHERE id = ?', gone)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM assignments')).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM students WHERE schoology_uid = 'u-only'")).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM parents')).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM students WHERE schoology_uid = 'u-both'")).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM grades')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM enrolments')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM mastery_rollups WHERE course_id = ?', kept)).toBe(1);
    expect(db.prepare('SELECT assignment_schoology_id AS t FROM mastery_scores').all()).toEqual([{ t: 't2' }]);
    // the district-wide topic another course's score uses stays, unowned
    expect(db.prepare("SELECT course_id FROM measurement_topics WHERE id = 'x'").get()).toEqual({ course_id: null });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('an unknown course is refused', () => {
    expect(() => removeCourse(db, 999)).toThrow(/no course 999/);
  });
});
