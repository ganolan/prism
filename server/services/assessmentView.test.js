import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
// The mastery route (for the parity check) imports these; none run here.
vi.mock('./masterySync.js', () => ({
  hasMasterySession: () => true, syncMasteryForCourse: vi.fn(), syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn(), writeMasteryScoresBatch: vi.fn(), writeMasteryOverride: vi.fn(),
  getMasteryForCourse: vi.fn(), getRubricScoresForStudent: vi.fn(), interactiveLogin: vi.fn(),
}));
vi.mock('./schoology.js', () => ({ pushGradeUpdates: vi.fn(), getSectionGrades: vi.fn() }));
vi.mock('./oneDriveLinks.js', () => ({ getAssignmentFiles: vi.fn() }));

import { getDb } from '../db/index.js';
import masteryRouter from '../routes/mastery.js';
import { buildAssessmentView } from './assessmentView.js';

let db, courseId, ada, bob, cy, assignmentId;

beforeEach(() => {
  db = getDb();
  db.exec(
    'DELETE FROM status_lines; DELETE FROM assessment_drafts; DELETE FROM mastery_scores; DELETE FROM mastery_alignments; ' +
    'DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM linked_sections; DELETE FROM assignment_assignees; ' +
    'DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
  );
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AIML')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'ART.5', 'Creating')`).run(courseId);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('topic-1', 'cat-1', ?, 'ART.5.1', 'Generates media')`).run(courseId);
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, max_points, published) VALUES (?, 'sa-1', 'Project', 100, 1)`).run(courseId);
  assignmentId = 'sa-1';
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-1', 'topic-1', ?)`).run(courseId);
  const student = (uid, first) => {
    const id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, 'Student')`).run(uid, first).lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, ?)`).run(id, courseId, `enr-${uid}`);
    return id;
  };
  ada = student('uid-1', 'Ada');
  bob = student('uid-2', 'Bob');
  cy = student('uid-3', 'Cy');
  const aid = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get('sa-1').id;
  db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('uid-1', 'sa-1', 'topic-1', 75, 'EX')`).run();
  db.prepare(`INSERT INTO grades (student_id, assignment_id, grade_comment, exception, comment_status) VALUES (?, ?, 'Nice work', 0, 1)`).run(ada, aid);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, grade_comment, exception, comment_status) VALUES (?, ?, 'Needs more', 0, NULL)`).run(bob, aid);
  db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, 'Resubmission requested', 'resubmission')`).run(bob, aid);
});

async function routeJson() {
  const app = express();
  app.use('/api/mastery', masteryRouter);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}/api/mastery/${courseId}/assignment/${assignmentId}`);
    return await res.json();
  } finally { server.close(); }
}

describe('buildAssessmentView', () => {
  test('matches the mastery route for the whole class', async () => {
    const view = buildAssessmentView(db, { courseId, assignmentId });
    expect(view.students.map((s) => s.id)).toEqual([ada, bob, cy]);
    expect(JSON.parse(JSON.stringify(view))).toEqual(await routeJson());
    expect(view.course.writable).toBe(true);
  });

  test('studentId keeps only that student', () => {
    const whole = buildAssessmentView(db, { courseId, assignmentId });
    const one = buildAssessmentView(db, { courseId, assignmentId, studentId: bob });
    expect(one.students).toHaveLength(1);
    expect(one.students[0].id).toBe(bob);
    expect(one.students[0]).toEqual(whole.students.find((s) => s.id === bob));
    expect(one.topics).toEqual(whole.topics);
  });

  test('builds a card for a dropped student', () => {
    db.prepare('UPDATE enrolments SET dropped_at = ? WHERE student_id = ?').run('2026-10-01', bob);
    expect(buildAssessmentView(db, { courseId, assignmentId }).students.map((s) => s.id)).toEqual([ada, cy]);
    const one = buildAssessmentView(db, { courseId, assignmentId, studentId: bob });
    expect(one.students).toHaveLength(1);
    expect(one.students[0]).toMatchObject({ id: bob, grade_comment: 'Needs more', has_grade_row: true });
  });

  test('builds a card for a student an individually assigned task is not assigned to', () => {
    const aid = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get('sa-1').id;
    db.prepare('UPDATE assignments SET num_assignees = 1 WHERE id = ?').run(aid);
    db.prepare(`INSERT INTO assignment_assignees (assignment_id, schoology_uid) VALUES (?, 'uid-1')`).run(aid);
    expect(buildAssessmentView(db, { courseId, assignmentId }).students.map((s) => s.id)).toEqual([ada]);
    expect(buildAssessmentView(db, { courseId, assignmentId, studentId: bob }).students[0])
      .toMatchObject({ id: bob, grade_comment: 'Needs more' });
  });

  test('no students for an id that is not a student', () => {
    expect(buildAssessmentView(db, { courseId, assignmentId, studentId: 99999 }).students).toEqual([]);
  });

  describe('course.writable', () => {
    const writable = () => buildAssessmentView(db, { courseId, assignmentId }).course.writable;
    test('true for a current course', () => expect(writable()).toBe(true));
    test('false for an archived course', () => {
      db.prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
      expect(writable()).toBe(false);
    });
    test('false for an excluded course', () => {
      db.prepare('UPDATE courses SET excluded = 1 WHERE id = ?').run(courseId);
      expect(writable()).toBe(false);
    });
    test('false for a set of linked sections', () => {
      db.prepare(`INSERT INTO linked_sections (course_id, schoology_section_id) VALUES (?, 'sec-linked')`).run(courseId);
      expect(writable()).toBe(false);
    });
  });
});
