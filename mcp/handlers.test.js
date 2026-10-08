import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
// Status-line publishing (Amendment B) reads/writes the student's Schoology
// comment — never for real in tests.
vi.mock('../server/services/schoology.js', () => ({ getSectionGrades: vi.fn(), pushGradeComments: vi.fn() }));

import { getDb } from '../server/db/index.js';
import { todayLocal } from '../server/lib/schoolDays.js';
import { getSectionGrades, pushGradeComments } from '../server/services/schoology.js';
import { listCourses, listAssignments, listStudents, writeRubric, attachRubricTool } from './handlers.js';
import {
  resolveCourseRef, getTriageTool, listReferralsTool, schoolCalendarTool, recordReferralTool, undoReferralTool,
  extendDeadlineTool, undoExtensionTool, setMakeupTrackingTool,
  requestResubmissionTool, gradeStandsTool, listResubmissionsTool, previewStatusLineTool,
  getSubmissionStatusTool,
} from './handlers.js';
import { saveRubric, listRubrics, getRubricByName } from '../server/services/rubricStore.js';
import { askLine, extendResubmissionLine, gradeStandsLine, extensionLine, makeUpLine } from '../server/lib/statusLines.js';
import { sessionDeps, resetSessionStatusCache } from '../server/services/schoologySession.js';
import { fakeSchoologyPage } from '../server/testing/fakeSchoologyPage.js';

beforeEach(() => {
  // Publishing tools check the Schoology credentials are configured (final review I3);
  // the Schoology client itself is mocked above.
  vi.stubEnv('SCHOOLOGY_BASE_URL', 'https://api.schoology.test');
  vi.stubEnv('SCHOOLOGY_CONSUMER_KEY', 'key');
  vi.stubEnv('SCHOOLOGY_CONSUMER_SECRET', 'secret');
  getDb().exec(
    'DELETE FROM status_lines; DELETE FROM feedback_snapshots; ' +
    'DELETE FROM referrals; DELETE FROM extensions; DELETE FROM resubmissions; DELETE FROM school_days; DELETE FROM mastery_scores; ' +
    'DELETE FROM rubric_attachment_topics; DELETE FROM rubric_attachments; ' +
    'DELETE FROM rubric_descriptors; DELETE FROM rubric_criteria; DELETE FROM rubrics; ' +
    'DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
    'DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; ' +
    'DELETE FROM students; DELETE FROM courses;'
  );
});

describe('listCourses', () => {
  test('returns active courses with the documented columns', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name, section_name, course_code, block_number)
       VALUES ('s1', 'Robotics', 'Block A', 'ROB', '4')`
    ).run();
    const rows = listCourses(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      course_name: 'Robotics',
      section_name: 'Block A',
      course_code: 'ROB',
      schoology_section_id: 's1',
      block_number: '4',
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
  test('leaves out assignments deleted in Schoology (removed_at)', () => {
    const db = getDb();
    const courseId = seedCourse(db);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'live', 'Live')`).run(courseId);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, removed_at) VALUES (?, 'gone', 'Gone', '2026-10-05')`).run(courseId);

    expect(listAssignments(db, { course_id: courseId }).map((a) => a.title)).toEqual(['Live']);
  });

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

  test('returns submission_counts and grading_counts', () => {
    const db = getDb();
    const courseId = seedCourse(db);
    const aId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission, due_date) VALUES (?, 'sa-c', 'NB', 1, '2026-06-01')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', NULL, ?, 'T1', 'Topic')`).run(courseId);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-c', 't1', ?)`).run(courseId);
    const mk = (uid, state) => {
      const sId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'F', 'L')`).run(uid).lastInsertRowid;
      db.prepare(`INSERT INTO grades (student_id, assignment_id, lti_submission_state) VALUES (?, ?, ?)`).run(sId, aId, state);
      return sId;
    };
    mk('u1', 'submitted'); mk('u2', 'in_progress'); mk('u3', 'not_started');

    const rows = listAssignments(db, { course_id: courseId });
    const nb = rows.find(r => r.schoology_assignment_id === 'sa-c');
    expect(nb.submission_counts).toMatchObject({ submitted: 1, in_progress: 1, not_started: 1, total: 3 });
    expect(nb.grading_counts).toMatchObject({ ungraded: 3, partial: 0, complete: 0 });
  });

  test('M3: a comment that is only Prism\'s stored status line counts as no comment in grading_counts', () => {
    const db = getDb();
    const courseId = seedCourse(db);
    const aId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-m3', 'NB')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'C1', 'Category')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat-1', ?, 'T1', 'Topic')`).run(courseId);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-m3', 't1', ?)`).run(courseId);
    const line = 'Resubmission requested - due Thu 15/10.';
    for (const [uid, comment] of [['u1', line], ['u2', `${line}\n\nWell done`]]) {
      const sId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'F', 'L')`).run(uid).lastInsertRowid;
      db.prepare(`INSERT INTO grades (student_id, assignment_id, grade_comment) VALUES (?, ?, ?)`).run(sId, aId, comment);
      db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'ask')`).run(sId, aId, line);
      db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES (?, 'sa-m3', 't1', 75, 'EX')`).run(uid);
    }
    const nb = listAssignments(db, { course_id: courseId }).find((r) => r.schoology_assignment_id === 'sa-m3');
    expect(nb.grading_counts).toMatchObject({ ungraded: 0, partial: 1, complete: 1 });
  });

  // #123: a stray mastery_scores row on a non-aligned topic must not stop a
  // student counting as complete — mirrors getAssessmentContext, which only
  // ever counts aligned-topic scores.
  test('grading_counts: a score on a non-aligned topic is ignored (complete, not partial)', () => {
    const db = getDb();
    const courseId = seedCourse(db);
    const aId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-x', 'NB')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'C1', 'Category')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat-1', ?, 'T1', 'Topic 1')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t2', 'cat-1', ?, 'T2', 'Topic 2')`).run(courseId);
    // Only t1 is aligned to this assignment; t2 is some other topic.
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-x', 't1', ?)`).run(courseId);
    const sId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'F', 'L')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, grade_comment) VALUES (?, ?, 'Nice work')`).run(sId, aId);
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'sa-x', 't1', 75, 'EX')`).run();
    // Stray score on a non-aligned topic (stale data / alignment changed after scoring).
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'sa-x', 't2', 50, 'DE')`).run();

    const nb = listAssignments(db, { course_id: courseId }).find((r) => r.schoology_assignment_id === 'sa-x');
    expect(nb.grading_counts).toMatchObject({ ungraded: 0, partial: 0, complete: 1 });
  });

  // #123: when alignments haven't synced yet, getAlignedTopics falls back to
  // topics that have any score for the assignment — assignmentCounts must use
  // the same fallback so it agrees with the per-student grading_state.
  test('grading_counts: no alignments synced falls back to scored topics, like the per-student path', () => {
    const db = getDb();
    const courseId = seedCourse(db);
    const aId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-y', 'NB')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'C1', 'Category')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat-1', ?, 'T1', 'Topic 1')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t2', 'cat-1', ?, 'T2', 'Topic 2')`).run(courseId);
    // No mastery_alignments rows at all for this assignment (not synced yet).
    const s1 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'F', 'L')`).run().lastInsertRowid;
    const s2 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u2', 'F', 'L')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, grade_comment) VALUES (?, ?, 'Nice work')`).run(s1, aId);
    db.prepare(`INSERT INTO grades (student_id, assignment_id) VALUES (?, ?)`).run(s2, aId);
    // Fallback topic set = {t1, t2} (both have scores for this assignment).
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'sa-y', 't1', 75, 'EX')`).run();
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'sa-y', 't2', 75, 'EX')`).run();
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u2', 'sa-y', 't1', 50, 'DE')`).run();

    const nb = listAssignments(db, { course_id: courseId }).find((r) => r.schoology_assignment_id === 'sa-y');
    expect(nb.grading_counts).toMatchObject({ ungraded: 0, partial: 1, complete: 1 });
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

  test('latest_submission_at reads latest_revision_at (not submitted_at) for an LTI assignment', () => {
    const db = getDb();
    const courseId = seedCourse(db);
    const ltiId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission) VALUES (?, 'lti-1', 'OneDrive Essay', 1)`).run(courseId).lastInsertRowid;
    const s1 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1','A','One')`).run().lastInsertRowid;
    // submitted_at here is the REST grade time (not the submission) — must be ignored for LTI.
    db.prepare(`INSERT INTO grades (student_id, assignment_id, submitted_at, latest_revision_at) VALUES (?, ?, 0, 1700000900)`).run(s1, ltiId);

    const byTitle = Object.fromEntries(listAssignments(db, { course_id: courseId }).map((a) => [a.title, a]));
    expect(byTitle['OneDrive Essay'].latest_submission_at).toBe(new Date(1700000900 * 1000).toISOString());
  });
});

describe('listAssignments — score scale (#41)', () => {
  test('names the scale an unaligned assignment can be graded on, null otherwise', () => {
    const db = getDb();
    const courseId = seedCourse(db);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'hw', 'Homework', '7165818')`).run(courseId);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'lt', 'Letter', '1293963')`).run(courseId);
    const byTitle = Object.fromEntries(listAssignments(db, { course_id: courseId }).map((a) => [a.title, a]));
    expect(byTitle.Homework.score_scale).toBe('Completion Scale');
    expect(byTitle.Letter.score_scale).toBeNull();
  });
});

describe('listStudents', () => {
  test('returns the roster with preferred_first_name resolved (teacher override beats synced preferred name)', () => {
    const db = getDb();
    const courseId = seedCourse(db);
    const s1 = db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name, preferred_name, preferred_name_teacher, email)
       VALUES ('u1', 'Pingye', 'Yuan', 'Ping', 'Kevin', 'k@x.com')`
    ).run().lastInsertRowid;
    const s2 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u2', 'Ada', 'Lovelace')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'e1')`).run(s1, courseId);
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'e2')`).run(s2, courseId);

    const rows = listStudents(db, { course_id: courseId });
    expect(rows.map((r) => r.last_name)).toEqual(['Lovelace', 'Yuan']); // ordered by last name
    expect(rows.find((r) => r.schoology_uid === 'u1')).toMatchObject({
      first_name: 'Pingye', last_name: 'Yuan', preferred_name: 'Ping', preferred_first_name: 'Kevin', email: 'k@x.com',
    });
    expect(rows.find((r) => r.schoology_uid === 'u2')).toMatchObject({ preferred_first_name: 'Ada', email: null });
  });

  test('excludes dropped enrolments and other courses', () => {
    const db = getDb();
    const courseId = seedCourse(db);
    const otherCourseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s2', 'Other')`).run().lastInsertRowid;
    const active = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'A', 'One')`).run().lastInsertRowid;
    const dropped = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u2', 'B', 'Two')`).run().lastInsertRowid;
    const elsewhere = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u3', 'C', 'Three')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'e1')`).run(active, courseId);
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id, dropped_at) VALUES (?, ?, 'e2', '2026-01-01T00:00:00.000Z')`).run(dropped, courseId);
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'e3')`).run(elsewhere, otherCourseId);

    expect(listStudents(db, { course_id: courseId }).map((r) => r.schoology_uid)).toEqual(['u1']);
  });
});

const C = (over = {}) => ({ criterion_name: 'UI/UX', standard_title: 'Visual', reporting_category: 'Produce', descriptors: { ED: 'a' }, ...over });

describe('writeRubric (dedup + conflict)', () => {
  test('reuses an existing rubric with identical content under a different name — no copy', () => {
    const db = getDb();
    saveRubric(db, { name: 'Design', source: 'csv', criteria: [{ position: 1, ...C() }] });
    const res = writeRubric(db, { name: 'Weather App Design', criteria: [C()] });
    expect(res).toEqual({ reused_existing: 'Design', match: 'exact', criteria_count: 1 });
    expect(listRubrics(db)).toHaveLength(1);
  });

  test('prompts (conflict, no overwrite) on a same-name different-content write', () => {
    const db = getDb();
    saveRubric(db, { name: 'Design', source: 'csv', criteria: [{ position: 1, ...C({ descriptors: { ED: 'a' } }) }] });
    const res = writeRubric(db, { name: 'Design', criteria: [C({ descriptors: { ED: 'CHANGED' } })] });
    expect(res.conflict).toBe('name');
    expect(res.existing).toBe('Design');
    expect(listRubrics(db)).toHaveLength(1);
    expect(getRubricByName(db, 'Design').criteria[0].descriptors.ED).toBe('a'); // unchanged
  });

  test("on_name_conflict:'update' replaces the existing rubric in place", () => {
    const db = getDb();
    saveRubric(db, { name: 'Design', source: 'csv', criteria: [{ position: 1, ...C({ descriptors: { ED: 'a' } }) }] });
    const res = writeRubric(db, { name: 'Design', on_name_conflict: 'update', criteria: [C({ descriptors: { ED: 'NEW' } })] });
    expect(res).toMatchObject({ name: 'Design', match: 'updated' });
    expect(listRubrics(db)).toHaveLength(1);
    expect(getRubricByName(db, 'Design').criteria[0].descriptors.ED).toBe('NEW');
  });

  test("on_name_conflict:'new' saves a separate same-name copy", () => {
    const db = getDb();
    saveRubric(db, { name: 'Design', source: 'csv', criteria: [{ position: 1, ...C({ descriptors: { ED: 'a' } }) }] });
    const res = writeRubric(db, { name: 'Design', on_name_conflict: 'new', criteria: [C({ descriptors: { ED: 'b' } })] });
    expect(res).toMatchObject({ name: 'Design', match: 'created_new' });
    expect(listRubrics(db).filter((r) => r.name === 'Design')).toHaveLength(2);
  });

  test('creates a new rubric when nothing matches', () => {
    const db = getDb();
    const res = writeRubric(db, { name: 'Fresh', criteria: [C()] });
    expect(res).toMatchObject({ name: 'Fresh', match: 'created', criteria_count: 1 });
    expect(listRubrics(db)).toHaveLength(1);
  });
});

describe('attachRubricTool', () => {
  test('attaches a library rubric to an assignment and reports unmatched criteria by name', () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1','AIML')`).run().lastInsertRowid;
    const asgId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-9', 'Project')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('rc1', ?, 'ART.5', 'Presenting')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1','rc1',?, 'ART.5.1','Visual design')`).run(courseId);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-9','t1',?)`).run(courseId);
    saveRubric(db, { name: 'Design', source: 'csv', criteria: [
      { position: 1, criterion_name: 'UI/UX', standard_title: 'Visual design', reporting_category: 'Produce', descriptors: { ED: 'a' } },
      { position: 2, criterion_name: 'Code', standard_title: 'Programming', reporting_category: 'Produce', descriptors: { ED: 'b' } },
    ] });

    const res = attachRubricTool(db, { rubric_name: 'Design', assignment_id: asgId });
    expect(res).toEqual({ attached_to: asgId, rubric: 'Design', unmatched_criteria: ['Code'] });
  });

  test('returns an error object when the rubric name is unknown', () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1','AIML')`).run().lastInsertRowid;
    const asgId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-9', 'Project')`).run(courseId).lastInsertRowid;
    expect(attachRubricTool(db, { rubric_name: 'Nope', assignment_id: asgId }).error).toMatch(/not found/);
  });

  test('returns an error object when the assignment id is unknown', () => {
    const db = getDb();
    saveRubric(db, { name: 'Design', source: 'csv', criteria: [
      { position: 1, criterion_name: 'UI/UX', standard_title: 'Visual design', reporting_category: 'Produce', descriptors: { ED: 'a' } },
    ] });
    expect(attachRubricTool(db, { rubric_name: 'Design', assignment_id: 99999 }).error).toMatch(/not found/);
  });
});

function seedLate(db) {
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, course_code) VALUES ('s', 'AP Computer Science Principles', 'APCSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'X', 'C')`).run(courseId);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat', ?, 'X.1', 'T')`).run(courseId);
  const studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(studentId, courseId);
  const assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, accepts_submissions) VALUES (?, 'a1', 'CP2', '2020-01-06 15:30:00', 1)`).run(courseId).lastInsertRowid;
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('a1', 't1', ?)`).run(courseId);
  return { courseId, studentId, assignmentId };
}

// Enrolled student + assignment in a current (non-archived, non-excluded)
// course — the minimal eligible pair resubmission tools act on.
function seedTriagePair(db) {
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('rs', 'Resubmissions Course')`).run().lastInsertRowid;
  const studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('ru1', 'Rae', 'So')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(studentId, courseId);
  const assignmentId = db.prepare(
    `INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, published) VALUES (?, 'rs-a1', 'Resubmit Task', '2026-10-05 15:30:00', 1)`
  ).run(courseId).lastInsertRowid;
  return { studentId, assignmentId };
}

describe('resubmission tools', () => {
  test('request → list → extend via extend_deadline → grade_stands (only after the deadline)', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedTriagePair(db);
    const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 2, note: 'fix tests' });
    expect(r).toMatchObject({ outcome: 'asked', source: 'mcp', lessons: 2 });
    expect(listResubmissionsTool(db, { state: 'asked' })).toHaveLength(1);
    expect(await extendDeadlineTool(db, { resubmission_id: r.id, lessons: 5 })).toMatchObject({ lessons: 5 });
    await expect(gradeStandsTool(db, { id: r.id })).rejects.toThrow(expect.objectContaining({ code: 'NOT_AT_DEADLINE' }));
    // Rewind to an old ask with no stored deadline (a pre-2026-10-08 row): due long ago.
    db.prepare(`UPDATE resubmissions SET requested_at = '2020-01-06 04:00:00', until = NULL WHERE id = ?`).run(r.id);
    expect(await gradeStandsTool(db, { id: r.id })).toMatchObject({ outcome: 'grade_stands', closeNote: 'grade stands' });
    expect(listResubmissionsTool(db, { state: 'grade_stands' })).toHaveLength(1);
  });

  test('get_triage student filter applies to resubmissions', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedTriagePair(db);
    await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId });
    expect(getTriageTool(db, { student: 'nobody-matches' }).resubmissions).toEqual([]);
  });
});

describe('status lines on resubmission/extension tools (Amendment B)', () => {
  const LINE = 'Resubmission requested - due Thu 09/10. Fix the loop.';
  const fresh = (over = {}) => ({ assignment_id: 'a1', enrollment_id: 'enr', grade: null, exception: 0, comment: 'Teacher note.', comment_status: 1, ...over });
  const storedLine = (db, studentId, assignmentId) =>
    db.prepare('SELECT line, kind FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId) || null;

  // seedLate's assignment is aligned (mastery_alignments) and accepts_submissions
  // — eligible for both the resubmission and extension tools — with a Schoology
  // enrolment id so the status-line publisher can resolve the pair.
  function seedEligiblePair(db) {
    const { studentId, assignmentId } = seedLate(db);
    db.prepare(`UPDATE enrolments SET schoology_enrolment_id = 'enr' WHERE student_id = ?`).run(studentId);
    return { studentId, assignmentId };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getSectionGrades.mockResolvedValue([fresh()]);
    pushGradeComments.mockResolvedValue({ status: 207, data: {} });
  });

  test('request_resubmission publishes via the mocked publisher when comment_line is given', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedEligiblePair(db);
    const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 2, comment_line: LINE });
    expect(getSectionGrades).toHaveBeenCalledWith('s');
    expect(pushGradeComments).toHaveBeenCalledTimes(1);
    expect(r.statusLine).toMatchObject({ comment: `${LINE}\n\nTeacher note.`, line: LINE });
    expect(storedLine(db, studentId, assignmentId)).toEqual({ line: LINE, kind: 'ask' });
  });

  // Final review I3: PrisMCP loads no dotenv; without the Schoology credentials in its
  // env block every publish would fail with a misleading read error. Say what is missing.
  test('without the Schoology env vars, publishing tools fail with SCHOOLOGY_NOT_CONFIGURED and write nothing', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedEligiblePair(db);
    vi.stubEnv('SCHOOLOGY_CONSUMER_SECRET', '');
    const notConfigured = expect.objectContaining({ code: 'SCHOOLOGY_NOT_CONFIGURED', message: expect.stringContaining('SCHOOLOGY_CONSUMER_SECRET') });
    await expect(requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, comment_line: LINE })).rejects.toEqual(notConfigured);
    await expect(extendDeadlineTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 2, comment_line: 'x' })).rejects.toEqual(notConfigured);
    await expect(previewStatusLineTool(db, { student_id: studentId, assignment_id: assignmentId, kind: 'ask', lessons: 2 })).rejects.toEqual(notConfigured);
    await expect(gradeStandsTool(db, { id: 1, comment_line: 'x' })).rejects.toEqual(notConfigured);
    await expect(undoExtensionTool(db, { id: 1, remove_line: true })).rejects.toEqual(notConfigured);
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM resubmissions').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM extensions').get().n).toBe(0);
    // Prism-only actions (no comment_line) still work without them.
    await expect(requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId })).resolves.toMatchObject({ outcome: 'asked' });
  });

  test('request_resubmission without comment_line never touches Schoology (Prism-only, as before)', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedEligiblePair(db);
    const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 2 });
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(r.statusLine).toBeUndefined();
    expect(storedLine(db, studentId, assignmentId)).toBeNull();
  });

  test('extend_deadline (resubmission_id path) publishes kind extend_resubmission', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedEligiblePair(db);
    const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 2 });
    vi.clearAllMocks();
    getSectionGrades.mockResolvedValue([fresh()]);
    pushGradeComments.mockResolvedValue({ status: 207, data: {} });
    const EXT = 'Resubmission requested - now due Mon 13/10.';
    const res = await extendDeadlineTool(db, { resubmission_id: r.id, lessons: 5, comment_line: EXT });
    expect(res.statusLine).toMatchObject({ line: EXT });
    expect(storedLine(db, studentId, assignmentId)).toEqual({ line: EXT, kind: 'extend_resubmission' });
  });

  test('extend_deadline (student/assignment path) publishes kind extension', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedEligiblePair(db);
    const EXT = 'Extension - now due Mon 13/10 (5 lessons).';
    const res = await extendDeadlineTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 5, comment_line: EXT });
    expect(res.statusLine).toMatchObject({ line: EXT });
    expect(storedLine(db, studentId, assignmentId)).toEqual({ line: EXT, kind: 'extension' });
  });

  test('extend_deadline without comment_line never touches Schoology', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedEligiblePair(db);
    const res = await extendDeadlineTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 5 });
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(res.statusLine).toBeUndefined();
  });

  test('grade_stands does not touch Schoology when comment_line is omitted', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedEligiblePair(db);
    const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 2 });
    db.prepare(`UPDATE resubmissions SET requested_at = '2020-01-06 04:00:00' WHERE id = ?`).run(r.id);
    vi.clearAllMocks();
    expect((await gradeStandsTool(db, { id: r.id })).statusLine).toBeUndefined();
    expect(getSectionGrades).not.toHaveBeenCalled();
  });

  test('grade_stands publishes the deadline-passed line when comment_line is given', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedEligiblePair(db);
    const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 2 });
    db.prepare(`UPDATE resubmissions SET requested_at = '2020-01-06 04:00:00' WHERE id = ?`).run(r.id);
    vi.clearAllMocks();
    getSectionGrades.mockResolvedValue([fresh()]);
    pushGradeComments.mockResolvedValue({ status: 207, data: {} });
    const STANDS = 'Resubmission deadline (Thu 09/10) passed - your grade stands.';
    const res = await gradeStandsTool(db, { id: r.id, comment_line: STANDS });
    expect(getSectionGrades).toHaveBeenCalled();
    expect(res.statusLine).toMatchObject({ line: STANDS });
    expect(storedLine(db, studentId, assignmentId)).toEqual({ line: STANDS, kind: 'grade_stands' });
  });

  test('undo_extension with remove_line removes the stored line; without it, Schoology is untouched', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedEligiblePair(db);
    const EXT = 'Extension - now due Mon 13/10 (5 lessons).';
    const created = await extendDeadlineTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 5, comment_line: EXT });
    vi.clearAllMocks();
    getSectionGrades.mockResolvedValue([fresh({ comment: `${EXT}\n\nTeacher note.` })]);
    pushGradeComments.mockResolvedValue({ status: 207, data: {} });
    const res = await undoExtensionTool(db, { id: created.id, remove_line: true });
    expect(res).toMatchObject({ deleted: true, statusLine: { removed: true, comment: 'Teacher note.' } });
    expect(storedLine(db, studentId, assignmentId)).toBeNull();

    const another = await extendDeadlineTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 3, comment_line: EXT });
    vi.clearAllMocks();
    expect(await undoExtensionTool(db, { id: another.id })).toEqual({ deleted: true });
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(pushGradeComments).not.toHaveBeenCalled();
  });

  describe('preview_status_line renders the line server-side (review I1)', () => {
    test('kind ask: the rendered line uses server/lib/statusLines.js, and until matches what request_resubmission then records', async () => {
      const db = getDb();
      const { studentId, assignmentId } = seedEligiblePair(db);
      const preview = await previewStatusLineTool(db, { student_id: studentId, assignment_id: assignmentId, kind: 'ask', lessons: 2, note: 'Fix the loop.' });
      expect(preview.line).toBe(askLine({ until: preview.until, note: 'Fix the loop.' }));
      expect(preview.resultingComment).toBe(`${preview.line}\n\nTeacher note.`);
      expect(preview).toMatchObject({ normalisedLine: preview.line, lineProblem: null });
      expect(pushGradeComments).not.toHaveBeenCalled();
      // A candidate line publish would refuse is flagged at preview time.
      const bad = await previewStatusLineTool(db, { student_id: studentId, assignment_id: assignmentId, kind: 'ask', lessons: 2, note: 'Fix the loop.', line: '\u27F3 Resubmit please' });
      expect(bad).toMatchObject({ line: preview.line, lineProblem: 'BAD_LINE' });
      const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 2 });
      expect(r.until).toBe(preview.until);
    });

    test('kind extend_resubmission: until matches what extend_deadline\'s resubmission_id path then records', async () => {
      const db = getDb();
      const { studentId, assignmentId } = seedEligiblePair(db);
      const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 2 });
      vi.clearAllMocks();
      getSectionGrades.mockResolvedValue([fresh()]);
      const preview = await previewStatusLineTool(db, { student_id: studentId, assignment_id: assignmentId, kind: 'extend_resubmission', resubmission_id: r.id, lessons: 5 });
      expect(preview.line).toBe(extendResubmissionLine({ until: preview.until }));
      const extended = await extendDeadlineTool(db, { resubmission_id: r.id, lessons: 5 });
      expect(extended.until).toBe(preview.until);
    });

    test('kind grade_stands: until is the open request\'s own (already-passed) deadline', async () => {
      const db = getDb();
      const { studentId, assignmentId } = seedEligiblePair(db);
      const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 2 });
      db.prepare(`UPDATE resubmissions SET requested_at = '2020-01-06 04:00:00' WHERE id = ?`).run(r.id);
      vi.clearAllMocks();
      getSectionGrades.mockResolvedValue([fresh()]);
      const preview = await previewStatusLineTool(db, { student_id: studentId, assignment_id: assignmentId, kind: 'grade_stands', resubmission_id: r.id });
      expect(preview.line).toBe(gradeStandsLine({ until: preview.until }));
      const stood = await gradeStandsTool(db, { id: r.id });
      expect(stood.until).toBe(preview.until);
    });

    test('kind extension: until matches what extend_deadline then records for ordinary work', async () => {
      const db = getDb();
      const { studentId, assignmentId } = seedEligiblePair(db);
      const preview = await previewStatusLineTool(db, { student_id: studentId, assignment_id: assignmentId, kind: 'extension', lessons: 5, note: 'sick' });
      expect(preview.line).toBe(extensionLine({ until: preview.until, lessons: 5, note: 'sick' }));
      const ext = await extendDeadlineTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 5, note: 'sick' });
      expect(ext.until).toBe(preview.until);
    });

    test('kind make_up: same calendar rule as extension', async () => {
      const db = getDb();
      const { studentId, assignmentId } = seedEligiblePair(db);
      const preview = await previewStatusLineTool(db, { student_id: studentId, assignment_id: assignmentId, kind: 'make_up', lessons: 4 });
      expect(preview.line).toBe(makeUpLine({ until: preview.until }));
      const ext = await extendDeadlineTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 4 });
      expect(ext.until).toBe(preview.until);
    });

    test('a teacher-edited `line` is previewed instead, but `line` in the response still returns Prism\'s suggestion', async () => {
      const db = getDb();
      const { studentId, assignmentId } = seedEligiblePair(db);
      const edited = `${LINE} Bring your notebook.`;
      const preview = await previewStatusLineTool(db, { student_id: studentId, assignment_id: assignmentId, kind: 'ask', lessons: 2, line: edited });
      expect(preview.resultingComment).toBe(`${edited}\n\nTeacher note.`);
      expect(preview.line).not.toBe(edited);
      expect(preview.line).toMatch(/^Resubmission requested - due /);
      expect(pushGradeComments).not.toHaveBeenCalled();
    });

    test('an unknown kind is rejected before any Schoology read', async () => {
      const db = getDb();
      const { studentId, assignmentId } = seedEligiblePair(db);
      await expect(previewStatusLineTool(db, { student_id: studentId, assignment_id: assignmentId, kind: 'bogus' }))
        .rejects.toThrow(expect.objectContaining({ code: 'BAD_VALUE' }));
      expect(getSectionGrades).not.toHaveBeenCalled();
    });

    test('extend_resubmission and grade_stands require resubmission_id', async () => {
      const db = getDb();
      const { studentId, assignmentId } = seedEligiblePair(db);
      await expect(previewStatusLineTool(db, { student_id: studentId, assignment_id: assignmentId, kind: 'extend_resubmission', lessons: 2 }))
        .rejects.toThrow(expect.objectContaining({ code: 'BAD_VALUE' }));
      await expect(previewStatusLineTool(db, { student_id: studentId, assignment_id: assignmentId, kind: 'grade_stands' }))
        .rejects.toThrow(expect.objectContaining({ code: 'BAD_VALUE' }));
    });
  });
});

describe('triage tools', () => {
  test('resolveCourseRef: id, name fragment, code; ambiguous/unknown throw', () => {
    const db = getDb();
    const { courseId } = seedLate(db);
    expect(resolveCourseRef(db, courseId)).toBe(courseId);
    expect(resolveCourseRef(db, 'computer science')).toBe(courseId);
    expect(resolveCourseRef(db, 'apcsp')).toBe(courseId);
    expect(resolveCourseRef(db, undefined)).toBeNull();
    expect(() => resolveCourseRef(db, 'robotics')).toThrow(/No active course/);
  });

  test('resolveCourseRef: ambiguous fragment matching multiple courses throws', () => {
    const db = getDb();
    const a = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, course_code, block_number) VALUES ('s1', 'Robotics', 'ROB', '2')`).run().lastInsertRowid;
    const b = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, course_code, block_number) VALUES ('s2', 'Robotics', 'ROB', '6')`).run().lastInsertRowid;
    const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, course_code) VALUES ('s3', 'Robotics Club', 'ROBC')`).run().lastInsertRowid;
    expect(() => resolveCourseRef(db, 'robotics')).toThrow(
      `"robotics" matches several courses (${a} Robotics (Block 2), ${b} Robotics (Block 6), ${c} Robotics Club): pass a course id`,
    );
  });

  test('resolveCourseRef: unknown lists the current courses with ids and blocks', () => {
    const db = getDb();
    const a = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, block_number) VALUES ('s1', 'AP CSP', '7')`).run().lastInsertRowid;
    expect(() => resolveCourseRef(db, 'chemistry')).toThrow(`No active course matches "chemistry" (current: ${a} AP CSP (Block 7)): pass a course id`);
  });

  test('get_triage rows carry blockNumber', () => {
    const db = getDb();
    const { courseId } = seedLate(db);
    db.prepare(`UPDATE courses SET block_number = '7' WHERE id = ?`).run(courseId);
    expect(getTriageTool(db, {}).lateWork[0]).toMatchObject({ courseName: 'AP Computer Science Principles', blockNumber: '7' });
  });

  test('listReferralsTool returns referrals + extensions, filtered by student id or name fragment', () => {
    const db = getDb();
    const { courseId, studentId, assignmentId } = seedLate(db);
    const zed = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u2', 'Zed', 'Young')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(zed, courseId);
    recordReferralTool(db, { student_id: studentId, assignment_id: assignmentId, action: 'referred' });
    recordReferralTool(db, { student_id: zed, assignment_id: assignmentId, action: 'referred' });
    extendDeadlineTool(db, { student_id: zed, assignment_id: assignmentId, lessons: 2 });
    const names = (out) => ({ referrals: out.referrals.map((r) => r.studentName), extensions: out.extensions.map((r) => r.studentName) });
    expect(names(listReferralsTool(db, { student: 'maya' }))).toEqual({ referrals: ['Maya Chen'], extensions: [] });
    expect(names(listReferralsTool(db, { student: zed }))).toEqual({ referrals: ['Zed Young'], extensions: ['Zed Young'] });
    expect(names(listReferralsTool(db, { student: String(zed) }))).toEqual({ referrals: ['Zed Young'], extensions: ['Zed Young'] });
    expect(listReferralsTool(db, {}).referrals).toHaveLength(2);
    expect(listReferralsTool(db, { course: 'apcsp' }).extensions).toHaveLength(1);
  });

  test('getTriageTool filters by student name fragment', () => {
    const db = getDb();
    seedLate(db);
    expect(getTriageTool(db, { student: 'maya' }).lateWork).toHaveLength(1);
    expect(getTriageTool(db, { student: 'zed' }).lateWork).toEqual([]);
  });

  test('getTriageTool limits counts.atReferralLimit to the filtered student, not the whole class', () => {
    const db = getDb();
    const { courseId } = seedLate(db);
    const studentId2 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u2', 'Zed', 'Young')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(studentId2, courseId);

    const all = getTriageTool(db, {});
    expect(all.lateWork).toHaveLength(2);
    expect(all.counts.atReferralLimit).toBe(2);
    expect(all.studentFilter).toBeUndefined();

    const filtered = getTriageTool(db, { student: 'maya' });
    expect(filtered.lateWork).toHaveLength(1);
    expect(filtered.counts.atReferralLimit).toBe(1);
    expect(filtered.studentFilter).toBe('maya');
  });

  test('get_triage includes make-up tests (filtered + counted per student) and the unchecked count', () => {
    const db = getDb();
    const { courseId } = seedLate(db);
    const zed = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u2', 'Zed', 'Young')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(zed, courseId);
    // A summative Schoology test long past (weekday fallback → red), attempts read OK; nobody took it.
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, accepts_submissions, is_test, test_fetch_status)
      VALUES (?, 'q1', 'Unit 1 test', '2020-01-06 14:00:00', 0, 1, 'ok'), (?, 'q2', 'Unit 2 test', '2020-01-07 14:00:00', 0, 1, 'failed')`).run(courseId, courseId);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('q1', 't1', ?), ('q2', 't1', ?)`).run(courseId, courseId);
    db.prepare(`INSERT INTO grades (student_id, assignment_id, test_attempt) SELECT s.id, a.id, 'none' FROM students s, assignments a WHERE a.schoology_assignment_id = 'q1'`).run();
    const all = getTriageTool(db, {});
    expect(all.makeUps.map((r) => [r.studentName, r.title, r.tone])).toEqual([['Maya Chen', 'Unit 1 test', 'red'], ['Zed Young', 'Unit 1 test', 'red']]);
    expect(all.counts.makeUpsOverdue).toBe(2);
    expect(all.makeUpsUnchecked).toBe(1);
    const maya = getTriageTool(db, { student: 'maya' });
    expect(maya.makeUps.map((r) => r.studentName)).toEqual(['Maya Chen']);
    expect(maya.counts.makeUpsOverdue).toBe(1);
  });

  test('set_makeup_tracking: tracked false silences a quiz for every student; true restores it', () => {
    const db = getDb();
    const { courseId } = seedLate(db);
    const quiz = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, is_test, test_fetch_status)
      VALUES (?, 'q1', 'Practice quiz', '2020-01-06 14:00:00', 1, 'ok')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, test_attempt) SELECT id, ?, 'none' FROM students`).run(quiz);
    expect(getTriageTool(db, {}).makeUps).toHaveLength(1);
    expect(setMakeupTrackingTool(db, { assignment_id: quiz, tracked: false })).toEqual({ assignmentId: quiz, title: 'Practice quiz', ignored: true });
    expect(getTriageTool(db, {})).toMatchObject({ makeUps: [], makeUpsIgnored: 1 });
    setMakeupTrackingTool(db, { assignment_id: quiz, tracked: true });
    expect(getTriageTool(db, {}).makeUps).toHaveLength(1);
    expect(() => setMakeupTrackingTool(db, { assignment_id: 99999, tracked: false })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  test('record → list → undo through the tools (source mcp)', () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLate(db);
    const r = recordReferralTool(db, { student_id: studentId, assignment_id: assignmentId, action: 'referred', note: 'emailed AO' });
    expect(r).toMatchObject({ action: 'referred', source: 'mcp', note: 'emailed AO' });
    expect(listReferralsTool(db, {}).referrals).toHaveLength(1);
    expect(undoReferralTool(db, { id: r.id })).toEqual({ deleted: true });
  });

  test("record_referral rejects 'exempt'", () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLate(db);
    expect(() => recordReferralTool(db, { student_id: studentId, assignment_id: assignmentId, action: 'exempt' }))
      .toThrow(expect.objectContaining({ code: 'BAD_ACTION' }));
  });

  test('extend_deadline → get_triage row carries it → undo_extension (source mcp)', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLate(db);
    // Due Mon 06/01/2020, long past: +3 school days from today (2026-10-08 rule); off the list until then.
    const e = await extendDeadlineTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 3, note: 'sick' });
    expect(e).toMatchObject({ lessons: 3, note: 'sick', source: 'mcp', studentName: 'Maya Chen' });
    expect(e.until > todayLocal()).toBe(true);
    expect(getTriageTool(db, {}).lateWork).toEqual([]);
    expect(listReferralsTool(db, {}).extensions).toHaveLength(1);
    expect(await undoExtensionTool(db, { id: e.id })).toEqual({ deleted: true });
    expect(listReferralsTool(db, {}).extensions).toEqual([]);
  });

  test('extend_deadline rejects out-of-range lessons', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLate(db);
    await expect(extendDeadlineTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 61 }))
      .rejects.toThrow(expect.objectContaining({ code: 'BAD_LESSONS' }));
  });

  test('record_referral rejects a pair not on the list', () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLate(db);
    recordReferralTool(db, { student_id: studentId, assignment_id: assignmentId, action: 'referred' });
    expect(() => recordReferralTool(db, { student_id: studentId, assignment_id: assignmentId, action: 'referred' }))
      .toThrow(/not on the late-work list/);
  });

  test('schoolCalendarTool: between + today info, weekday fallback when empty', () => {
    const out = schoolCalendarTool(getDb(), { date: '2026-09-25', to: '2026-09-29' });
    expect(out.between).toMatchObject({ from: '2026-09-25', to: '2026-09-29', days: 2, approx: true });
    expect(out.source).toBe('weekdays');
    expect(out.today).toHaveProperty('isSchoolDay');
  });

  test('schoolCalendarTool without `to` omits between but still returns today/date', () => {
    const out = schoolCalendarTool(getDb(), { date: '2026-09-25' });
    expect(out).not.toHaveProperty('between');
    expect(out).toHaveProperty('today');
    expect(out).toHaveProperty('date');
  });
});

describe('get_submission_status', () => {
  test('resolves course by name fragment and lists an outstanding student as owing', () => {
    const db = getDb();
    const { studentId } = seedLate(db);
    const r = getSubmissionStatusTool(db, { course: 'apcsp' });
    expect(r.students).toHaveLength(1);
    expect(r.students[0]).toMatchObject({ studentId, studentName: 'Maya Chen' });
    expect(r.students[0].items[0]).toMatchObject({ title: 'CP2', status: 'not_started', owing: true });
  });

  test('passes summative_only / past_due_only / assignment_id / status through to the service', () => {
    const db = getDb();
    const { courseId, assignmentId } = seedLate(db);
    const r = getSubmissionStatusTool(db, {
      course: courseId, assignment_id: assignmentId, status: 'all', summative_only: true, past_due_only: true,
    });
    expect(r.filters).toMatchObject({ summativeOnly: true, pastDueOnly: true, status: 'all', assignmentId });
    expect(r.students[0].items).toHaveLength(1);
  });
});

describe('request_resubmission unsubmit (Phase 2, LTI unsubmit on Ask)', () => {
  const noBrowser = () => { throw new Error('tests must inject a fake Schoology page'); };
  function seedLtiPair(db, state = 'submitted') {
    const { studentId, assignmentId } = seedTriagePair(db);
    db.prepare('UPDATE assignments SET is_lti_submission = 1 WHERE id = ?').run(assignmentId);
    db.prepare('INSERT INTO grades (student_id, assignment_id, score, lti_submission_state) VALUES (?, ?, 2, ?)').run(studentId, assignmentId, state);
    return { studentId, assignmentId };
  }
  beforeEach(() => { vi.clearAllMocks(); resetSessionStatusCache(); sessionDeps.openPage = noBrowser; });

  test('defaults to unsubmitting submitted LTI work; reports the outcome', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLtiPair(db);
    const fake = fakeSchoologyPage({ uid: 'ru1', aid: 'rs-a1' });
    const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId }, { unsubmitOpts: { openPage: async () => fake.session } });
    expect(r).toMatchObject({ outcome: 'asked', source: 'mcp', unsubmit: { ok: true, message: expect.stringMatching(/Unsubmitted/) } });
    expect(fake.requests.find((q) => q.method === 'POST').body).toBe('{"isSubmit":false}');
  });

  test('unsubmit: false → nothing in Schoology changes', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLtiPair(db);
    const openPage = vi.fn();
    const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, unsubmit: false }, { unsubmitOpts: { openPage } });
    expect(r.unsubmit).toBeUndefined();
    expect(openPage).not.toHaveBeenCalled();
  });

  test('defaults to no unsubmit for work that is not submitted LTI work; an explicit unsubmit there is NOT_ELIGIBLE before anything is written', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLtiPair(db, 'in_progress');
    const openPage = vi.fn();
    await expect(requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, unsubmit: true }, { unsubmitOpts: { openPage } }))
      .rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM resubmissions').get().n).toBe(0);
    const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId }, { unsubmitOpts: { openPage } });
    expect(r.unsubmit).toBeUndefined();
    expect(openPage).not.toHaveBeenCalled();
  });

  test('a failed unsubmit still records the ask and hands the teacher the Schoology link', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLtiPair(db);
    const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId }, { unsubmitOpts: { openPage: async () => null } });
    const url = 'https://schoology.hkis.edu.hk/assignments/rs-a1/info';
    expect(r).toMatchObject({
      outcome: 'asked', unsubmitError: expect.stringMatching(/expired/), unsubmitUrl: url,
      unsubmit: { ok: false, url, code: 'SCHOOLOGY_SESSION', message: expect.stringContaining(url) },
    });
    expect(r.unsubmit.message).toMatch(/still submitted/);
  });

  test('an unconfirmed unsubmit is reported as "may still be submitted"', async () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLtiPair(db);
    const fake = fakeSchoologyPage({ uid: 'ru1', aid: 'rs-a1', post: (respond) => respond(503, '') });
    const r = await requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId }, { unsubmitOpts: { openPage: async () => fake.session } });
    expect(r.unsubmit).toMatchObject({ ok: false, uncertain: true, message: expect.stringMatching(/may still be submitted/) });
  });
});
