import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { upsertStudentSuggestion, writeStudentSuggestions } from './suggestions.js';

// A course with one aligned measurement topic (ART.5.1 / "Generates media"),
// an assignment (Schoology id 'sa-1'), and one enrolled student (uid-1).
function seed(db) {
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AIML')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'ART.5', 'Creating')`).run(courseId);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('topic-1', 'cat-1', ?, 'ART.5.1', 'Generates media')`).run(courseId);
  const assignmentLocalId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`).run(courseId).lastInsertRowid;
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-1', 'topic-1', ?)`).run(courseId);
  const studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`).run().lastInsertRowid;
  return { courseId, assignmentLocalId, studentId };
}

beforeEach(() => {
  getDb().exec(
    'DELETE FROM feedback; DELETE FROM mastery_alignments; DELETE FROM mastery_scores; ' +
    'DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM grades; ' +
    'DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
  );
});

describe('upsertStudentSuggestion', () => {
  test('writes a draft feedback row with name→code normalized rubric scores', () => {
    const db = getDb();
    const { assignmentLocalId, studentId } = seed(db);

    const result = upsertStudentSuggestion(db, {
      assignmentId: 'sa-1',
      student: 'uid-1',
      narrative_feedback: 'Great depth of exploration.',
      rubric_scores: { 'ART.5.1': 'Exhibiting Depth' },
      reviewer_flags: 'check sources',
    });

    expect(result).toMatchObject({ student: 'uid-1', status: 'written' });
    expect(typeof result.feedback_id).toBe('number');

    const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(result.feedback_id);
    expect(row.status).toBe('draft');
    expect(row.student_id).toBe(studentId);
    expect(row.assignment_id).toBe(assignmentLocalId);
    const fj = JSON.parse(row.feedback_json);
    expect(fj.narrative_feedback).toBe('Great depth of exploration.');
    expect(fj.rubric_scores).toEqual({ 'ART.5.1': 'ED' });
    expect(fj.reviewer_flags).toBe('check sources');
  });

  test('accepts level codes and reports out-of-vocabulary levels without storing them', () => {
    const db = getDb();
    seed(db);
    const ok = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', rubric_scores: { 'ART.5.1': 'ex' } });
    expect(JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(ok.feedback_id).feedback_json).rubric_scores).toEqual({ 'ART.5.1': 'EX' });

    const bad = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', rubric_scores: { 'ART.5.1': 'Amazing' } });
    expect(JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(bad.feedback_id).feedback_json).rubric_scores).toEqual({});
    expect(bad.message).toMatch(/out-of-vocabulary/i);
  });

  test('resolves topic keys by external_id or title and reports unresolved keys', () => {
    const db = getDb();
    seed(db);
    const r = upsertStudentSuggestion(db, {
      assignmentId: 'sa-1', student: 'uid-1',
      rubric_scores: { 'Generates media': 'Developing', 'ART.9.9': 'ED' },
    });
    expect(JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(r.feedback_id).feedback_json).rubric_scores)
      .toEqual({ 'Generates media': 'D' });
    expect(r.unresolved_topics).toEqual(['ART.9.9']);
  });

  test('re-grade upserts one row, re-activates as draft, and pushes prior content to revision_history', () => {
    const db = getDb();
    const { studentId, assignmentLocalId } = seed(db);
    const first = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'v1', rubric_scores: { 'ART.5.1': 'EX' } });
    db.prepare(`UPDATE feedback SET status = 'approved' WHERE id = ?`).run(first.feedback_id);

    const second = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'v2', rubric_scores: { 'ART.5.1': 'ED' } });
    expect(second.feedback_id).toBe(first.feedback_id);
    expect(db.prepare('SELECT COUNT(*) n FROM feedback WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentLocalId).n).toBe(1);

    const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(first.feedback_id);
    expect(row.status).toBe('draft');
    expect(JSON.parse(row.feedback_json).narrative_feedback).toBe('v2');
    const history = JSON.parse(row.revision_history);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('approved');
    expect(JSON.parse(history[0].feedback_json).narrative_feedback).toBe('v1');
  });

  test('never touches mastery_scores or grades', () => {
    const db = getDb();
    const { studentId, assignmentLocalId } = seed(db);
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('uid-1', 'sa-1', 'topic-1', 75, 'EX')`).run();
    db.prepare(`INSERT INTO grades (student_id, assignment_id, score, grade_comment) VALUES (?, ?, 88, 'teacher comment')`).run(studentId, assignmentLocalId);

    upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'x', rubric_scores: { 'ART.5.1': 'ED' } });

    expect(db.prepare(`SELECT points, grade FROM mastery_scores WHERE student_uid = 'uid-1' AND topic_id = 'topic-1'`).get()).toEqual({ points: 75, grade: 'EX' });
    expect(db.prepare('SELECT score, grade_comment FROM grades WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentLocalId))
      .toEqual({ score: 88, grade_comment: 'teacher comment' });
  });
});

describe('writeStudentSuggestions', () => {
  test('writes the batch and returns a per-student written/error summary', () => {
    const db = getDb();
    seed(db);
    const { results } = writeStudentSuggestions(db, {
      assignmentId: 'sa-1',
      students: [
        { student: 'uid-1', narrative_feedback: 'ok', rubric_scores: { 'ART.5.1': 'ED' } },
        { student: 'uid-missing', narrative_feedback: 'nope' },
      ],
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ student: 'uid-1', status: 'written' });
    expect(results[1]).toMatchObject({ student: 'uid-missing', status: 'error' });
    expect(results[1].message).toMatch(/not found/i);
  });
});
