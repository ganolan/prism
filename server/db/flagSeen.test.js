import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, backfillFlagSeenAt } from './index.js';
import { writeGrades } from '../services/taskGrades.js';

// #174: grades.flag_seen_at, when Prism first saw the pair's current flag (epoch seconds), kept by
// triggers so every writer of grades.exception agrees.
const T = 1760000000;
const nowSecs = () => Math.floor(Date.now() / 1000);

let db;
let ids;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('S1', 'CSP')`).run().lastInsertRowid;
  const ada = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'Ada', 'L')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, '801')`).run(ada, courseId);
  const task = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'A1', 'Task')`).run(courseId).lastInsertRowid;
  const task2 = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'A2', 'Task 2')`).run(courseId).lastInsertRowid;
  ids = { courseId, ada, task, task2 };
});

const seen = (assignmentId = ids.task) =>
  db.prepare('SELECT flag_seen_at FROM grades WHERE student_id = ? AND assignment_id = ?').get(ids.ada, assignmentId).flag_seen_at;
const insert = (cols, assignmentId = ids.task) => {
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
    .run(ids.ada, assignmentId, ...keys.map((k) => cols[k]));
};
const update = (cols) => {
  const keys = Object.keys(cols);
  db.prepare(`UPDATE grades SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE student_id = ? AND assignment_id = ?`)
    .run(...keys.map((k) => cols[k]), ids.ada, ids.task);
};

describe('grades.flag_seen_at', () => {
  test('an insert with a flag takes the record timestamp when given, else now', () => {
    insert({ exception: 6, submitted_at: T });
    expect(seen()).toBe(T);
    insert({ exception: 2 }, ids.task2);
    expect(Math.abs(seen(ids.task2) - nowSecs())).toBeLessThan(5);
  });

  test('an insert with no flag leaves it empty', () => {
    insert({ exception: 0, submitted_at: T });
    expect(seen()).toBeNull();
  });

  test('re-writing the same flag keeps the date', () => {
    insert({ exception: 6, submitted_at: T });
    update({ exception: 6, submitted_at: T + 500 });
    expect(seen()).toBe(T);
  });

  test('a different flag restarts the date', () => {
    insert({ exception: 6, submitted_at: T });
    update({ exception: 3, submitted_at: T + 900 });
    expect(seen()).toBe(T + 900);
    update({ exception: 5 });
    expect(Math.abs(seen() - nowSecs())).toBeLessThan(5);
  });

  test('a flag on a pair that had none starts the date', () => {
    insert({ exception: 0, submitted_at: T });
    update({ exception: 6, submitted_at: T + 60 });
    expect(seen()).toBe(T + 60);
  });

  test('clearing the flag clears the date', () => {
    insert({ exception: 6, submitted_at: T });
    update({ exception: 0 });
    expect(seen()).toBeNull();
  });

  test('a sync upsert (writeGrades) stamps the record timestamp, and a later read keeps it', () => {
    const read = (timestamp) => writeGrades(db, {
      courseId: ids.courseId, now: '2026-10-23T00:00:00Z',
      grades: [{ enrollment_id: '801', assignment_id: 'A1', exception: 6, timestamp: String(timestamp) }],
    });
    read(T);
    expect(seen()).toBe(T);
    read(T + 3600);
    expect(seen()).toBe(T);
  });
});

describe('backfillFlagSeenAt', () => {
  test('fills flagged rows from submitted_at, else now; leaves unflagged rows empty', () => {
    insert({ exception: 6, submitted_at: T });
    insert({ exception: 1, submitted_at: 0 }, ids.task2);
    db.exec('UPDATE grades SET flag_seen_at = NULL');
    const bo = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('702', 'Bo', 'K')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, exception, submitted_at) VALUES (?, ?, 0, ?)`).run(bo, ids.task, T);
    backfillFlagSeenAt(db);
    expect(seen()).toBe(T);
    expect(Math.abs(seen(ids.task2) - nowSecs())).toBeLessThan(5);
    expect(db.prepare('SELECT flag_seen_at FROM grades WHERE student_id = ?').get(bo).flag_seen_at).toBeNull();
  });

  test('never overwrites a stored date', () => {
    insert({ exception: 6, submitted_at: T });
    db.exec(`UPDATE grades SET flag_seen_at = ${T - 100}`);
    backfillFlagSeenAt(db);
    expect(seen()).toBe(T - 100);
  });
});
