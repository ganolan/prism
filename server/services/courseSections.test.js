import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { courseSectionIds, heldSectionIds, linkedCourseOf, assertSectionWritable } from './courseSections.js';

let db;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
});

describe('courseSectionIds (#178)', () => {
  test('the course\'s own section, then its linked sections', () => {
    const id = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('4', 'AIML')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO linked_sections (schoology_section_id, course_id) VALUES ('9', ?), ('6', ?)`).run(id, id);
    expect(courseSectionIds(db, id)).toEqual(['4', '6', '9']);
  });

  test('a course with no linked section is its own section; an unknown course has none', () => {
    const id = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('4', 'AIML')`).run().lastInsertRowid;
    expect(courseSectionIds(db, id)).toEqual(['4']);
    expect(courseSectionIds(db, 999)).toEqual([]);
  });
});

describe('heldSectionIds (#178)', () => {
  test('every course\'s section and every linked section', () => {
    const id = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('4', 'AIML')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('5', 'MAD')`).run();
    db.prepare(`INSERT INTO linked_sections (schoology_section_id, course_id) VALUES ('6', ?)`).run(id);
    expect(heldSectionIds(db)).toEqual(new Set(['4', '5', '6']));
  });
});

describe('assertSectionWritable (#178)', () => {
  test('refuses the parent and the child of a linked set; allows any other section', () => {
    const id = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('4', 'AIML')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('5', 'MAD')`).run();
    db.prepare(`INSERT INTO linked_sections (schoology_section_id, course_id) VALUES ('6', ?)`).run(id);
    expect(linkedCourseOf(db, '4')).toEqual({ courseId: Number(id) });
    expect(linkedCourseOf(db, 6)).toEqual({ courseId: Number(id) });
    expect(() => assertSectionWritable(db, '4')).toThrow(expect.objectContaining({ code: 'LINKED_SECTION' }));
    expect(() => assertSectionWritable(db, '6')).toThrow(/linked sections/);
    expect(() => assertSectionWritable(db, '5')).not.toThrow();
    expect(() => assertSectionWritable(db, '99')).not.toThrow();
  });
});
