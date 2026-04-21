import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'students.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Run schema
    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schema);

    // Run incremental migrations (silently ignore duplicate column errors)
    const migrations = [
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
      // Indexes for issue #13 columns (must run after ALTER TABLEs above)
      `CREATE INDEX IF NOT EXISTS idx_assignments_folder ON assignments(folder_id)`,
      `CREATE INDEX IF NOT EXISTS idx_assignments_grading_category ON assignments(grading_category_id)`,
    ];
    for (const sql of migrations) {
      try { db.exec(sql); } catch { /* column already exists */ }
    }
  }
  return db;
}
