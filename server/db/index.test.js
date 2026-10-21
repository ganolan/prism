import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { backfillArchivedSyncedAt, migrate, migrateMasteryRollupsPk, migrateResubmitFlags, purgeEmptyMasteryScores, purgeLegacyAutoFlags, purgeStudentScopedFlags } from './index.js';

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

describe('purgeEmptyMasteryScores', () => {
  test('deletes score rows with no level and keeps real ones', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO measurement_topics (id, title) VALUES ('t1', 'A'), ('t2', 'B')`).run();
    const ins = db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES (?, '900', ?, ?, ?)`);
    ins.run('701', 't1', null, null);
    ins.run('701', 't2', 75, 'Exhibiting');
    purgeEmptyMasteryScores(db);
    expect(db.prepare('SELECT topic_id FROM mastery_scores').all()).toEqual([{ topic_id: 't2' }]);
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

// #171: archived courses read in full before the import stamped its Synced time get it from
// finalized_at; a course whose read is not known to be complete keeps none. migrate() runs it on
// each boot.
describe('backfillArchivedSyncedAt: archived courses get course_synced_at from finalized_at (#171)', () => {
  const F = '2026-06-18T03:02:00.000Z';
  const LATER = '2026-06-18T03:09:00.000Z';
  const EARLIER = '2026-05-01T00:00:00.000Z';
  function seed(db, sectionId, over = {}) {
    const row = { course_code: 'BIO', archived: 1, excluded: 0, finalized_at: F, submissions_read_at: F, mastery_synced_at: LATER,
      course_synced_at: null, sync_attempted_at: null, ...over };
    const cols = Object.keys(row);
    return db.prepare(`INSERT INTO courses (schoology_section_id, course_name, ${cols.join(', ')})
      VALUES (?, ?, ${cols.map(() => '?').join(', ')})`).run(sectionId, sectionId, ...Object.values(row)).lastInsertRowid;
  }
  const synced = (db, id) => db.prepare('SELECT course_synced_at FROM courses WHERE id = ?').get(id).course_synced_at;
  function task(db, courseId, over = {}) {
    const row = { accepts_submissions: 1, is_test: 0, submissions_read_at: F, removed_at: null, ...over };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, ${cols.join(', ')})
      VALUES (?, ?, 'T', ${cols.map(() => '?').join(', ')})`).run(courseId, `a-${Math.random()}`, ...Object.values(row));
  }

  test('a fully read archived course is stamped at its finalized_at, and a second boot changes nothing', () => {
    const db = new Database(':memory:');
    migrate(db);
    const id = seed(db, 'full');
    task(db, id);
    task(db, id, { accepts_submissions: 0, is_test: 0, submissions_read_at: null }); // no submission channel
    task(db, id, { submissions_read_at: null, removed_at: F }); // deleted in Schoology
    migrate(db); // the next boot
    expect(synced(db, id)).toBe(F);
    db.prepare('UPDATE courses SET finalized_at = ? WHERE id = ?').run(LATER, id);
    backfillArchivedSyncedAt(db);
    expect(synced(db, id)).toBe(F);
  });

  test.each([
    ['current course', { archived: 0 }],
    ['excluded section', { excluded: 1 }],
    ['never finalized', { finalized_at: null }],
    ['submissions never read with a session', { submissions_read_at: null }],
    ['mastery not read at or after finalizing', { mastery_synced_at: EARLIER }],
    ['mastery never read', { mastery_synced_at: null }],
    ['already stamped', { course_synced_at: LATER }],
    ['already attempted by a stamping sync or import', { sync_attempted_at: LATER }],
  ])('%s: left as it is', (_, over) => {
    const db = new Database(':memory:');
    migrate(db);
    const id = seed(db, 'x', over);
    backfillArchivedSyncedAt(db);
    expect(synced(db, id)).toBe(over.course_synced_at ?? null);
  });

  test.each([
    ['a dropbox task', { accepts_submissions: 1 }],
    ['a test', { accepts_submissions: 0, is_test: 1 }],
  ])('%s never read in full: left unstamped', (_, over) => {
    const db = new Database(':memory:');
    migrate(db);
    const id = seed(db, 'x');
    task(db, id, { ...over, submissions_read_at: null });
    backfillArchivedSyncedAt(db);
    expect(synced(db, id)).toBeNull();
  });

  test('a failure is logged and the boot goes on (the later backfills still run)', () => {
    const db = new Database(':memory:');
    migrate(db);
    const id = seed(db, 'x');
    db.exec(`CREATE TRIGGER no_stamp BEFORE UPDATE OF course_synced_at ON courses
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
    const studentId = newStudent(db);
    const assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'a-x', 'T')`)
      .run(id).lastInsertRowid;
    db.prepare('INSERT INTO grades (student_id, assignment_id, latest_revision_at, first_submitted_at) VALUES (?, ?, 500, 0)')
      .run(studentId, assignmentId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => migrate(db)).not.toThrow();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Synced times'), 'disk I/O error');
    } finally {
      error.mockRestore();
    }
    expect(synced(db, id)).toBeNull();
    expect(db.prepare('SELECT first_submitted_at FROM grades').get().first_submitted_at).toBe(500);
  });
});

describe('migration: feedback_snapshots.arrival_write_at (residual review R2)', () => {
  test('a dev DB whose feedback_snapshots predates the column gains it (default 0)', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE feedback_snapshots (student_id INTEGER NOT NULL, assignment_id INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      revision_at INTEGER NOT NULL DEFAULT 0, arrival_revision_at INTEGER NOT NULL DEFAULT 0, arrival_baseline TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (student_id, assignment_id))`);
    db.prepare(`INSERT INTO feedback_snapshots (student_id, assignment_id, fingerprint) VALUES (1, 2, '{}')`).run();
    migrate(db);
    expect(db.prepare('SELECT arrival_write_at, fingerprint_at FROM feedback_snapshots').get()).toEqual({ arrival_write_at: 0, fingerprint_at: 0 });
  });
});

describe('migration: guardian slots and the correspondence code (#66)', () => {
  test('an existing database gains correspondence and guardians_synced_at', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE student_powerschool (student_id INTEGER PRIMARY KEY, alerts_synced_at TEXT, dnc_g1 TEXT, dnc_g2 TEXT,
      g1_deceased TEXT, g2_deceased TEXT)`);
    db.prepare(`INSERT INTO student_powerschool (student_id, dnc_g1) VALUES (1, '1')`).run();
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(student_powerschool)').all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['correspondence', 'guardians_synced_at']));
    expect(db.prepare('SELECT dnc_g1, correspondence, guardians_synced_at FROM student_powerschool').get())
      .toEqual({ dnc_g1: '1', correspondence: null, guardians_synced_at: null });
    expect(db.prepare('PRAGMA table_info(student_ps_guardians)').all().map((c) => c.name)).toEqual(['student_id', 'slot', 'name', 'email', 'phone']);
  });
});

describe('migration: guardian phones and the extra email (#173)', () => {
  test('an existing database gains student_ps_guardians.phone and parents.extra_email', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE parents (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, schoology_uid TEXT,
      first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, phone TEXT, relationship TEXT, UNIQUE(student_id, schoology_uid))`);
    db.exec(`CREATE TABLE student_ps_guardians (student_id INTEGER NOT NULL, slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
      name TEXT, email TEXT, PRIMARY KEY (student_id, slot))`);
    db.prepare(`INSERT INTO parents (student_id, first_name, last_name, phone) VALUES (1, 'Robin', 'Sample', '5550 0100')`).run();
    db.prepare(`INSERT INTO student_ps_guardians (student_id, slot, name) VALUES (1, 1, 'Sample, Robin')`).run();
    migrate(db);
    expect(db.prepare('SELECT phone, extra_email FROM parents').get()).toEqual({ phone: '5550 0100', extra_email: null });
    expect(db.prepare('SELECT name, phone FROM student_ps_guardians').get()).toEqual({ name: 'Sample, Robin', phone: null });
  });

  test('a fresh DB has both columns from schema.sql', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf-8'));
    expect(db.prepare('PRAGMA table_info(parents)').all().map((c) => c.name)).toContain('extra_email');
    expect(db.prepare('PRAGMA table_info(student_ps_guardians)').all().map((c) => c.name)).toContain('phone');
  });
});

describe('migration: the feedback inbox log is dropped (#122)', () => {
  test('an existing database loses inbox_log', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE inbox_log (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, status TEXT NOT NULL)`);
    db.prepare(`INSERT INTO inbox_log (filename, status) VALUES ('a.json', 'success')`).run();
    migrate(db);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'inbox_log'`).get()).toBeUndefined();
  });
});

describe('migration: sync_metrics per-phase timing (#143)', () => {
  test('a DB whose sync_metrics predates the timing columns gains them (NULL on old rows)', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sync_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, sync_log_id INTEGER, started_at TEXT NOT NULL,
      duration_ms INTEGER, submission_calls INTEGER DEFAULT 0, failed_assignment_ids TEXT)`);
    db.prepare(`INSERT INTO sync_metrics (started_at, duration_ms) VALUES ('2026-10-01T00:00:00Z', 1000)`).run();
    migrate(db);
    expect(db.prepare('SELECT schoology_ms, blocks_ms, mastery_ms, quizzes_ms, total_ms FROM sync_metrics').get())
      .toEqual({ schoology_ms: null, blocks_ms: null, mastery_ms: null, quizzes_ms: null, total_ms: null });
  });

  test('a fresh DB has the timing columns from schema.sql', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf-8'));
    const cols = db.prepare('PRAGMA table_info(sync_metrics)').all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['schoology_ms', 'blocks_ms', 'mastery_ms', 'quizzes_ms', 'total_ms']));
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

  test('resubmissions has no closes_request_id (Reviewed removed, Amendment B)', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(db.prepare('PRAGMA table_info(resubmissions)').all().map((c) => c.name)).not.toContain('closes_request_id');
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
        'arrival_revision_at', 'arrival_baseline', 'updated_at', 'synced_fingerprint', 'fingerprint_at',
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
    expect(row.synced_fingerprint).toBeNull();
    expect(row.fingerprint_at).toBe(0);
    expect(byName.fingerprint_at.notnull).toBe(1);
  });

  test('adds synced_fingerprint / fingerprint_at to a dev DB created before fix round 1', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.exec('ALTER TABLE feedback_snapshots DROP COLUMN synced_fingerprint; ALTER TABLE feedback_snapshots DROP COLUMN fingerprint_at;');
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(feedback_snapshots)').all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['synced_fingerprint', 'fingerprint_at']));
  });

  test('status_lines carries source_type / source_id, added to a dev DB that lacks them', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.exec('ALTER TABLE status_lines DROP COLUMN source_type; ALTER TABLE status_lines DROP COLUMN source_id;');
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(status_lines)').all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['source_type', 'source_id']));
  });
});
