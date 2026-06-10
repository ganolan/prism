import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ db: null }));
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDb: () => h.db };
});

import { migrate } from '../db/index.js';
import { syncPsAttendance, applyGradeLevels } from './psAttendanceSync.js';

function seed(db, name, { archived = 0, excluded = 0 } = {}) {
  const id = db.prepare('INSERT INTO courses (schoology_section_id, course_name) VALUES (?, ?)').run(`sec-${name}`, name).lastInsertRowid;
  db.prepare('UPDATE courses SET archived = ?, excluded = ? WHERE id = ?').run(archived, excluded, id);
  return id;
}

describe('syncPsAttendance — guard', () => {
  beforeEach(() => { h.db = new Database(':memory:'); migrate(h.db); });

  // When there are no ACTIVE courses, the service must return before launching a
  // browser. (It returns prior to the session-file check and openPage, so this
  // is safe to run without a Playwright session.)
  test('no active courses → processed 0, no browser launched', async () => {
    const s = await syncPsAttendance();
    expect(s).toEqual({ processed: 0, updated: 0, unchanged: 0, skipped: 0, results: [] });
  });

  test('default (active) ignores archived/excluded courses → no-op', async () => {
    seed(h.db, 'old', { archived: 1 });
    seed(h.db, 'template', { excluded: 1 });
    const s = await syncPsAttendance();
    expect(s.processed).toBe(0);
  });

  test('courseIds excludes template/excluded courses → no-op (no browser)', async () => {
    const id = seed(h.db, 'template', { excluded: 1 });
    const s = await syncPsAttendance({ courseIds: [id] });
    expect(s.processed).toBe(0);
  });
});

describe('applyGradeLevels', () => {
  beforeEach(() => { h.db = new Database(':memory:'); migrate(h.db); });

  function seedStudent(schoolUid, gradYear = null) {
    const id = h.db.prepare(
      'INSERT INTO students (first_name, last_name, school_uid, grad_year) VALUES (?, ?, ?, ?)'
    ).run('First', 'Last', schoolUid, gradYear).lastInsertRowid;
    return id;
  }

  test('sets grad_year for matched students and leaves unmatched ones untouched', () => {
    const matched = seedStudent('1_42302', null);     // Gr 10 → 2028
    const other = seedStudent('1_77777', 2099);        // not in the map → preserved
    const map = new Map([['42302', 10], ['00000', 11]]); // 00000 has no matching student

    const updated = applyGradeLevels(h.db, map, new Date('2026-01-15'));

    expect(updated).toBe(1);
    expect(h.db.prepare('SELECT grad_year FROM students WHERE id = ?').get(matched).grad_year).toBe(2028);
    expect(h.db.prepare('SELECT grad_year FROM students WHERE id = ?').get(other).grad_year).toBe(2099);
  });

  test('empty map → no updates', () => {
    seedStudent('1_42302', 2027);
    expect(applyGradeLevels(h.db, new Map(), new Date('2026-01-15'))).toBe(0);
  });
});
