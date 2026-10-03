import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { migrate } from '../server/db/index.js';
import { runParity } from './parity-lti-resubmission.js';

// A source database on disk, opened read-only by the probe like the real run.
let dir;
function sourceDb({ unmigrated }) {
  const file = join(dir, 'source.db');
  const w = new Database(file);
  w.pragma('journal_mode = WAL');
  migrate(w);
  const course = w.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'Course')`).run().lastInsertRowid;
  const student = w.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'F', 'L')`).run().lastInsertRowid;
  w.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(student, course);
  const a = w.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission, published) VALUES (?, 'a1', 'T', 1, 1)`).run(course).lastInsertRowid;
  // Graded with visible feedback, then resubmitted: an arrival under the first-deploy rule.
  w.prepare(`INSERT INTO grades (student_id, assignment_id, score, grade_comment, comment_status, submitted_at, latest_revision_at, lti_submission_state)
             VALUES (?, ?, 80, 'ok', 1, 100, 200, 'submitted')`).run(student, a);
  if (unmigrated) {
    // As a database from before this branch: no snapshot / status-line tables.
    w.exec('DROP TABLE feedback_snapshots; DROP TABLE status_lines;');
  }
  w.close();
  return new Database(file, { readonly: true, fileMustExist: true });
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prism-parity-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('parity-lti-resubmission (final review M5)', () => {
  it('an unmigrated source: migrates the in-memory copy, reports it, captures, and leaves the source alone', () => {
    const db = sourceDb({ unmigrated: true });
    const lines = [];
    const out = runParity(db, (...a) => lines.push(a.join(' ')));
    expect(out).toMatchObject({ migrated: true, before: null, after: 1, arrivals: 1, arrivedNow: 1 });
    expect(lines.some((l) => l.includes('migrated the IN-MEMORY copy'))).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'feedback_snapshots'`).get().n).toBe(0);
    db.close();
  });

  it('a current source: no migration needed', () => {
    const db = sourceDb({ unmigrated: false });
    const lines = [];
    const out = runParity(db, (...a) => lines.push(a.join(' ')));
    expect(out).toMatchObject({ migrated: false, before: 0, after: 1, arrivals: 1 });
    expect(lines.some((l) => l.includes('no migration needed'))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_snapshots').get().n).toBe(0);
    db.close();
  });
});
