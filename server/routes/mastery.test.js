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
// The OneDrive lookup drives a real browser — never launch one in tests (#120).
vi.mock('../services/oneDriveLinks.js', () => ({ getAssignmentFiles: vi.fn() }));

import router from './mastery.js';
import triageRouter from './triage.js';
import { getDb } from '../db/index.js';
import { getMasteryForCourse, writeMasteryScoresBatch, writeMasteryOverride } from '../services/masterySync.js';
import { getSectionGrades, pushGradeComments } from '../services/schoology.js';
import { getAssignmentFiles } from '../services/oneDriveLinks.js';
import { requestResubmission, resubmissionByStudent } from '../services/resubmissions.js';
import { captureFeedbackSnapshots } from '../services/feedbackSnapshots.js';
import { writeMasteryScores } from '../services/masterySync.js';

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
      'DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM flags; DELETE FROM resubmissions; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; ' +
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

  test('course carries archived/excluded so the page can hide the resubmission control', async () => {
    let { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.course).toMatchObject({ archived: 0, excluded: 0 });
    getDb().prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
    ({ body } = await get(`/api/mastery/${courseId}/assignment/sa-1`));
    expect(body.course.archived).toBe(1);
  });

  test('resubmit_flag is null when the student has no resubmit flag', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmit_flag).toBeNull();
  });

  test('resubmit_flag carries the id for an open resubmission request, and resubmission is "waiting"', async () => {
    const db = getDb();
    const request = requestResubmission(db, { studentId, assignmentId: assignmentInternalId, source: 'app' });
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmit_flag).toEqual({ id: request.id });
    expect(body.students[0].resubmission.state).toBe('waiting');
  });

  test('resubmitted follows arrivedKeys: true once the arrival is captured', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, score, submitted_at, latest_revision_at)
       VALUES (?, ?, 80, 1000, 2000)`
    ).run(studentId, assignmentInternalId);
    captureFeedbackSnapshots(db);
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmitted).toBe(true);
  });

  test('resubmitted is false with no newer revision', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmitted).toBe(false);
  });

  test('resubmitted goes false once the visible feedback changes, and true again for a newer revision', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, score, submitted_at, latest_revision_at)
       VALUES (?, ?, 80, 1000, 2000)`
    ).run(studentId, assignmentInternalId);
    captureFeedbackSnapshots(db);
    const before = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(before.body.students[0].resubmitted).toBe(true);

    db.prepare('UPDATE grades SET score = 90, submitted_at = 2500 WHERE student_id = ? AND assignment_id = ?')
      .run(studentId, assignmentInternalId);
    captureFeedbackSnapshots(db);
    const afterRegrade = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(afterRegrade.body.students[0].resubmitted).toBe(false);

    db.prepare('UPDATE grades SET latest_revision_at = 3000 WHERE student_id = ? AND assignment_id = ?')
      .run(studentId, assignmentInternalId);
    captureFeedbackSnapshots(db);
    const afterNewRevision = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(afterNewRevision.body.students[0].resubmitted).toBe(true);
  });

  test('per-student payload carries raw submission-status fields', async () => {
    const db = getDb();
    db.prepare(`UPDATE assignments SET is_lti_submission = 1, due_date = '2026-06-01' WHERE schoology_assignment_id = 'sa-1'`).run();
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, lti_submission_state, submission_type, late, draft)
       VALUES (?, ?, 'in_progress', 'drop', 1, 0)`
    ).run(studentId, assignmentInternalId);

    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    const s = body.students.find(x => x.schoology_uid === 'uid-1');
    expect(s).toMatchObject({ lti_submission_state: 'in_progress', submission_type: 'drop', late: 1, draft: 0 });
    expect(body.assignment).toMatchObject({ is_lti_submission: 1, due_date: '2026-06-01' });
  });

  // Task 7 (Amendment B): the card's "resubmission received" chip reads
  // status_line (the exact text Prism last published) and arrived_on (the
  // arrival date, for the inserted line's date) from this payload.
  test('status_line is null with nothing published; arrived_on is null when not arrived', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].status_line).toBeNull();
    expect(body.students[0].arrived_on).toBeNull();
  });

  test('status_line carries the stored line + kind once something has been published', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, '⟳ Resubmission requested — due Thu 09/10.', 'ask')`)
      .run(studentId, assignmentInternalId);
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].status_line).toEqual({ line: '⟳ Resubmission requested — due Thu 09/10.', kind: 'ask' });
  });

  test('arrived_on is the snapshot\'s arrival date when the resubmission state is arrived', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, score, submitted_at, latest_revision_at)
       VALUES (?, ?, 80, 1000, 2000)`
    ).run(studentId, assignmentInternalId);
    captureFeedbackSnapshots(db);
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].resubmission.state).toBe('arrived');
    const expected = resubmissionByStudent(db, assignmentInternalId).get(studentId).arrivedOn;
    expect(expected).toBeTruthy();
    expect(body.students[0].arrived_on).toBe(expected);
  });
});

describe('GET /api/mastery/:courseId/assignment/:assignmentId — individually assigned (#54)', () => {
  let courseId;
  let studentA;
  let studentB;

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM feedback_snapshots; DELETE FROM assignment_assignees; DELETE FROM flags; DELETE FROM grades; ' +
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
      'DELETE FROM feedback_snapshots; DELETE FROM mastery_alignments; DELETE FROM mastery_scores; ' +
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
      'DELETE FROM feedback_snapshots; DELETE FROM mastery_alignments; DELETE FROM mastery_scores; ' +
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
      'DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM flags; DELETE FROM resubmissions; DELETE FROM grades; DELETE FROM mastery_alignments; ' +
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
    // The grade time is never older than the write itself (see the regrade test below).
    expect(row.submitted_at).toBeGreaterThanOrEqual(1779418446);
    expect(row.grade_comment).toBe('Nice work');
  });

  test('mirrors a fresh timestamp newer than now unchanged', async () => {
    const db = getDb();
    const future = Math.floor(Date.now() / 1000) + 3600;
    getSectionGrades.mockResolvedValue([
      { assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade: 95, exception: 0, timestamp: future },
    ]);
    await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'x' });
    const row = db.prepare('SELECT submitted_at FROM grades WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId);
    expect(row.submitted_at).toBe(future);
  });

  // Final review finding 1: `fresh` is read BEFORE the comment PUT, so its
  // timestamp is the old grade time. Mirroring it left a regraded resubmission
  // "Arrived" (and its open request unsettled) until the next sync.
  test('a regrade of an arrived resubmission settles the open request (fresh.timestamp predates the arrival)', async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, enrolment_id, score, submitted_at, latest_revision_at)
       VALUES (?, ?, 'enr-wc', 50, ?, ?)`
    ).run(studentId, assignmentId, now - 86400 * 10, now - 3600);
    const request = requestResubmission(db, {
      studentId, assignmentId, requestedAt: new Date((now - 86400 * 2) * 1000).toISOString().slice(0, 19).replace('T', ' '),
    });
    captureFeedbackSnapshots(db);
    expect(resubmissionByStudent(db, assignmentId).get(studentId).state).toBe('arrived');
    getSectionGrades.mockResolvedValue([
      { assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade: 50, exception: 0, timestamp: now - 86400 * 10 },
    ]);

    const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Regraded',
    });
    expect(status).toBe(200);

    const row = db.prepare('SELECT submitted_at FROM grades WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId);
    expect(row.submitted_at).toBeGreaterThanOrEqual(now);
    expect(db.prepare('SELECT status FROM resubmissions WHERE id = ?').get(request.id).status).toBe('done');
    expect(resubmissionByStudent(db, assignmentId).has(studentId)).toBe(false);
    // The save captured the new visible feedback (Amendment B capture point).
    const snap = db.prepare('SELECT fingerprint, arrival_baseline, synced_fingerprint, fingerprint_at FROM feedback_snapshots WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId);
    expect(JSON.parse(snap.fingerprint).c).toBe('Regraded');
    // A Prism save: stamped, and the last sync's fingerprint kept for a later revision's baseline.
    expect(snap.fingerprint_at).toBeGreaterThanOrEqual(now);
    expect(snap.synced_fingerprint).toBe(snap.arrival_baseline);
    expect(snap.fingerprint).not.toBe(snap.arrival_baseline);
  });

  test('C1: a course mastery pull (POST /sync/:courseId) and an assignment pull re-snapshot the course', async () => {
    const db = getDb();
    const { syncMasteryForCourse, syncMasteryForAssignment } = await import('../services/masterySync.js');
    db.prepare(`INSERT INTO measurement_topics (id, course_id, external_id, title) VALUES ('t-wc', ?, 'X.1', 'T')`).run(courseId);
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, submitted_at, latest_revision_at) VALUES (?, ?, 'enr-wc', 50, 1000, 900)`).run(studentId, assignmentId);
    captureFeedbackSnapshots(db);
    const levels = () => JSON.parse(db.prepare('SELECT fingerprint FROM feedback_snapshots WHERE student_id = ?').get(studentId).fingerprint).l;
    syncMasteryForCourse.mockImplementation(async () => {
      db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('uid-wc', 'sa-wc', 't-wc', 75, 'EX')`).run();
      return { scoresCount: 1 };
    });
    expect((await post(`/api/mastery/sync/${courseId}`, {})).status).toBe(200);
    expect(levels()).toEqual(['t-wc:EX']);
    syncMasteryForAssignment.mockImplementation(async () => {
      db.prepare(`UPDATE mastery_scores SET grade = 'ED', points = 100`).run();
      return { scoresCount: 1 };
    });
    expect((await post(`/api/mastery/${courseId}/assignment/sa-wc/sync`, {})).status).toBe(200);
    expect(levels()).toEqual(['t-wc:ED']);
  });

  test('a rubric save (POST /write) captures the snapshot so a rubric regrade of an arrival clears it at once', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO measurement_topics (id, course_id, external_id, title) VALUES ('t-wc', ?, 'X.1', 'T')`).run(courseId);
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, enrolment_id, score, submitted_at, latest_revision_at)
       VALUES (?, ?, 'enr-wc', 50, 1000, 2000)`
    ).run(studentId, assignmentId);
    captureFeedbackSnapshots(db);
    expect(resubmissionByStudent(db, assignmentId).get(studentId).state).toBe('arrived');
    writeMasteryScores.mockResolvedValue({ ok: true });

    const { status } = await post(`/api/mastery/${courseId}/write`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', gradeInfo: { 't-wc': { grade: '75' } },
    });
    expect(status).toBe(200);
    const snap = db.prepare('SELECT fingerprint FROM feedback_snapshots WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId);
    expect(JSON.parse(snap.fingerprint).l).toEqual(['t-wc:EX']);
    expect(resubmissionByStudent(db, assignmentId).has(studentId)).toBe(false);
  });

  test('statusLine: stored (default kind received) after the PUT; the snapshot ignores it', async () => {
    const db = getDb();
    db.exec('DELETE FROM status_lines');
    const line = '⟳ Resubmission received 03/10 — regraded.';
    getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade: 3, exception: 0, timestamp: 1 }]);
    const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: `${line}\n\nMuch better.`, statusLine: line,
    });
    expect(status).toBe(200);
    expect(db.prepare('SELECT line, kind FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId))
      .toEqual({ line, kind: 'received' });
    const snap = db.prepare('SELECT fingerprint FROM feedback_snapshots WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId);
    expect(JSON.parse(snap.fingerprint).c).toBe('Much better.');
  });

  test('statusLine: honours statusLineKind; refuses a line that is not the comment\'s first line (no PUT)', async () => {
    const db = getDb();
    db.exec('DELETE FROM status_lines');
    pushGradeComments.mockClear();
    getSectionGrades.mockResolvedValue([]);
    const bad = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Note first\n⟳ X', statusLine: '⟳ X',
    });
    expect(bad.status).toBe(400);
    const badKind = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: '⟳ X', statusLine: '⟳ X', statusLineKind: 'bogus',
    });
    expect(badKind.status).toBe(400);
    expect(pushGradeComments).not.toHaveBeenCalled();
    await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: '⟳ X', statusLine: '⟳ X', statusLineKind: 'ask',
    });
    expect(db.prepare('SELECT kind FROM status_lines WHERE student_id = ?').get(studentId).kind).toBe('ask');
  });

  test('statusLine is not stored when Schoology rejects the PUT; no statusLine → nothing stored', async () => {
    const db = getDb();
    db.exec('DELETE FROM status_lines');
    getSectionGrades.mockResolvedValue([]);
    pushGradeComments.mockResolvedValueOnce({ status: 403, data: 'forbidden' });
    await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: '⟳ X', statusLine: '⟳ X' });
    await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'plain' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM status_lines').get().n).toBe(0);
  });

  test('a failed Schoology grade lookup → 502 and no PUT (a grade-less PUT would wipe the score)', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, enrolment_id, score, submitted_at)
       VALUES (?, ?, 'enr-wc', 88, 1779000000)`
    ).run(studentId, assignmentId);
    getSectionGrades.mockRejectedValue(new Error('Schoology down'));
    pushGradeComments.mockClear();

    const res = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc',
      assignmentId: 'sa-wc',
      comment: 'Comment only',
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/nothing was saved/);
    expect(pushGradeComments).not.toHaveBeenCalled();

    const row = db.prepare(
      'SELECT score, submitted_at, grade_comment FROM grades WHERE student_id = ? AND assignment_id = ?'
    ).get(studentId, assignmentId);
    expect(row.score).toBe(88);
    expect(row.submitted_at).toBe(1779000000);
    expect(row.grade_comment).toBeNull();
  });

  test('read OK but no record for the pair while Prism has a score/exception → 502, no PUT', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score) VALUES (?, ?, 'enr-wc', 88)`).run(studentId, assignmentId);
    getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-wc', enrollment_id: 'someone-else', grade: 50, exception: 0 }]);
    pushGradeComments.mockClear();
    const res = await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Hi' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Schoology has no grade record Prism expected — sync, then try again');
    db.prepare('UPDATE grades SET score = NULL, exception = 2 WHERE student_id = ?').run(studentId);
    expect((await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Hi' })).status).toBe(502);
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(db.prepare('SELECT grade_comment FROM grades WHERE student_id = ?').get(studentId).grade_comment).toBeNull();
  });

  test('genuine no-record (no Prism score/exception) still writes comment-only', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception) VALUES (?, ?, 'enr-wc', NULL, 0)`).run(studentId, assignmentId);
    getSectionGrades.mockResolvedValue([]);
    pushGradeComments.mockClear();
    const res = await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'First note' });
    expect(res.status).toBe(200);
    expect(pushGradeComments).toHaveBeenCalledTimes(1);
    expect(pushGradeComments.mock.calls[0][1][0]).toEqual({ assignment_id: 'sa-wc', enrollment_id: 'enr-wc', comment: 'First note', comment_status: 1 });
    expect(db.prepare('SELECT grade_comment FROM grades WHERE student_id = ?').get(studentId).grade_comment).toBe('First note');
  });

  test('N-1: a received line written after an ask clears the source, so undoing the ask (removeLine) leaves it', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score) VALUES (?, ?, 'enr-wc', 2)`).run(studentId, assignmentId);
    const ask = requestResubmission(db, { studentId, assignmentId, lessons: 2 });
    const askLine = '⟳ Resubmission requested — due Thu 09/10.';
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind, source_type, source_id) VALUES (?, ?, ?, 'ask', 'resubmission', ?)`)
      .run(studentId, assignmentId, askLine, ask.id);
    const received = '⟳ Resubmission received 03/10 — regraded.';
    getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade: 3, exception: 0, comment: askLine, comment_status: 1 }]);
    expect((await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: `${received}\n\nBetter.`, statusLine: received,
    })).status).toBe(200);
    expect(db.prepare('SELECT line, kind, source_type, source_id FROM status_lines WHERE student_id = ?').get(studentId))
      .toEqual({ line: received, kind: 'received', source_type: null, source_id: null });

    pushGradeComments.mockClear();
    getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade: 3, exception: 0, comment: `${received}\n\nBetter.`, comment_status: 1 }]);
    const app = express();
    app.use(express.json());
    app.use('/api/triage', triageRouter);
    const server = app.listen(0);
    try {
      const r = await fetch(`http://localhost:${server.address().port}/api/triage/resubmissions/${ask.id}?removeLine=1`, { method: 'DELETE' });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ deleted: true, statusLine: { removed: false } });
    } finally { server.close(); }
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(db.prepare('SELECT line FROM status_lines WHERE student_id = ?').get(studentId).line).toBe(received);
  });

  test('statusLine with a line break → 400 BAD_LINE, no read or PUT', async () => {
    getSectionGrades.mockClear();
    pushGradeComments.mockClear();
    const res = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: '⟳ A\nB', statusLine: '⟳ A\nB',
    });
    expect(res).toMatchObject({ status: 400, body: { code: 'BAD_LINE' } });
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(pushGradeComments).not.toHaveBeenCalled();
  });

  test('statusLine holds the per-pair lock: an overlapping status-line write → 409 BUSY before any read', async () => {
    getSectionGrades.mockClear();
    let finishPut;
    pushGradeComments.mockImplementationOnce(() => new Promise((resolve) => { finishPut = () => resolve({ status: 207 }); }));
    getSectionGrades.mockResolvedValue([]);
    const body = { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: '⟳ R', statusLine: '⟳ R' };
    const first = post(`/api/mastery/${courseId}/write-comment`, body);
    await vi.waitFor(() => expect(pushGradeComments).toHaveBeenCalled());
    const second = await post(`/api/mastery/${courseId}/write-comment`, body);
    expect(second).toMatchObject({ status: 409, body: { code: 'BUSY' } });
    expect(getSectionGrades).toHaveBeenCalledTimes(1);
    finishPut();
    expect((await first).status).toBe(200);
    // Released: the next write goes through.
    expect((await post(`/api/mastery/${courseId}/write-comment`, body)).status).toBe(200);
  });
});

describe('POST /api/mastery/:courseId/send-all — batched bulk send (#51)', () => {
  let courseId;
  let adaId, bobId;
  let assignmentRowId;

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM flags; DELETE FROM resubmissions; DELETE FROM grades; DELETE FROM mastery_alignments; ' +
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

  test('N-2: an entry with no Schoology record while Prism has its grade → 502, no PUT, no local writes', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, grade_comment) VALUES (?, ?, 'enr-bob', 70, 'old')`).run(bobId, assignmentRowId);
    getSectionGrades.mockResolvedValue([
      { assignment_id: 'sa-1', enrollment_id: 'enr-ada', grade: 95, exception: 0, timestamp: 1779418446 },
    ]);
    const res = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [entry('uid-ada', 'enr-ada'), entry('uid-bob', 'enr-bob')],
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Schoology has no grade record Prism expected — sync, then try again');
    expect(res.body.results).toEqual([{ uid: 'uid-ada', ok: false }, { uid: 'uid-bob', ok: false }]);
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(db.prepare('SELECT score, grade_comment FROM grades WHERE student_id = ?').get(bobId)).toEqual({ score: 70, grade_comment: 'old' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM grades WHERE student_id = ?').get(adaId).n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_scores').get().n).toBe(0);
  });

  test('N-2: a genuinely never-graded pair (no Prism score/exception) still sends comment-only', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception) VALUES (?, ?, 'enr-bob', NULL, 0)`).run(bobId, assignmentRowId);
    getSectionGrades.mockResolvedValue([
      { assignment_id: 'sa-1', enrollment_id: 'enr-ada', grade: 95, exception: 0, timestamp: 1779418446 },
    ]);
    const res = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [entry('uid-ada', 'enr-ada', { scores: false }), entry('uid-bob', 'enr-bob', { scores: false })],
    });
    expect(res.status).toBe(200);
    expect(pushGradeComments).toHaveBeenCalledTimes(1);
    const bob = pushGradeComments.mock.calls[0][1].find((p) => p.enrollment_id === 'enr-bob');
    expect(bob).toEqual({ assignment_id: 'sa-1', enrollment_id: 'enr-bob', comment: 'note uid-bob', comment_status: 1 });
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
    // Never older than the write itself — a teacher write sets the REST timestamp.
    expect(grade.submitted_at).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5);
  });

  test('a regrade via send-all settles an arrived resubmission request (fresh.timestamp predates the arrival)', async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, enrolment_id, score, submitted_at, latest_revision_at)
       VALUES (?, ?, 'enr-ada', 50, 1779418446, ?)`
    ).run(adaId, assignmentRowId, now - 3600);
    const request = requestResubmission(db, {
      studentId: adaId, assignmentId: assignmentRowId,
      requestedAt: new Date((now - 86400) * 1000).toISOString().slice(0, 19).replace('T', ' '),
    });
    captureFeedbackSnapshots(db);
    expect(resubmissionByStudent(db, assignmentRowId).get(adaId).state).toBe('arrived');

    const { status } = await post(`/api/mastery/${courseId}/send-all`, { entries: [entry('uid-ada', 'enr-ada')] });
    expect(status).toBe(200);
    expect(db.prepare('SELECT status FROM resubmissions WHERE id = ?').get(request.id).status).toBe('done');
    expect(resubmissionByStudent(db, assignmentRowId).has(adaId)).toBe(false);
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

  // Task 7 (Amendment B): the card's "resubmission received" chip can save via
  // Send-all too — same statusLine/statusLineKind contract as write-comment.
  test('statusLine: stored (default kind received) once Send-all succeeds', async () => {
    const line = '⟳ Resubmission received 03/10 — regraded.';
    const { status } = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [entry('uid-ada', 'enr-ada', { scores: false }), {
        uid: 'uid-ada', enrollmentId: 'enr-ada', assignmentId: 'sa-1', scores: null,
        comment: { comment: `${line}\n\nBetter.`, commentStatus: true, statusLine: line },
      }],
    });
    expect(status).toBe(200);
    const db = getDb();
    expect(db.prepare('SELECT line, kind FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(adaId, assignmentRowId))
      .toEqual({ line, kind: 'received' });
  });

  test('statusLine: refuses a line that is not the comment\'s first line, before any write', async () => {
    const res = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [{
        uid: 'uid-ada', enrollmentId: 'enr-ada', assignmentId: 'sa-1', scores: null,
        comment: { comment: 'Note first\n⟳ X', commentStatus: true, statusLine: '⟳ X' },
      }],
    });
    expect(res.status).toBe(400);
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(writeMasteryScoresBatch).not.toHaveBeenCalled();
  });

  test('statusLine: an unknown statusLineKind is rejected before any write', async () => {
    const res = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [{
        uid: 'uid-ada', enrollmentId: 'enr-ada', assignmentId: 'sa-1', scores: null,
        comment: { comment: '⟳ X', commentStatus: true, statusLine: '⟳ X', statusLineKind: 'bogus' },
      }],
    });
    expect(res.status).toBe(400);
    expect(pushGradeComments).not.toHaveBeenCalled();
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
      'DELETE FROM feedback_snapshots; DELETE FROM mastery_rollups; DELETE FROM mastery_scores; ' +
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

describe('rollups are per-course for a multi-course student (#127)', () => {
  // A student enrolled in two of the teacher's courses, both aligned to the
  // SAME district objective UUID. Schoology computes a distinct rollup per
  // course; the pre-fix key (student_uid, objective_id) collapsed them to one
  // row, so the proficiency columns went blank on the student's other course
  // page. These guard that each course keeps its own rollup end-to-end.
  let courseMad, courseRob;
  const UID = 'uid-multi';
  const OBJ_CAT = 'cat-shared'; // reporting-category UUID shared across courses

  beforeEach(() => {
    const db = getDb();
    db.pragma('foreign_keys = OFF');
    db.exec(
      'DELETE FROM feedback_snapshots; DELETE FROM mastery_rollups; DELETE FROM mastery_scores; ' +
      'DELETE FROM mastery_alignments; DELETE FROM measurement_topics; ' +
      'DELETE FROM reporting_categories; DELETE FROM enrolments; ' +
      'DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
    );
    db.pragma('foreign_keys = ON');
    courseMad = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s-mad','MAD')`).run().lastInsertRowid;
    courseRob = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s-rob','Robotics')`).run().lastInsertRowid;
    const sid = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Adrien', 'Wu')`).run(UID).lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?,?,'e-mad')`).run(sid, courseMad);
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?,?,'e-rob')`).run(sid, courseRob);
  });

  function seedRollup(courseId, scaled) {
    getDb().prepare(
      `INSERT INTO mastery_rollups (student_uid, objective_id, course_id, is_category, grade_percentage, grade_scaled_rounded, override_value, synced_at)
       VALUES (?, ?, ?, 1, ?, ?, NULL, 't')`
    ).run(UID, OBJ_CAT, courseId, scaled, scaled);
  }

  test('the course page returns THIS course\'s rollup (not blank) for the multi-course student', async () => {
    seedRollup(courseMad, 87.5);
    seedRollup(courseRob, 62.5); // would collide on the old key

    const mad = await get(`/api/mastery/${courseMad}`);
    const rob = await get(`/api/mastery/${courseRob}`);
    const find = (b) => b.rollups.find(r => r.student_uid === UID && r.objective_id === OBJ_CAT);
    expect(find(mad.body)?.grade_scaled_rounded).toBe(87.5);
    expect(find(rob.body)?.grade_scaled_rounded).toBe(62.5);
  });

  test('the per-student summary returns the rollup for the requested course only', async () => {
    seedRollup(courseMad, 87.5);
    seedRollup(courseRob, 62.5);

    const mad = await get(`/api/mastery/${courseMad}/student/${UID}`);
    const rob = await get(`/api/mastery/${courseRob}/student/${UID}`);
    expect(mad.body.rollups.find(r => r.objective_id === OBJ_CAT)?.grade_scaled_rounded).toBe(87.5);
    expect(rob.body.rollups.find(r => r.objective_id === OBJ_CAT)?.grade_scaled_rounded).toBe(62.5);
  });

  test('the override mirror writes a per-course rollup row, never a cross-course collision', async () => {
    writeMasteryOverride.mockReset();
    writeMasteryOverride.mockResolvedValue({ data: { outcome_override: { grade_scaled_rounded: 87.5 } } });
    await post(`/api/mastery/${courseMad}/override`, { studentUid: UID, objectiveId: OBJ_CAT, gradeScaled: '87.50' });
    writeMasteryOverride.mockResolvedValue({ data: { outcome_override: { grade_scaled_rounded: 62.5 } } });
    await post(`/api/mastery/${courseRob}/override`, { studentUid: UID, objectiveId: OBJ_CAT, gradeScaled: '62.50' });

    const rows = getDb().prepare(
      `SELECT course_id, override_value FROM mastery_rollups
       WHERE student_uid=? AND objective_id=? ORDER BY course_id`
    ).all(UID, OBJ_CAT);
    expect(rows).toEqual([
      { course_id: courseMad, override_value: 87.5 },
      { course_id: courseRob, override_value: 62.5 },
    ]);
  });
});

describe('GET /api/mastery/:courseId/assignment/:assignmentId/submission-links (#120)', () => {
  const ORIGIN = 'https://hkis-my.sharepoint.com';
  const DIR = '/personal/t/Documents/Schoology Microsoft OneDrive Assignments/C - sec-L/Launch - sa-lti';
  const spFile = (name, extra = {}) => ({
    Name: name,
    ServerRelativeUrl: `${DIR}/${name}`,
    LinkingUrl: `${ORIGIN}${DIR}/${name}?d=wabc`,
    TimeLastModified: '2026-09-28T06:27:25Z',
    ...extra,
  });
  let courseId;

  beforeEach(() => {
    vi.mocked(getAssignmentFiles).mockReset();
    const db = getDb();
    db.exec(
      'DELETE FROM feedback_snapshots; DELETE FROM mastery_rollups; DELETE FROM mastery_scores; DELETE FROM mastery_alignments; ' +
      'DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM assignment_assignees; ' +
      'DELETE FROM flags; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; ' +
      'DELETE FROM students; DELETE FROM courses;'
    );
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-L', 'Course')`
    ).run().lastInsertRowid;
    for (const [uid, first, last] of [['uid-A', 'Alison', 'Cheng'], ['uid-G', 'Garmin', 'Ho']]) {
      const sid = db.prepare('INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, ?)').run(uid, first, last).lastInsertRowid;
      db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, ?)`).run(sid, courseId, `e-${uid}`);
    }
    db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission) VALUES (?, 'sa-lti', 'Launch', 1)`
    ).run(courseId);
    db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-native', 'Essay')`
    ).run(courseId);
  });

  test('keys the OneDrive files to roster students by name', async () => {
    vi.mocked(getAssignmentFiles).mockResolvedValue({
      status: 'ok',
      origin: ORIGIN,
      files: [spFile('Alison Cheng - Launch - 4299333.pptx'), spFile('Stranger Danger - Launch - 1.pptx')],
    });
    const { status, body } = await get(`/api/mastery/${courseId}/assignment/sa-lti/submission-links`);
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(Object.keys(body.links)).toEqual(['uid-A']);
    expect(body.links['uid-A'].url).toBe(`${ORIGIN}${DIR}/Alison Cheng - Launch - 4299333.pptx?d=wabc`);
    expect(getAssignmentFiles).toHaveBeenCalledWith({ sectionId: 'sec-L', assignmentId: 'sa-lti', refresh: false });
  });

  test('?refresh=1 bypasses the cache', async () => {
    vi.mocked(getAssignmentFiles).mockResolvedValue({ status: 'ok', origin: ORIGIN, files: [] });
    await get(`/api/mastery/${courseId}/assignment/sa-lti/submission-links?refresh=1`);
    expect(getAssignmentFiles).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
  });

  test('non-lti assignments never touch OneDrive', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-native/submission-links`);
    expect(body).toEqual({ status: 'not_lti', links: {} });
    expect(getAssignmentFiles).not.toHaveBeenCalled();
  });

  test('a lookup failure passes its status through with no links', async () => {
    vi.mocked(getAssignmentFiles).mockResolvedValue({ status: 'sso_failed' });
    const { status, body } = await get(`/api/mastery/${courseId}/assignment/sa-lti/submission-links`);
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'sso_failed', links: {} });
  });

  test('404 for an unknown course', async () => {
    const { status } = await get('/api/mastery/999999/assignment/sa-lti/submission-links');
    expect(status).toBe(404);
  });
});

describe('Score-scale grading for unaligned assignments (#41)', () => {
  let courseId;
  let studentA;

  beforeEach(() => {
    vi.mocked(pushGradeComments).mockReset().mockResolvedValue({});
    vi.mocked(getSectionGrades).mockReset();
    const db = getDb();
    db.exec(
      'DELETE FROM feedback_snapshots; DELETE FROM mastery_rollups; DELETE FROM mastery_scores; DELETE FROM mastery_alignments; ' +
      'DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM assignment_assignees; ' +
      'DELETE FROM flags; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; ' +
      'DELETE FROM students; DELETE FROM courses;'
    );
    courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-S', 'Course')`).run().lastInsertRowid;
    studentA = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-A', 'Ada', 'A')`).run().lastInsertRowid;
    const studentB = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-B', 'Bob', 'B')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'eA')`).run(studentA, courseId);
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'eB')`).run(studentB, courseId);
    const completion = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-C', 'Homework', '7165818')`
    ).run(courseId).lastInsertRowid;
    db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-L', 'Letter', '1293963')`
    ).run(courseId);
    db.prepare(`INSERT INTO grades (student_id, assignment_id, score) VALUES (?, ?, 100)`).run(studentA, completion);
  });

  test('GET ships the assignment\'s scale (best → worst) and each student\'s current level', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-C`);
    expect(body.scoreScale.name).toBe('Completion Scale');
    expect(body.scoreScale.levels.map(l => l.code)).toEqual(['C', 'I']);
    const byUid = Object.fromEntries(body.students.map(s => [s.schoology_uid, s]));
    expect(byUid['uid-A']).toMatchObject({ score: 100, scale_level: 'C' });
    expect(byUid['uid-B']).toMatchObject({ score: null, scale_level: null });
  });

  test('GET names the class (course + block) so the page can say which section it is', async () => {
    getDb().prepare(`UPDATE courses SET section_name = '4(A-B)', block_number = '7' WHERE id = ?`).run(courseId);
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-C`);
    // block_number is a TEXT column (#106).
    expect(body.course).toEqual({ id: courseId, course_name: 'Course', section_name: '4(A-B)', block_number: '7', archived: 0, excluded: 0 });
  });

  test('GET: no scoreScale for a scale Prism does not grade', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-L`);
    expect(body.scoreScale).toBeNull();
  });

  test('write-comment with points writes the grade + comment in one PUT, echoing the exception', async () => {
    vi.mocked(getSectionGrades).mockResolvedValue([
      { assignment_id: 'sa-C', enrollment_id: 'eB', grade: null, exception: 4, timestamp: '1700000000' },
    ]);
    const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'eB', assignmentId: 'sa-C', points: 100, comment: 'Done', commentStatus: true,
    });
    expect(status).toBe(200);
    expect(pushGradeComments).toHaveBeenCalledWith('sec-S', [{
      assignment_id: 'sa-C', enrollment_id: 'eB', comment: 'Done', comment_status: 1, grade: '100', exception: 4,
    }]);
    const row = getDb().prepare(
      `SELECT g.score, g.grade_comment FROM grades g JOIN students s ON s.id = g.student_id WHERE s.schoology_uid = 'uid-B'`
    ).get();
    expect(row).toEqual({ score: 100, grade_comment: 'Done' });
  });

  test('write-comment refuses points that are not one of the scale\'s levels', async () => {
    const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'eB', assignmentId: 'sa-C', points: 80, comment: '', commentStatus: true,
    });
    expect(status).toBe(400);
    expect(pushGradeComments).not.toHaveBeenCalled();
  });

  test('write-comment refuses points on an assignment Prism does not grade by scale', async () => {
    const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'eB', assignmentId: 'sa-L', points: 100, comment: '', commentStatus: true,
    });
    expect(status).toBe(400);
    expect(pushGradeComments).not.toHaveBeenCalled();
  });

  test('write-comment with points stops if the current Schoology grade cannot be read', async () => {
    vi.mocked(getSectionGrades).mockRejectedValue(new Error('network'));
    const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'eB', assignmentId: 'sa-C', points: 100, comment: '', commentStatus: true,
    });
    expect(status).toBe(502);
    expect(pushGradeComments).not.toHaveBeenCalled();
  });

  test('send-all carries a scale grade into the PUT payload and mirrors the score', async () => {
    vi.mocked(getSectionGrades).mockResolvedValue([
      { assignment_id: 'sa-C', enrollment_id: 'eB', grade: null, exception: 0, timestamp: '0' },
    ]);
    const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [{ uid: 'uid-B', enrollmentId: 'eB', assignmentId: 'sa-C', scores: null,
        grade: { points: 0 }, comment: { comment: '', commentStatus: false } }],
    });
    expect(status).toBe(200);
    expect(body.results).toEqual([{ uid: 'uid-B', ok: true }]);
    expect(pushGradeComments).toHaveBeenCalledWith('sec-S', [expect.objectContaining({ grade: '0', comment_status: null })]);
    const row = getDb().prepare(
      `SELECT g.score FROM grades g JOIN students s ON s.id = g.student_id WHERE s.schoology_uid = 'uid-B'`
    ).get();
    expect(row.score).toBe(0);
  });

  test('send-all rejects an off-scale grade before writing anything', async () => {
    const { status } = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [{ uid: 'uid-B', enrollmentId: 'eB', assignmentId: 'sa-C', scores: null,
        grade: { points: 55 }, comment: { comment: '', commentStatus: true } }],
    });
    expect(status).toBe(400);
    expect(pushGradeComments).not.toHaveBeenCalled();
  });
});
