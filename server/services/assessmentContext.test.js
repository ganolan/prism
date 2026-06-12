import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { getAssessmentContext } from './assessmentContext.js';

// Seed one fully-populated assignment context: a course, a reporting category +
// aligned measurement topic, an assignment, a roster of one enrolled student
// with a synced final score + grade comment, and an existing AI draft suggestion.
function seedContext(db) {
  const courseId = db.prepare(
    `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AIML')`
  ).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'ART.5', 'Creating')`).run(courseId);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('topic-1', 'cat-1', ?, 'ART.5.1', 'Generates media')`).run(courseId);
  const assignmentId = db.prepare(
    `INSERT INTO assignments (course_id, schoology_assignment_id, title, max_points, grading_scale_id) VALUES (?, 'sa-1', 'Project', 100, 'gs-1')`
  ).run(courseId).lastInsertRowid;
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-1', 'topic-1', ?)`).run(courseId);
  const studentId = db.prepare(
    `INSERT INTO students (schoology_uid, first_name, last_name, preferred_name) VALUES ('uid-1', 'Ada', 'Lovelace', 'Ada')`
  ).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-1')`).run(studentId, courseId);
  db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('uid-1', 'sa-1', 'topic-1', 75, 'EX')`).run();
  db.prepare(`INSERT INTO grades (student_id, assignment_id, grade_comment, exception, comment_status) VALUES (?, ?, 'Nice work', 0, 1)`).run(studentId, assignmentId);
  db.prepare(`INSERT INTO feedback (student_id, assignment_id, status, feedback_json) VALUES (?, ?, 'draft', ?)`).run(
    studentId, assignmentId,
    JSON.stringify({ narrative_feedback: 'Strong concept', rubric_scores: { 'ART.5.1': 'ED' }, reviewer_flags: 'check sources' })
  );
  return { courseId, assignmentId, studentId };
}

beforeEach(() => {
  getDb().exec(
    'DELETE FROM feedback; DELETE FROM mastery_alignments; DELETE FROM mastery_scores; ' +
    'DELETE FROM grades; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
    'DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
  );
});

describe('getAssessmentContext', () => {
  test('composes assignment + aligned topics + roster + finals/comments + existing suggestion', () => {
    const db = getDb();
    const { courseId } = seedContext(db);

    const ctx = getAssessmentContext(db, { courseId, assignmentId: 'sa-1' });

    expect(ctx.assignment).toMatchObject({ schoology_assignment_id: 'sa-1', title: 'Project', max_points: 100 });
    expect(ctx.topics).toEqual([
      { id: 'topic-1', external_id: 'ART.5.1', title: 'Generates media', category_title: 'Creating', category_external_id: 'ART.5' },
    ]);
    expect(ctx.students).toHaveLength(1);
    const s = ctx.students[0];
    expect(s).toMatchObject({
      schoology_uid: 'uid-1',
      enrollment_id: 'enr-1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      preferred_name: 'Ada',
      // Resolved name the agent should address the student by (spec: name
      // students correctly in suggested feedback).
      preferred_first_name: 'Ada',
      grade_comment: 'Nice work',
      display_to_student: true,
      exception: 0,
    });
    expect(s.current_scores).toEqual({ 'topic-1': { level: 'EX' } });
    expect(s.existing_suggestion).toMatchObject({
      status: 'draft',
      narrative_feedback: 'Strong concept',
      rubric_scores: { 'ART.5.1': 'ED' },
      reviewer_flags: 'check sources',
    });
  });

  test('resolves preferred_first_name from the teacher override, not the Schoology preferred name', () => {
    const db = getDb();
    seedContext(db);
    // Teacher renamed Ada → "Lexi"; this override must win in the agent payload
    // just as it does everywhere in the UI.
    db.prepare(`UPDATE students SET preferred_name_teacher = 'Lexi' WHERE schoology_uid = 'uid-1'`).run();

    const ctx = getAssessmentContext(db, { assignmentId: 'sa-1' });

    expect(ctx.students[0].preferred_first_name).toBe('Lexi');
  });

  test('accepts a local assignment id as well as the Schoology id', () => {
    const db = getDb();
    const { assignmentId } = seedContext(db);
    expect(getAssessmentContext(db, { assignmentId }).assignment.schoology_assignment_id).toBe('sa-1');
  });

  test('existing_suggestion is null when no draft/teacher_modified row exists', () => {
    const db = getDb();
    seedContext(db);
    db.prepare('DELETE FROM feedback').run();
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-1' });
    expect(ctx.students[0].existing_suggestion).toBeNull();
  });

  test('excludes approved feedback from existing_suggestion', () => {
    const db = getDb();
    const { studentId } = seedContext(db);
    db.prepare(`UPDATE feedback SET status = 'approved' WHERE student_id = ?`).run(studentId);
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-1' });
    expect(ctx.students[0].existing_suggestion).toBeNull();
  });

  test('display_to_student is false when comment_status is not 1', () => {
    const db = getDb();
    const { studentId } = seedContext(db);
    db.prepare('UPDATE grades SET comment_status = NULL WHERE student_id = ?').run(studentId);
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-1' });
    expect(ctx.students[0].display_to_student).toBe(false);
  });

  test('current_scores exposes level only — no bare points', () => {
    const db = getDb();
    seedContext(db);
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-1' });
    const scored = ctx.students.find((s) => Object.keys(s.current_scores).length);
    const entry = Object.values(scored.current_scores)[0];
    expect(entry).toHaveProperty('level');
    expect(entry).not.toHaveProperty('points');
    expect(entry).not.toHaveProperty('grade');
  });

  test('returns null for an unknown assignment', () => {
    expect(getAssessmentContext(getDb(), { assignmentId: 'no-such' })).toBeNull();
  });
});
