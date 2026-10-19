import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { writeGrades } from './taskGrades.js';

const NOW = '2026-10-19T15:00:00.000Z';

describe('writeGrades (#108)', () => {
  let db;
  let ids;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('S1', 'CSP')`).run().lastInsertRowid;
    const ada = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'Ada', 'L')`).run().lastInsertRowid;
    const bo = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('702', 'Bo', 'K')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, '801')`).run(ada, courseId);
    const task = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, max_points) VALUES (?, 'A1', 'Task', 4)`).run(courseId).lastInsertRowid;
    ids = { courseId, ada, bo, task };
  });

  const row = (studentId) => db.prepare('SELECT * FROM grades WHERE student_id = ? AND assignment_id = ?').get(studentId, ids.task);

  test('writes score, comment, comment_status, exception and submitted_at, never late or draft', () => {
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, late, draft) VALUES (?, ?, '801', 1, 1)`).run(ids.ada, ids.task);
    const n = writeGrades(db, {
      courseId: ids.courseId, now: NOW,
      grades: [{ enrollment_id: '801', assignment_id: 'A1', grade: 3, max_points: 4, comment: 'Good', comment_status: 1, exception: 0, timestamp: '1760000000' }],
    });
    expect(n).toBe(1);
    expect(row(ids.ada)).toMatchObject({
      score: 3, max_score: 4, grade_comment: 'Good', comment_status: 1, exception: 0, submitted_at: 1760000000, late: 1, draft: 1, synced_at: NOW,
    });
  });

  test('resolves a student by stored enrolment, then by uid', () => {
    writeGrades(db, {
      courseId: ids.courseId, now: NOW, enrollIdToUid: { 802: '702' },
      grades: [
        { enrollment_id: '801', assignment_id: 'A1', grade: 2 },
        { enrollment_id: '802', assignment_id: 'A1', grade: 4 },
        { enrollment_id: '999', assignment_id: 'A1', grade: 1 },
      ],
    });
    expect(row(ids.ada).score).toBe(2);
    expect(row(ids.bo).score).toBe(4);
    expect(db.prepare('SELECT COUNT(*) AS n FROM grades').get().n).toBe(2);
  });
});
