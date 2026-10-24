import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { semesterEndFor, loadTermRanges, splitAtLongestBreak } from './semesters.js';

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

  test('only terms inside the course\'s own term count', () => {
    const OTHER = { start: '2026-08-10', end: '2026-12-01' }; // another course's odd term, starting before S1
    expect(semesterEndFor('2026-10-23', [YEAR, S1, OTHER], S1)).toBe('2027-01-08');
    expect(semesterEndFor('2026-10-23', [YEAR, S1, OTHER])).toBe('2026-12-01');
    expect(semesterEndFor('2026-10-23', [YEAR, S1], YEAR)).toBe('2027-01-08');
  });

  test('a term shorter than 100 days (a quarter) is never a semester', () => {
    const Q = { start: '2026-09-01', end: '2026-10-30' };
    expect(semesterEndFor('2026-10-23', [YEAR, S1, Q])).toBe('2027-01-08');
    expect(semesterEndFor('2026-10-23', [Q])).toBeNull();
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
  test('distinct stored ranges from every course, archived included, excluded (template) courses left out', () => {
    const db = new Database(':memory:');
    migrate(db);
    const add = (sid, archived, start, end) => db.prepare(
      'INSERT INTO courses (schoology_section_id, course_name, archived, term_start, term_end) VALUES (?, ?, ?, ?, ?)',
    ).run(sid, sid, archived, start, end);
    add('a', 0, S1.start, S1.end);
    add('b', 0, S1.start, S1.end);
    add('c', 1, YEAR.start, YEAR.end);
    add('d', 0, null, null);
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name, excluded, term_start, term_end) VALUES ('e', 'e', 1, '2026-09-01', '2026-10-30')`).run();
    const got = loadTermRanges(db).sort((x, y) => x.end.localeCompare(y.end));
    expect(got).toEqual([S1, YEAR]);
  });
});

// #180: a year with only full-year terms. School days Mon-Fri across 2026-27 with the year's breaks
// as PowerSchool's calendar holds them (prod, 24 Oct 2026): winter 12/12-03/01 (24 days between
// school days), spring 24/03-05/04 (14), Chinese New Year 05/02-14/02 (11).
const BREAKS = [['2026-12-12', '2027-01-03'], ['2027-03-24', '2027-04-05'], ['2027-02-05', '2027-02-14']];
function schoolDays(start, end, breaks = BREAKS) {
  const out = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (breaks.some(([a, b]) => a <= d && d <= b)) continue;
    out.push(d);
  }
  return out;
}
const FULL_YEAR = { start: '2026-08-13', end: '2027-06-08' };
const DAYS = schoolDays(FULL_YEAR.start, FULL_YEAR.end);

describe('splitAtLongestBreak', () => {
  test('the year splits at its longest break (winter), matching PowerSchool\'s 2026-27 semester terms', () => {
    expect(splitAtLongestBreak(FULL_YEAR, DAYS)).toEqual([
      { start: '2026-08-13', end: '2026-12-11' },
      { start: '2027-01-04', end: '2027-06-08' },
    ]);
  });

  test('a calendar that does not cover the whole term is not split', () => {
    expect(splitAtLongestBreak(FULL_YEAR, DAYS.filter((d) => d >= '2026-09-01'))).toBeNull();
    expect(splitAtLongestBreak(FULL_YEAR, DAYS.filter((d) => d <= '2027-05-01'))).toBeNull();
    expect(splitAtLongestBreak(FULL_YEAR, [])).toBeNull();
  });

  test('a split that leaves a half under 100 days is not a semester split', () => {
    const lateBreak = schoolDays(FULL_YEAR.start, FULL_YEAR.end, [['2027-04-10', '2027-05-10']]);
    expect(splitAtLongestBreak(FULL_YEAR, lateBreak)).toBeNull();
  });
});

describe('loadTermRanges: full-year terms only (#180)', () => {
  function dbWith(terms, days = DAYS) {
    const db = new Database(':memory:');
    migrate(db);
    terms.forEach(([start, end], i) => db.prepare(
      'INSERT INTO courses (schoology_section_id, course_name, term_start, term_end) VALUES (?, ?, ?, ?)',
    ).run(`s${i}`, `c${i}`, start, end));
    const ins = db.prepare('INSERT INTO school_days (date, in_session) VALUES (?, 1)');
    for (const d of days) ins.run(d);
    db.prepare("INSERT INTO school_days (date, in_session) VALUES ('2026-12-20', 0)").run(); // a break day row
    return db;
  }

  test('a flag in semester 1 of a full-year-only year ends at the winter break, not in June', () => {
    const ranges = loadTermRanges(dbWith([[FULL_YEAR.start, FULL_YEAR.end]]));
    expect(semesterEndFor('2026-09-15', ranges, FULL_YEAR)).toBe('2026-12-11');
    expect(semesterEndFor('2027-03-01', ranges, FULL_YEAR)).toBe('2027-06-08');
    expect(semesterEndFor('2026-12-20', ranges, FULL_YEAR)).toBe('2027-06-08'); // a break day: the year
  });

  test('stored semester terms win; a derived half is added only where none overlaps it', () => {
    const psS1 = { start: '2026-08-13', end: '2026-12-04' }; // differs from the calendar split on purpose
    const both = loadTermRanges(dbWith([[FULL_YEAR.start, FULL_YEAR.end], [psS1.start, psS1.end]]));
    expect(semesterEndFor('2026-09-15', both, FULL_YEAR)).toBe('2026-12-04');
    expect(semesterEndFor('2027-03-01', both, FULL_YEAR)).toBe('2027-06-08');
    expect(both).toContainEqual({ start: '2027-01-04', end: '2027-06-08' });
    expect(both).not.toContainEqual({ start: '2026-08-13', end: '2026-12-11' });

    const psS2 = { start: '2027-01-04', end: '2027-06-08' }; // only a semester 2 course
    const s2 = loadTermRanges(dbWith([[FULL_YEAR.start, FULL_YEAR.end], [psS2.start, psS2.end]]));
    expect(semesterEndFor('2026-09-15', s2, FULL_YEAR)).toBe('2026-12-11');
  });

  test('no school calendar stored → the year end, as before', () => {
    const ranges = loadTermRanges(dbWith([[FULL_YEAR.start, FULL_YEAR.end]], []));
    expect(semesterEndFor('2026-09-15', ranges, FULL_YEAR)).toBe('2027-06-08');
  });
});
