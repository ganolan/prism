import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { saveRubric } from './rubricStore.js';
import {
  getFeedbackRows, getRowLevels, saveRowLevels, rowLevelsError, resolveRowKey,
  hiddenRowLevelCount, orderedRowLevels,
} from './feedbackRows.js';

const GAS = { name: 'General Academic Scale (Unaligned)', levels: [
  { code: 'ED', label: 'Exhibiting Depth', points: 100, cutoff: 87.5 },
  { code: 'EX', label: 'Exhibiting', points: 75, cutoff: 62.5 },
  { code: 'D', label: 'Developing', points: 50, cutoff: 37.5 },
  { code: 'EM', label: 'Emerging', points: 25, cutoff: 12.5 },
  { code: 'IE', label: 'Insufficient Evidence', points: 0, cutoff: 0 },
] };

let db, rubricId;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  rubricId = saveRubric(db, { name: 'Flappy', source: 'csv', criteria: [
    { position: 1, criterion_name: 'Features and Code', standard_title: 'Anchor Standard 5: Develop', reporting_category: 'PRODUCE', descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd' } },
    { position: 2, criterion_name: 'Playtesting', standard_title: 'Anchor Standard 3: Refine', reporting_category: 'CREATE, RESPOND, CONNECT', descriptors: { ED: 'e', EX: 'f', D: 'g', EM: 'h' } },
  ] });
});

const attach = () => db.prepare(
  `INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-F', NULL, 'now')`
).run(rubricId);

describe('rubric_row_levels table', () => {
  test('rejects a level outside ED..IE and a duplicate row', () => {
    const ins = db.prepare(`INSERT INTO rubric_row_levels (assignment_schoology_id, student_uid, criterion_name, level) VALUES (?, ?, ?, ?)`);
    ins.run('sa-F', 'u1', 'Playtesting', 'EX');
    expect(() => ins.run('sa-F', 'u1', 'Playtesting', 'D')).toThrow(/UNIQUE/);
    expect(() => ins.run('sa-F', 'u2', 'Playtesting', 'A')).toThrow(/CHECK/);
  });

  test('migrate() adds the table to a database created before it existed', () => {
    const old = new Database(':memory:');
    migrate(old);
    old.exec('DROP TABLE rubric_row_levels');
    migrate(old);
    expect(old.prepare(`SELECT name FROM sqlite_master WHERE name = 'rubric_row_levels'`).get()).toBeTruthy();
  });
});

describe('getFeedbackRows', () => {
  test('null for a task that is not on a score scale', () => {
    attach();
    expect(getFeedbackRows(db, 'sa-F', null)).toBeNull();
  });

  test('no rubric attached: rubric null, no rows', () => {
    expect(getFeedbackRows(db, 'sa-F', GAS)).toEqual({ rubric: null, rows: [] });
  });

  test('every criterion is a row, in rubric order, IE defaulted', () => {
    attach();
    const fr = getFeedbackRows(db, 'sa-F', GAS);
    expect(fr.rubric).toEqual({ id: rubricId, name: 'Flappy' });
    expect(fr.rows.map(r => r.criterion)).toEqual(['Features and Code', 'Playtesting']);
    expect(fr.rows[0]).toMatchObject({ standard: 'Anchor Standard 5: Develop', category: 'PRODUCE' });
    expect(fr.rows[0].descriptors).toEqual({ ED: 'a', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' });
  });
});

describe('row levels', () => {
  test('save, read back by name, and null deletes', () => {
    saveRowLevels(db, { assignmentSchoologyId: 'sa-F', studentUid: 'u1', rowLevels: { 'Features and Code': 'EX', Playtesting: 'D' } });
    saveRowLevels(db, { assignmentSchoologyId: 'sa-F', studentUid: 'u1', rowLevels: { Playtesting: 'ED' } });
    expect(getRowLevels(db, 'sa-F')).toEqual({ u1: { 'Features and Code': 'EX', Playtesting: 'ED' } });
    saveRowLevels(db, { assignmentSchoologyId: 'sa-F', studentUid: 'u1', rowLevels: { Playtesting: null } });
    expect(getRowLevels(db, 'sa-F')).toEqual({ u1: { 'Features and Code': 'EX' } });
  });

  test('rowLevelsError refuses unknown rows, bad levels and non-objects', () => {
    attach();
    const { rows } = getFeedbackRows(db, 'sa-F', GAS);
    expect(rowLevelsError(rows, { Playtesting: 'EX', 'Features and Code': null })).toBeNull();
    expect(rowLevelsError(rows, { Evaluation: 'EX' })).toMatch(/Evaluation/);
    expect(rowLevelsError(rows, { Playtesting: 'A' })).toMatch(/level/);
    expect(rowLevelsError(rows, ['EX'])).toMatch(/object/);
    expect(rowLevelsError([], { Playtesting: 'EX' })).toMatch(/feedback rows/);
  });

  test('resolveRowKey matches criterion name, then standard text, ignoring case', () => {
    attach();
    const { rows } = getFeedbackRows(db, 'sa-F', GAS);
    expect(resolveRowKey(rows, ' playtesting ')).toBe('Playtesting');
    expect(resolveRowKey(rows, 'anchor standard 5: develop')).toBe('Features and Code');
    expect(resolveRowKey(rows, 'Evaluation')).toBeNull();
  });

  test('hiddenRowLevelCount counts finals whose names are not rows', () => {
    saveRowLevels(db, { assignmentSchoologyId: 'sa-F', studentUid: 'u1', rowLevels: { Aesthetic: 'EX', Playtesting: 'D' } });
    expect(hiddenRowLevelCount(db, 'sa-F', ['Features and Code', 'Playtesting'])).toBe(1);
  });

  test('orderedRowLevels follows the rubric order, extras last', () => {
    expect(orderedRowLevels(['B', 'A'], { A: 'EX', Z: 'D', B: 'ED' }))
      .toEqual([{ criterion: 'B', level: 'ED' }, { criterion: 'A', level: 'EX' }, { criterion: 'Z', level: 'D' }]);
  });
});
