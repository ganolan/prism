import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';

const h = vi.hoisted(() => {
  process.env.DB_PATH = ':memory:';
  return { loggedIn: true };
});

vi.mock('../services/masterySync.js', () => ({
  hasMasterySession: () => h.loggedIn,
  // Other named exports the route imports — unused in this test.
  syncMasteryForCourse: vi.fn(),
  syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn(),
  writeMasteryOverride: vi.fn(),
  getMasteryForCourse: vi.fn(),
  getRubricScoresForStudent: vi.fn(),
  interactiveLogin: vi.fn(),
}));
vi.mock('../services/schoology.js', () => ({
  pushGradeComments: vi.fn(),
  getSectionGrades: vi.fn(),
}));

import router from './mastery.js';
import { getDb } from '../db/index.js';
import { getMasteryForCourse } from '../services/masterySync.js';

function startServer() {
  const app = express();
  app.use('/api/mastery', router);
  const server = app.listen(0);
  return { server, port: server.address().port };
}

async function get(path) {
  const { server, port } = startServer();
  try {
    const res = await fetch(`http://localhost:${port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('GET /api/mastery/:courseId/assignment/:assignmentId — review and resubmit flags', () => {
  let courseId;
  let studentId;
  let assignmentInternalId;

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM flags; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; ' +
      'DELETE FROM students; DELETE FROM courses;'
    );
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'Course')`
    ).run().lastInsertRowid;
    studentId = db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`
    ).run().lastInsertRowid;
    db.prepare(
      `INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-1')`
    ).run(studentId, courseId);
    assignmentInternalId = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`
    ).run(courseId).lastInsertRowid;
  });

  test('review_flag is null when the student has no review flag', async () => {
    const { status, body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(status).toBe(200);
    expect(body.students).toHaveLength(1);
    expect(body.students[0].review_flag).toBeNull();
  });

  test('review_flag carries id and reason for a review_needed flag', async () => {
    const db = getDb();
    const flagId = db.prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
       VALUES (?, ?, 'review_needed', 'Check the citations')`
    ).run(studentId, assignmentInternalId).lastInsertRowid;

    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].review_flag).toEqual({
      id: flagId,
      flag_reason: 'Check the citations',
    });
  });

  test('a non-review flag on the same submission is ignored', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
       VALUES (?, ?, 'custom', 'something else')`
    ).run(studentId, assignmentInternalId);

    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].review_flag).toBeNull();
  });

  test('does not throw for an unknown assignment id', async () => {
    const { status, body } = await get(`/api/mastery/${courseId}/assignment/no-such-assignment`);
    expect(status).toBe(200);
    expect(body.students.every(s => s.review_flag === null)).toBe(true);
  });

  test('resubmit_flag is null when the student has no resubmit flag', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmit_flag).toBeNull();
  });

  test('resubmit_flag carries the id for a resubmit_requested flag', async () => {
    const db = getDb();
    const flagId = db.prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type)
       VALUES (?, ?, 'resubmit_requested')`
    ).run(studentId, assignmentInternalId).lastInsertRowid;
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmit_flag).toEqual({ id: flagId });
  });

  test('resubmitted is true when the latest revision postdates the grade', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, score, submitted_at, latest_revision_at)
       VALUES (?, ?, 80, 1000, 2000)`
    ).run(studentId, assignmentInternalId);
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmitted).toBe(true);
  });

  test('resubmitted is false with no newer revision', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmitted).toBe(false);
  });
});

describe('GET /api/mastery/:courseId/assignment/:assignmentId — individually assigned (#54)', () => {
  let courseId;
  let studentA;
  let studentB;

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM assignment_assignees; DELETE FROM flags; DELETE FROM grades; ' +
      'DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
    );
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-2', 'Course')`
    ).run().lastInsertRowid;
    studentA = db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-A', 'Ada', 'A')`
    ).run().lastInsertRowid;
    studentB = db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-B', 'Bob', 'B')`
    ).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'eA')`).run(studentA, courseId);
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'eB')`).run(studentB, courseId);
  });

  test('open-to-all assignment lists both students', async () => {
    getDb().prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-open', 'Open')`).run(courseId);
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-open`);
    const uids = body.students.map(s => s.schoology_uid).sort();
    expect(uids).toEqual(['uid-A', 'uid-B']);
  });

  test('individually-targeted assignment hides non-targeted students', async () => {
    const db = getDb();
    const aid = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, num_assignees) VALUES (?, 'sa-targeted', 'Targeted', 1)`
    ).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO assignment_assignees (assignment_id, schoology_uid) VALUES (?, 'uid-A')`).run(aid);
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-targeted`);
    expect(body.students.map(s => s.schoology_uid)).toEqual(['uid-A']);
  });
});

describe('GET /api/mastery/:courseId/student/:studentUid — individually assigned (#54)', () => {
  let courseId;
  let topicId;
  let categoryId;

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM mastery_alignments; DELETE FROM mastery_scores; ' +
      'DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
      'DELETE FROM assignment_assignees; DELETE FROM assignments; ' +
      'DELETE FROM enrolments; DELETE FROM students; DELETE FROM courses;'
    );
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-3', 'Course')`
    ).run().lastInsertRowid;
    categoryId = 'cat-1';
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES (?, ?, 'ART.5', 'Cat')`).run(categoryId, courseId);
    topicId = 'topic-1';
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES (?, ?, ?, 'ART.5.1', 'Topic')`).run(topicId, categoryId, courseId);
    db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-X', 'X', 'Y')`).run();
  });

  test('alignment for an assignment targeted at others is excluded from student summary', async () => {
    const db = getDb();
    const aid = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, num_assignees, published) VALUES (?, 'sa-1', 'NotMine', 1, 1)`
    ).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO assignment_assignees (assignment_id, schoology_uid) VALUES (?, 'uid-other')`).run(aid);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-1', ?, ?)`).run(topicId, courseId);

    const { body } = await get(`/api/mastery/${courseId}/student/uid-X`);
    expect(body.alignments).toEqual([]);
  });

  test('stale score for an assignment targeted at others is excluded from student summary', async () => {
    const db = getDb();
    // An open-to-all alignment so the topic still surfaces.
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'sa-open', 'Open', 1)`).run(courseId);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-open', ?, ?)`).run(topicId, courseId);
    // A separate individually-targeted assignment with a stale score row for uid-X.
    const targetedAid = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, num_assignees, published) VALUES (?, 'sa-targeted', 'Targeted', 1, 1)`
    ).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO assignment_assignees (assignment_id, schoology_uid) VALUES (?, 'uid-other')`).run(targetedAid);
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points) VALUES ('uid-X', 'sa-targeted', ?, 75)`).run(topicId);

    const { body } = await get(`/api/mastery/${courseId}/student/uid-X`);
    expect(body.scores.find(s => s.assignment_schoology_id === 'sa-targeted')).toBeUndefined();
  });
});

describe('GET /api/mastery/login-status', () => {
  beforeEach(() => { h.loggedIn = true; });

  test('reports loggedIn true when a session file exists', async () => {
    h.loggedIn = true;
    const { status, body } = await get('/api/mastery/login-status');
    expect(status).toBe(200);
    expect(body).toEqual({ loggedIn: true });
  });

  test('reports loggedIn false when no session file exists', async () => {
    h.loggedIn = false;
    const { status, body } = await get('/api/mastery/login-status');
    expect(status).toBe(200);
    expect(body).toEqual({ loggedIn: false });
  });
});

describe('GET /api/mastery/:courseId — alignments (#32)', () => {
  let courseId;

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM mastery_alignments; DELETE FROM mastery_scores; ' +
      'DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
      'DELETE FROM assignments; DELETE FROM courses;'
    );
    getMasteryForCourse.mockReturnValue({ categories: [], topics: [], scores: [] });
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-32', 'Course')`
    ).run().lastInsertRowid;
    db.prepare(
      `INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'RC.1', 'Creating')`
    ).run(courseId);
    db.prepare(
      `INSERT INTO measurement_topics (id, category_id, course_id, external_id, title)
       VALUES ('topic-1', 'cat-1', ?, 'RC.1.1', 'Generates media')`
    ).run(courseId);
    db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'sa-1', 'Project', 1)`
    ).run(courseId);
  });

  test('returns an empty alignments array when none exist', async () => {
    const { status, body } = await get(`/api/mastery/${courseId}`);
    expect(status).toBe(200);
    expect(body.alignments).toEqual([]);
  });

  test('returns alignment rows with topic and category metadata', async () => {
    getDb().prepare(
      `INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id)
       VALUES ('sa-1', 'topic-1', ?)`
    ).run(courseId);
    const { body } = await get(`/api/mastery/${courseId}`);
    expect(body.alignments).toEqual([{
      assignment_schoology_id: 'sa-1',
      topic_id: 'topic-1',
      topic_title: 'Generates media',
      topic_external_id: 'RC.1.1',
      category_id: 'cat-1',
      category_title: 'Creating',
      category_external_id: 'RC.1',
    }]);
  });

  test('excludes alignments for unpublished assignments', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'sa-2', 'Draft', 0)`
    ).run(courseId);
    db.prepare(
      `INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-2', 'topic-1', ?)`
    ).run(courseId);
    const { body } = await get(`/api/mastery/${courseId}`);
    expect(body.alignments).toEqual([]);
  });
});
