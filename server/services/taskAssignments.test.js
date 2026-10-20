import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { writeAssignments, isTest } from './taskAssignments.js';

const NOW = '2026-10-20T00:00:00.000Z';

describe('writeAssignments (#58)', () => {
  let db;
  let courseId;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('S1', 'C')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'OTHER', 'Other')`).run(courseId);
  });
  const row = (ext) => db.prepare('SELECT title, due_date, removed_at, is_test, accepts_submissions FROM assignments WHERE schoology_assignment_id = ?').get(ext);

  test('one task (complete: false) is written; the course\'s other tasks are left alone', () => {
    writeAssignments(db, {
      courseId, now: NOW, complete: false, enrolmentIdToUid: new Map([['801', '701']]),
      assignments: [{ id: 'A1', title: 'Essay', due: '2026-10-30 15:30:00', allow_dropbox: '1', assignees: '[801]' }],
    });
    expect(row('A1')).toMatchObject({ title: 'Essay', due_date: '2026-10-30 15:30:00', accepts_submissions: 1, is_test: 0 });
    expect(row('OTHER').removed_at).toBeNull();
    const aid = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = 'A1'`).get().id;
    expect(db.prepare('SELECT schoology_uid FROM assignment_assignees WHERE assignment_id = ?').all(aid)).toEqual([{ schoology_uid: '701' }]);
  });

  test('the section list (complete: true) soft-removes a task missing from it', () => {
    writeAssignments(db, { courseId, now: NOW, complete: true, enrolmentIdToUid: new Map(), assignments: [{ id: 'A1', title: 'Essay' }] });
    expect(row('OTHER').removed_at).toBe(NOW);
  });

  test('isTest: a Schoology test or quiz', () => {
    expect(isTest({ type: 'assessment' })).toBe(true);
    expect(isTest({ type: 'assignment' })).toBe(false);
  });
});
