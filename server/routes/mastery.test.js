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
  writeMasteryScoresBatch: vi.fn(),
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
import { getMasteryForCourse, writeMasteryScoresBatch, writeMasteryOverride } from '../services/masterySync.js';
import { getSectionGrades, pushGradeComments } from '../services/schoology.js';

function startServer() {
  const app = express();
  app.use(express.json());
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

async function post(path, body) {
  const { server, port } = startServer();
  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
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

  // #76: the assignment-context response must carry the Schoology assignment
  // web_url so the /assessment/ page can link straight to Schoology. Guards the
  // SELECT * contract — a refactor to explicit columns that drops web_url would
  // fail here. The stored app.schoology.com host is rewritten onto the school
  // web domain so the link resolves to the right tenant.
  test('assignment.web_url is served rewritten onto the school domain (#76)', async () => {
    const db = getDb();
    db.prepare(
      `UPDATE assignments SET web_url = 'https://app.schoology.com/assignments/sa-1/info'
       WHERE schoology_assignment_id = 'sa-1'`
    ).run();
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.assignment.web_url).toBe('https://schoology.hkis.edu.hk/assignments/sa-1/info');
  });

  test('assignment.web_url is null when the assignment has none (#76)', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.assignment.web_url).toBeNull();
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

describe('POST /api/mastery/:courseId/write-comment — mirrors score to local DB (#60)', () => {
  let courseId;
  let studentId;
  let assignmentId;

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM flags; DELETE FROM grades; DELETE FROM mastery_alignments; ' +
      'DELETE FROM mastery_scores; DELETE FROM measurement_topics; ' +
      'DELETE FROM reporting_categories; DELETE FROM assignment_assignees; ' +
      'DELETE FROM enrolments; DELETE FROM assignments; ' +
      'DELETE FROM students; DELETE FROM courses;'
    );
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-wc', 'Course')`
    ).run().lastInsertRowid;
    studentId = db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-wc', 'Ada', 'Lovelace')`
    ).run().lastInsertRowid;
    db.prepare(
      `INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-wc')`
    ).run(studentId, courseId);
    assignmentId = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-wc', 'Project')`
    ).run(courseId).lastInsertRowid;
    pushGradeComments.mockResolvedValue({ status: 207 });
  });

  // The bug (#60): grading on the assessment page calls write-comment, which
  // fetched the fresh Schoology grade but mirrored only the comment — leaving
  // the local row's score NULL, so the gradebook showed "Missing • Not Started"
  // for work that was actually graded.
  test('mirrors the freshly-fetched score and submission timestamp into a stale grades row', async () => {
    const db = getDb();
    // Stale row: a full sync ran before the teacher graded, so score is NULL.
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, enrolment_id, score, submitted_at)
       VALUES (?, ?, 'enr-wc', NULL, 0)`
    ).run(studentId, assignmentId);
    getSectionGrades.mockResolvedValue([
      { assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade: 95, exception: 0, timestamp: 1779418446 },
    ]);

    const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc',
      assignmentId: 'sa-wc',
      comment: 'Nice work',
    });
    expect(status).toBe(200);

    const row = db.prepare(
      'SELECT score, submitted_at, grade_comment FROM grades WHERE student_id = ? AND assignment_id = ?'
    ).get(studentId, assignmentId);
    expect(row.score).toBe(95);
    expect(row.submitted_at).toBe(1779418446);
    expect(row.grade_comment).toBe('Nice work');
  });

  test('does not wipe an existing score when the Schoology grade lookup fails', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, enrolment_id, score, submitted_at)
       VALUES (?, ?, 'enr-wc', 88, 1779000000)`
    ).run(studentId, assignmentId);
    getSectionGrades.mockRejectedValue(new Error('Schoology down'));

    const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc',
      assignmentId: 'sa-wc',
      comment: 'Comment only',
    });
    expect(status).toBe(200);

    const row = db.prepare(
      'SELECT score, submitted_at, grade_comment FROM grades WHERE student_id = ? AND assignment_id = ?'
    ).get(studentId, assignmentId);
    expect(row.score).toBe(88);
    expect(row.submitted_at).toBe(1779000000);
    expect(row.grade_comment).toBe('Comment only');
  });
});

describe('POST /api/mastery/:courseId/send-all — batched bulk send (#51)', () => {
  let courseId;
  let adaId, bobId;
  let assignmentRowId;

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM flags; DELETE FROM grades; DELETE FROM mastery_alignments; ' +
      'DELETE FROM mastery_scores; DELETE FROM measurement_topics; ' +
      'DELETE FROM reporting_categories; DELETE FROM assignment_assignees; ' +
      'DELETE FROM enrolments; DELETE FROM assignments; ' +
      'DELETE FROM students; DELETE FROM courses;'
    );
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-sa', 'Course')`
    ).run().lastInsertRowid;
    adaId = db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-ada', 'Ada', 'Lovelace')`
    ).run().lastInsertRowid;
    bobId = db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-bob', 'Bob', 'Babbage')`
    ).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-ada')`).run(adaId, courseId);
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-bob')`).run(bobId, courseId);
    assignmentRowId = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`
    ).run(courseId).lastInsertRowid;
    // Topic the score mirror references (FK: mastery_scores.topic_id → measurement_topics.id).
    db.prepare(`INSERT INTO measurement_topics (id, course_id, external_id, title) VALUES ('t1', ?, 'ART.1.1', 'Topic 1')`).run(courseId);

    writeMasteryScoresBatch.mockReset();
    writeMasteryScoresBatch.mockResolvedValue(undefined);
    pushGradeComments.mockReset();
    pushGradeComments.mockResolvedValue({ status: 207 });
    getSectionGrades.mockReset();
    getSectionGrades.mockResolvedValue([
      { assignment_id: 'sa-1', enrollment_id: 'enr-ada', grade: 95, exception: 0, timestamp: 1779418446 },
      { assignment_id: 'sa-1', enrollment_id: 'enr-bob', grade: 80, exception: 0, timestamp: 1779418400 },
    ]);
  });

  function entry(uid, enrollmentId, { scores = true, comment = true } = {}) {
    return {
      uid,
      enrollmentId,
      assignmentId: 'sa-1',
      scores: scores ? { gradeInfo: { 't1': { grade: '100', gradingScaleId: 21337256 } }, gradingPeriodId: 1, gradingCategoryId: 2 } : null,
      comment: comment ? { comment: `note ${uid}`, commentStatus: true } : null,
    };
  }

  test('writes all students with one score-batch call and one comment PUT', async () => {
    const { status } = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [entry('uid-ada', 'enr-ada'), entry('uid-bob', 'enr-bob')],
    });
    expect(status).toBe(200);

    // One batched score write covering both students…
    expect(writeMasteryScoresBatch).toHaveBeenCalledTimes(1);
    const batchArg = writeMasteryScoresBatch.mock.calls[0][0];
    expect(batchArg.sectionId).toBe('sec-sa');
    expect(batchArg.entries).toHaveLength(2);

    // …and one bulk comment PUT covering both students.
    expect(getSectionGrades).toHaveBeenCalledTimes(1);
    expect(pushGradeComments).toHaveBeenCalledTimes(1);
    const [, comments] = pushGradeComments.mock.calls[0];
    expect(comments).toHaveLength(2);
  });

  test('echoes each student\'s fresh grade into its comment payload (#46 safety)', async () => {
    await post(`/api/mastery/${courseId}/send-all`, {
      entries: [entry('uid-ada', 'enr-ada'), entry('uid-bob', 'enr-bob')],
    });

    const [, comments] = pushGradeComments.mock.calls[0];
    const ada = comments.find(c => c.enrollment_id === 'enr-ada');
    const bob = comments.find(c => c.enrollment_id === 'enr-bob');
    // Grades come from the single getSectionGrades read (95 / 80), echoed so the
    // full-record-replace PUT doesn't wipe the score.
    expect(ada.grade).toBe('95');
    expect(bob.grade).toBe('80');
    expect(ada.comment_status).toBe(1);
  });

  test('mirrors scores and comments into the local DB on success', async () => {
    const db = getDb();
    const { status } = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [entry('uid-ada', 'enr-ada'), entry('uid-bob', 'enr-bob')],
    });
    expect(status).toBe(200);

    // mastery_scores mirrored per topic (points → letter, like the single /write).
    const score = db.prepare(
      `SELECT points, grade FROM mastery_scores WHERE student_uid = 'uid-ada' AND assignment_schoology_id = 'sa-1' AND topic_id = 't1'`
    ).get();
    expect(score.points).toBe(100);
    expect(score.grade).toBe('ED');

    // grades row mirrored with the fresh score + comment (like the single write-comment).
    const grade = db.prepare(
      `SELECT score, grade_comment, comment_status, submitted_at FROM grades
       WHERE student_id = ? AND assignment_id = ?`
    ).get(adaId, assignmentRowId);
    expect(grade.score).toBe(95);
    expect(grade.grade_comment).toBe('note uid-ada');
    expect(grade.comment_status).toBe(1);
    expect(grade.submitted_at).toBe(1779418446);
  });

  test('all-or-nothing: a score-batch failure aborts before comments and mirrors nothing', async () => {
    const db = getDb();
    writeMasteryScoresBatch.mockRejectedValue(new Error('session stale'));

    const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [entry('uid-ada', 'enr-ada'), entry('uid-bob', 'enr-bob')],
    });

    expect(status).toBe(502);
    expect(body.results.every(r => r.ok === false)).toBe(true);
    // No comment PUT, and nothing mirrored locally.
    expect(pushGradeComments).not.toHaveBeenCalled();
    const scores = db.prepare(`SELECT COUNT(*) AS n FROM mastery_scores`).get();
    expect(scores.n).toBe(0);
    const grades = db.prepare(`SELECT COUNT(*) AS n FROM grades`).get();
    expect(grades.n).toBe(0);
  });

  test('all-or-nothing: a fresh-grade read failure skips the comment PUT (no #46 wipe)', async () => {
    getSectionGrades.mockRejectedValue(new Error('Schoology down'));

    const { status } = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [entry('uid-ada', 'enr-ada'), entry('uid-bob', 'enr-bob')],
    });

    expect(status).toBe(502);
    expect(pushGradeComments).not.toHaveBeenCalled();
  });

  test('score-only entries are excluded from the comment PUT', async () => {
    await post(`/api/mastery/${courseId}/send-all`, {
      entries: [
        entry('uid-ada', 'enr-ada', { comment: false }), // scores only
        entry('uid-bob', 'enr-bob'),                      // scores + comment
      ],
    });

    const [, comments] = pushGradeComments.mock.calls[0];
    expect(comments).toHaveLength(1);
    expect(comments[0].enrollment_id).toBe('enr-bob');
  });
});

describe('POST /api/mastery/:courseId/override — level-based input', () => {
  let COURSE;
  let UID;
  let OBJ;

  beforeEach(() => {
    const db = getDb();
    db.pragma('foreign_keys = OFF');
    db.exec(
      'DELETE FROM mastery_rollups; DELETE FROM mastery_scores; ' +
      'DELETE FROM mastery_alignments; DELETE FROM measurement_topics; ' +
      'DELETE FROM reporting_categories; DELETE FROM enrolments; ' +
      'DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
    );
    db.pragma('foreign_keys = ON');
    COURSE = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-ov', 'Override Course')`
    ).run().lastInsertRowid;
    db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-ov', 'Over', 'Rider')`
    ).run();
    UID = 'uid-ov';
    OBJ = 'obj-ov-1';

    writeMasteryOverride.mockReset();
    writeMasteryOverride.mockResolvedValue({ data: { outcome_override: { grade_scaled_rounded: 3 } } });
  });

  test('override route maps a level to grade_scaled', async () => {
    const { status } = await post(`/api/mastery/${COURSE}/override`, {
      studentUid: UID,
      objectiveId: OBJ,
      level: 'EX',
    });
    expect(status).toBe(200);
    expect(writeMasteryOverride).toHaveBeenCalledWith(
      expect.objectContaining({ gradeScaled: '62.50' })
    );
  });

  test('override route rejects an out-of-scale value', async () => {
    const { status } = await post(`/api/mastery/${COURSE}/override`, {
      studentUid: UID,
      objectiveId: OBJ,
      gradeScaled: '50.00',
    });
    expect(status).toBe(400);
  });

  test('override route accepts a valid raw gradeScaled (transitional path)', async () => {
    const { status } = await post(`/api/mastery/${COURSE}/override`, {
      studentUid: UID,
      objectiveId: OBJ,
      gradeScaled: '87.50',
    });
    expect(status).toBe(200);
    expect(writeMasteryOverride).toHaveBeenCalledWith(
      expect.objectContaining({ gradeScaled: '87.50' })
    );
  });

  test('override route clears an override when both level and gradeScaled are omitted', async () => {
    const { status } = await post(`/api/mastery/${COURSE}/override`, {
      studentUid: UID,
      objectiveId: OBJ,
    });
    expect(status).toBe(200);
    expect(writeMasteryOverride).toHaveBeenCalledWith(
      expect.objectContaining({ gradeScaled: null })
    );
  });

  test('override route returns 400 for an unrecognised level (typo), does not clear', async () => {
    // A typo'd level (e.g. 'EXX') previously fell through to a clear because
    // levelToGradeScaled returned null, which bypassed the valid.has check.
    const { status, body } = await post(`/api/mastery/${COURSE}/override`, {
      studentUid: UID,
      objectiveId: OBJ,
      level: 'EXX',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Unknown level/);
    expect(writeMasteryOverride).not.toHaveBeenCalled();
  });
});
