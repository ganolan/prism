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
    ];
    for (const sql of migrations) {
      try { db.exec(sql); } catch { /* column already exists */ }
    }
  }
  return db;
}
