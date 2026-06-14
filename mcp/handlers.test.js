import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../server/db/index.js';
import { listCourses, listAssignments, writeRubric, attachRubricTool } from './handlers.js';
import { saveRubric, listRubrics, getRubricByName } from '../server/services/rubricStore.js';

beforeEach(() => {
  getDb().exec(
    'DELETE FROM rubric_attachment_topics; DELETE FROM rubric_attachments; ' +
    'DELETE FROM rubric_descriptors; DELETE FROM rubric_criteria; DELETE FROM rubrics; ' +
    'DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
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
