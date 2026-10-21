import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { getAssessmentContext, getGradeMetaRows, normalizeSubmissionStatus, gradingState, getFlagsByStudent } from './assessmentContext.js';
import { requestResubmission } from './resubmissions.js';
import { saveRubric } from './rubricStore.js';
import { saveRowLevels } from './feedbackRows.js';

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
    JSON.stringify({ narrative_feedback: 'Strong concept', rubric_scores: { 'ART.5.1': 'ED' }, reviewer_flags: 'check sources', strengths: ['Clear concept', 'Good docs'], suggestions: ['Add tests', 'Tighten UI'] })
  );
  // Draft teacher feedback: one staged proficiency, one staged removal, a comment.
  db.prepare(`INSERT INTO assessment_drafts (assignment_id, student_id, enrolment_id, draft_json) VALUES (?, ?, 'enr-1', ?)`).run(
    assignmentId, studentId,
    JSON.stringify({ pending: { 'topic-1': 'D', 'topic-9': '__remove__' }, comment: 'draft note', display: true, displayTouched: true, base: 'b1' })
  );
  return { courseId, assignmentId, studentId };
}

beforeEach(() => {
  getDb().exec(
    'DELETE FROM student_ps_alerts; DELETE FROM student_powerschool; ' +
    'DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM rubric_criteria; DELETE FROM rubrics; ' +
    'DELETE FROM status_lines; DELETE FROM resubmissions; DELETE FROM assessment_drafts; DELETE FROM assessment_analysis; DELETE FROM feedback; DELETE FROM mastery_alignments; DELETE FROM mastery_scores; ' +
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
      strengths: ['Clear concept', 'Good docs'],
      suggestions: ['Add tests', 'Tighten UI'],
    });
  });

  test('existing_suggestion defaults strengths/suggestions to [] when the feedback row omits them', () => {
    const db = getDb();
    const { assignmentId, studentId } = seedContext(db);
    db.prepare('DELETE FROM feedback WHERE assignment_id = ?').run(assignmentId);
    db.prepare(`INSERT INTO feedback (student_id, assignment_id, status, feedback_json) VALUES (?, ?, 'draft', ?)`).run(
      studentId, assignmentId, JSON.stringify({ narrative_feedback: 'x', rubric_scores: {}, reviewer_flags: null })
    );

    const sug = getAssessmentContext(db, { assignmentId: 'sa-1' }).students[0].existing_suggestion;

    expect(sug.strengths).toEqual([]);
    expect(sug.suggestions).toEqual([]);
  });

  test('includes the class-level assessment_analysis (noticings + moderation_note) when present', () => {
    const db = getDb();
    const { assignmentId } = seedContext(db);
    db.prepare(
      `INSERT INTO assessment_analysis (assignment_id, analysis_json, created_at, updated_at) VALUES (?, ?, '2026-06-14', '2026-06-14')`
    ).run(
      assignmentId,
      JSON.stringify({
        noticings: [{ title: 'AI use', body: 'Half the class used AI.' }],
        moderation_note: '- Graded from slides\n- Distribution is generous',
      })
    );

    const ctx = getAssessmentContext(db, { assignmentId: 'sa-1' });

    expect(ctx.assessment_analysis).toEqual({
      noticings: [{ title: 'AI use', body: 'Half the class used AI.' }],
      moderation_note: '- Graded from slides\n- Distribution is generous',
    });
  });

  test('assessment_analysis is null when no analysis row exists', () => {
    const db = getDb();
    seedContext(db);
    expect(getAssessmentContext(db, { assignmentId: 'sa-1' }).assessment_analysis).toBeNull();
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

  test('surfaces the teacher draft as draft_feedback, splitting picks from removals', () => {
    const db = getDb();
    seedContext(db);
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-1' });
    expect(ctx.students[0].draft_feedback).toMatchObject({
      rubric_scores: { 'topic-1': 'D' },
      removed_topics: ['topic-9'],
      comment: 'draft note',
      display_to_student: true,
    });
  });

  test('draft_feedback is null when no draft row exists', () => {
    const db = getDb();
    seedContext(db);
    db.prepare('DELETE FROM assessment_drafts').run();
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-1' });
    expect(ctx.students[0].draft_feedback).toBeNull();
  });

  test('per-student includes submission_status, grading_state, is_lti, due_date, and flags', () => {
    const db = getDb();
    const { courseId, assignmentId, studentId } = seedContext(db);
    // Make the assignment LTI with a due date and a submitted state for the student.
    db.prepare(`UPDATE assignments SET is_lti_submission = 1, due_date = '2026-06-01' WHERE id = ?`).run(assignmentId);
    db.prepare(`UPDATE grades SET lti_submission_state = 'submitted' WHERE student_id = ? AND assignment_id = ?`).run(studentId, assignmentId);

    const ctx = getAssessmentContext(db, { courseId, assignmentId: 'sa-1' });
    const s = ctx.students[0];
    expect(s.submission_status).toBe('submitted');
    expect(s.grading_state).toBe('complete'); // one aligned topic scored + comment present
    expect(s.is_lti).toBe(true);
    expect(s.due_date).toBe('2026-06-01');
    expect(s.flags).toEqual({ resubmit_requested: false }); // Flag for review is gone (#40): no review_needed key
  });

  test('M3: a comment that is only Prism\'s stored status line does not make grading_state complete', () => {
    const db = getDb();
    const { courseId, assignmentId, studentId } = seedContext(db);
    const line = 'Resubmission requested - due Thu 15/10.';
    db.prepare('UPDATE grades SET grade_comment = ? WHERE student_id = ?').run(line, studentId);
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'ask')`).run(studentId, assignmentId, line);
    expect(getAssessmentContext(db, { courseId, assignmentId: 'sa-1' }).students[0].grading_state).toBe('partial');
    db.prepare('UPDATE grades SET grade_comment = ? WHERE student_id = ?').run(`${line}\n\nNice work`, studentId);
    expect(getAssessmentContext(db, { courseId, assignmentId: 'sa-1' }).students[0].grading_state).toBe('complete');
  });

  test('an open resubmission request surfaces as flags.resubmit_requested and a resubmission object', () => {
    const db = getDb();
    const { courseId, assignmentId, studentId } = seedContext(db);
    const request = requestResubmission(db, { studentId, assignmentId, source: 'app' });

    const ctx = getAssessmentContext(db, { courseId, assignmentId: 'sa-1' });
    const s = ctx.students[0];
    expect(s.flags.resubmit_requested).toBe(true);
    expect(s.resubmission).toEqual({ state: 'waiting', deadline: request.until, source: 'app' });
  });

  test('per-student includes the student email (for roster / email-list use cases)', () => {
    const db = getDb();
    const { courseId, studentId } = seedContext(db);
    db.prepare(`UPDATE students SET email = 'ada@hkis.edu.hk' WHERE id = ?`).run(studentId);
    const ctx = getAssessmentContext(db, { courseId, assignmentId: 'sa-1' });
    expect(ctx.students[0].email).toBe('ada@hkis.edu.hk');
  });

  test('per-student carries submission timestamps (ISO) for both non-LTI and LTI (#125)', () => {
    const db = getDb();
    const { courseId, assignmentId, studentId } = seedContext(db);
    db.prepare(`UPDATE grades SET submission_type = 'drop', submitted_at = 1700000000, latest_revision_at = 1700000500, first_submitted_at = 1700000400 WHERE student_id = ? AND assignment_id = ?`).run(studentId, assignmentId);

    // non-LTI: the latest dropbox revision, never the REST grade time (2026-10-19)
    let s = getAssessmentContext(db, { courseId, assignmentId: 'sa-1' }).students[0];
    expect(s.submitted_at).toBe(new Date(1700000500 * 1000).toISOString());
    expect(s.latest_revision_at).toBe(new Date(1700000500 * 1000).toISOString());
    expect(s.first_submitted_at).toBe(new Date(1700000400 * 1000).toISOString());

    // LTI: submitted_at stays the REST grade time (owned by upsertGrade); the
    // grader's authoritative submission time lives in latest_revision_at — so for
    // LTI the surfaced submitted_at tracks latest_revision_at, not the REST value
    // (triage resubmissions, 2026-10-03).
    db.prepare(`UPDATE assignments SET is_lti_submission = 1 WHERE id = ?`).run(assignmentId);
    db.prepare(`UPDATE grades SET lti_submission_state = 'submitted' WHERE student_id = ? AND assignment_id = ?`).run(studentId, assignmentId);
    s = getAssessmentContext(db, { courseId, assignmentId: 'sa-1' }).students[0];
    expect(s.submitted_at).toBe(new Date(1700000500 * 1000).toISOString());
    expect(s.latest_revision_at).toBe(new Date(1700000500 * 1000).toISOString());
  });

  test('LTI submitted_at tracks latest_revision_at (the submission time) even when it differs from the REST grade time (triage resubmissions)', () => {
    const db = getDb();
    const { courseId, assignmentId, studentId } = seedContext(db);
    db.prepare(`UPDATE assignments SET is_lti_submission = 1 WHERE id = ?`).run(assignmentId);
    db.prepare(`UPDATE grades SET submitted_at = 2000, latest_revision_at = 3000, lti_submission_state = 'submitted' WHERE student_id = ? AND assignment_id = ?`).run(studentId, assignmentId);

    const s = getAssessmentContext(db, { courseId, assignmentId: 'sa-1' }).students[0];
    expect(s.submitted_at).toBe(new Date(3000 * 1000).toISOString());
    expect(s.latest_revision_at).toBe(new Date(3000 * 1000).toISOString());
  });

  test('unsubmitted since (back in progress): the stored time is history, not a current submission', () => {
    const db = getDb();
    const { courseId, assignmentId, studentId } = seedContext(db);
    db.prepare(`UPDATE assignments SET is_lti_submission = 1 WHERE id = ?`).run(assignmentId);
    db.prepare(`UPDATE grades SET latest_revision_at = 3000, first_submitted_at = 3000, late = 1, lti_submission_state = 'in_progress' WHERE student_id = ? AND assignment_id = ?`).run(studentId, assignmentId);
    const s = getAssessmentContext(db, { courseId, assignmentId: 'sa-1' }).students[0];
    expect(s).toMatchObject({ submission_status: 'in_progress', submitted_at: null, latest_revision_at: null, first_submitted_at: null });
  });

  test('a teacher comment alone (grade time, no revision) is not a submission', () => {
    const db = getDb();
    const { courseId, studentId, assignmentId } = seedContext(db);
    db.prepare(`UPDATE assignments SET accepts_submissions = 1 WHERE id = ?`).run(assignmentId);
    db.prepare(`UPDATE grades SET submitted_at = 1700000000 WHERE student_id = ? AND assignment_id = ?`).run(studentId, assignmentId);
    const s = getAssessmentContext(db, { courseId, assignmentId: 'sa-1' }).students[0];
    expect(s).toMatchObject({ submission_status: 'not_started', submitted_at: null });
  });

  test('LTI with no captured submission time still surfaces null timestamps (#125)', () => {
    const db = getDb();
    const { courseId, assignmentId, studentId } = seedContext(db);
    // not_started/in_progress lti cell: state but no submitted_at (stays 0)
    db.prepare(`UPDATE assignments SET is_lti_submission = 1 WHERE id = ?`).run(assignmentId);
    db.prepare(`UPDATE grades SET lti_submission_state = 'not_started', submitted_at = 0, latest_revision_at = 0 WHERE student_id = ? AND assignment_id = ?`).run(studentId, assignmentId);

    const s = getAssessmentContext(db, { courseId, assignmentId: 'sa-1' }).students[0];
    expect(s.submitted_at).toBeNull();
    expect(s.latest_revision_at).toBeNull();
  });
});

describe('getGradeMetaRows', () => {
  test('selects the submission-status columns', () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-g', 'ROB')`).run().lastInsertRowid;
    const assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-g', 'Notebook')`).run(courseId).lastInsertRowid;
    const studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-g', 'Grace', 'Hopper')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-g')`).run(studentId, courseId);
    db.prepare(`INSERT INTO grades (student_id, assignment_id, lti_submission_state, submission_type, late, draft, submitted_at)
                VALUES (?, ?, 'in_progress', 'drop', 1, 0, 123)`).run(studentId, assignmentId);

    const rows = getGradeMetaRows(db, 'sa-g');
    expect(rows[0]).toMatchObject({
      schoology_uid: 'uid-g',
      lti_submission_state: 'in_progress',
      submission_type: 'drop',
      late: 1,
      draft: 0,
    });
  });
});

describe('normalizeSubmissionStatus', () => {
  test('LTI uses lti_submission_state', () => {
    expect(normalizeSubmissionStatus({ is_lti_submission: 1, lti_submission_state: 'in_progress' })).toBe('in_progress');
    expect(normalizeSubmissionStatus({ is_lti_submission: 1, lti_submission_state: 'submitted' })).toBe('submitted');
  });
  test('LTI with no state but a submission_type counts as submitted', () => {
    expect(normalizeSubmissionStatus({ is_lti_submission: 1, lti_submission_state: null, submission_type: 'drop' })).toBe('submitted');
  });
  test('LTI with nothing is unknown', () => {
    expect(normalizeSubmissionStatus({ is_lti_submission: 1, lti_submission_state: null, submission_type: null })).toBe('unknown');
  });
  test('non-LTI: a real submission signal only; the grade time is not one; paper work is not tracked', () => {
    expect(normalizeSubmissionStatus({ is_lti_submission: 0, submission_type: 'drop' })).toBe('submitted');
    expect(normalizeSubmissionStatus({ is_lti_submission: 0, is_test: 1, test_attempt: 'took' })).toBe('submitted');
    expect(normalizeSubmissionStatus({ is_lti_submission: 0, accepts_submissions: 1, submitted_at: 5 })).toBe('not_started'); // grade time only
    expect(normalizeSubmissionStatus({ is_lti_submission: 0, submission_type: null, submitted_at: 0 })).toBe('not_started');
    expect(normalizeSubmissionStatus({ is_lti_submission: 0, accepts_submissions: 0, submitted_at: 5 })).toBe('not_tracked');
    expect(normalizeSubmissionStatus({ is_lti_submission: 0, accepts_submissions: 0, is_test: 1 })).toBe('not_started'); // a test is tracked by attempt
  });
});

describe('getFlagsByStudent', () => {
  test('carries only resubmit_requested, from an open resubmission request (Flag for review is gone, #40)', () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-f', 'ROB')`).run().lastInsertRowid;
    const assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-f', 'NB')`).run(courseId).lastInsertRowid;
    const sId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-f', 'Ada', 'L')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-f')`).run(sId, courseId);
    requestResubmission(db, { studentId: sId, assignmentId, source: 'app' });

    const byStudent = getFlagsByStudent(db, assignmentId);
    expect(byStudent[sId]).toEqual({ resubmit_requested: true });
    expect(byStudent[sId]).not.toHaveProperty('review_needed');
  });

  test('a student with no open request has no entry', () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-g', 'ROB')`).run().lastInsertRowid;
    const assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-g', 'NB')`).run(courseId).lastInsertRowid;
    expect(getFlagsByStudent(db, assignmentId)).toEqual({});
  });
});

describe('gradingState', () => {
  test('excepted is complete regardless of scores', () => {
    expect(gradingState({ scoredCount: 0, topicsCount: 3, hasComment: false, exception: 3 })).toBe('complete');
  });
  test('exception 4 is no flag: ungraded until graded', () => {
    expect(gradingState({ scoredCount: 0, topicsCount: 2, hasComment: false, exception: 4 })).toBe('ungraded');
  });
  test('only the final flags (Exempt, Missing) are complete; a marker grades like no flag (#40)', () => {
    for (const exception of [1, 3]) {
      expect(gradingState({ scoredCount: 0, topicsCount: 2, hasComment: false, exception })).toBe('complete');
    }
    for (const exception of [2, 5, 6]) {
      expect(gradingState({ scoredCount: 0, topicsCount: 2, hasComment: false, exception })).toBe('ungraded');
      expect(gradingState({ scoredCount: 1, topicsCount: 2, hasComment: true, exception })).toBe('partial');
      expect(gradingState({ scoredCount: 2, topicsCount: 2, hasComment: true, exception })).toBe('complete');
    }
  });
  test('all topics scored + comment is complete', () => {
    expect(gradingState({ scoredCount: 3, topicsCount: 3, hasComment: true, exception: 0 })).toBe('complete');
  });
  test('nothing entered is ungraded', () => {
    expect(gradingState({ scoredCount: 0, topicsCount: 3, hasComment: false, exception: 0 })).toBe('ungraded');
  });
  test('some topics missing a level is partial', () => {
    expect(gradingState({ scoredCount: 2, topicsCount: 3, hasComment: true, exception: 0 })).toBe('partial');
  });
  test('all scored but no comment is partial', () => {
    expect(gradingState({ scoredCount: 3, topicsCount: 3, hasComment: false, exception: 0 })).toBe('partial');
  });
  test('zero aligned topics with a comment is complete (nothing to score per-topic)', () => {
    expect(gradingState({ scoredCount: 0, topicsCount: 0, hasComment: true, exception: 0 })).toBe('complete');
  });
  test('zero aligned topics with nothing entered is ungraded', () => {
    expect(gradingState({ scoredCount: 0, topicsCount: 0, hasComment: false, exception: 0 })).toBe('ungraded');
  });
});

describe('getAssessmentContext — score-scale assignments (#41)', () => {
  test('exposes the scale (best → worst), each student\'s current level, and a scale suggestion', () => {
    const db = getDb();
    const { courseId, studentId } = seedContext(db);
    const aid = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, max_points, grading_scale_id) VALUES (?, 'sa-C', 'Homework', 100, '7165818')`
    ).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, score) VALUES (?, ?, 100)`).run(studentId, aid);
    db.prepare(`INSERT INTO feedback (student_id, assignment_id, status, feedback_json) VALUES (?, ?, 'draft', ?)`).run(
      studentId, aid, JSON.stringify({ narrative_feedback: '', rubric_scores: {}, scale_level: 'C', evidence: 'done on platform' })
    );
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-C' });
    expect(ctx.score_scale).toEqual({ name: 'Completion Scale', levels: [{ code: 'C', label: 'Completed' }, { code: 'I', label: 'Incomplete' }] });
    expect(ctx.students[0].current_scale_level).toBe('C');
    expect(ctx.students[0].existing_suggestion).toMatchObject({ scale_level: 'C', evidence: 'done on platform' });
  });

  test('score_scale is null (and current_scale_level null) for an aligned assignment', () => {
    const db = getDb();
    seedContext(db);
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-1' });
    expect(ctx.score_scale).toBeNull();
    expect(ctx.students[0].current_scale_level).toBeNull();
  });
});

describe('getAssessmentContext — reviewer_flags_brief', () => {
  test('existing_suggestion carries the brief flag lines ([] when absent)', () => {
    const db = getDb();
    const { studentId, assignmentId } = seedContext(db);
    expect(getAssessmentContext(db, { assignmentId: 'sa-1' }).students[0].existing_suggestion.reviewer_flags_brief).toEqual([]);
    db.prepare(`UPDATE feedback SET feedback_json = json_set(feedback_json, '$.reviewer_flags_brief', json('["Short"]')) WHERE student_id = ? AND assignment_id = ?`).run(studentId, assignmentId);
    expect(getAssessmentContext(db, { assignmentId: 'sa-1' }).students[0].existing_suggestion.reviewer_flags_brief).toEqual(['Short']);
  });
});

describe('getAssessmentContext - submission timeline', () => {
  test('each student carries the submission timeline (as on the card)', () => {
    const db = getDb();
    const { courseId, assignmentId } = seedContext(db);
    db.prepare(`UPDATE assignments SET due_date = '2026-10-05 15:30:00', is_lti_submission = 1, accepts_submissions = 1 WHERE id = ?`).run(assignmentId);
    db.prepare(`UPDATE grades SET lti_submission_state = 'submitted', first_submitted_at = ?`).run(Math.floor(new Date('2026-10-05T14:00:00').getTime() / 1000));
    const ctx = getAssessmentContext(db, { courseId, assignmentId: 'sa-1' });
    expect(ctx.students[0].submission_timeline).toMatchObject({
      due: { date: '2026-10-05', time: '15:30' },
      submission: { state: 'submitted', late: false },
    });
    expect(ctx.students[0].submission_timeline.submission.firstSubmittedAt).toMatch(/^2026-10-05T/);
  });
});

describe('feedback rows on an unaligned GAS task', () => {
  // A course, a GAS (Unaligned) assignment 'sa-F' with the Flappy rubric attached,
  // and two enrolled students: uid-1 (published EX overall, with row finals) and uid-2 (ungraded).
  function seedRows(db) {
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-F', 'MGD')`).run().lastInsertRowid;
    const asg = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-F', 'Flappy (F)', '23495360')`).run(courseId).lastInsertRowid;
    const s1 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`).run().lastInsertRowid;
    const s2 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-2', 'Alan', 'Turing')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-1'), (?, ?, 'enr-2')`).run(s1, courseId, s2, courseId);
    const rubricId = saveRubric(db, { name: 'Flappy', source: 'mcp', criteria: [
      { position: 1, criterion_name: 'Features and Code', standard_title: 'AS5', reporting_category: 'PRODUCE', descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd' } },
      { position: 2, criterion_name: 'Playtesting', standard_title: 'AS3', reporting_category: 'CREATE', descriptors: { ED: 'e', EX: 'f', D: 'g', EM: 'h' } },
    ] });
    db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-F', ?, 'now')`).run(rubricId, courseId);
    db.prepare(`INSERT INTO grades (student_id, assignment_id, score, grade_comment, exception, comment_status) VALUES (?, ?, 75, 'Well done', 0, 1)`).run(s1, asg);
    saveRowLevels(db, { assignmentSchoologyId: 'sa-F', studentUid: 'uid-1', rowLevels: { 'Features and Code': 'EX', Playtesting: 'ED' } });
    return { courseId, asg, s1, s2 };
  }

  test('returns the rubric rows, finals, suggestions and an empty topic set', () => {
    const db = getDb();
    seedRows(db);
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-F' });
    expect(ctx.topics).toEqual([]);
    expect(ctx.rubric.name).toBe('Flappy');
    expect(ctx.rubric.rows[0]).toEqual({ criterion: 'Features and Code', standard: 'AS5', category: 'PRODUCE',
      descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' } });
    const s1 = ctx.students.find(s => s.schoology_uid === 'uid-1');
    expect(s1).toMatchObject({ current_scale_level: 'EX', current_scores: {}, grade_comment: 'Well done', display_to_student: true,
      current_row_levels: { 'Features and Code': 'EX', Playtesting: 'ED' } });
    expect(ctx.students.find(s => s.schoology_uid === 'uid-2').current_row_levels).toEqual({});
  });

  test('draft_feedback separates row picks and the overall, with its source', () => {
    const db = getDb();
    seedRows(db);
    const uid2 = db.prepare(`SELECT id FROM students WHERE schoology_uid = 'uid-2'`).get().id;
    const asg = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = 'sa-F'`).get().id;
    const put = (studentId, pending) => db.prepare(
      `INSERT OR REPLACE INTO assessment_drafts (assignment_id, student_id, draft_json, updated_at) VALUES (?, ?, ?, datetime('now'))`
    ).run(asg, studentId, JSON.stringify({ pending, comment: 'x', display: true }));

    put(uid2, { 'row:Features and Code': 'EX', 'row:Playtesting': 'D' });
    let d = getAssessmentContext(db, { assignmentId: 'sa-F' }).students.find(s => s.id === uid2).draft_feedback;
    expect(d).toMatchObject({ rubric_scores: {}, row_levels: { 'Features and Code': 'EX', Playtesting: 'D' }, scale_level: 'EX', scale_level_source: 'rubric_average' });

    put(uid2, { 'row:Features and Code': 'EX', 'row:Playtesting': 'D', __scale__: 'D' });
    d = getAssessmentContext(db, { assignmentId: 'sa-F' }).students.find(s => s.id === uid2).draft_feedback;
    expect(d).toMatchObject({ scale_level: 'D', scale_level_source: 'teacher' });
    expect(d.rubric_scores).toEqual({});
  });

  test('a published student is never given a rubric_average overall', () => {
    const db = getDb();
    seedRows(db);
    const uid1 = db.prepare(`SELECT id FROM students WHERE schoology_uid = 'uid-1'`).get().id;
    const asg = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = 'sa-F'`).get().id;
    db.prepare(`INSERT INTO assessment_drafts (assignment_id, student_id, draft_json, updated_at) VALUES (?, ?, ?, datetime('now'))`)
      .run(asg, uid1, JSON.stringify({ pending: { 'row:Playtesting': 'D' } }));
    const d = getAssessmentContext(db, { assignmentId: 'sa-F' }).students.find(s => s.id === uid1).draft_feedback;
    expect(d).toMatchObject({ scale_level: null, scale_level_source: null });
  });

  test('a scale task without a rubric returns rubric null; __scale__ never leaks into rubric_scores', () => {
    const db = getDb();
    const { courseId, s2 } = seedRows(db);
    const asgG = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-G', 'Plain (F)', '23495360')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO assessment_drafts (assignment_id, student_id, draft_json, updated_at) VALUES (?, ?, ?, datetime('now'))`)
      .run(asgG, s2, JSON.stringify({ pending: { __scale__: 'EX' } }));
    const ctx = getAssessmentContext(db, { assignmentId: 'sa-G' });
    expect(ctx.rubric).toBeNull();
    const d = ctx.students.find(s => s.id === s2).draft_feedback;
    expect(d.rubric_scores).toEqual({});
    expect(d).toMatchObject({ scale_level: 'EX', scale_level_source: 'teacher' });
  });

  test('an aligned task has no rubric key', () => {
    const db = getDb();
    seedContext(db);
    expect('rubric' in getAssessmentContext(db, { assignmentId: 'sa-1' })).toBe(false);
  });
});

describe('getAssessmentContext — PowerSchool alerts (#117)', () => {
  test('each student carries powerschool_alerts (labels only) and when they were read', () => {
    const db = getDb();
    const { assignmentId, studentId } = seedContext(db);
    db.prepare(`INSERT INTO student_ps_alerts (student_id, alert_key) VALUES (?, 'accommodation_plan')`).run(studentId);
    db.prepare(`INSERT INTO student_powerschool (student_id, alerts_synced_at, dnc_g1) VALUES (?, '2026-10-17T00:00:00.000Z', '1')`).run(studentId);
    const ctx = getAssessmentContext(db, { assignmentId });
    expect(ctx.students[0]).toMatchObject({
      powerschool_alerts: [{ key: 'accommodation_plan', label: 'Accommodation plan', category: 'learning' }],
      powerschool_alerts_read_at: '2026-10-17T00:00:00.000Z',
    });
    expect(JSON.stringify(ctx)).not.toMatch(/dnc_g1/);
  });

  test('never read: an empty list and read_at null', () => {
    const db = getDb();
    const { assignmentId } = seedContext(db);
    expect(getAssessmentContext(db, { assignmentId }).students[0]).toMatchObject({ powerschool_alerts: [], powerschool_alerts_read_at: null });
  });
});
