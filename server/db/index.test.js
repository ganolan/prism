import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, migrateMasteryRollupsPk, purgeLegacyAutoFlags, purgeStudentScopedFlags } from './index.js';

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

  test('deletes performance_change flags', () => {
    purgeLegacyAutoFlags(db);
    expect(flagTypes(db)).not.toContain('performance_change');
  });

  test('preserves custom and review_needed flags', () => {
    purgeLegacyAutoFlags(db);
    // purgeLegacyAutoFlags alone keeps these; via migrate() all NULL-assignment flags are also purged
    expect(flagTypes(db)).toEqual(['custom', 'review_needed']);
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

describe('migration: courses.finalized_at (#70)', () => {
  test('adds a finalized_at column to courses', () => {
    const db = new Database(':memory:');
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(courses)').all().map((c) => c.name);
    expect(cols).toContain('finalized_at');
  });
});

describe('migrateMasteryRollupsPk (rollups keyed per course)', () => {
  // The pre-fix schema: a student's rollup is keyed (student_uid, objective_id)
  // only, so a district objective UUID shared across courses collapses to a
  // single row — blanking the proficiency display on a multi-course student's
  // other course pages. These tests pin the rebuilt key.
  const OLD_SHAPE = `
    CREATE TABLE mastery_rollups (
      student_uid TEXT NOT NULL,
      objective_id TEXT NOT NULL,
      course_id INTEGER,
      is_category INTEGER NOT NULL DEFAULT 0,
      grade_percentage REAL,
      grade_scaled_rounded REAL,
      override_value REAL,
      synced_at TEXT,
      PRIMARY KEY (student_uid, objective_id)
    )`;

  function pkCols(db) {
    return db.prepare(`SELECT name FROM pragma_table_info('mastery_rollups') WHERE pk > 0 ORDER BY pk`)
      .all().map(r => r.name);
  }
  function insertRollup(db, uid, obj, course, pct) {
    db.prepare(`INSERT INTO mastery_rollups
      (student_uid, objective_id, course_id, is_category, grade_percentage)
      VALUES (?, ?, ?, 1, ?)`).run(uid, obj, course, pct);
  }

  test('rebuilds the old (student_uid, objective_id) key to include course_id', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SHAPE);
    expect(pkCols(db)).toEqual(['student_uid', 'objective_id']);

    migrateMasteryRollupsPk(db);

    expect(pkCols(db)).toEqual(['student_uid', 'objective_id', 'course_id']);
  });

  test('a multi-course student keeps one rollup PER course for a shared objective', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SHAPE);
    // The rebuilt table FKs course_id -> courses(id), and better-sqlite3 enforces
    // foreign keys by default, so the parent rows must exist for the insert below.
    db.exec(`CREATE TABLE courses (id INTEGER PRIMARY KEY)`);
    db.exec(`INSERT INTO courses (id) VALUES (7), (9)`);
    insertRollup(db, 'stuA', 'objX', 7, 87.5); // last-synced course before fix
    migrateMasteryRollupsPk(db);

    // The same objective in a second course must now coexist, not overwrite.
    insertRollup(db, 'stuA', 'objX', 9, 62.5);

    const rows = db.prepare(
      `SELECT course_id, grade_percentage FROM mastery_rollups
       WHERE student_uid='stuA' AND objective_id='objX' ORDER BY course_id`
    ).all();
    expect(rows).toEqual([
      { course_id: 7, grade_percentage: 87.5 },
      { course_id: 9, grade_percentage: 62.5 },
    ]);
  });

  test('preserves existing rows through the rebuild', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SHAPE);
    insertRollup(db, 'stuA', 'objX', 7, 87.5);
    insertRollup(db, 'stuB', 'objY', 9, 37.5);

    migrateMasteryRollupsPk(db);

    expect(db.prepare('SELECT COUNT(*) AS c FROM mastery_rollups').get().c).toBe(2);
    expect(db.prepare(
      `SELECT grade_percentage FROM mastery_rollups WHERE student_uid='stuB'`
    ).get().grade_percentage).toBe(37.5);
  });

  test('is idempotent — a second run is a no-op and loses no data', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SHAPE);
    insertRollup(db, 'stuA', 'objX', 7, 87.5);

    migrateMasteryRollupsPk(db);
    migrateMasteryRollupsPk(db); // simulates the next server boot

    expect(pkCols(db)).toEqual(['student_uid', 'objective_id', 'course_id']);
    expect(db.prepare('SELECT COUNT(*) AS c FROM mastery_rollups').get().c).toBe(1);
  });

  test('a fresh migrate() yields the per-course key directly', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(pkCols(db)).toEqual(['student_uid', 'objective_id', 'course_id']);
  });

  test('runs as part of migrate() on an old-shape DB', () => {
    const db = new Database(':memory:');
    // Build the full schema, then clobber mastery_rollups back to the old shape
    // to simulate a database created before the fix.
    migrate(db);
    db.exec('DROP TABLE mastery_rollups');
    db.exec(OLD_SHAPE);

    migrate(db); // next boot must repair the key

    expect(pkCols(db)).toEqual(['student_uid', 'objective_id', 'course_id']);
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

  test('preserves submission-scoped flags across a migrate() reboot', () => {
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
    migrate(db); // simulate reboot
    expect(db.prepare('SELECT COUNT(*) AS c FROM flags').get().c).toBe(1);
  });
});
