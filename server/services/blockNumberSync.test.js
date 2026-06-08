import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ db: null }));
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDb: () => h.db };
});

import { migrate } from '../db/index.js';
import { syncBlockNumbers } from './blockNumberSync.js';

function seed(db, name, { archived = 0, excluded = 0 } = {}) {
  const id = db.prepare('INSERT INTO courses (schoology_section_id, course_name) VALUES (?, ?)').run(`sec-${name}`, name).lastInsertRowid;
  db.prepare('UPDATE courses SET archived = ?, excluded = ? WHERE id = ?').run(archived, excluded, id);
  return id;
}

describe('syncBlockNumbers — guard', () => {
  beforeEach(() => { h.db = new Database(':memory:'); migrate(h.db); });

  // When there are no ACTIVE courses, the service must return before launching a
  // browser. (It returns prior to the session-file check and openPage, so this
  // is safe to run without a Playwright session.)
  test('no active courses → processed 0, no browser launched', async () => {
    const s = await syncBlockNumbers();
    expect(s).toEqual({ processed: 0, updated: 0, unchanged: 0, skipped: 0, results: [] });
  });

  test('default (active) ignores archived/excluded courses → no-op', async () => {
    seed(h.db, 'old', { archived: 1 });
    seed(h.db, 'template', { excluded: 1 });
    const s = await syncBlockNumbers();
    expect(s.processed).toBe(0);
  });

  test('courseIds excludes template/excluded courses → no-op (no browser)', async () => {
    const id = seed(h.db, 'template', { excluded: 1 });
    const s = await syncBlockNumbers({ courseIds: [id] });
    expect(s.processed).toBe(0);
  });
});
