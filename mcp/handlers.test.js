import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../server/db/index.js';
import { listCourses } from './handlers.js';

beforeEach(() => {
  getDb().exec('DELETE FROM courses;');
});

describe('listCourses', () => {
  test('returns active courses with the documented columns', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name, section_name, course_code)
       VALUES ('s1', 'Robotics', 'Block A', 'ROB')`
    ).run();
    const rows = listCourses(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      course_name: 'Robotics',
      section_name: 'Block A',
      course_code: 'ROB',
      schoology_section_id: 's1',
    });
    expect(typeof rows[0].id).toBe('number');
  });

  test('excludes archived, excluded, and hidden courses', () => {
    const db = getDb();
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('a', 'Archived', 1)`).run();
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name, excluded) VALUES ('e', 'Excluded', 1)`).run();
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name, hidden) VALUES ('h', 'Hidden', 1)`).run();
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('ok', 'Active')`).run();
    expect(listCourses(db).map((c) => c.course_name)).toEqual(['Active']);
  });
});
