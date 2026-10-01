import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../server/db/index.js';
import { listCourses, listAssignments, listStudents, writeRubric, attachRubricTool } from './handlers.js';
import {
  resolveCourseRef, getTriageTool, listReferralsTool, schoolCalendarTool, recordReferralTool, undoReferralTool,
  extendDeadlineTool, undoExtensionTool,
} from './handlers.js';
import { saveRubric, listRubrics, getRubricByName } from '../server/services/rubricStore.js';

beforeEach(() => {
  getDb().exec(
    'DELETE FROM referrals; DELETE FROM extensions; DELETE FROM school_days; DELETE FROM mastery_scores; ' +
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
      `"robotics" matches several courses (${a} Robotics (Block 2), ${b} Robotics (Block 6), ${c} Robotics Club) — pass a course id`,
    );
  });

  test('resolveCourseRef: unknown lists the current courses with ids and blocks', () => {
    const db = getDb();
    const a = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, block_number) VALUES ('s1', 'AP CSP', '7')`).run().lastInsertRowid;
    expect(() => resolveCourseRef(db, 'chemistry')).toThrow(`No active course matches "chemistry" (current: ${a} AP CSP (Block 7)) — pass a course id`);
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

  test('extend_deadline → get_triage row carries it → undo_extension (source mcp)', () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLate(db);
    // Due Mon 06/01/2020, weekday fallback: +3 lessons → Thu 09/01/2020.
    const e = extendDeadlineTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 3, note: 'sick' });
    expect(e).toMatchObject({ lessons: 3, note: 'sick', source: 'mcp', until: '2020-01-09', studentName: 'Maya Chen' });
    expect(getTriageTool(db, {}).lateWork[0].extension).toMatchObject({ id: e.id, lessons: 3, until: '2020-01-09' });
    expect(listReferralsTool(db, {}).extensions).toHaveLength(1);
    expect(undoExtensionTool(db, { id: e.id })).toEqual({ deleted: true });
    expect(listReferralsTool(db, {}).extensions).toEqual([]);
  });

  test('extend_deadline rejects out-of-range lessons', () => {
    const db = getDb();
    const { studentId, assignmentId } = seedLate(db);
    expect(() => extendDeadlineTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 61 }))
      .toThrow(expect.objectContaining({ code: 'BAD_LESSONS' }));
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
