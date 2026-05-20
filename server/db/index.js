import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'students.db');

let db;

// Incremental migrations — each runs on every boot; duplicate-column errors
// are silently ignored so already-migrated databases are left untouched.
const MIGRATIONS = [
  `ALTER TABLE students ADD COLUMN nickname TEXT`,
  `ALTER TABLE students ADD COLUMN picture_url TEXT`,
  `ALTER TABLE parents ADD COLUMN phone TEXT`,
  `ALTER TABLE courses ADD COLUMN course_code TEXT`,
  `ALTER TABLE courses ADD COLUMN section_school_code TEXT`,
  `ALTER TABLE courses ADD COLUMN hidden INTEGER DEFAULT 0`,
  `ALTER TABLE students RENAME COLUMN nickname TO preferred_name_teacher`,
  `ALTER TABLE courses ADD COLUMN block_number TEXT`,
  `ALTER TABLE assignments ADD COLUMN mastery_grading_period_id TEXT`,
  `ALTER TABLE assignments ADD COLUMN mastery_grading_category_id TEXT`,
  // Issue #13 additions
  `ALTER TABLE assignments ADD COLUMN grading_category_id TEXT`,
  `ALTER TABLE assignments ADD COLUMN grading_scale_id TEXT`,
  `ALTER TABLE assignments ADD COLUMN folder_id TEXT`,
  `ALTER TABLE assignments ADD COLUMN count_in_grade INTEGER DEFAULT 1`,
  `ALTER TABLE students ADD COLUMN grad_year INTEGER`,
  `ALTER TABLE students ADD COLUMN school_uid TEXT`,
  `ALTER TABLE grades ADD COLUMN late INTEGER DEFAULT 0`,
  `ALTER TABLE grades ADD COLUMN draft INTEGER DEFAULT 0`,
  `ALTER TABLE assignments ADD COLUMN published INTEGER DEFAULT 1`,
  `ALTER TABLE assignments ADD COLUMN display_weight INTEGER DEFAULT 0`,
  // Issue #13 follow-up: distinguish submitted-awaiting-grade from
  // never-opened on OneDrive/GDrive assignments. grade.timestamp is
  // non-zero in Schoology only after a submission/grade-entry event.
  `ALTER TABLE grades ADD COLUMN submitted_at INTEGER DEFAULT 0`,
  // Issue #49: latest non-draft submission revision time, for resubmission
  // auto-detect. Compared against submitted_at (the submission/grade-entry
  // time) at read time.
  `ALTER TABLE grades ADD COLUMN latest_revision_at INTEGER DEFAULT 0`,
  // Issue #54: per-assignment individually-assigned targeting.
  `ALTER TABLE assignments ADD COLUMN num_assignees INTEGER`,
  // Issue #56: courses we never want to sync (e.g., template sections like
  // "MASTER Art, Design & Technology" that carry assignments but zero real
  // enrolments). Auto-detected by the absence of course_code AND
  // section_school_code. Distinct from `hidden` — the user-facing toggle to
  // 'Include hidden courses' must NEVER re-include excluded rows.
  `ALTER TABLE courses ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0`,
  // Indexes for issue #13 columns (must run after ALTER TABLEs above)
  `CREATE INDEX IF NOT EXISTS idx_assignments_folder ON assignments(folder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_assignments_grading_category ON assignments(grading_category_id)`,
];

// Remove orphaned auto-flag rows. The auto-flag feature that wrote 'missing',
// 'late_submission', and 'performance_change' rows into the flags table was
// dropped in commit 743a68d, but the rows it had created were left behind —
// surfacing as stale, un-removable badges on the student page. None of these
// are creatable flag types any more (flags.js only writes 'review_needed',
// 'resubmit_requested', and 'custom'), so any surviving row is an orphan.
// 'performance_change' rows carry an assignment_id, so purgeStudentScopedFlags
// does not catch them — they must be named explicitly here. Idempotent — safe
// to run on every boot. See #45.
export function purgeLegacyAutoFlags(database) {
  database.exec(
    `DELETE FROM flags WHERE flag_type IN ('missing', 'late_submission', 'performance_change')`
  );
}

// Remove orphaned student-scoped flags. Before #20/#19, flags could be created
// against a student profile with no assignment_id (the retired FlagsCard).
// Review flags are now always submission-scoped — student AND assignment — so a
// NULL assignment_id marks a flag with no home in the UI. Idempotent — safe to
// run on every boot. See #20/#19.
export function purgeStudentScopedFlags(database) {
  database.exec(`DELETE FROM flags WHERE assignment_id IS NULL`);
}

// Issue #56: flip existing template-pattern courses (no course_code AND no
// section_school_code) to excluded=1 so the next sync skips them without
// requiring user action. Idempotent — the predicate filters to rows that
// haven't been flagged yet, so re-running is a no-op.
export function backfillExcludedCourses(database) {
  database.exec(`
    UPDATE courses SET excluded = 1
    WHERE excluded = 0
      AND (course_code IS NULL OR course_code = '')
      AND (section_school_code IS NULL OR section_school_code = '')
  `);
}

// Build the schema, apply incremental migrations, and run data purges on an
// open database. Exported so tests can drive it against an in-memory database.
export function migrate(database) {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  database.exec(schema);

  for (const sql of MIGRATIONS) {
    try { database.exec(sql); } catch { /* column already exists */ }
  }

  // Data purges — independent of each other; order does not matter.
  purgeLegacyAutoFlags(database);
  purgeStudentScopedFlags(database);
  backfillExcludedCourses(database);
}

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}
