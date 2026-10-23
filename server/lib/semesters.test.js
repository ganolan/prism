import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { semesterEndFor, loadTermRanges } from './semesters.js';

// #174: PowerSchool terms per course; a date's semester ends where the shortest term containing it
// ends (a full-year course spans both semesters).
const YEAR = { start: '2026-08-20', end: '2027-06-10' };
const S1 = { start: '2026-08-20', end: '2027-01-08' };
const S2 = { start: '2027-01-19', end: '2027-06-10' };

describe('semesterEndFor', () => {
  test('a date inside a semester term takes that semester\'s end', () => {
    expect(semesterEndFor('2026-10-23', [YEAR, S1, S2])).toBe('2027-01-08');
    expect(semesterEndFor('2027-03-01', [YEAR, S1, S2])).toBe('2027-06-10');
    expect(semesterEndFor('2027-01-08', [YEAR, S1, S2])).toBe('2027-01-08');
  });

  test('only the full-year term known → the year end', () => {
    expect(semesterEndFor('2026-10-23', [YEAR])).toBe('2027-06-10');
  });

  test('no term contains the date → null', () => {
    expect(semesterEndFor('2025-10-23', [YEAR, S1])).toBeNull();
    expect(semesterEndFor('2026-10-23', [])).toBeNull();
    expect(semesterEndFor(null, [YEAR])).toBeNull();
  });
});

describe('loadTermRanges', () => {
  test('distinct stored ranges from every course, archived included', () => {
    const db = new Database(':memory:');
    migrate(db);
    const add = (sid, archived, start, end) => db.prepare(
      'INSERT INTO courses (schoology_section_id, course_name, archived, term_start, term_end) VALUES (?, ?, ?, ?, ?)',
    ).run(sid, sid, archived, start, end);
    add('a', 0, S1.start, S1.end);
    add('b', 0, S1.start, S1.end);
    add('c', 1, YEAR.start, YEAR.end);
    add('d', 0, null, null);
    const got = loadTermRanges(db).sort((x, y) => x.end.localeCompare(y.end));
    expect(got).toEqual([S1, YEAR]);
  });
});
