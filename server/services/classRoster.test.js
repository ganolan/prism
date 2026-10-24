import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import {
  loadClassRoster, parseRosterFilters, applyRosterFilters, rosterFacets, gradeFromGradYear,
} from './classRoster.js';

// 2026-27: grad_year 2027 is grade 12, 2030 grade 9.
const NOW = new Date('2026-10-24T12:00:00');

let db;
let courseA;
let courseB;
function addStudent({ first, last, uid, gender = null, gradYear = null, courses = [courseA], dropped = null }) {
  const id = db.prepare(
    'INSERT INTO students (first_name, last_name, schoology_uid, gender, grad_year) VALUES (?,?,?,?,?)',
  ).run(first, last, uid, gender, gradYear).lastInsertRowid;
  for (const c of courses) db.prepare('INSERT INTO enrolments (student_id, course_id, dropped_at) VALUES (?,?,?)').run(id, c, dropped);
  return id;
}
const rollup = (uid, courseId, pct, objective) => db.prepare(
  'INSERT INTO mastery_rollups (student_uid, course_id, objective_id, is_category, grade_percentage) VALUES (?,?,?,1,?)',
).run(uid, courseId, objective, pct);

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  courseA = db.prepare("INSERT INTO courses (schoology_section_id, course_name) VALUES ('a', 'A')").run().lastInsertRowid;
  courseB = db.prepare("INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('b', 'B', 1)").run().lastInsertRowid;
});

describe('gradeFromGradYear', () => {
  test('today\'s grade from the graduating year; null when unknown or graduated', () => {
    expect(gradeFromGradYear(2027, NOW)).toBe(12);
    expect(gradeFromGradYear(2030, NOW)).toBe(9);
    expect(gradeFromGradYear(2026, NOW)).toBeNull();
    expect(gradeFromGradYear(null, NOW)).toBeNull();
  });
});

describe('loadClassRoster', () => {
  test('each student once across the courses, with gender, grade and overall proficiency level', () => {
    addStudent({ first: 'Zoe', last: 'Adams', uid: 'u1', gender: 'F', gradYear: 2028, courses: [courseA, courseB] });
    addStudent({ first: 'Max', last: 'Chen', uid: 'u2', gender: 'M', gradYear: 2027 });
    addStudent({ first: 'Old', last: 'Boyd', uid: 'u3', courses: [courseB] });
    addStudent({ first: 'Gone', last: 'Dale', uid: 'u4', dropped: '2026-09-01' });
    // Zoe: categories 90 and 70 in A → 80 → EX; B's rollup counts only when B is selected.
    rollup('u1', courseA, 90, 'c1');
    rollup('u1', courseA, 70, 'c2');
    rollup('u1', courseB, 20, 'c1');
    rollup('u2', courseA, 87.5, 'c1'); // exactly the ED cut

    const one = loadClassRoster(db, [courseA], NOW);
    expect(one.map((s) => [s.last_name, s.gender, s.grade, s.avg_pct, s.level])).toEqual([
      ['Adams', 'F', 11, 80, 'EX'],
      ['Chen', 'M', 12, 87.5, 'ED'],
    ]);
    const both = loadClassRoster(db, [courseA, courseB], NOW);
    expect(both.map((s) => [s.last_name, s.gender, s.grade, s.level])).toEqual([
      ['Adams', 'F', 11, 'D'], // (90 + 70 + 20) / 3 = 60 → D
      ['Boyd', null, null, null],
      ['Chen', 'M', 12, 'ED'],
    ]);
  });

  test('no courses → no students', () => {
    expect(loadClassRoster(db, [], NOW)).toEqual([]);
  });
});

describe('filters', () => {
  const roster = [
    { id: 1, gender: 'F', grade: 9, level: 'EX' },
    { id: 2, gender: 'M', grade: 9, level: 'D' },
    { id: 3, gender: 'F', grade: 10, level: null },
    { id: 4, gender: null, grade: null, level: 'ED' },
  ];
  const ids = (q) => applyRosterFilters(roster, parseRosterFilters(q)).map((s) => s.id);

  test('no filter keeps everyone', () => {
    expect(ids({})).toEqual([1, 2, 3, 4]);
    expect(ids({ gender: '' })).toEqual([1, 2, 3, 4]);
  });

  test('values of one type combine with OR, types with AND', () => {
    expect(ids({ gender: 'F' })).toEqual([1, 3]);
    expect(ids({ grade: '9,10' })).toEqual([1, 2, 3]);
    expect(ids({ gender: 'F', grade: '9' })).toEqual([1]);
    expect(ids({ level: 'ED,EX' })).toEqual([1, 4]);
  });

  test('"none" picks students with no value of that type', () => {
    expect(ids({ level: 'none' })).toEqual([3]);
    expect(ids({ gender: 'none,M' })).toEqual([2, 4]);
    expect(ids({ grade: 'none' })).toEqual([4]);
  });

  test('facets list each held value with its count, levels best first, "none" last', () => {
    expect(rosterFacets(roster)).toEqual({
      gender: [{ value: 'F', count: 2 }, { value: 'M', count: 1 }, { value: 'none', count: 1 }],
      grade: [{ value: '9', count: 2 }, { value: '10', count: 1 }, { value: 'none', count: 1 }],
      level: [{ value: 'ED', count: 1 }, { value: 'EX', count: 1 }, { value: 'D', count: 1 }, { value: 'none', count: 1 }],
    });
    expect(rosterFacets([])).toEqual({ gender: [], grade: [], level: [] });
  });
});
