import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { upsertStudentSuggestion, writeStudentSuggestions, upsertAssessmentAnalysis } from './suggestions.js';
import { saveRubric } from './rubricStore.js';
import { recordServe } from './contextServes.js';

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
    'DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM rubric_criteria; DELETE FROM rubrics; ' +
    'DELETE FROM assessment_analysis; DELETE FROM context_serves; DELETE FROM feedback; DELETE FROM mastery_alignments; ' +
    'DELETE FROM mastery_scores; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
    'DELETE FROM grades; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
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

  test('a suggestion stores the task_synced_at of its assignment as data_as_of', () => {
    const db = getDb();
    const { assignmentLocalId } = seed(db);
    db.prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run('2026-10-20T09:00:00.000Z', assignmentLocalId);

    const result = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'Good.' });

    expect(db.prepare('SELECT data_as_of FROM feedback WHERE id = ?').get(result.feedback_id).data_as_of).toBe('2026-10-20T09:00:00.000Z');
  });

  test("a suggestion for a task that was never synced stores 'never' as data_as_of", () => {
    const db = getDb();
    seed(db);
    const result = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'Good.' });
    expect(db.prepare('SELECT data_as_of FROM feedback WHERE id = ?').get(result.feedback_id).data_as_of).toBe('never');
  });

  test('a suggestion stamps suggested_at on write and again on rewrite', () => {
    vi.useFakeTimers();
    try {
      const db = getDb();
      seed(db);
      vi.setSystemTime(new Date('2026-10-20T10:00:00.000Z'));
      const first = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'First.' });
      expect(db.prepare('SELECT suggested_at FROM feedback WHERE id = ?').get(first.feedback_id).suggested_at).toBe('2026-10-20T10:00:00.000Z');
      vi.setSystemTime(new Date('2026-10-20T11:00:00.000Z'));
      upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'Second.' });
      expect(db.prepare('SELECT suggested_at FROM feedback WHERE id = ?').get(first.feedback_id).suggested_at).toBe('2026-10-20T11:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a rewrite updates data_as_of', () => {
    const db = getDb();
    const { assignmentLocalId } = seed(db);
    db.prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run('2026-10-20T09:00:00.000Z', assignmentLocalId);
    const first = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'First.' });

    db.prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run('2026-10-20T10:25:00.000Z', assignmentLocalId);
    const second = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'Second.' });

    expect(second.feedback_id).toBe(first.feedback_id);
    expect(db.prepare('SELECT data_as_of FROM feedback WHERE id = ?').get(second.feedback_id).data_as_of).toBe('2026-10-20T10:25:00.000Z');
  });

  test('a context_id sets data_as_of and suggested_at from that serve, not task_synced_at and the write time', () => {
    const db = getDb();
    const { assignmentLocalId } = seed(db);
    db.prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run('2026-10-20T10:20:00.000Z', assignmentLocalId);
    const contextId = recordServe(db, { assignmentId: assignmentLocalId, dataAsOf: '2026-10-20T09:00:00.000Z', now: '2026-10-20T09:05:00.000Z' });
    const result = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'Good.', contextId });
    expect(db.prepare('SELECT data_as_of, suggested_at FROM feedback WHERE id = ?').get(result.feedback_id))
      .toEqual({ data_as_of: '2026-10-20T09:00:00.000Z', suggested_at: '2026-10-20T09:05:00.000Z' });
  });

  test("a context_id for a never-synced task stores 'never', even once the task has since been synced", () => {
    const db = getDb();
    const { assignmentLocalId } = seed(db);
    db.prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run('2026-10-20T10:20:00.000Z', assignmentLocalId);
    const contextId = recordServe(db, { assignmentId: assignmentLocalId, dataAsOf: 'never', now: '2026-10-20T09:05:00.000Z' });
    const result = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'Good.', contextId });
    expect(db.prepare('SELECT data_as_of FROM feedback WHERE id = ?').get(result.feedback_id).data_as_of).toBe('never');
  });

  test("another assignment's context_id is an error for the student and writes nothing", () => {
    const db = getDb();
    const { courseId, assignmentLocalId } = seed(db);
    const other = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-2', 'Other')`).run(courseId).lastInsertRowid;
    const contextId = recordServe(db, { assignmentId: other, dataAsOf: '2026-10-20T09:00:00.000Z' });
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'Good.', contextId });
    expect(r).toMatchObject({ student: 'uid-1', status: 'error' });
    expect(r.message).toMatch(/another assignment/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE assignment_id = ?').get(assignmentLocalId).n).toBe(0);
  });

  test('an unknown context_id falls back to the oldest serve in 3 hours and the result says so', () => {
    const db = getDb();
    const { assignmentLocalId } = seed(db);
    const now = new Date();
    recordServe(db, { assignmentId: assignmentLocalId, dataAsOf: new Date(now - 100 * 60000).toISOString(), now: new Date(now - 90 * 60000).toISOString() });
    recordServe(db, { assignmentId: assignmentLocalId, dataAsOf: new Date(now - 6 * 60000).toISOString(), now: new Date(now - 5 * 60000).toISOString() });
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'Good.', contextId: 987654 });
    expect(r.status).toBe('written');
    expect(r.message).toMatch(/context_id 987654/);
    expect(db.prepare('SELECT data_as_of, suggested_at FROM feedback WHERE id = ?').get(r.feedback_id))
      .toEqual({ data_as_of: new Date(now - 100 * 60000).toISOString(), suggested_at: new Date(now - 90 * 60000).toISOString() });
  });

  test('two sessions, one stored and one fresh, each write with their own context_id', () => {
    const db = getDb();
    const { assignmentLocalId } = seed(db);
    const storedId = recordServe(db, { assignmentId: assignmentLocalId, dataAsOf: '2026-10-17T10:00:00.000Z', now: '2026-10-20T09:00:00.000Z' });
    const freshId = recordServe(db, { assignmentId: assignmentLocalId, dataAsOf: '2026-10-20T09:29:00.000Z', now: '2026-10-20T09:30:00.000Z' });
    const a = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'A.', contextId: storedId });
    expect(db.prepare('SELECT data_as_of, suggested_at FROM feedback WHERE id = ?').get(a.feedback_id))
      .toEqual({ data_as_of: '2026-10-17T10:00:00.000Z', suggested_at: '2026-10-20T09:00:00.000Z' });
    const b = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'B.', contextId: freshId });
    expect(db.prepare('SELECT data_as_of, suggested_at FROM feedback WHERE id = ?').get(b.feedback_id))
      .toEqual({ data_as_of: '2026-10-20T09:29:00.000Z', suggested_at: '2026-10-20T09:30:00.000Z' });
  });

  test('writeStudentSuggestions passes the context_id to every student', () => {
    const db = getDb();
    const { assignmentLocalId } = seed(db);
    const contextId = recordServe(db, { assignmentId: assignmentLocalId, dataAsOf: '2026-10-20T09:00:00.000Z', now: '2026-10-20T09:05:00.000Z' });
    const { results } = writeStudentSuggestions(db, { assignmentId: 'sa-1', contextId, students: [{ student: 'uid-1', narrative_feedback: 'Good.' }] });
    expect(results[0].status).toBe('written');
    expect(db.prepare('SELECT data_as_of, suggested_at FROM feedback WHERE id = ?').get(results[0].feedback_id))
      .toEqual({ data_as_of: '2026-10-20T09:00:00.000Z', suggested_at: '2026-10-20T09:05:00.000Z' });
  });

  test('writeStudentSuggestions notes a fallback once for the batch when no context_id was passed; upsertStudentSuggestion alone stays quiet', () => {
    const db = getDb();
    const { assignmentLocalId } = seed(db);
    const NOTE = 'No context_id was passed, so the oldest read of this task in the last 3 hours was used. Pass the context_id from get_assignment_context.';
    const students = [{ student: 'uid-1', narrative_feedback: 'Good.' }, { student: 'uid-1', narrative_feedback: 'Fine.' }];
    // No serve either: nothing to note.
    const none = writeStudentSuggestions(db, { assignmentId: 'sa-1', students });
    expect(none.note).toBeUndefined();
    expect(none.results[0].message).toBeUndefined();
    recordServe(db, { assignmentId: assignmentLocalId, dataAsOf: new Date(Date.now() - 6 * 60000).toISOString(), now: new Date(Date.now() - 5 * 60000).toISOString() });
    const r = writeStudentSuggestions(db, { assignmentId: 'sa-1', students });
    expect(r.note).toBe(NOTE);
    expect(r.results.map(x => x.message)).toEqual([undefined, undefined]);
    expect(upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'Good.' }).message).toBeUndefined();
    // With a context_id the note does not appear.
    const contextId = recordServe(db, { assignmentId: assignmentLocalId, dataAsOf: new Date().toISOString() });
    const withId = writeStudentSuggestions(db, { assignmentId: 'sa-1', students, contextId });
    expect(withId.note).toBeUndefined();
    expect(withId.results[0].message).toBeUndefined();
  });

  test('writeStudentSuggestions says an unknown context_id once for the batch and keeps per-student messages that differ', () => {
    const db = getDb();
    const { assignmentLocalId } = seed(db);
    recordServe(db, { assignmentId: assignmentLocalId, dataAsOf: new Date(Date.now() - 6 * 60000).toISOString(), now: new Date(Date.now() - 5 * 60000).toISOString() });
    const r = writeStudentSuggestions(db, { assignmentId: 'sa-1', contextId: 987654, students: [
      { student: 'uid-1', narrative_feedback: 'Good.' },
      { student: 'uid-1', narrative_feedback: 'Again.', rubric_scores: { 'ART.5.1': 'Amazing' } },
      { student: 'nobody', narrative_feedback: 'x' },
    ] });
    expect(r.note).toMatch(/context_id 987654/);
    expect(r.results[0].message).toBeUndefined();
    expect(r.results[1].message).toMatch(/out-of-vocabulary/i);
    expect(r.results[1].message).not.toMatch(/987654/);
    expect(r.results[2].message).toMatch(/Student not found/);
  });

  test('a serve older than 3 hours is never copied by the fallback', () => {
    const db = getDb();
    const { assignmentLocalId } = seed(db);
    db.prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run('2026-10-20T10:20:00.000Z', assignmentLocalId);
    recordServe(db, { assignmentId: assignmentLocalId, dataAsOf: '2026-10-01T09:00:00.000Z', now: new Date(Date.now() - 4 * 3600 * 1000).toISOString() });
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'Good.' });
    expect(db.prepare('SELECT data_as_of FROM feedback WHERE id = ?').get(r.feedback_id).data_as_of).toBe('2026-10-20T10:20:00.000Z');
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

  test('caller-supplied score is ignored (not written to feedback.score)', () => {
    const db = getDb();
    seed(db);
    const res = upsertStudentSuggestion(db, {
      assignmentId: 'sa-1', student: 'uid-1', rubric_scores: { 'ART.5.1': 'ED' }, score: 92,
    });
    expect(res.status).toBe('written');
    const row = db.prepare('SELECT score FROM feedback WHERE id = ?').get(res.feedback_id);
    expect(row.score).toBeNull();
  });

  test('numeric rubric_scores value is rejected with an instructive message', () => {
    const db = getDb();
    seed(db);
    const res = upsertStudentSuggestion(db, {
      assignmentId: 'sa-1', student: 'uid-1', rubric_scores: { 'ART.5.1': '75' },
    });
    expect(res.message).toMatch(/emit proficiency levels/i);
    const row = db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(res.feedback_id);
    expect(JSON.parse(row.feedback_json).rubric_scores).toEqual({});
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

describe('upsertAssessmentAnalysis', () => {
  test('upserts the single assessment_analysis row in the UI shape (one row, moderation optional)', () => {
    const db = getDb();
    const { assignmentLocalId } = seed(db);

    const r1 = upsertAssessmentAnalysis(db, {
      assignmentId: 'sa-1',
      noticings: [{ title: 'AI use', body: 'half the class leaned on it' }],
      moderation_note: 'spot-check the borderline EX/D calls',
    });
    expect(r1).toMatchObject({ status: 'written', assignment_id: assignmentLocalId });
    expect(JSON.parse(db.prepare('SELECT analysis_json FROM assessment_analysis WHERE assignment_id = ?').get(assignmentLocalId).analysis_json))
      .toEqual({ noticings: [{ title: 'AI use', body: 'half the class leaned on it' }], moderation_note: 'spot-check the borderline EX/D calls' });

    // Re-run upserts (PK is assignment_id → one row); moderation omitted when absent.
    upsertAssessmentAnalysis(db, { assignmentId: 'sa-1', noticings: [{ title: 'Integrity', body: 'all original' }] });
    const all = db.prepare('SELECT analysis_json FROM assessment_analysis WHERE assignment_id = ?').all(assignmentLocalId);
    expect(all).toHaveLength(1);
    expect(JSON.parse(all[0].analysis_json)).toEqual({ noticings: [{ title: 'Integrity', body: 'all original' }] });
  });

  test('reports an error for an unknown assignment', () => {
    expect(upsertAssessmentAnalysis(getDb(), { assignmentId: 'no-such', noticings: [] }))
      .toMatchObject({ status: 'error' });
  });
});

describe('scale-level suggestions for unaligned assignments (#41)', () => {
  function seedCompletion(db) {
    const { courseId } = seed(db);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-C', 'Homework', '7165818')`).run(courseId);
  }
  const fj = (db, id) => JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(id).feedback_json);

  test('stores a label or code as the scale\'s level code, with the evidence note', () => {
    const db = getDb();
    seedCompletion(db);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-C', student: 'uid-1', scale_level: 'Completed', evidence: 'Codecademy: lesson 4 done 26/09' });
    expect(r.status).toBe('written');
    expect(fj(db, r.feedback_id)).toMatchObject({ scale_level: 'C', evidence: 'Codecademy: lesson 4 done 26/09' });
  });

  test('reports (never stores) a level outside the assignment\'s scale', () => {
    const db = getDb();
    seedCompletion(db);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-C', student: 'uid-1', scale_level: 'Done' });
    expect(fj(db, r.feedback_id).scale_level).toBeNull();
    expect(r.message).toMatch(/Completed, Incomplete/);
  });

  test('reports a scale_level sent for an assignment that is not graded on a scale', () => {
    const db = getDb();
    seed(db);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', scale_level: 'Completed' });
    expect(fj(db, r.feedback_id).scale_level).toBeNull();
    expect(r.message).toMatch(/not graded on a scale/i);
  });
});

describe('reviewer_flags_brief — flags at a glance', () => {
  test('stores the agent\'s short flag lines beside the full reviewer_flags', () => {
    const db = getDb();
    seed(db);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1',
      reviewer_flags: 'Long detail one. More.\nLong detail two.', reviewer_flags_brief: ['Detail one', 'Detail two'] });
    const fj = JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(r.feedback_id).feedback_json);
    expect(fj.reviewer_flags_brief).toEqual(['Detail one', 'Detail two']);
  });

  test('defaults to [] when omitted', () => {
    const db = getDb();
    seed(db);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', reviewer_flags: 'x' });
    expect(JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(r.feedback_id).feedback_json).reviewer_flags_brief).toEqual([]);
  });
});

describe('suggestion_state across agent re-runs', () => {
  const state = (db, id) => db.prepare('SELECT suggestion_state FROM feedback WHERE id = ?').get(id).suggestion_state;

  test('a re-run that changes the narrative after the teacher used/ignored it marks it revised', () => {
    const db = getDb();
    seed(db);
    for (const prior of ['used', 'ignored']) {
      const r = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: `v1 ${prior}` });
      db.prepare('UPDATE feedback SET suggestion_state = ? WHERE id = ?').run(prior, r.feedback_id);
      upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: `v2 ${prior}` });
      expect(state(db, r.feedback_id)).toBe('revised');
    }
  });

  test('a re-run with the same narrative keeps the teacher\'s state', () => {
    const db = getDb();
    seed(db);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'same' });
    db.prepare(`UPDATE feedback SET suggestion_state = 'ignored' WHERE id = ?`).run(r.feedback_id);
    upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'same', strengths: ['new'] });
    expect(state(db, r.feedback_id)).toBe('ignored');
  });

  test('a never-handled suggestion stays unhandled (null) on a re-run', () => {
    const db = getDb();
    seed(db);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'a' });
    upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'b' });
    expect(state(db, r.feedback_id)).toBeNull();
  });
});

test('quiz_overall is stored in feedback_json when given, and absent otherwise', () => {
  const db = getDb();
  seed(db);
  const a = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'n', quiz_overall: { group_id: 4, impression: 'Good.' } });
  expect(JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(a.feedback_id).feedback_json).quiz_overall).toEqual({ group_id: 4, impression: 'Good.' });
  const b = upsertStudentSuggestion(db, { assignmentId: 'sa-1', student: 'uid-1', narrative_feedback: 'n2' });
  expect(JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(b.feedback_id).feedback_json)).not.toHaveProperty('quiz_overall');
});

describe('row suggestions on a task with feedback rows', () => {
  function seedRows(db) {
    const { courseId } = seed(db);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-F', 'Flappy (F)', '23495360')`).run(courseId);
    const rubricId = saveRubric(db, { name: 'Flappy', source: 'mcp', criteria: [
      { position: 1, criterion_name: 'Features and Code', standard_title: 'Anchor Standard 5: Develop', reporting_category: 'PRODUCE' },
      { position: 2, criterion_name: 'Playtesting', standard_title: 'Anchor Standard 3: Refine', reporting_category: 'CREATE' },
    ] });
    db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-F', ?, 'now')`).run(rubricId, courseId);
  }
  const fj = (db, id) => JSON.parse(db.prepare('SELECT feedback_json FROM feedback WHERE id = ?').get(id).feedback_json);

  test('stores row levels under the exact criterion name, from a name in any case or the standard text', () => {
    const db = getDb();
    seedRows(db);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-F', student: 'uid-1',
      rubric_scores: { 'features and code': 'Exhibiting', 'Anchor Standard 3: Refine': 'ED' } });
    expect(r.unresolved_rows).toBeUndefined();
    expect(fj(db, r.feedback_id).rubric_scores).toEqual({ 'Features and Code': 'EX', Playtesting: 'ED' });
  });

  test('reports an unknown row with the valid names, keeps the rest, and stores an optional scale_level', () => {
    const db = getDb();
    seedRows(db);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-F', student: 'uid-1',
      rubric_scores: { Evaluation: 'EX', Playtesting: 'IE' }, scale_level: 'Developing' });
    expect(r.unresolved_rows).toEqual(['Evaluation']);
    expect(r.message).toMatch(/Features and Code, Playtesting/);
    expect(fj(db, r.feedback_id)).toMatchObject({ rubric_scores: { Playtesting: 'IE' }, scale_level: 'D' });
  });

  test('a score-scale task with no rubric states that one must be attached', () => {
    const db = getDb();
    const { courseId } = seed(db);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-G', 'Plain (F)', '23495360')`).run(courseId);
    const r = upsertStudentSuggestion(db, { assignmentId: 'sa-G', student: 'uid-1', rubric_scores: { Playtesting: 'EX' } });
    expect(r.unresolved_topics).toEqual(['Playtesting']);
    expect(r.message).toMatch(/attach a rubric/i);
  });
});
