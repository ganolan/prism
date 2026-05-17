import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, purgeLegacyAutoFlags, purgeStudentScopedFlags } from './index.js';

function seedFlag(db, studentId, flagType) {
  db.prepare(
    `INSERT INTO flags (student_id, flag_type, flag_reason) VALUES (?, ?, ?)`
  ).run(studentId, flagType, `${flagType} reason`);
}

function flagTypes(db) {
  return db.prepare('SELECT flag_type FROM flags ORDER BY flag_type').all().map(r => r.flag_type);
}

function newStudent(db) {
  return db.prepare(
    `INSERT INTO students (first_name, last_name) VALUES ('Test', 'Student')`
  ).run().lastInsertRowid;
}

describe('purgeLegacyAutoFlags', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    const studentId = newStudent(db);
    for (const t of ['missing', 'late_submission', 'custom', 'review_needed', 'performance_change']) {
      seedFlag(db, studentId, t);
    }
  });

  test('deletes missing flags', () => {
    purgeLegacyAutoFlags(db);
    expect(flagTypes(db)).not.toContain('missing');
  });

  test('deletes late_submission flags', () => {
    purgeLegacyAutoFlags(db);
    expect(flagTypes(db)).not.toContain('late_submission');
  });

  test('preserves custom, review_needed, and performance_change flags', () => {
    purgeLegacyAutoFlags(db);
    expect(flagTypes(db)).toEqual(['custom', 'performance_change', 'review_needed']);
  });

  test('is idempotent', () => {
    purgeLegacyAutoFlags(db);
    const afterFirst = flagTypes(db);
    purgeLegacyAutoFlags(db);
    expect(flagTypes(db)).toEqual(afterFirst);
  });
});

describe('migrate', () => {
  test('purges legacy auto-flags so they do not survive a server reboot', () => {
    const db = new Database(':memory:');
    migrate(db);
    const studentId = newStudent(db);
    seedFlag(db, studentId, 'missing');
    seedFlag(db, studentId, 'custom');
    // A second migrate() simulates the next server boot calling getDb().
    // Both flags have assignment_id = NULL, so both are purged (purgeLegacyAutoFlags
    // removes 'missing'; purgeStudentScopedFlags removes all remaining NULL-scoped flags).
    migrate(db);
    expect(flagTypes(db)).toEqual([]);
  });
});

describe('purgeStudentScopedFlags', () => {
  let db;
  let studentId;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    studentId = newStudent(db);
  });

  test('deletes flags with no assignment_id', () => {
    seedFlag(db, studentId, 'custom');
    seedFlag(db, studentId, 'review_needed');
    purgeStudentScopedFlags(db);
    expect(db.prepare('SELECT COUNT(*) AS c FROM flags').get().c).toBe(0);
  });

  test('keeps submission-scoped flags (assignment_id set)', () => {
    const courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sc-1', 'Math')`
    ).run().lastInsertRowid;
    const assignmentId = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'HW1')`
    ).run(courseId).lastInsertRowid;
    db.prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
       VALUES (?, ?, 'review_needed', 'recheck')`
    ).run(studentId, assignmentId);
    purgeStudentScopedFlags(db);
    expect(db.prepare('SELECT COUNT(*) AS c FROM flags').get().c).toBe(1);
  });

  test('runs as part of migrate() and is idempotent', () => {
    seedFlag(db, studentId, 'custom');
    migrate(db);
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS c FROM flags').get().c).toBe(0);
  });
});
