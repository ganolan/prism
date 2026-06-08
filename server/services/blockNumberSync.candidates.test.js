import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { countCoursesNeedingBlockSync } from './blockNumberSync.js';

// Insert a course and set the columns that matter for the candidate query.
function seed(db, name, { archived = 0, excluded = 0, section = `sec-${name}`, block = null, syncedAt = null } = {}) {
  const id = db.prepare('INSERT INTO courses (schoology_section_id, course_name) VALUES (?, ?)').run(section, name).lastInsertRowid;
  db.prepare('UPDATE courses SET archived = ?, excluded = ?, schoology_section_id = ?, block_number = ?, block_synced_at = ? WHERE id = ?')
    .run(archived, excluded, section, block, syncedAt, id);
  return id;
}

describe('countCoursesNeedingBlockSync', () => {
  let db;
  beforeEach(() => { db = new Database(':memory:'); migrate(db); });

  test('counts only current, non-excluded, sectioned courses with no block and never examined', () => {
    seed(db, 'needs-it');                                    // ✓ counts
    seed(db, 'has-block', { block: '3' });                   // already set
    seed(db, 'already-checked', { syncedAt: '2026-06-08T00:00:00Z' }); // PCG-style, examined
    seed(db, 'archived', { archived: 1 });
    seed(db, 'excluded', { excluded: 1 });

    expect(countCoursesNeedingBlockSync(db)).toBe(1);
  });

  test('returns 0 when every course is examined or set (steady state → no browser launch)', () => {
    seed(db, 'a', { block: '1' });
    seed(db, 'b', { syncedAt: '2026-06-08T00:00:00Z' });
    expect(countCoursesNeedingBlockSync(db)).toBe(0);
  });

  test('a blank-string block_number still counts as needing a block', () => {
    seed(db, 'blank', { block: '' });
    expect(countCoursesNeedingBlockSync(db)).toBe(1);
  });
});
