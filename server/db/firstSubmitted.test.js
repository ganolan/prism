import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, backfillFirstSubmittedAt } from './index.js';

describe('backfillFirstSubmittedAt', () => {
  test('seeds from latest_revision_at only where unset', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO students (id, schoology_uid, first_name, last_name) VALUES (1, 'u1', 'A', 'B')`).run();
    db.prepare(`INSERT INTO courses (id, schoology_section_id, course_name) VALUES (1, 's1', 'C')`).run();
    db.prepare(`INSERT INTO assignments (id, course_id, schoology_assignment_id, title) VALUES (1, 1, 'a1', 'T'), (2, 1, 'a2', 'T2'), (3, 1, 'a3', 'T3')`).run();
    db.prepare(`INSERT INTO grades (student_id, assignment_id, latest_revision_at, first_submitted_at) VALUES (1, 1, 500, 0), (1, 2, 900, 300), (1, 3, 0, 0)`).run();
    backfillFirstSubmittedAt(db);
    const got = db.prepare('SELECT assignment_id, first_submitted_at FROM grades ORDER BY assignment_id').all();
    expect(got).toEqual([
      { assignment_id: 1, first_submitted_at: 500 },
      { assignment_id: 2, first_submitted_at: 300 },
      { assignment_id: 3, first_submitted_at: 0 },
    ]);
  });
});
