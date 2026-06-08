import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './index.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

describe('rubric schema', () => {
  test('creates the five rubric tables', () => {
    const db = freshDb();
    const names = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rubric%'`
    ).all().map(r => r.name).sort();
    expect(names).toEqual([
      'rubric_attachment_topics', 'rubric_attachments',
      'rubric_criteria', 'rubric_descriptors', 'rubrics',
    ]);
  });

  test('descriptor is unique per (criterion, level) and cascades on rubric delete', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO rubrics (id, name) VALUES (1, 'R')`).run();
    db.prepare(`INSERT INTO rubric_criteria (id, rubric_id, position) VALUES (10, 1, 1)`).run();
    db.prepare(`INSERT INTO rubric_descriptors (criterion_id, level, descriptor_text) VALUES (10, 'ED', 'a')`).run();
    expect(() =>
      db.prepare(`INSERT INTO rubric_descriptors (criterion_id, level, descriptor_text) VALUES (10, 'ED', 'b')`).run()
    ).toThrow();
    db.prepare(`DELETE FROM rubrics WHERE id = 1`).run();
    expect(db.prepare(`SELECT COUNT(*) c FROM rubric_criteria`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM rubric_descriptors`).get().c).toBe(0);
  });
});
