import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, migrateMasteryRollupsPk, migrateResubmitFlags, purgeLegacyAutoFlags, purgeStudentScopedFlags } from './index.js';

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

describe('migrateResubmitFlags', () => {
  test('turns open resubmit_requested flags into open requests and removes the flags', () => {
    const db = new Database(':memory:');
    migrate(db);
    const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'C')`).run().lastInsertRowid;
    const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u', 'A', 'B')`).run().lastInsertRowid;
    const a = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'x', 'T')`).run(c).lastInsertRowid;
    db.prepare(`INSERT INTO flags (student_id, assignment_id, flag_type, created_at) VALUES (?, ?, 'resubmit_requested', '2026-06-02 04:50:08')`).run(s, a);
    db.prepare(`INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason) VALUES (?, ?, 'review_needed', 'why')`).run(s, a);

    migrateResubmitFlags(db);
    migrateResubmitFlags(db); // idempotent

    const reqs = db.prepare(`SELECT * FROM resubmissions`).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ student_id: s, assignment_id: a, course_id: c, kind: 'request', status: 'open', lessons: 3, source: 'app', requested_at: '2026-06-02 04:50:08' });
    expect(db.prepare(`SELECT flag_type FROM flags`).all()).toEqual([{ flag_type: 'review_needed' }]);
  });

  test('flags on an archived or excluded course migrate closed; current-course flags stay open (final review 5d)', () => {
    const db = new Database(':memory:');
    migrate(db);
    const course = (name, cols = '') => db.prepare(`INSERT INTO courses (schoology_section_id, course_name${cols ? ', ' + cols : ''}) VALUES (?, ?${cols ? ', 1' : ''})`).run(`s-${name}`, name).lastInsertRowid;
    const current = course('Now'); const archived = course('Old', 'archived'); const excluded = course('Tpl', 'excluded');
    const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u', 'A', 'B')`).run().lastInsertRowid;
    for (const c of [current, archived, excluded]) {
      const a = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, ?, 'T')`).run(c, `x-${c}`).lastInsertRowid;
      db.prepare(`INSERT INTO flags (student_id, assignment_id, flag_type, created_at) VALUES (?, ?, 'resubmit_requested', '2026-06-02 04:50:08')`).run(s, a);
    }

    migrateResubmitFlags(db);

    const byCourse = Object.fromEntries(db.prepare(`SELECT course_id, status, close_note, closed_at FROM resubmissions`).all().map((r) => [r.course_id, r]));
    expect(byCourse[current]).toMatchObject({ status: 'open', close_note: null, closed_at: null });
    for (const c of [archived, excluded]) {
      expect(byCourse[c]).toMatchObject({ status: 'closed', close_note: 'Migrated (archived course)' });
      expect(byCourse[c].closed_at).toBeTruthy();
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM flags`).get().n).toBe(0);
  });

  test('adds resubmissions.closes_request_id to an existing DB (final review finding 2)', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.exec('ALTER TABLE resubmissions DROP COLUMN closes_request_id');
    migrate(db);
    expect(db.prepare('PRAGMA table_info(resubmissions)').all().map((c) => c.name)).toContain('closes_request_id');
  });

  test('one open request per pair is enforced', () => {
    const db = new Database(':memory:');
    migrate(db);
    const ins = `INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons) VALUES (1, 1, 1, 'request', 'open', '2026-10-01 00:00:00', 3)`;
    db.pragma('foreign_keys = OFF');
    db.exec(ins);
    expect(() => db.exec(ins)).toThrow(/UNIQUE/);
  });
});

describe('migration: make-up tests + extension re-extend time', () => {
  test('adds assignments.is_test / test_fetch_status and extensions.updated_at to an existing DB', () => {
    const db = new Database(':memory:');
    migrate(db);
    // Simulate a DB created before these columns existed.
    db.exec(`
      ALTER TABLE assignments DROP COLUMN is_test;
      ALTER TABLE assignments DROP COLUMN test_fetch_status;
      ALTER TABLE assignments DROP COLUMN makeup_ignored;
      ALTER TABLE grades DROP COLUMN test_attempt;
      ALTER TABLE extensions DROP COLUMN updated_at;
    `);
    migrate(db);
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    expect(cols('assignments')).toEqual(expect.arrayContaining(['is_test', 'test_fetch_status', 'makeup_ignored']));
    db.prepare(`INSERT INTO courses (id, schoology_section_id, course_name) VALUES (1, 's', 'C')`).run();
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (1, 'a', 'T')`).run();
    expect(db.prepare('SELECT makeup_ignored FROM assignments').get().makeup_ignored).toBe(0); // tracked by default
    expect(cols('extensions')).toContain('updated_at');
    expect(cols('grades')).toContain('test_attempt');
  });
});

describe('migration: status_lines and feedback_snapshots tables (Amendment B)', () => {
  test('creates status_lines with the expected columns and composite PK', () => {
    const db = new Database(':memory:');
    migrate(db);
    const info = db.prepare('PRAGMA table_info(status_lines)').all();
    const byName = Object.fromEntries(info.map((c) => [c.name, c]));
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining(['student_id', 'assignment_id', 'line', 'kind', 'written_at'])
    );
    expect(byName.student_id.notnull).toBe(1);
    expect(byName.assignment_id.notnull).toBe(1);
    expect(byName.line.notnull).toBe(1);
    expect(byName.kind.notnull).toBe(1);
    // Composite primary key (student_id, assignment_id): both columns carry pk
    // ordinals 1 and 2 (order doesn't matter, but both must be part of the PK).
    expect(byName.student_id.pk).toBeGreaterThan(0);
    expect(byName.assignment_id.pk).toBeGreaterThan(0);
  });

  test('creates feedback_snapshots with the expected columns, defaults, and composite PK', () => {
    const db = new Database(':memory:');
    migrate(db);
    const info = db.prepare('PRAGMA table_info(feedback_snapshots)').all();
    const byName = Object.fromEntries(info.map((c) => [c.name, c]));
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining([
        'student_id', 'assignment_id', 'fingerprint', 'revision_at',
        'arrival_revision_at', 'arrival_baseline', 'updated_at',
      ])
    );
    expect(byName.student_id.notnull).toBe(1);
    expect(byName.assignment_id.notnull).toBe(1);
    expect(byName.fingerprint.notnull).toBe(1);
    expect(byName.revision_at.notnull).toBe(1);
    expect(byName.arrival_revision_at.notnull).toBe(1);
    expect(byName.student_id.pk).toBeGreaterThan(0);
    expect(byName.assignment_id.pk).toBeGreaterThan(0);

    // Defaults apply when omitted.
    db.exec(`INSERT INTO students (id, first_name, last_name) VALUES (1, 'A', 'B')`);
    db.exec(`INSERT INTO courses (id, schoology_section_id, course_name) VALUES (1, 's', 'C')`);
    db.exec(`INSERT INTO assignments (id, course_id, schoology_assignment_id, title) VALUES (1, 1, 'a', 'T')`);
    db.prepare(
      `INSERT INTO feedback_snapshots (student_id, assignment_id, fingerprint) VALUES (1, 1, 'fp')`
    ).run();
    const row = db.prepare('SELECT * FROM feedback_snapshots WHERE student_id = 1 AND assignment_id = 1').get();
    expect(row.revision_at).toBe(0);
    expect(row.arrival_revision_at).toBe(0);
    expect(row.arrival_baseline).toBeNull();
    expect(row.updated_at).toBeTruthy();
  });
});
