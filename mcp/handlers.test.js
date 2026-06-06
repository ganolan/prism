import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../server/db/index.js';
import { listCourses, listAssignments } from './handlers.js';

beforeEach(() => {
  getDb().exec(
    'DELETE FROM mastery_alignments; DELETE FROM measurement_topics; ' +
    'DELETE FROM grades; DELETE FROM assignments; ' +
    'DELETE FROM students; DELETE FROM courses;'
  );
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

function seedCourse(db) {
  return db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'MAD')`).run().lastInsertRowid;
}

describe('listAssignments', () => {
  test('has_aligned_topics reflects whether the assignment has a mastery alignment', () => {
    const db = getDb();
    const courseId = seedCourse(db);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'aligned', 'Aligned')`).run(courseId);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'bare', 'Bare')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, course_id) VALUES ('t1', ?)`).run(courseId);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('aligned', 't1', ?)`).run(courseId);

    const byTitle = Object.fromEntries(listAssignments(db, { course_id: courseId }).map((a) => [a.title, a]));
    expect(byTitle.Aligned.has_aligned_topics).toBe(true);
    expect(byTitle.Bare.has_aligned_topics).toBe(false);
  });

  test('latest_submission_at is the max submitted_at as ISO, null when never submitted', () => {
    const db = getDb();
    const courseId = seedCourse(db);
    const submittedId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sub', 'Submitted')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'untouched', 'Untouched')`).run(courseId);
    const s1 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1','A','One')`).run().lastInsertRowid;
    const s2 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u2','B','Two')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, submitted_at) VALUES (?, ?, 1700000000)`).run(s1, submittedId);
    db.prepare(`INSERT INTO grades (student_id, assignment_id, submitted_at) VALUES (?, ?, 1700000500)`).run(s2, submittedId);

    const byTitle = Object.fromEntries(listAssignments(db, { course_id: courseId }).map((a) => [a.title, a]));
    expect(byTitle.Submitted.latest_submission_at).toBe(new Date(1700000500 * 1000).toISOString());
    expect(byTitle.Untouched.latest_submission_at).toBeNull();
  });
});
