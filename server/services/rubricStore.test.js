import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { saveRubric, getRubric, listRubrics, deleteRubric, getRubricByName, upsertRubricByName } from './rubricStore.js';

let db;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
});

const CONTENT = {
  name: 'MAD Dev', source: 'csv',
  criteria: [
    { position: 1, criterion_name: 'UI/UX', standard_title: 'Select, analyze',
      reporting_category: 'Produce', descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' } },
    { position: 2, criterion_name: 'Functionality', standard_title: 'Develop and refine',
      reporting_category: 'Produce', descriptors: { ED: 'e', EX: 'f', D: 'g', EM: 'h', IE: 'Insufficient Evidence' } },
  ],
};

describe('rubricStore', () => {
  test('saveRubric persists content and getRubric returns it ordered by position', () => {
    const id = saveRubric(db, CONTENT);
    const r = getRubric(db, id);
    expect(r.name).toBe('MAD Dev');
    expect(r.criteria.map(c => c.criterion_name)).toEqual(['UI/UX', 'Functionality']);
    expect(r.criteria[0].descriptors.ED).toBe('a');
    expect(r.criteria[0].descriptors.IE).toBe('Insufficient Evidence');
  });

  test('saveRubric with existing id replaces all content (no orphans)', () => {
    const id = saveRubric(db, CONTENT);
    saveRubric(db, { ...CONTENT, name: 'Renamed', criteria: [CONTENT.criteria[0]] }, id);
    const r = getRubric(db, id);
    expect(r.name).toBe('Renamed');
    expect(r.criteria).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) c FROM rubric_descriptors`).get().c).toBe(5);
  });

  test('listRubrics returns summaries; deleteRubric removes content', () => {
    const id = saveRubric(db, CONTENT);
    expect(listRubrics(db)).toEqual([expect.objectContaining({ id, name: 'MAD Dev', criteria_count: 2 })]);
    deleteRubric(db, id);
    expect(listRubrics(db)).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) c FROM rubric_criteria`).get().c).toBe(0);
  });

  test('listRubrics reports how many assignments each rubric is attached to', () => {
    const id = saveRubric(db, CONTENT);
    db.prepare(
      `INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at)
       VALUES (?, '800', NULL, '2026-01-01')`
    ).run(id);
    expect(listRubrics(db)[0]).toMatchObject({ id, attachment_count: 1, criteria_count: 2 });
  });

  test('upsertRubricByName creates when absent and replaces (same id) when present', () => {
    const id1 = upsertRubricByName(db, CONTENT);
    const id2 = upsertRubricByName(db, { ...CONTENT, criteria: [CONTENT.criteria[0]] });
    expect(id2).toBe(id1);                                  // replaced, not duplicated
    expect(listRubrics(db)).toHaveLength(1);
    expect(getRubric(db, id1).criteria).toHaveLength(1);
  });

  test('getRubricByName returns the rubric content by name', () => {
    saveRubric(db, CONTENT);
    const r = getRubricByName(db, 'MAD Dev');
    expect(r.criteria.map((c) => c.criterion_name)).toEqual(['UI/UX', 'Functionality']);
    expect(getRubricByName(db, 'nope')).toBeNull();
  });
});
