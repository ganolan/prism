import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
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
  readPairLevels: vi.fn(),
  interactiveLogin: vi.fn(),
}));
// The real feedback-rows service, with saveRowLevels wrapped so one test can make it fail.
vi.mock('../services/feedbackRows.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, saveRowLevels: vi.fn(real.saveRowLevels) };
});
vi.mock('../services/schoology.js', () => ({
  pushGradeUpdates: vi.fn(),
  getSectionGrades: vi.fn(),
  getAssignmentGrades: vi.fn(),
}));
// The OneDrive lookup drives a real browser — never launch one in tests (#120).
vi.mock('../services/oneDriveLinks.js', () => ({ getAssignmentFiles: vi.fn() }));
vi.mock('../services/syncQueue.js', () => ({ enqueue: vi.fn(() => ({ runId: 77, state: 'queued', joined: false })) }));
vi.mock('../services/ltiSubmissionApps.js', () => ({ getLtiSubmissionApp: vi.fn(), getSubmittedDocuments: vi.fn() }));

import router from './mastery.js';
import { enqueue } from '../services/syncQueue.js';
import triageRouter from './triage.js';
import { getDb } from '../db/index.js';
import { saveRowLevels } from '../services/feedbackRows.js';
import { getMasteryForCourse, writeMasteryScoresBatch, writeMasteryOverride } from '../services/masterySync.js';
import { getSectionGrades, getAssignmentGrades, pushGradeUpdates } from '../services/schoology.js';
import { getAssignmentFiles } from '../services/oneDriveLinks.js';
import { getLtiSubmissionApp, getSubmittedDocuments } from '../services/ltiSubmissionApps.js';
import { requestResubmission, resubmissionByStudent } from '../services/resubmissions.js';
import { captureFeedbackSnapshots } from '../services/feedbackSnapshots.js';
import { publishStatusLine } from '../services/statusLinePublisher.js';
import { writeMasteryScores, interactiveLogin } from '../services/masterySync.js';
import { sessionDeps, resetSessionStatusCache } from '../services/schoologySession.js';
import { fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';

// Never a real browser or a real Schoology request in tests: the live session
// check is a plain-HTTP GET of /home (sessionDeps.openJar + fetch), faked below.
const noBrowser = () => { throw new Error('tests must inject a fake Schoology page'); };
const noNetwork = () => { throw new Error('tests must inject a fake Schoology web'); };
sessionDeps.openPage = noBrowser;
sessionDeps.openJar = noNetwork;
sessionDeps.fetch = noNetwork;

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

describe('GET /api/mastery/:courseId/assignment/:assignmentId — resubmit flags', () => {
  let courseId;
  let studentId;
  let assignmentInternalId;

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM resubmissions; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; ' +
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

  test('each student carries the submission timeline (late day against an extension)', async () => {
    const db = getDb();
    db.exec("DELETE FROM extensions; DELETE FROM school_days;");
    db.prepare(`UPDATE assignments SET due_date = '2026-10-06 15:00:00', is_lti_submission = 1, accepts_submissions = 1 WHERE id = ?`).run(assignmentInternalId);
    // Weekday fallback calendar (no school_days): extended +1 → Wed 07/10; submitted Fri 09/10 = day 3.
    db.prepare(`INSERT INTO extensions (student_id, assignment_id, course_id, lessons, note, source) VALUES (?, ?, ?, 1, NULL, 'app')`)
      .run(studentId, assignmentInternalId, courseId);
    const submittedAt = Math.floor(new Date('2026-10-09T10:00:00').getTime() / 1000);
    db.prepare(`INSERT INTO grades (student_id, assignment_id, lti_submission_state, first_submitted_at, latest_revision_at, late) VALUES (?, ?, 'submitted', ?, ?, 1)`)
      .run(studentId, assignmentInternalId, submittedAt, submittedAt);

    try {
      const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
      expect(body.students[0].timeline).toMatchObject({
        due: { date: '2026-10-06', time: '15:00' },
        extension: { schoolDays: 1, until: '2026-10-07' },
        submission: { state: 'submitted', firstAt: submittedAt, late: true, day: 3, schoologyLate: true },
        overdue: null,
      });
    } finally {
      db.exec('DELETE FROM extensions;'); // references the course the next beforeEach deletes
    }
  });

  test('unsubmit_available: only OneDrive (LTI) work Prism last saw submitted (Phase 2)', async () => {
    const db = getDb();
    const grade = db.prepare(`INSERT INTO grades (student_id, assignment_id, lti_submission_state) VALUES (?, ?, 'submitted')`)
      .run(studentId, assignmentInternalId).lastInsertRowid;
    const available = async () => (await get(`/api/mastery/${courseId}/assignment/sa-1`)).body.students[0].unsubmit_available;
    expect(await available()).toBe(false); // not LTI
    db.prepare('UPDATE assignments SET is_lti_submission = 1 WHERE id = ?').run(assignmentInternalId);
    expect(await available()).toBe(true);
    for (const st of ['in_progress', 'not_started', null]) {
      db.prepare('UPDATE grades SET lti_submission_state = ? WHERE id = ?').run(st, grade);
      expect(await available()).toBe(false);
    }
  });

  test('a student carries no review_flag (Flag for review is gone, #40)', async () => {
    const { status, body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(status).toBe(200);
    expect(body.students).toHaveLength(1);
    expect(body.students[0]).not.toHaveProperty('review_flag');
  });

  test('each student carries the waiting saved copy (saved_grade) and the flag\'s status line (flag_line) (#40)', async () => {
    const db = getDb();
    db.exec('DELETE FROM excused_grades;');
    db.prepare(`INSERT INTO grades (student_id, assignment_id, exception, score) VALUES (?, ?, 1, NULL)`).run(studentId, assignmentInternalId);
    const none = (await get(`/api/mastery/${courseId}/assignment/sa-1`)).body.students[0];
    expect(none).toMatchObject({ saved_grade: null, flag_line: null });
    db.prepare(`INSERT INTO excused_grades (student_id, assignment_id, flag, saved_json, saved_at) VALUES (?, ?, 1, ?, '2026-10-21 02:00:00')`)
      .run(studentId, assignmentInternalId, JSON.stringify({ score: 75, max_points: 100, comment: 'Good.', topics: { t1: 'EX' }, rows: {}, scale_level: null }));
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, 'Marked exempt on Wed 21/10. Medical leave.', 'flag')`)
      .run(studentId, assignmentInternalId);
    try {
      const st = (await get(`/api/mastery/${courseId}/assignment/sa-1`)).body.students[0];
      expect(st.saved_grade).toMatchObject({ score: 75, topics: { t1: 'EX' }, flag: 1, savedAt: '2026-10-21 02:00:00', summary: '75 / 100 and 1 topic level' });
      // What clearing can stage: on a points-only task, the score in the card's points box (#181).
      expect(st.saved_grade).toMatchObject({ restoreSummary: '75 points', notRestored: [] });
      expect(st.flag_line).toBe('Marked exempt on Wed 21/10. Medical leave.');
      // Restored: no longer waiting. Another kind of status line is not the flag's.
      db.prepare(`UPDATE excused_grades SET restored_at = '2026-10-22 00:00:00'`).run();
      db.prepare(`UPDATE status_lines SET kind = 'extension'`).run();
      const after = (await get(`/api/mastery/${courseId}/assignment/sa-1`)).body.students[0];
      expect(after).toMatchObject({ saved_grade: null, flag_line: null });
    } finally {
      db.exec('DELETE FROM excused_grades;');
    }
  });

  test('each student carries attention: handedIn + the calendar reasons (cardAttention.test.js has the cases)', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].attention).toEqual({ handedIn: expect.any(Boolean), reasons: expect.any(Array) });
  });

  test('does not throw for an unknown assignment id', async () => {
    const { status, body } = await get(`/api/mastery/${courseId}/assignment/no-such-assignment`);
    expect(status).toBe(200);
    expect(body.students.every(s => !('review_flag' in s))).toBe(true);
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
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, 'Resubmission requested - due Thu 09/10.', 'ask')`)
      .run(studentId, assignmentInternalId);
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].status_line).toEqual({ line: 'Resubmission requested - due Thu 09/10.', kind: 'ask' });
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
      'DELETE FROM feedback_snapshots; DELETE FROM assignment_assignees; DELETE FROM grades; ' +
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
  let home; // the /home answer: 200 = signed in, { login: true } = sent to sign-in
  let web;
  const homeLoads = () => web.requests.filter((r) => r.path === '/home').length;
  beforeEach(() => {
    h.loggedIn = true;
    resetSessionStatusCache();
    home = { status: 200, text: 'home' };
    web = fakeSchoologyWeb({ routes: { '/home': () => home } });
    sessionDeps.openJar = vi.fn(() => web.jar);
    sessionDeps.fetch = web.fetchImpl;
  });
  afterEach(() => { sessionDeps.openJar = noNetwork; sessionDeps.fetch = noNetwork; });

  test("a live saved session → loggedIn, live 'connected', checkedAt", async () => {
    const { status, body } = await get('/api/mastery/login-status');
    expect(status).toBe(200);
    expect(body).toMatchObject({ loggedIn: true, live: 'connected' });
    expect(Date.parse(body.checkedAt)).not.toBeNaN();
  });

  test("no session file → loggedIn false, live 'none', nothing requested", async () => {
    h.loggedIn = false;
    const { status, body } = await get('/api/mastery/login-status');
    expect(status).toBe(200);
    expect(body).toEqual({ loggedIn: false, live: 'none', checkedAt: null });
    expect(sessionDeps.openJar).not.toHaveBeenCalled();
  });

  test('cached between calls; ?refresh=1 re-checks; ?check=0 never checks', async () => {
    await get('/api/mastery/login-status');
    await get('/api/mastery/login-status');
    expect(homeLoads()).toBe(1);
    home = { login: true };
    const refreshed = await get('/api/mastery/login-status?refresh=1');
    expect(homeLoads()).toBe(2);
    expect(refreshed.body).toMatchObject({ loggedIn: true, live: 'expired' });
    const quick = await get('/api/mastery/login-status?check=0&refresh=1');
    expect(homeLoads()).toBe(2);
    expect(quick.body.live).toBe('expired');
  });

  test("a failing check → 'unknown' with a message, still 200", async () => {
    home = { throws: new Error('boom') };
    const { status, body } = await get('/api/mastery/login-status');
    expect(status).toBe(200);
    expect(body).toMatchObject({ live: 'unknown', message: expect.stringMatching(/boom/) });
  });

  test('POST /login is gone: sign-in is /api/schoology-login (any device)', async () => {
    const { server, port } = startServer();
    try {
      const res = await fetch(`http://localhost:${port}/api/mastery/login`, { method: 'POST' });
      expect(res.status).toBe(404);
    } finally { server.close(); }
    expect(interactiveLogin).not.toHaveBeenCalled();
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
      'DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM resubmissions; DELETE FROM grades; DELETE FROM mastery_alignments; ' +
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
    pushGradeUpdates.mockResolvedValue({ status: 207 });
  });

  // #200: the Attempts tab writes a Schoology test's overall comment through this route, with no
  // points: the PUT carries the auto-scored grade Schoology holds, so the score never changes.
  test('write-comment on a Schoology test sends back the grade Schoology holds', async () => {
    const db = getDb();
    db.prepare(`UPDATE assignments SET is_test = 1 WHERE id = ?`).run(assignmentId);
    getSectionGrades.mockResolvedValue([
      { assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade: 100, exception: 0, timestamp: 1779418446 },
    ]);
    const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Multiple choice: 20/20 (100%)', commentStatus: false,
    });
    expect(status).toBe(200);
    const [, entries] = pushGradeUpdates.mock.calls.at(-1);
    expect(entries).toEqual([expect.objectContaining({
      assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade: '100', comment: 'Multiple choice: 20/20 (100%)', comment_status: null,
    })]);
  });

  // The bug (#60): grading on the assessment page calls write-comment, which
  // fetched the fresh Schoology grade but mirrored only the comment — leaving
  // the local row's score NULL, so the gradebook showed "Overdue • Not Started"
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
    // The assignment pull now runs as a queued task run (taskSyncRun.js → refreshAssignmentMastery,
    // whose afterPull re-snapshots the course): see taskSyncRun.test.js and masteryRefresh.test.js.
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

  // Round 5: a save credits only what the teacher wrote. Before its own mirror the route
  // runs an unstamped capture (judges a revision a running sync upserted, absorbs a
  // pull's levels); the fresh Schoology score/exception it echoes is mirrored unstamped
  // unless the teacher wrote it in this save (rubricSaved / points); then the teacher's
  // own changes are mirrored and captured stamped.
  describe('round 5: other writers are never credited to the teacher\'s save', () => {
    const state = () => resubmissionByStudent(getDb(), assignmentId).get(studentId)?.state ?? null;
    const fresh = (grade, timestamp = 1500) => getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade, exception: 0, timestamp }]);
    const level = (g) => getDb().prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('uid-wc', 'sa-wc', 't-wc', 50, ?)
      ON CONFLICT(student_uid, assignment_schoology_id, topic_id) DO UPDATE SET grade = excluded.grade`).run(g);
    const set = (cols) => { const k = Object.keys(cols); getDb().prepare(`UPDATE grades SET ${k.map((x) => `${x} = ?`).join(', ')} WHERE student_id = ? AND assignment_id = ?`).run(...k.map((x) => cols[x]), studentId, assignmentId); };
    const hideOnly = () => post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Note', commentStatus: false });
    function base() {
      const db = getDb();
      db.prepare(`INSERT INTO measurement_topics (id, course_id, external_id, title) VALUES ('t-wc', ?, 'X.1', 'T')`).run(courseId);
      db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, grade_comment, comment_status, submitted_at, latest_revision_at)
        VALUES (?, ?, 'enr-wc', 60, 'Note', 1, 1000, 900)`).run(studentId, assignmentId);
      level('D');
      captureFeedbackSnapshots(db);
    }

    test('N1: Schoology rubric regrade moving the score before R → R unsynced → hide-only save (fresh score echo) → pull → sync: arrived', async () => {
      base();
      fresh(80);                                                     // Schoology: 80 + EX at 1500, before R = 2000
      expect((await hideOnly()).status).toBe(200);
      level('EX'); captureFeedbackSnapshots(getDb(), { courseId });  // pull
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());   // sync
      expect(state()).toBe('arrived');
    });

    test('N2: a running sync upserted a pre-R score + R → hide-only save before its capture → arrived', async () => {
      base();
      set({ score: 70, submitted_at: 1500, latest_revision_at: 2000 });       // sync upsert, capture pending
      fresh(70);
      await hideOnly();
      captureFeedbackSnapshots(getDb());                             // the sync's end capture
      expect(state()).toBe('arrived');
    });

    test('N2b: same with a save that changes nothing visible → arrived', async () => {
      base();
      set({ score: 70, submitted_at: 1500, latest_revision_at: 2000 });
      fresh(70);
      await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Note', commentStatus: true });
      captureFeedbackSnapshots(getDb());
      expect(state()).toBe('arrived');
    });

    test('N3: R → sync → a pull wrote a pre-R level → hide-only save before the pull capture → arrived', async () => {
      base();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      level('EX');                                                   // pull upsert, capture pending
      fresh(60);
      await hideOnly();
      captureFeedbackSnapshots(getDb(), { courseId }); captureFeedbackSnapshots(getDb());
      expect(state()).toBe('arrived');
    });

    test('W1: Prism rubric regrade (/write, then write-comment with rubricSaved echoing the new score) → answered', async () => {
      base();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      writeMasteryScores.mockResolvedValue({ ok: true });
      await post(`/api/mastery/${courseId}/write`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', gradeInfo: { 't-wc': { grade: '75' } } });
      fresh(80);
      await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Note', commentStatus: true, rubricSaved: true });
      captureFeedbackSnapshots(getDb());
      expect(state()).toBe(null);
    });

    test('rubricSaved: the echoed score is the teacher\'s change (answers); without it, the same echo does not', async () => {
      base();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      fresh(80);
      await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Note', commentStatus: true });
      expect(state()).toBe('arrived');                               // a pre-R Schoology score (grade time 1500 < R)
      getDb().exec('DELETE FROM feedback_snapshots; DELETE FROM grades; DELETE FROM mastery_scores; DELETE FROM measurement_topics;');
      base();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      fresh(80);
      await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Note', commentStatus: true, rubricSaved: true });
      expect(state()).toBe(null);
    });

    test('W2: a Schoology score regrade after R, echoed by a hide-only save before any sync → answered (its grade time is after R)', async () => {
      base();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      fresh(80, 2500);
      await hideOnly();
      expect(state()).toBe(null);
    });

    test('W2c: R not yet synced → a Schoology score regrade after R echoed by a hide-only save → the sync sees R → answered', async () => {
      base();
      fresh(80, 2500);                                               // Schoology regrade at 2500, after R = 2000
      await hideOnly();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      expect(state()).toBe(null);
    });

    // Round 6: absorption is part-wise — only the parts that changed since the last capture
    // (another writer's) — so a teacher's own earlier non-answering save is never absorbed.
    const reshow = () => post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Note', commentStatus: true });
    test('S16: R synced → hide-only save → re-show the same comment → arrived', async () => {
      base();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      fresh(60, 1500); await hideOnly();
      expect(state()).toBe('arrived');
      fresh(60, 2600); await reshow();
      expect(state()).toBe('arrived');
    });

    test('S16b: hide-only → identical hidden re-save → re-show → arrived', async () => {
      base();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      fresh(60, 1500); await hideOnly();
      fresh(60, 2550); await hideOnly();
      fresh(60, 2600); await reshow();
      expect(state()).toBe('arrived');
    });

    test('S16r: with an open request — hide-only → re-show → still arrived, the request stays open', async () => {
      base();
      requestResubmission(getDb(), { studentId, assignmentId, requestedAt: '1970-01-01 00:25:00' });   // epoch 1500, before R
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      expect(state()).toBe('arrived');
      fresh(60, 1500); await hideOnly();
      fresh(60, 2600); await reshow();
      expect(state()).toBe('arrived');
      expect(getDb().prepare('SELECT status FROM resubmissions WHERE student_id = ?').get(studentId).status).toBe('open');
    });

    test('S5b: R unsynced → a pre-R Schoology regrade echoed by a hide save → sync sees R → re-show → arrived', async () => {
      base();
      fresh(80, 1500); await hideOnly();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      fresh(80, 2600); await reshow();
      expect(state()).toBe('arrived');
    });

    // Round 7: a pre-R change a sync saw after R was judged is absorbed by the next save's
    // pre-capture (the teacher never touched it through Prism since the arrival).
    test('X1: R synced (C1) → the next sync brings a pre-R score → Prism hide-only save → arrived', async () => {
      base();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      set({ score: 80, submitted_at: 1500 }); captureFeedbackSnapshots(getDb());
      expect(state()).toBe('arrived');
      fresh(80, 1500); await hideOnly();
      expect(state()).toBe('arrived');
    });

    test('X1r: same with an open request → the request stays open', async () => {
      base();
      requestResubmission(getDb(), { studentId, assignmentId, requestedAt: '1970-01-01 00:25:00' });
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      set({ score: 80, submitted_at: 1500 }); captureFeedbackSnapshots(getDb());
      fresh(80, 1500); await hideOnly();
      expect(state()).toBe('arrived');
      expect(getDb().prepare('SELECT status FROM resubmissions WHERE student_id = ?').get(studentId).status).toBe('open');
    });

    test('documented residual S6b: after a save, Schoology shows an OLDER score than Prism just read and a status-line publish mirrors it → answered', async () => {
      // Needs a grade time moving backwards: the save's fresh read showed 60, then Schoology
      // "shows" a pre-R 80. The publisher (R1) never moves submitted_at, so Prism's own later
      // write time pairs with the score change. Judged unreachable; pinned so a change is noticed.
      base();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      fresh(60, 1500); await hideOnly();
      fresh(80, 1500);
      await publishStatusLine(getDb(), { studentId, assignmentId, line: 'Resubmission received 01/10 - regraded.', kind: 'received' });
      expect(state()).toBe(null);
    });

    test('W4: a Prism visible-comment save after R → answered', async () => {
      base();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      fresh(60);
      await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Much better now', commentStatus: true });
      captureFeedbackSnapshots(getDb());
      expect(state()).toBe(null);
    });

    test('/write: a pull\'s pending level is absorbed before the rubric save is captured', async () => {
      base();
      set({ latest_revision_at: 2000 }); captureFeedbackSnapshots(getDb());
      getDb().prepare(`INSERT INTO measurement_topics (id, course_id, external_id, title) VALUES ('t-wc2', ?, 'X.2', 'T2')`).run(courseId);
      getDb().prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('uid-wc', 'sa-wc', 't-wc2', 75, 'EX')`).run();  // pull upsert
      writeMasteryScores.mockResolvedValue({ ok: true });
      await post(`/api/mastery/${courseId}/write`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', gradeInfo: { 't-wc': { grade: '50' }, 't-wc2': { grade: '75' } } });  // re-saves D and the pulled EX (no change); the write replaces the whole set, so a level left out would be dropped (#176)
      captureFeedbackSnapshots(getDb(), { courseId });
      expect(state()).toBe('arrived');
    });
  });

  // Final review I2: the response carries the pair's post-save resubmission state, so the
  // card patches what the server decided instead of clearing Arrived on every save.
  describe('I2: the response carries the saved pair\'s resubmission fields', () => {
    function arrivedPair() {
      const db = getDb();
      db.prepare(
        `INSERT INTO grades (student_id, assignment_id, enrolment_id, score, grade_comment, comment_status, submitted_at, latest_revision_at)
         VALUES (?, ?, 'enr-wc', 50, 'Good start', 1, 1000, 2000)`
      ).run(studentId, assignmentId);
      captureFeedbackSnapshots(db);
      expect(resubmissionByStudent(db, assignmentId).get(studentId).state).toBe('arrived');
      getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade: 50, exception: 0, timestamp: 1000 }]);
    }

    test('a hidden-only comment save keeps the arrival Arrived', async () => {
      arrivedPair();
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Good start', commentStatus: false,
      });
      expect(status).toBe(200);
      expect(body.resubmissionFields).toMatchObject({ resubmission: { state: 'arrived', request: null }, resubmit_flag: null, resubmitted: true });
      expect(body.resubmissionFields.arrived_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('an unchanged visible re-save keeps the arrival Arrived', async () => {
      arrivedPair();
      const { body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Good start', commentStatus: true,
      });
      expect(body.resubmissionFields).toMatchObject({ resubmitted: true, resubmission: { state: 'arrived' } });
    });

    test('a received-line-only save keeps the arrival Arrived', async () => {
      arrivedPair();
      const line = 'Resubmission received 03/10 - regraded.';
      const { body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: `${line}\n\nGood start`, statusLine: line,
      });
      expect(body.resubmissionFields).toMatchObject({ resubmitted: true });
    });

    test('a new visible comment answers it: everything cleared', async () => {
      arrivedPair();
      const { body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'v2 is much better', commentStatus: true,
      });
      expect(body.resubmissionFields).toEqual({ resubmission: null, resubmit_flag: null, resubmitted: false, arrived_on: null });
    });

    test('POST /write (rubric) carries them too', async () => {
      arrivedPair();
      getDb().prepare(`INSERT INTO measurement_topics (id, course_id, external_id, title) VALUES ('t-wc', ?, 'X.1', 'T')`).run(courseId);
      writeMasteryScores.mockResolvedValue({ ok: true });
      const { body } = await post(`/api/mastery/${courseId}/write`, {
        enrollmentId: 'enr-wc', assignmentId: 'sa-wc', gradeInfo: { 't-wc': { grade: '75' } },
      });
      expect(body).toMatchObject({ ok: true, resubmissionFields: { resubmitted: false, resubmission: null } });
    });
  });

  test('statusLine: stored (default kind received) after the PUT; the snapshot ignores it', async () => {
    const db = getDb();
    db.exec('DELETE FROM status_lines');
    const line = 'Resubmission received 03/10 - regraded.';
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
    pushGradeUpdates.mockClear();
    getSectionGrades.mockResolvedValue([]);
    const bad = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Note first\nLine X', statusLine: 'Line X',
    });
    expect(bad.status).toBe(400);
    const badKind = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Line X', statusLine: 'Line X', statusLineKind: 'bogus',
    });
    expect(badKind.status).toBe(400);
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Line X', statusLine: 'Line X', statusLineKind: 'ask',
    });
    expect(db.prepare('SELECT kind FROM status_lines WHERE student_id = ?').get(studentId).kind).toBe('ask');
  });

  test('statusLine (ASCII guarantee): write-comment normalises a typographic line in the stored line and the sent comment; refuses other non-ASCII', async () => {
    const db = getDb();
    db.exec('DELETE FROM status_lines');
    pushGradeUpdates.mockClear();
    getSectionGrades.mockResolvedValue([]);
    const ok = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Resubmission received 03/10 \u2013 regraded.\n\nGood.', statusLine: 'Resubmission received 03/10 \u2013 regraded.',
    });
    expect(ok.status).toBe(200);
    expect(pushGradeUpdates.mock.calls.at(-1)[1][0].comment).toBe('Resubmission received 03/10 - regraded.\n\nGood.');
    expect(db.prepare('SELECT line FROM status_lines WHERE student_id = ?').get(studentId).line).toBe('Resubmission received 03/10 - regraded.');
    pushGradeUpdates.mockClear();
    const bad = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: '\u27F3 X', statusLine: '\u27F3 X',
    });
    expect(bad).toMatchObject({ status: 400, body: { code: 'BAD_LINE', error: 'Use plain characters in the status line' } });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });

  test('statusLine is not stored when Schoology rejects the PUT; no statusLine → nothing stored', async () => {
    const db = getDb();
    db.exec('DELETE FROM status_lines');
    getSectionGrades.mockResolvedValue([]);
    pushGradeUpdates.mockResolvedValueOnce({ status: 403, data: 'forbidden' });
    const rejected = await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Line X', statusLine: 'Line X' });
    expect(rejected.status).toBe(502);
    await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'plain' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM status_lines').get().n).toBe(0);
  });

  // apiPut never throws on an HTTP error — write-comment must check the result
  // itself, or a rejected write is silently mirrored (grades, status_lines,
  // capture/settle) and reported back as if it had been saved.
  test('a rejected Schoology PUT (HTTP error) → 502, nothing mirrored, reported as saved nowhere', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, grade_comment) VALUES (?, ?, 'enr-wc', 80, 'old')`).run(studentId, assignmentId);
    getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade: 80, exception: 0, timestamp: 1 }]);
    pushGradeUpdates.mockResolvedValueOnce({ status: 403, data: 'forbidden' });
    const res = await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'New comment' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Schoology rejected the update: nothing was recorded in Prism');
    const row = db.prepare('SELECT score, grade_comment FROM grades WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId);
    expect(row).toEqual({ score: 80, grade_comment: 'old' }); // unchanged — not the rejected write
  });

  test('a 207 with a failed per-item entry → 502, nothing mirrored (same as an HTTP-level rejection)', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, grade_comment) VALUES (?, ?, 'enr-wc', 80, 'old')`).run(studentId, assignmentId);
    getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade: 80, exception: 0, timestamp: 1 }]);
    pushGradeUpdates.mockResolvedValueOnce({ status: 207, data: { grade: [{ response_code: 400 }] } });
    const res = await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'New comment' });
    expect(res.status).toBe(502);
    const row = db.prepare('SELECT grade_comment FROM grades WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId);
    expect(row.grade_comment).toBe('old');
  });

  test('a failed Schoology grade lookup → 502 and no PUT (a grade-less PUT would wipe the score)', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, enrolment_id, score, submitted_at)
       VALUES (?, ?, 'enr-wc', 88, 1779000000)`
    ).run(studentId, assignmentId);
    getSectionGrades.mockRejectedValue(new Error('Schoology down'));
    pushGradeUpdates.mockClear();

    const res = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc',
      assignmentId: 'sa-wc',
      comment: 'Comment only',
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/nothing was saved/);
    expect(pushGradeUpdates).not.toHaveBeenCalled();

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
    pushGradeUpdates.mockClear();
    const res = await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Hi' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Schoology has no grade record Prism expected: sync, then try again');
    db.prepare('UPDATE grades SET score = NULL, exception = 2 WHERE student_id = ?').run(studentId);
    expect((await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Hi' })).status).toBe(502);
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    expect(db.prepare('SELECT grade_comment FROM grades WHERE student_id = ?').get(studentId).grade_comment).toBeNull();
  });

  test('genuine no-record (no Prism score/exception) still writes comment-only', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception) VALUES (?, ?, 'enr-wc', NULL, 0)`).run(studentId, assignmentId);
    getSectionGrades.mockResolvedValue([]);
    pushGradeUpdates.mockClear();
    const res = await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'First note' });
    expect(res.status).toBe(200);
    expect(pushGradeUpdates).toHaveBeenCalledTimes(1);
    expect(pushGradeUpdates.mock.calls[0][1][0]).toEqual({ assignment_id: 'sa-wc', enrollment_id: 'enr-wc', comment: 'First note', comment_status: 1 });
    expect(db.prepare('SELECT grade_comment FROM grades WHERE student_id = ?').get(studentId).grade_comment).toBe('First note');
  });

  test('N-1: a received line written after an ask clears the source, so undoing the ask (removeLine) leaves it', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score) VALUES (?, ?, 'enr-wc', 2)`).run(studentId, assignmentId);
    const ask = requestResubmission(db, { studentId, assignmentId, lessons: 2 });
    const askLine = 'Resubmission requested - due Thu 09/10.';
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind, source_type, source_id) VALUES (?, ?, ?, 'ask', 'resubmission', ?)`)
      .run(studentId, assignmentId, askLine, ask.id);
    const received = 'Resubmission received 03/10 - regraded.';
    getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-wc', enrollment_id: 'enr-wc', grade: 3, exception: 0, comment: askLine, comment_status: 1 }]);
    expect((await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: `${received}\n\nBetter.`, statusLine: received,
    })).status).toBe(200);
    expect(db.prepare('SELECT line, kind, source_type, source_id FROM status_lines WHERE student_id = ?').get(studentId))
      .toEqual({ line: received, kind: 'received', source_type: null, source_id: null });

    pushGradeUpdates.mockClear();
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
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    expect(db.prepare('SELECT line FROM status_lines WHERE student_id = ?').get(studentId).line).toBe(received);
  });

  test('statusLine with a line break → 400 BAD_LINE, no read or PUT', async () => {
    getSectionGrades.mockClear();
    pushGradeUpdates.mockClear();
    const res = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Line A\nB', statusLine: 'Line A\nB',
    });
    expect(res).toMatchObject({ status: 400, body: { code: 'BAD_LINE' } });
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });

  test('statusLine holds the per-pair lock: an overlapping status-line write → 409 BUSY before any read', async () => {
    getSectionGrades.mockClear();
    let finishPut;
    pushGradeUpdates.mockImplementationOnce(() => new Promise((resolve) => { finishPut = () => resolve({ status: 207 }); }));
    getSectionGrades.mockResolvedValue([]);
    const body = { enrollmentId: 'enr-wc', assignmentId: 'sa-wc', comment: 'Line R', statusLine: 'Line R' };
    const first = post(`/api/mastery/${courseId}/write-comment`, body);
    await vi.waitFor(() => expect(pushGradeUpdates).toHaveBeenCalled());
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
      'DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM resubmissions; DELETE FROM grades; DELETE FROM mastery_alignments; ' +
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
    pushGradeUpdates.mockReset();
    pushGradeUpdates.mockResolvedValue({ status: 207 });
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

    // …and one bulk comment PUT covering both students. Two section reads: the flag check before
    // the mastery batch (#40), then the echo read after it.
    expect(getSectionGrades).toHaveBeenCalledTimes(2);
    expect(pushGradeUpdates).toHaveBeenCalledTimes(1);
    const [, comments] = pushGradeUpdates.mock.calls[0];
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
    // The rubric scores (step 1) already went — say so.
    expect(res.body.error).toBe('Schoology has no grade record Prism expected: nothing was recorded in Prism; rubric scores may already be in Schoology, sync, then check');
    expect(res.body.results).toEqual([{ uid: 'uid-ada', ok: false }, { uid: 'uid-bob', ok: false }]);
    expect(pushGradeUpdates).not.toHaveBeenCalled();
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
    expect(pushGradeUpdates).toHaveBeenCalledTimes(1);
    const bob = pushGradeUpdates.mock.calls[0][1].find((p) => p.enrollment_id === 'enr-bob');
    expect(bob).toEqual({ assignment_id: 'sa-1', enrollment_id: 'enr-bob', comment: 'note uid-bob', comment_status: 1 });
  });

  test('echoes each student\'s fresh grade into its comment payload (#46 safety)', async () => {
    await post(`/api/mastery/${courseId}/send-all`, {
      entries: [entry('uid-ada', 'enr-ada'), entry('uid-bob', 'enr-bob')],
    });

    const [, comments] = pushGradeUpdates.mock.calls[0];
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

  test('I2: each result carries its pair\'s post-save resubmission fields (hidden-only stays Arrived)', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO grades (student_id, assignment_id, enrolment_id, score, grade_comment, comment_status, submitted_at, latest_revision_at)
       VALUES (?, ?, 'enr-ada', 95, 'Good start', 1, 1000, 2000), (?, ?, 'enr-bob', 80, 'Ok', 1, 1000, 2000)`
    ).run(adaId, assignmentRowId, bobId, assignmentRowId);
    captureFeedbackSnapshots(db);
    const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [
        { uid: 'uid-ada', enrollmentId: 'enr-ada', assignmentId: 'sa-1', scores: null, comment: { comment: 'Good start', commentStatus: false } },
        { uid: 'uid-bob', enrollmentId: 'enr-bob', assignmentId: 'sa-1', scores: null, comment: { comment: 'v2 is better', commentStatus: true } },
      ],
    });
    expect(status).toBe(200);
    const byUid = Object.fromEntries(body.results.map((r) => [r.uid, r]));
    expect(byUid['uid-ada']).toMatchObject({ ok: true, resubmissionFields: { resubmitted: true, resubmission: { state: 'arrived' } } });
    expect(byUid['uid-bob']).toMatchObject({ ok: true, resubmissionFields: { resubmitted: false, resubmission: null, resubmit_flag: null } });
  });

  test('a failure after the rubric scores went says they may already be in Schoology', async () => {
    // The flag check's read (before the mastery batch) works; the echo read after it fails.
    getSectionGrades.mockResolvedValueOnce([]).mockRejectedValue(new Error('Schoology down'));
    const withScores = await post(`/api/mastery/${courseId}/send-all`, { entries: [entry('uid-ada', 'enr-ada')] });
    expect(withScores.status).toBe(502);
    expect(withScores.body.error).toBe('Schoology down: nothing was recorded in Prism; rubric scores may already be in Schoology, sync, then check');
    pushGradeUpdates.mockResolvedValue({ status: 400 });
    getSectionGrades.mockReset().mockResolvedValue([{ assignment_id: 'sa-1', enrollment_id: 'enr-ada', grade: 95, exception: 0, timestamp: 1 }]);
    const rejected = await post(`/api/mastery/${courseId}/send-all`, { entries: [entry('uid-ada', 'enr-ada')] });
    expect(rejected.body.error).toMatch(/rubric scores may already be in Schoology/);
    const commentOnly = await post(`/api/mastery/${courseId}/send-all`, { entries: [entry('uid-ada', 'enr-ada', { scores: false })] });
    expect(commentOnly.body.error).toBe('Schoology rejected the update: nothing was recorded in Prism');
  });

  test('the flag check\'s read fails before the mastery batch: nothing is written (#40)', async () => {
    getSectionGrades.mockRejectedValue(new Error('Schoology down'));
    const { status, body } = await post(`/api/mastery/${courseId}/send-all`, { entries: [entry('uid-ada', 'enr-ada')] });
    expect(status).toBe(502);
    expect(body.error).toBe('Could not read the current Schoology grade: nothing was saved. Try again.');
    expect(writeMasteryScoresBatch).not.toHaveBeenCalled();
    expect(pushGradeUpdates).not.toHaveBeenCalled();
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
    expect(pushGradeUpdates).not.toHaveBeenCalled();
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
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });

  test('score-only entries are excluded from the comment PUT', async () => {
    await post(`/api/mastery/${courseId}/send-all`, {
      entries: [
        entry('uid-ada', 'enr-ada', { comment: false }), // scores only
        entry('uid-bob', 'enr-bob'),                      // scores + comment
      ],
    });

    const [, comments] = pushGradeUpdates.mock.calls[0];
    expect(comments).toHaveLength(1);
    expect(comments[0].enrollment_id).toBe('enr-bob');
  });

  // Task 7 (Amendment B): the card's "resubmission received" chip can save via
  // Send-all too — same statusLine/statusLineKind contract as write-comment.
  function statusLineEntry(line, overrides = {}) {
    return {
      uid: 'uid-ada', enrollmentId: 'enr-ada', assignmentId: 'sa-1', scores: null,
      comment: { comment: `${line}\n\nBetter.`, commentStatus: true, statusLine: line, ...overrides },
    };
  }

  test('statusLine: stored (default kind received, trimmed) once Send-all succeeds', async () => {
    const line = 'Resubmission received 03/10 - regraded.';
    // The comment's first line is the plain (unpadded) text; the submitted
    // statusLine has incidental whitespace — checkLine trims it before storing,
    // and the trim still matches the comment's exact first line.
    const { status } = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [{
        uid: 'uid-ada', enrollmentId: 'enr-ada', assignmentId: 'sa-1', scores: null,
        comment: { comment: `${line}\n\nBetter.`, commentStatus: true, statusLine: `  ${line}  ` },
      }],
    });
    expect(status).toBe(200);
    const db = getDb();
    expect(db.prepare('SELECT line, kind FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(adaId, assignmentRowId))
      .toEqual({ line, kind: 'received' });
  });

  describe('round 5: send-all credits only what the teacher wrote', () => {
    const state = () => resubmissionByStudent(getDb(), assignmentRowId).get(adaId)?.state ?? null;
    function arrived() {
      const db = getDb();
      db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, grade_comment, comment_status, submitted_at, latest_revision_at)
        VALUES (?, ?, 'enr-ada', 60, 'Note', 1, 1000, 2000)`).run(adaId, assignmentRowId);
      captureFeedbackSnapshots(db);
      expect(state()).toBe('arrived');
    }
    test('a comment-only entry: a pre-R Schoology score in the fresh echo does not answer', async () => {
      arrived();
      getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-1', enrollment_id: 'enr-ada', grade: 80, exception: 0, timestamp: 1500 }]);
      const res = await post(`/api/mastery/${courseId}/send-all`, { entries: [{ uid: 'uid-ada', enrollmentId: 'enr-ada', assignmentId: 'sa-1', scores: null, comment: { comment: 'Note', commentStatus: false } }] });
      expect(res.status).toBe(200);
      expect(state()).toBe('arrived');
    });
    test('an entry that wrote rubric scores: the echoed score is the teacher\'s → answered', async () => {
      arrived();
      getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-1', enrollment_id: 'enr-ada', grade: 80, exception: 0, timestamp: 1500 }]);
      const res = await post(`/api/mastery/${courseId}/send-all`, { entries: [{
        uid: 'uid-ada', enrollmentId: 'enr-ada', assignmentId: 'sa-1',
        scores: { gradeInfo: { t1: { grade: '75' } }, gradingPeriodId: 1, gradingCategoryId: 2 },
        comment: { comment: 'Note', commentStatus: true },
      }] });
      expect(res.status).toBe(200);
      expect(state()).toBe(null);
    });
  });

  test('statusLine: refuses a line that is not the comment\'s first line, before any write', async () => {
    const res = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [{
        uid: 'uid-ada', enrollmentId: 'enr-ada', assignmentId: 'sa-1', scores: null,
        comment: { comment: 'Note first\nLine X', commentStatus: true, statusLine: 'Line X' },
      }],
    });
    expect(res.status).toBe(400);
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    expect(writeMasteryScoresBatch).not.toHaveBeenCalled();
  });

  test('statusLine: an unknown statusLineKind is rejected before any write', async () => {
    const res = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [{
        uid: 'uid-ada', enrollmentId: 'enr-ada', assignmentId: 'sa-1', scores: null,
        comment: { comment: 'Line X', commentStatus: true, statusLine: 'Line X', statusLineKind: 'bogus' },
      }],
    });
    expect(res.status).toBe(400);
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });

  test('statusLine (ASCII guarantee): a typographic line is normalised in the stored line and the sent comment', async () => {
    const typed = 'Resubmission received 03/10 \u2014 regraded.';
    const plain = 'Resubmission received 03/10 - regraded.';
    const { status } = await post(`/api/mastery/${courseId}/send-all`, { entries: [statusLineEntry(typed)] });
    expect(status).toBe(200);
    expect(pushGradeUpdates.mock.calls[0][1][0].comment).toBe(`${plain}\n\nBetter.`);
    expect(getDb().prepare('SELECT line FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(adaId, assignmentRowId).line).toBe(plain);
  });

  test('statusLine (ASCII guarantee): a non-ASCII line → 400 BAD_LINE, no write', async () => {
    const res = await post(`/api/mastery/${courseId}/send-all`, { entries: [statusLineEntry('\u27F3 Received')] });
    expect(res).toMatchObject({ status: 400, body: { code: 'BAD_LINE', error: 'Use plain characters in the status line' } });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });

  test('statusLine: a line with a line break → 400 BAD_LINE, no write (minor)', async () => {
    const res = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [statusLineEntry('Line A\nB', { comment: 'Line A\nB\n\nBetter.' })],
    });
    expect(res).toMatchObject({ status: 400, body: { code: 'BAD_LINE' } });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });

  // I1: apiPut never throws on an HTTP error — send-all must check the result,
  // same as write-comment, or it would mirror a comment Schoology rejected.
  test('I1: a rejected comment PUT (HTTP error) → 502, nothing mirrored, no status_lines', async () => {
    const line = 'Resubmission received 03/10 - regraded.';
    pushGradeUpdates.mockResolvedValueOnce({ status: 403, data: 'forbidden' });
    const res = await post(`/api/mastery/${courseId}/send-all`, { entries: [statusLineEntry(line)] });
    expect(res.status).toBe(502);
    expect(res.body.results).toEqual([{ uid: 'uid-ada', ok: false }]);
    const db = getDb();
    expect(db.prepare('SELECT COUNT(*) AS n FROM status_lines').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM grades WHERE student_id = ?').get(adaId).n).toBe(0);
  });

  test('I1: a 207 with a failed entry (per-item response_code) → 502, nothing mirrored', async () => {
    const line = 'Resubmission received 03/10 - regraded.';
    pushGradeUpdates.mockResolvedValueOnce({ status: 207, data: { grade: [{ response_code: 400 }] } });
    const res = await post(`/api/mastery/${courseId}/send-all`, { entries: [statusLineEntry(line)] });
    expect(res.status).toBe(502);
    const db = getDb();
    expect(db.prepare('SELECT COUNT(*) AS n FROM status_lines').get().n).toBe(0);
  });

  test('a failed fresh-grade read with a statusLine present → 502, no status_lines write either', async () => {
    const line = 'Resubmission received 03/10 - regraded.';
    getSectionGrades.mockRejectedValueOnce(new Error('Schoology down'));
    const res = await post(`/api/mastery/${courseId}/send-all`, { entries: [statusLineEntry(line)] });
    expect(res.status).toBe(502);
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    const db = getDb();
    expect(db.prepare('SELECT COUNT(*) AS n FROM status_lines').get().n).toBe(0);
  });

  // I2: an overlapping write for the same pair must not compose from the same
  // stale read and drop one line — mirrors the write-comment BUSY test.
  test('I2: statusLine holds the per-pair lock — an overlapping send-all for the same pair → 409 BUSY', async () => {
    const line = 'Resubmission received 03/10 - regraded.';
    let finishPut;
    pushGradeUpdates.mockImplementationOnce(() => new Promise((resolve) => { finishPut = () => resolve({ status: 207 }); }));
    const body = { entries: [statusLineEntry(line)] };
    const first = post(`/api/mastery/${courseId}/send-all`, body);
    await vi.waitFor(() => expect(pushGradeUpdates).toHaveBeenCalled());
    const second = await post(`/api/mastery/${courseId}/send-all`, body);
    expect(second).toMatchObject({ status: 409, body: { code: 'BUSY' } });
    finishPut();
    expect((await first).status).toBe(200);
    // Released: the next write goes through.
    expect((await post(`/api/mastery/${courseId}/send-all`, body)).status).toBe(200);
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

  // #160: the Roster's Mastery view reads category rollups only (is_category = 1). An override
  // written where Schoology had no category level yet must land as a category row, or the
  // view keeps showing "-" for Schoology after the write.
  test('the override mirror marks a new rollup row as a category when the objective is a reporting category', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO reporting_categories (id, course_id, title) VALUES ('cat-ov', ?, 'Design')`).run(COURSE);
    const isCategory = (obj) => db.prepare(
      'SELECT is_category FROM mastery_rollups WHERE student_uid = ? AND objective_id = ? AND course_id = ?',
    ).get(UID, obj, COURSE)?.is_category;

    await post(`/api/mastery/${COURSE}/override`, { studentUid: UID, objectiveId: 'cat-ov', level: 'EX' });
    await post(`/api/mastery/${COURSE}/override`, { studentUid: UID, objectiveId: OBJ, level: 'EX' });

    expect(isCategory('cat-ov')).toBe(1);
    expect(isCategory(OBJ)).toBe(0); // a measurement topic stays a topic row
  });

  test('the override mirror repairs a category row an earlier mirror stored as a topic row', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO reporting_categories (id, course_id, title) VALUES ('cat-ov', ?, 'Design')`).run(COURSE);
    db.prepare(
      `INSERT INTO mastery_rollups (student_uid, objective_id, course_id, is_category, override_value, synced_at)
       VALUES (?, 'cat-ov', ?, 0, 1, 't')`,
    ).run(UID, COURSE);

    await post(`/api/mastery/${COURSE}/override`, { studentUid: UID, objectiveId: 'cat-ov', level: 'EX' });

    expect(db.prepare(
      `SELECT is_category, override_value FROM mastery_rollups WHERE objective_id = 'cat-ov'`,
    ).get()).toEqual({ is_category: 1, override_value: 3 });
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

  const ONEDRIVE_APP = {
    status: 'ok', appId: '1078786112', provider: 'onedrive', targetHost: 'lti-submission-microsoft.app.schoology.com',
    launchUrl: '/apps/lti/1078786112/run/assignment/sa-lti?context=assignment_submission',
  };
  const DRIVE_APP = {
    status: 'ok', appId: '1073361950', provider: 'google_drive', targetHost: 'lti-submission-google.app.schoology.com',
    launchUrl: '/apps/lti/1073361950/run/assignment/sa-lti?context=assignment_submission',
  };

  beforeEach(() => {
    vi.mocked(getAssignmentFiles).mockReset();
    vi.mocked(getLtiSubmissionApp).mockReset().mockResolvedValue(ONEDRIVE_APP);
    vi.mocked(getSubmittedDocuments).mockReset();
    const db = getDb();
    db.exec(
      'DELETE FROM feedback_snapshots; DELETE FROM mastery_rollups; DELETE FROM mastery_scores; DELETE FROM mastery_alignments; ' +
      'DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM assignment_assignees; ' +
      'DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; ' +
      'DELETE FROM students; DELETE FROM courses;'
    );
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-L', 'Course')`
    ).run().lastInsertRowid;
    for (const [uid, first, last] of [['101', 'Alison', 'Cheng'], ['102', 'Garmin', 'Ho']]) {
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
    expect(body.provider).toBe('onedrive');
    expect(Object.keys(body.links)).toEqual(['101']);
    expect(body.links['101'].url).toBe(`${ORIGIN}${DIR}/Alison Cheng - Launch - 4299333.pptx?d=wabc`);
    expect(body.links['101'].provider).toBe('onedrive');
    expect(getAssignmentFiles).toHaveBeenCalledWith({ sectionId: 'sec-L', assignmentId: 'sa-lti', refresh: false });
  });

  test('?refresh=1 bypasses the cache', async () => {
    vi.mocked(getAssignmentFiles).mockResolvedValue({ status: 'ok', origin: ORIGIN, files: [] });
    await get(`/api/mastery/${courseId}/assignment/sa-lti/submission-links?refresh=1`);
    expect(getAssignmentFiles).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
  });

  test('non-lti assignments never touch OneDrive or the assignment page', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-native/submission-links`);
    expect(body).toEqual({ status: 'not_lti', links: {} });
    expect(getAssignmentFiles).not.toHaveBeenCalled();
    expect(getLtiSubmissionApp).not.toHaveBeenCalled();
  });

  test('a lookup failure passes its status through with no links', async () => {
    vi.mocked(getAssignmentFiles).mockResolvedValue({ status: 'sso_failed' });
    const { status, body } = await get(`/api/mastery/${courseId}/assignment/sa-lti/submission-links`);
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'sso_failed', provider: 'onedrive', links: {} });
  });

  test('when the app cannot be read, the OneDrive lookup still runs (the behaviour before #142)', async () => {
    vi.mocked(getLtiSubmissionApp).mockResolvedValue({ status: 'error' });
    vi.mocked(getAssignmentFiles).mockResolvedValue({ status: 'ok', origin: ORIGIN, files: [spFile('Alison Cheng - Launch - 4299333.pptx')] });
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-lti/submission-links`);
    expect(body.status).toBe('ok');
    expect(Object.keys(body.links)).toEqual(['101']);
  });

  test('Google Drive (#142): launch links for the roster students who submitted, no OneDrive lookup', async () => {
    vi.mocked(getLtiSubmissionApp).mockResolvedValue(DRIVE_APP);
    vi.mocked(getSubmittedDocuments).mockResolvedValue({
      status: 'ok',
      entries: [
        { id: 101, submissionStatus: 1, submissionDate: 'Thursday, March 16, 2023 at 1:52 pm' },
        { id: 999, submissionStatus: 1, submissionDate: '' },
      ],
    });
    const { status, body } = await get(`/api/mastery/${courseId}/assignment/sa-lti/submission-links?refresh=1`);
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.provider).toBe('google_drive');
    expect(Object.keys(body.links)).toEqual(['101']);
    expect(body.links['101']).toMatchObject({
      provider: 'google_drive',
      url: 'https://schoology.hkis.edu.hk/apps/lti/1073361950/run/assignment/sa-lti?context=assignment_submission' +
        '&custom_parameters[in_edit_mode]=true&studentId=101',
    });
    expect(getLtiSubmissionApp).toHaveBeenCalledWith({ assignmentId: 'sa-lti', refresh: true });
    expect(getSubmittedDocuments).toHaveBeenCalledWith({ assignmentId: 'sa-lti', refresh: true });
    expect(getAssignmentFiles).not.toHaveBeenCalled();
  });

  test('Google Drive: a failed submitted-list read passes its status through with no links', async () => {
    vi.mocked(getLtiSubmissionApp).mockResolvedValue(DRIVE_APP);
    vi.mocked(getSubmittedDocuments).mockResolvedValue({ status: 'session_expired' });
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-lti/submission-links`);
    expect(body).toEqual({ status: 'session_expired', provider: 'google_drive', links: {} });
  });

  test('an app Prism does not know gets no links', async () => {
    vi.mocked(getLtiSubmissionApp).mockResolvedValue({ ...DRIVE_APP, provider: 'other' });
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-lti/submission-links`);
    expect(body).toEqual({ status: 'unsupported_app', provider: 'other', links: {} });
    expect(getAssignmentFiles).not.toHaveBeenCalled();
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
    // A real apiPut response always carries a status (send-all now checks it,
    // I1) — {} isn't a shape pushGradeUpdates can actually return.
    vi.mocked(pushGradeUpdates).mockReset().mockResolvedValue({ status: 207 });
    vi.mocked(getSectionGrades).mockReset();
    const db = getDb();
    db.exec(
      'DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM rubrics; ' +
      'DELETE FROM feedback_snapshots; DELETE FROM mastery_rollups; DELETE FROM mastery_scores; DELETE FROM mastery_alignments; ' +
      'DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM assignment_assignees; ' +
      'DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; ' +
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
    expect(body.course).toEqual({ id: courseId, course_name: 'Course', section_name: '4(A-B)', block_number: '7', archived: 0, excluded: 0, writable: true });
  });

  test('GET: no scoreScale for a scale Prism does not grade', async () => {
    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-L`);
    expect(body.scoreScale).toBeNull();
  });

  test('write-comment with points writes the grade + comment in one PUT, echoing the exception', async () => {
    vi.mocked(getSectionGrades).mockResolvedValue([
      { assignment_id: 'sa-C', enrollment_id: 'eB', grade: null, exception: 0, timestamp: '1700000000' },
    ]);
    const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'eB', assignmentId: 'sa-C', points: 100, comment: 'Done', commentStatus: true,
    });
    expect(status).toBe(200);
    expect(pushGradeUpdates).toHaveBeenCalledWith('sec-S', [{
      assignment_id: 'sa-C', enrollment_id: 'eB', comment: 'Done', comment_status: 1, grade: '100', exception: 0,
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
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });

  test('write-comment refuses points on an assignment Prism does not grade by scale', async () => {
    const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'eB', assignmentId: 'sa-L', points: 100, comment: '', commentStatus: true,
    });
    expect(status).toBe(400);
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });

  test('write-comment with points stops if the current Schoology grade cannot be read', async () => {
    vi.mocked(getSectionGrades).mockRejectedValue(new Error('network'));
    const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
      enrollmentId: 'eB', assignmentId: 'sa-C', points: 100, comment: '', commentStatus: true,
    });
    expect(status).toBe(502);
    expect(pushGradeUpdates).not.toHaveBeenCalled();
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
    expect(body.results).toEqual([{ uid: 'uid-B', ok: true, resubmissionFields: { resubmission: null, resubmit_flag: null, resubmitted: false, arrived_on: null } }]);
    expect(pushGradeUpdates).toHaveBeenCalledWith('sec-S', [expect.objectContaining({ grade: '0', comment_status: null })]);
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
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });

  describe('points-only tasks (#181)', () => {
    beforeEach(() => {
      vi.mocked(getAssignmentGrades).mockReset();
      const db = getDb();
      db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id, max_points) VALUES (?, 'sa-P', 'Paper test', '0', 50)`).run(courseId);
      db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id, assignment_type, max_points) VALUES (?, 'sa-Q', 'Quiz', '0', 'assessment', 20)`).run(courseId);
    });
    const freshB = (grade, exception = 0) => [{ assignment_id: 'sa-P', enrollment_id: 'eB', grade, exception, timestamp: '1700000000' }];
    const scoreOfB = () => getDb().prepare(
      `SELECT g.score, g.exception FROM grades g JOIN students s ON s.id = g.student_id JOIN assignments a ON a.id = g.assignment_id
       WHERE s.schoology_uid = 'uid-B' AND a.schoology_assignment_id = 'sa-P'`
    ).get();

    test('write-comment writes the points with the comment, reads them back and mirrors them', async () => {
      vi.mocked(getSectionGrades).mockResolvedValue(freshB(null));
      vi.mocked(getAssignmentGrades).mockResolvedValue(freshB('42.5'));
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-P', points: 42.5, expectedScore: null, comment: 'Well done', commentStatus: true,
      });
      expect(status).toBe(200);
      expect(body.score).toBe(42.5);
      expect(body.warning).toBeUndefined();
      expect(pushGradeUpdates).toHaveBeenCalledWith('sec-S', [{
        assignment_id: 'sa-P', enrollment_id: 'eB', comment: 'Well done', comment_status: 1, grade: '42.5', exception: 0,
      }]);
      expect(getAssignmentGrades).toHaveBeenCalledWith('sec-S', 'sa-P');
      expect(scoreOfB()).toEqual({ score: 42.5, exception: 0 });
    });

    test('write-comment refuses when the score changed in Schoology since the card loaded', async () => {
      vi.mocked(getSectionGrades).mockResolvedValue(freshB('30'));
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-P', points: 45, expectedScore: 40, comment: '', commentStatus: true,
      });
      expect(status).toBe(409);
      expect(body.code).toBe('SCORE_CHANGED');
      expect(body.error).toMatch(/The score in Schoology is now 30/);
      expect(pushGradeUpdates).not.toHaveBeenCalled();
    });

    test('write-comment: a read-back that differs mirrors what Schoology holds, with a warning', async () => {
      vi.mocked(getSectionGrades).mockResolvedValue(freshB('40'));
      vi.mocked(getAssignmentGrades).mockResolvedValue(freshB('40'));
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-P', points: 45, expectedScore: '40', comment: '', commentStatus: true,
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({ score: 40, warning: 'Schoology holds 40, not the 45 sent: check the grade in Schoology' });
      expect(scoreOfB().score).toBe(40);
    });

    test('write-comment refuses points over Exempt or Missing, and clears a marker', async () => {
      vi.mocked(getSectionGrades).mockResolvedValue(freshB(null, 1));
      const exempt = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-P', points: 45, expectedScore: null, comment: '', commentStatus: true,
      });
      expect(exempt.status).toBe(409);
      expect(exempt.body.code).toBe('FLAGGED');
      expect(pushGradeUpdates).not.toHaveBeenCalled();

      vi.mocked(getSectionGrades).mockResolvedValue(freshB(null, 6));
      vi.mocked(getAssignmentGrades).mockResolvedValue(freshB('45', 0));
      const late = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-P', points: 45, expectedScore: null, comment: '', commentStatus: true,
      });
      expect(late.status).toBe(200);
      expect(pushGradeUpdates).toHaveBeenCalledWith('sec-S', [expect.objectContaining({ grade: '45', exception: 0 })]);
      expect(scoreOfB()).toEqual({ score: 45, exception: 0 });
    });

    test('write-comment refuses points on a test or quiz, and a negative score', async () => {
      const quiz = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-Q', points: 10, comment: '', commentStatus: true,
      });
      expect(quiz.status).toBe(400);
      expect(quiz.body.error).toBe('Schoology scores tests and quizzes: Prism writes no points to them');
      const negative = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-P', points: -2, comment: '', commentStatus: true,
      });
      expect(negative.status).toBe(400);
      expect(pushGradeUpdates).not.toHaveBeenCalled();
    });

    test('send-all writes points, reads each task back once, and mirrors the score', async () => {
      vi.mocked(getSectionGrades).mockResolvedValue([
        ...freshB(null), { assignment_id: 'sa-P', enrollment_id: 'eA', grade: '10', exception: 0, timestamp: '0' },
      ]);
      vi.mocked(getAssignmentGrades).mockResolvedValue([
        ...freshB('50'), { assignment_id: 'sa-P', enrollment_id: 'eA', grade: '12', exception: 0, timestamp: '0' },
      ]);
      const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [
          { uid: 'uid-B', enrollmentId: 'eB', assignmentId: 'sa-P', scores: null, grade: { points: 50, expected: null }, comment: { comment: 'Full marks', commentStatus: true } },
          { uid: 'uid-A', enrollmentId: 'eA', assignmentId: 'sa-P', scores: null, grade: { points: 11, expected: 10 }, comment: { comment: '', commentStatus: true } },
        ],
      });
      expect(status).toBe(200);
      expect(getAssignmentGrades).toHaveBeenCalledTimes(1);
      expect(body.results[0]).toMatchObject({ uid: 'uid-B', ok: true, score: 50 });
      expect(body.results[0].warning).toBeUndefined();
      expect(body.results[1]).toMatchObject({ uid: 'uid-A', ok: true, score: 12, warning: 'Schoology holds 12, not the 11 sent: check the grade in Schoology' });
      expect(scoreOfB().score).toBe(50);
    });

    test('an empty comment is stored with Display off, as Schoology keeps it (#183)', async () => {
      vi.mocked(getSectionGrades).mockResolvedValue(freshB(null));
      vi.mocked(getAssignmentGrades).mockResolvedValue(freshB('42'));
      await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-P', points: 42, expectedScore: null, comment: '', commentStatus: true,
      });
      const status = () => getDb().prepare(
        `SELECT g.comment_status FROM grades g JOIN students s ON s.id = g.student_id JOIN assignments a ON a.id = g.assignment_id
         WHERE s.schoology_uid = 'uid-B' AND a.schoology_assignment_id = 'sa-P'`
      ).get().comment_status;
      expect(status()).toBeNull();

      vi.mocked(getSectionGrades).mockResolvedValue(freshB('42'));
      vi.mocked(getAssignmentGrades).mockResolvedValue(freshB('43'));
      await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-B', enrollmentId: 'eB', assignmentId: 'sa-P', scores: null, grade: { points: 43, expected: 42 }, comment: { comment: '', commentStatus: true } }],
      });
      expect(status()).toBeNull();

      // With text, Display is kept as sent.
      vi.mocked(getSectionGrades).mockResolvedValue(freshB('43'));
      await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-B', enrollmentId: 'eB', assignmentId: 'sa-P', scores: null, comment: { comment: 'Good', commentStatus: true } }],
      });
      expect(status()).toBe(1);
    });

    test('send-all refuses the batch when a score changed in Schoology', async () => {
      vi.mocked(getSectionGrades).mockResolvedValue(freshB('20'));
      const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-B', enrollmentId: 'eB', assignmentId: 'sa-P', scores: null, grade: { points: 50, expected: null }, comment: { comment: '', commentStatus: true } }],
      });
      expect(status).toBe(409);
      expect(body.code).toBe('SCORE_CHANGED');
      expect(pushGradeUpdates).not.toHaveBeenCalled();
    });
  });

  describe('feedback rows (spec 2026-10-13)', () => {
    beforeEach(() => {
      const db = getDb();
      db.exec('DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM rubrics;');
      db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-F', 'Flappy (F)', '23495360')`).run(courseId);
      const rubricId = db.prepare(`INSERT INTO rubrics (name, source, created_at, updated_at) VALUES ('Flappy', 'mcp', 'now', 'now')`).run().lastInsertRowid;
      db.prepare(`INSERT INTO rubric_criteria (rubric_id, position, criterion_name) VALUES (?, 1, 'Features and Code'), (?, 2, 'Playtesting')`).run(rubricId, rubricId);
      db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-F', ?, 'now')`).run(rubricId, courseId);
      vi.mocked(getSectionGrades).mockResolvedValue([{ assignment_id: 'sa-F', enrollment_id: 'eB', grade: null, exception: 0, timestamp: '0' }]);
      vi.mocked(pushGradeUpdates).mockResolvedValue({ status: 207 });
    });
    const rowsOf = (uid) => Object.fromEntries(getDb().prepare(
      `SELECT criterion_name, level FROM rubric_row_levels WHERE assignment_schoology_id = 'sa-F' AND student_uid = ?`).all(uid).map(r => [r.criterion_name, r.level]));

    test('GET returns only the row levels of the attached rubric\'s rows (an orphan from an old rubric is left out)', async () => {
      getDb().prepare(`INSERT INTO rubric_row_levels (assignment_schoology_id, student_uid, criterion_name, level) VALUES ('sa-F', 'uid-B', 'Playtesting', 'ED'), ('sa-F', 'uid-B', 'Aesthetic', 'D')`).run();
      const { body } = await get(`/api/mastery/${courseId}/assignment/sa-F`);
      expect(body.students.find(s => s.schoology_uid === 'uid-B').row_levels).toEqual({ Playtesting: 'ED' });
    });

    test('write-comment: if the rows cannot be saved after Schoology accepted, the grade is still mirrored and the error states that', async () => {
      vi.mocked(saveRowLevels).mockImplementationOnce(() => { throw new Error('disk I/O error'); });
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-F', points: 75, comment: 'Good', commentStatus: true, rowLevels: { Playtesting: 'D' },
      });
      expect(status).toBe(500);
      expect(body).toMatchObject({ published: true });
      expect(body.error).toMatch(/published to Schoology.*rows were not saved/i);
      const g = getDb().prepare(`SELECT g.score, g.grade_comment FROM grades g JOIN students s ON s.id = g.student_id JOIN assignments a ON a.id = g.assignment_id WHERE s.schoology_uid = 'uid-B' AND a.schoology_assignment_id = 'sa-F'`).get();
      expect(g).toEqual({ score: 75, grade_comment: 'Good' });
    });

    test('send-all: an entry whose rows cannot be saved is reported not ok; the others are ok', async () => {
      vi.mocked(saveRowLevels).mockImplementationOnce(() => { throw new Error('disk I/O error'); });
      const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-B', enrollmentId: 'eB', assignmentId: 'sa-F', scores: null,
          grade: { points: 75 }, comment: { comment: 'Good', commentStatus: true }, rowLevels: { Playtesting: 'EX' } }],
      });
      expect(status).toBe(200);
      expect(body.results[0]).toMatchObject({ uid: 'uid-B', ok: false, published: true });
      expect(body.results[0].error).toMatch(/rows were not saved/i);
    });

    test('GET returns each student\'s row levels', async () => {
      getDb().prepare(`INSERT INTO rubric_row_levels (assignment_schoology_id, student_uid, criterion_name, level) VALUES ('sa-F', 'uid-B', 'Playtesting', 'ED')`).run();
      const { body } = await get(`/api/mastery/${courseId}/assignment/sa-F`);
      const byUid = Object.fromEntries(body.students.map(s => [s.schoology_uid, s]));
      expect(byUid['uid-B'].row_levels).toEqual({ Playtesting: 'ED' });
      expect(byUid['uid-A'].row_levels).toEqual({});
    });

    test('write-comment sends only the overall to Schoology and then stores the rows', async () => {
      const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-F', points: 75, comment: 'Good', commentStatus: true,
        rowLevels: { 'Features and Code': 'EX', Playtesting: 'D' },
      });
      expect(status).toBe(200);
      const sent = vi.mocked(pushGradeUpdates).mock.calls[0][1][0];
      expect(sent).toEqual({ assignment_id: 'sa-F', enrollment_id: 'eB', comment: 'Good', comment_status: 1, grade: '75', exception: 0 });
      expect(rowsOf('uid-B')).toEqual({ 'Features and Code': 'EX', Playtesting: 'D' });
    });

    test('write-comment stores no rows when Schoology rejects the write', async () => {
      vi.mocked(pushGradeUpdates).mockResolvedValue({ status: 500, data: {} });
      const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-F', points: 75, comment: '', commentStatus: true, rowLevels: { Playtesting: 'D' },
      });
      expect(status).toBe(502);
      expect(rowsOf('uid-B')).toEqual({});
    });

    test('write-comment refuses an unknown row before any Schoology call', async () => {
      const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eB', assignmentId: 'sa-F', points: 75, comment: '', rowLevels: { Evaluation: 'EX' },
      });
      expect(status).toBe(400);
      expect(getSectionGrades).not.toHaveBeenCalled();
      expect(pushGradeUpdates).not.toHaveBeenCalled();
    });

    test('send-all with only row changes makes no Schoology call and stores the rows', async () => {
      const { status } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-B', enrollmentId: 'eB', assignmentId: 'sa-F', scores: null, grade: null, comment: null, rowLevels: { Playtesting: 'EX' } }],
      });
      expect(status).toBe(200);
      expect(getSectionGrades).not.toHaveBeenCalled();
      expect(pushGradeUpdates).not.toHaveBeenCalled();
      expect(rowsOf('uid-B')).toEqual({ Playtesting: 'EX' });
    });

    test('send-all stores rows only after the comment PUT succeeds', async () => {
      vi.mocked(pushGradeUpdates).mockResolvedValue({ status: 500, data: {} });
      await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-B', enrollmentId: 'eB', assignmentId: 'sa-F', scores: null,
          grade: { points: 75 }, comment: { comment: 'Good', commentStatus: true }, rowLevels: { Playtesting: 'EX' } }],
      });
      expect(rowsOf('uid-B')).toEqual({});
    });
  });
});

describe('#52: mastery refreshed on demand after a page loads', () => {
  let courseId;
  let n = 0;
  beforeEach(async () => {
    // A fresh course and assignment per test (no deletes: earlier tests leave rows that reference courses).
    const db = getDb();
    n++;
    courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES (?, 'Course')`).run(`sec-r${n}`).lastInsertRowid;
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, ?, 'Project')`).run(courseId, `sa-r${n}`);
    const { syncMasteryForCourse, syncMasteryForAssignment } = await import('../services/masterySync.js');
    syncMasteryForCourse.mockReset();
    syncMasteryForAssignment.mockReset();
  });
  const stampCourse = (at) => getDb().prepare('UPDATE courses SET mastery_synced_at = ? WHERE id = ?').run(at, courseId);





  test('Sync Assignment queues a forced task run and answers its runId (background sync)', async () => {
    enqueue.mockClear();
    const s = await post(`/api/mastery/${courseId}/assignment/sa-r${n}/sync`, {});
    expect(s).toEqual({ status: 200, body: { runId: 77, state: 'queued', joined: false } });
    expect(enqueue).toHaveBeenCalledWith({ kind: 'task', courseId: Number(courseId), assignmentId: `sa-r${n}`, trigger: 'button', force: true });
    expect((await post(`/api/mastery/${courseId}/assignment/missing-task/sync`, {})).status).toBe(404);
  });


  test('POST /sync/:courseId always reads, and shares a refresh already running', async () => {
    const { syncMasteryForCourse } = await import('../services/masterySync.js');
    let release;
    const gate = new Promise((r) => { release = r; });
    syncMasteryForCourse.mockImplementation(async () => { await gate; stampCourse('2026-10-19T08:00:00.000Z'); return { scoresCount: 2 }; });
    stampCourse(new Date().toISOString()); // fresh: the page refresh would skip, the button still reads
    const both = Promise.all([post(`/api/mastery/sync/${courseId}`, {}), post(`/api/mastery/sync/${courseId}`, {})]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b] = await both;
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toMatchObject({ scoresCount: 2, syncedAt: '2026-10-19T08:00:00.000Z' });
    expect(syncMasteryForCourse).toHaveBeenCalledTimes(1);
  });
});

// #40: Late, Incomplete and Absent are markers the teacher grades straight through; Exempt and
// Missing are final. A score sent with a flag is removed (verified), so a grade written over a
// marker sends exception 0; one over a final flag is refused. Never a real Schoology call: the
// fake below keeps one record per pair and applies each PUT as the probes showed.
describe('grading over a flag (#40)', () => {
  let courseId, studentId, scaleTask, alignedTask;
  let records; // `${assignment_id}::${enrollment_id}` → the Schoology grade record
  const LINE = 'Marked late on Wed 21/10. Handed in after the deadline.';
  const key = (a, e) => `${a}::${e}`;
  const copyOf = (assignmentId) => getDb().prepare('SELECT * FROM excused_grades WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId) || null;
  const gradeOf = (assignmentId) => getDb().prepare('SELECT score, exception, grade_comment FROM grades WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId);
  const lineOf = (assignmentId) => getDb().prepare('SELECT line, kind FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId) || null;
  function setRecord(a, over) {
    records.set(key(a, 'eF'), { assignment_id: a, enrollment_id: 'eF', grade: null, exception: 0, comment: '', comment_status: 1, timestamp: 1700000000, ...over });
  }
  // A marker set in Prism: the local row, a saved copy and the flag's status line.
  function markLate(assignmentId, a, { line = true } = {}) {
    const db = getDb();
    const comment = line ? `${LINE}\n\nGood start.` : 'Good start.';
    setRecord(a, { exception: 6, comment });
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception, grade_comment, comment_status) VALUES (?, ?, 'eF', NULL, 6, ?, 1)
      ON CONFLICT (student_id, assignment_id) DO UPDATE SET score = NULL, exception = 6, grade_comment = excluded.grade_comment`).run(studentId, assignmentId, comment);
    db.prepare(`INSERT INTO excused_grades (student_id, assignment_id, flag, saved_json, saved_at, restored_at) VALUES (?, ?, 6, '{"score":100,"topics":{},"rows":{}}', datetime('now'), NULL)`).run(studentId, assignmentId);
    if (line) db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'flag')`).run(studentId, assignmentId, LINE);
    return comment;
  }

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM excused_grades; DELETE FROM assessment_drafts; DELETE FROM feedback_snapshots; DELETE FROM mastery_rollups; DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM rubrics; DELETE FROM extensions; DELETE FROM referrals; ' +
      ' DELETE FROM status_lines; DELETE FROM resubmissions; ' +
      'DELETE FROM mastery_scores; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
      'DELETE FROM assignment_assignees; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
    );
    courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-F', 'Course')`).run().lastInsertRowid;
    studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-F', 'Fay', 'F')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'eF')`).run(studentId, courseId);
    scaleTask = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-S', 'Homework', '7165818')`).run(courseId).lastInsertRowid;
    alignedTask = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-A', 'Project')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO measurement_topics (id, course_id, external_id, title) VALUES ('tF', ?, 'X.1', 'Topic')`).run(courseId);
    records = new Map();
    writeMasteryScoresBatch.mockReset().mockImplementation(async ({ entries }) => {
      // The mastery write clears the flag in Schoology by itself (verified) and sets the score.
      for (const e of entries) { const r = records.get(key(e.assignmentId, e.enrollmentId)); if (r) Object.assign(r, { exception: 0, grade: 100 }); }
    });
    vi.mocked(getSectionGrades).mockReset().mockImplementation(async () => [...records.values()].map((r) => ({ ...r })));
    vi.mocked(pushGradeUpdates).mockReset().mockImplementation(async (_section, entries) => {
      for (const e of entries) {
        const r = records.get(key(e.assignment_id, e.enrollment_id)) || {};
        const next = { ...r, assignment_id: e.assignment_id, enrollment_id: e.enrollment_id, comment: e.comment, comment_status: e.comment_status, grade: e.grade ?? null, exception: Number(e.exception) || 0 };
        if (next.exception !== 0 && next.exception !== 3) next.grade = null; // a score sent with a flag is removed
        records.set(key(e.assignment_id, e.enrollment_id), next);
      }
      return { status: 207, data: { grades: { grade: entries.map(() => ({ response_code: 204 })) } } };
    });
  });

  describe('write-comment', () => {
    test('points over Late: the PUT sends exception 0 with the grade; the copy is retired, the flag line removed, exception 0 mirrored', async () => {
      const comment = markLate(scaleTask, 'sa-S');
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eF', assignmentId: 'sa-S', points: 100, comment, commentStatus: true,
      });
      expect(status).toBe(200);
      expect(pushGradeUpdates.mock.calls[0][1]).toEqual([{
        assignment_id: 'sa-S', enrollment_id: 'eF', comment, comment_status: 1, grade: '100', exception: 0,
      }]);
      // The flag's line comes off by its exact stored text (a second, comment-only PUT echoing the new grade).
      expect(pushGradeUpdates).toHaveBeenCalledTimes(2);
      expect(pushGradeUpdates.mock.calls[1][1][0]).toMatchObject({ comment: 'Good start.', grade: '100', exception: 0 });
      expect(lineOf(scaleTask)).toBeNull();
      expect(copyOf(scaleTask).restored_at).not.toBeNull();
      expect(gradeOf(scaleTask)).toMatchObject({ score: 100, exception: 0, grade_comment: 'Good start.' });
      expect(body.flagCleared).toEqual({ exception: 0, comment: 'Good start.', status_line: null });
    });

    test.each([2, 5])('points over marker %i also sends exception 0', async (code) => {
      markLate(scaleTask, 'sa-S', { line: false });
      records.get(key('sa-S', 'eF')).exception = code;
      const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eF', assignmentId: 'sa-S', points: 0, comment: 'Not done', commentStatus: true,
      });
      expect(status).toBe(200);
      expect(pushGradeUpdates.mock.calls[0][1][0]).toMatchObject({ grade: '0', exception: 0 });
      expect(pushGradeUpdates).toHaveBeenCalledTimes(1); // no flag line to remove
      expect(copyOf(scaleTask).restored_at).not.toBeNull();
    });

    test('points with no flag echoes exception 0, and a waiting copy is retired (a newer published grade makes it stale)', async () => {
      setRecord('sa-S', { exception: 0 });
      getDb().prepare(`INSERT INTO excused_grades (student_id, assignment_id, flag, saved_json, saved_at) VALUES (?, ?, 1, '{}', datetime('now'))`).run(studentId, scaleTask);
      const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eF', assignmentId: 'sa-S', points: 100, comment: 'x', commentStatus: true,
      });
      expect(status).toBe(200);
      expect(pushGradeUpdates.mock.calls[0][1][0]).toMatchObject({ exception: 0 });
      expect(copyOf(scaleTask).restored_at).not.toBeNull();
    });

    test('a comment-only save with no flag keeps a waiting copy (no grade was published)', async () => {
      setRecord('sa-S', { exception: 0 });
      getDb().prepare(`INSERT INTO excused_grades (student_id, assignment_id, flag, saved_json, saved_at) VALUES (?, ?, 1, '{}', datetime('now'))`).run(studentId, scaleTask);
      const { status } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eF', assignmentId: 'sa-S', comment: 'x', commentStatus: true,
      });
      expect(status).toBe(200);
      expect(copyOf(scaleTask).restored_at).toBeNull();
    });

    test.each([1, 3])('points over the final flag %i: 409, nothing written', async (code) => {
      setRecord('sa-S', { exception: code, grade: code === 3 ? 0 : null });
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eF', assignmentId: 'sa-S', points: 100, comment: 'x', commentStatus: true,
      });
      expect(status).toBe(409);
      expect(body.code).toBe('FLAGGED');
      expect(body.error).toMatch(code === 1 ? /Exempt/ : /Missing/);
      expect(pushGradeUpdates).not.toHaveBeenCalled();
    });

    test('a comment-only write over a marker is no grade: the flag is echoed, the copy and line stay', async () => {
      const comment = markLate(scaleTask, 'sa-S');
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eF', assignmentId: 'sa-S', comment: `${comment} More.`, commentStatus: true,
      });
      expect(status).toBe(200);
      expect(pushGradeUpdates).toHaveBeenCalledTimes(1);
      expect(pushGradeUpdates.mock.calls[0][1][0]).toMatchObject({ exception: 6 });
      expect(copyOf(scaleTask).restored_at).toBeNull();
      expect(lineOf(scaleTask)).toMatchObject({ kind: 'flag' });
      expect(gradeOf(scaleTask).exception).toBe(6);
      expect(body.flagCleared).toBeUndefined();
    });

    test('rubricSaved over Late (the rubric write cleared it, fresh reads 0): copy retired, line removed, exception 0 mirrored', async () => {
      const comment = markLate(alignedTask, 'sa-A');
      Object.assign(records.get(key('sa-A', 'eF')), { exception: 0, grade: 100 }); // the mastery write just ran
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eF', assignmentId: 'sa-A', comment, commentStatus: true, rubricSaved: true,
      });
      expect(status).toBe(200);
      expect(pushGradeUpdates.mock.calls[0][1][0]).toMatchObject({ grade: '100', exception: 0 });
      expect(pushGradeUpdates.mock.calls[1][1][0]).toMatchObject({ comment: 'Good start.', exception: 0 });
      expect(copyOf(alignedTask).restored_at).not.toBeNull();
      expect(lineOf(alignedTask)).toBeNull();
      expect(gradeOf(alignedTask)).toMatchObject({ score: 100, exception: 0 });
      expect(body.flagCleared).toEqual({ exception: 0, comment: 'Good start.', status_line: null });
    });

    test('a status line of another kind is never removed by a grade over a marker', async () => {
      markLate(scaleTask, 'sa-S', { line: false });
      const received = 'Resubmission received 20/10 - regraded.';
      getDb().prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'received')`).run(studentId, scaleTask, received);
      await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eF', assignmentId: 'sa-S', points: 100, comment: `${received}\n\nx`, commentStatus: true,
      });
      expect(pushGradeUpdates).toHaveBeenCalledTimes(1);
      expect(lineOf(scaleTask)).toMatchObject({ kind: 'received' });
    });

    test('removing the line fails: the grade stays published and the response says so', async () => {
      const comment = markLate(scaleTask, 'sa-S');
      pushGradeUpdates.mockImplementationOnce(async (_section, entries) => {
        for (const e of entries) records.set(key(e.assignment_id, e.enrollment_id), { ...records.get(key(e.assignment_id, e.enrollment_id)), comment: e.comment, grade: e.grade, exception: 0 });
        return { status: 207 };
      }).mockResolvedValueOnce({ status: 500, data: 'oops' });
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, {
        enrollmentId: 'eF', assignmentId: 'sa-S', points: 100, comment, commentStatus: true,
      });
      expect(status).toBe(200);
      expect(body.flagCleared).toMatchObject({ exception: 0, lineError: expect.any(String) });
      expect(gradeOf(scaleTask)).toMatchObject({ score: 100, exception: 0 });
      expect(copyOf(scaleTask).restored_at).not.toBeNull();
      expect(lineOf(scaleTask)).toMatchObject({ kind: 'flag' }); // still there: removable later by its stored text
    });
  });

  describe('settleMarker: a rubric-only save over a marker never writes the card\'s comment', () => {
    test('with a flag line: exactly one PUT, the line removal composed from the FRESH comment', async () => {
      markLate(alignedTask, 'sa-A');
      // The rubric write cleared Late; the comment was edited in Schoology since the page loaded.
      Object.assign(records.get(key('sa-A', 'eF')), { exception: 0, grade: 100, comment: `${LINE}\n\nGood start. Edited in Schoology.` });
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'eF', assignmentId: 'sa-A', settleMarker: true });
      expect(status).toBe(200);
      expect(pushGradeUpdates).toHaveBeenCalledTimes(1);
      expect(pushGradeUpdates.mock.calls[0][1][0]).toMatchObject({ comment: 'Good start. Edited in Schoology.', grade: '100', exception: 0 });
      expect(copyOf(alignedTask).restored_at).not.toBeNull();
      expect(lineOf(alignedTask)).toBeNull();
      expect(gradeOf(alignedTask)).toMatchObject({ score: 100, exception: 0, grade_comment: 'Good start. Edited in Schoology.' });
      expect(body.flagCleared).toEqual({ exception: 0, comment: 'Good start. Edited in Schoology.', status_line: null });
    });

    test('with no flag line: no PUT at all; the copy is retired and exception 0 mirrored', async () => {
      markLate(alignedTask, 'sa-A', { line: false });
      Object.assign(records.get(key('sa-A', 'eF')), { exception: 0, grade: 100 });
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'eF', assignmentId: 'sa-A', settleMarker: true });
      expect(status).toBe(200);
      expect(pushGradeUpdates).not.toHaveBeenCalled();
      expect(copyOf(alignedTask).restored_at).not.toBeNull();
      expect(gradeOf(alignedTask)).toMatchObject({ score: 100, exception: 0, grade_comment: 'Good start.' });
      expect(body.flagCleared).toEqual({ exception: 0 });
    });

    test('the flag is still set in Schoology: nothing changes', async () => {
      markLate(alignedTask, 'sa-A');
      const { status, body } = await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'eF', assignmentId: 'sa-A', settleMarker: true });
      expect(status).toBe(200);
      expect(pushGradeUpdates).not.toHaveBeenCalled();
      expect(copyOf(alignedTask).restored_at).toBeNull();
      expect(lineOf(alignedTask)).toMatchObject({ kind: 'flag' });
      expect(body.flagCleared ?? null).toBeNull();
    });

    test('settleMarker with a comment is refused (a settle never writes a comment)', async () => {
      markLate(alignedTask, 'sa-A');
      const { status } = await post(`/api/mastery/${courseId}/write-comment`, { enrollmentId: 'eF', assignmentId: 'sa-A', settleMarker: true, comment: 'x' });
      expect(status).toBe(400);
      expect(pushGradeUpdates).not.toHaveBeenCalled();
    });

    test('send-all: a scores entry with settleMarker and no comment: only the line removal is PUT', async () => {
      markLate(alignedTask, 'sa-A');
      const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-F', enrollmentId: 'eF', assignmentId: 'sa-A', settleMarker: true, comment: null,
          scores: { gradeInfo: { tF: { grade: '100', gradingScaleId: 1 } }, gradingPeriodId: 1, gradingCategoryId: 2 } }],
      });
      expect(status).toBe(200);
      expect(writeMasteryScoresBatch).toHaveBeenCalledTimes(1);
      expect(pushGradeUpdates).toHaveBeenCalledTimes(1);
      expect(pushGradeUpdates.mock.calls[0][1][0]).toMatchObject({ comment: 'Good start.', exception: 0 });
      expect(copyOf(alignedTask).restored_at).not.toBeNull();
      expect(gradeOf(alignedTask)).toMatchObject({ exception: 0 });
      expect(body.results[0]).toMatchObject({ ok: true, flagCleared: { exception: 0, comment: 'Good start.', status_line: null } });
      expect(body.results[0].warning).toBeUndefined();
    });

    test('send-all: the settle read fails: levels published, the marker kept, and the result warns (#177)', async () => {
      markLate(alignedTask, 'sa-A');
      // The first read is the final-flag check before any write; the second, after the levels, fails.
      getSectionGrades.mockImplementationOnce(getSectionGrades.getMockImplementation()).mockRejectedValueOnce(new Error('Schoology down'));
      const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-F', enrollmentId: 'eF', assignmentId: 'sa-A', settleMarker: true, comment: null,
          scores: { gradeInfo: { tF: { grade: '100', gradingScaleId: 1 } }, gradingPeriodId: 1, gradingCategoryId: 2 } }],
      });
      expect(status).toBe(200);
      expect(writeMasteryScoresBatch).toHaveBeenCalledTimes(1);
      expect(pushGradeUpdates).not.toHaveBeenCalled();
      expect(gradeOf(alignedTask).exception).toBe(6);
      expect(lineOf(alignedTask)).toMatchObject({ kind: 'flag' });
      expect(body.results[0]).toMatchObject({ ok: true, warning: expect.stringMatching(/Levels published to Schoology.*Sync, then check the comment/) });
      expect(body.results[0].flagCleared).toBeUndefined();
    });
  });

  describe('levels over a final flag are refused (a level write clears Exempt, Incomplete, Absent and Late: probed 21-22 Oct 2026)', () => {
    const gradeInfo = { tF: { grade: '75', gradingScaleId: 1 } };
    const write = () => post(`/api/mastery/${courseId}/write`, { enrollmentId: 'eF', assignmentId: 'sa-A', gradeInfo, gradingPeriodId: 1, gradingCategoryId: 2 });
    beforeEach(() => { writeMasteryScores.mockReset().mockResolvedValue({}); });

    test('levels published with no flag retire a waiting copy (/write)', async () => {
      setRecord('sa-A', { exception: 0 });
      getDb().prepare(`INSERT INTO excused_grades (student_id, assignment_id, flag, saved_json, saved_at) VALUES (?, ?, 1, '{}', datetime('now'))`).run(studentId, alignedTask);
      const { status } = await write();
      expect(status).toBe(200);
      expect(copyOf(alignedTask).restored_at).not.toBeNull();
    });

    test('a stale card (Prism holds Late, Schoology now Exempt): 409, no observations write', async () => {
      markLate(alignedTask, 'sa-A');
      records.get(key('sa-A', 'eF')).exception = 1;
      const { status, body } = await write();
      expect(status).toBe(409);
      expect(body.code).toBe('FLAGGED');
      expect(writeMasteryScores).not.toHaveBeenCalled();
    });

    test('Prism holds Missing (Schoology cleared it since): still refused, reload first', async () => {
      setRecord('sa-A', { exception: 0 });
      getDb().prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception) VALUES (?, ?, 'eF', 0, 3)`).run(studentId, alignedTask);
      const { status } = await write();
      expect(status).toBe(409);
      expect(writeMasteryScores).not.toHaveBeenCalled();
    });

    test('a marker, or no flag: the levels are written', async () => {
      markLate(alignedTask, 'sa-A');
      expect((await write()).status).toBe(200);
      expect(writeMasteryScores).toHaveBeenCalledTimes(1);
    });

    test('the fresh read fails: 502, nothing written', async () => {
      vi.mocked(getSectionGrades).mockRejectedValueOnce(new Error('down'));
      const { status } = await write();
      expect(status).toBe(502);
      expect(writeMasteryScores).not.toHaveBeenCalled();
    });

    test('send-all: a scores entry on a pair Prism holds as Exempt is refused before step 1', async () => {
      getDb().prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, exception) VALUES (?, ?, 'eF', 1)`).run(studentId, alignedTask);
      setRecord('sa-A', { exception: 1 });
      const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-F', enrollmentId: 'eF', assignmentId: 'sa-A', scores: { gradeInfo, gradingPeriodId: 1, gradingCategoryId: 2 }, comment: { comment: 'x', commentStatus: true } }],
      });
      expect(status).toBe(409);
      expect(body.code).toBe('FLAGGED');
      expect(writeMasteryScoresBatch).not.toHaveBeenCalled();
      expect(pushGradeUpdates).not.toHaveBeenCalled();
    });

    test('send-all: Prism holds Late but Schoology now Missing: refused by the fresh read before step 1', async () => {
      markLate(alignedTask, 'sa-A');
      records.get(key('sa-A', 'eF')).exception = 3;
      const { status } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-F', enrollmentId: 'eF', assignmentId: 'sa-A', scores: { gradeInfo, gradingPeriodId: 1, gradingCategoryId: 2 }, comment: null }],
      });
      expect(status).toBe(409);
      expect(writeMasteryScoresBatch).not.toHaveBeenCalled();
    });
  });

  describe('send-all', () => {
    test('a scale grade over Late: exception 0 in the PUT, copy retired, line removed, exception 0 mirrored', async () => {
      const comment = markLate(scaleTask, 'sa-S');
      const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-F', enrollmentId: 'eF', assignmentId: 'sa-S', scores: null, grade: { points: 100 }, comment: { comment, commentStatus: true } }],
      });
      expect(status).toBe(200);
      expect(pushGradeUpdates.mock.calls[0][1][0]).toMatchObject({ grade: '100', exception: 0 });
      expect(pushGradeUpdates.mock.calls[1][1][0]).toMatchObject({ comment: 'Good start.', exception: 0 });
      expect(copyOf(scaleTask).restored_at).not.toBeNull();
      expect(lineOf(scaleTask)).toBeNull();
      expect(gradeOf(scaleTask)).toMatchObject({ score: 100, exception: 0, grade_comment: 'Good start.' });
      expect(body.results[0]).toMatchObject({ ok: true, flagCleared: { exception: 0, comment: 'Good start.', status_line: null } });
    });

    test('a grade or levels with no flag retire a waiting copy; a comment-only entry keeps it', async () => {
      setRecord('sa-S', { exception: 0 });
      setRecord('sa-A', { exception: 0 });
      const db = getDb();
      for (const t of [scaleTask, alignedTask]) db.prepare(`INSERT INTO excused_grades (student_id, assignment_id, flag, saved_json, saved_at) VALUES (?, ?, 1, '{}', datetime('now'))`).run(studentId, t);
      const comment = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-F', enrollmentId: 'eF', assignmentId: 'sa-S', scores: null, comment: { comment: 'x', commentStatus: true } }],
      });
      expect(comment.status).toBe(200);
      expect(copyOf(scaleTask).restored_at).toBeNull();
      const graded = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [
          { uid: 'uid-F', enrollmentId: 'eF', assignmentId: 'sa-S', scores: null, grade: { points: 100 }, comment: { comment: 'x', commentStatus: true } },
        ],
      });
      expect(graded.status).toBe(200);
      expect(copyOf(scaleTask).restored_at).not.toBeNull();
      const levels = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-F', enrollmentId: 'eF', assignmentId: 'sa-A',
          scores: { gradeInfo: { tF: { grade: '100', gradingScaleId: 1 } }, gradingPeriodId: 1, gradingCategoryId: 2 }, comment: null }],
      });
      expect(levels.status).toBe(200);
      expect(copyOf(alignedTask).restored_at).not.toBeNull();
    });

    test('rubric scores over Late (Prism held the marker): copy retired, line removed, exception 0 mirrored', async () => {
      const comment = markLate(alignedTask, 'sa-A');
      const { status } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-F', enrollmentId: 'eF', assignmentId: 'sa-A',
          scores: { gradeInfo: { tF: { grade: '100', gradingScaleId: 1 } }, gradingPeriodId: 1, gradingCategoryId: 2 },
          comment: { comment, commentStatus: true } }],
      });
      expect(status).toBe(200);
      expect(pushGradeUpdates.mock.calls[0][1][0]).toMatchObject({ grade: '100', exception: 0 });
      expect(copyOf(alignedTask).restored_at).not.toBeNull();
      expect(lineOf(alignedTask)).toBeNull();
      expect(gradeOf(alignedTask)).toMatchObject({ exception: 0 });
    });

    test.each([1, 3])('a scale grade over the final flag %i: 409 before any write', async (code) => {
      setRecord('sa-S', { exception: code });
      getDb().prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, exception) VALUES (?, ?, 'eF', ?)`).run(studentId, scaleTask, code);
      const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-F', enrollmentId: 'eF', assignmentId: 'sa-S', scores: null, grade: { points: 100 }, comment: { comment: 'x', commentStatus: true } }],
      });
      expect(status).toBe(409);
      expect(body.code).toBe('FLAGGED');
      expect(body.results).toEqual([{ uid: 'uid-F', ok: false }]);
      expect(pushGradeUpdates).not.toHaveBeenCalled();
      expect(writeMasteryScoresBatch).not.toHaveBeenCalled();
    });

    test('a final flag Prism did not know of (set in Schoology since): refused at the fresh read, nothing PUT', async () => {
      setRecord('sa-S', { exception: 1 });
      const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{ uid: 'uid-F', enrollmentId: 'eF', assignmentId: 'sa-S', scores: null, grade: { points: 100 }, comment: { comment: 'x', commentStatus: true } }],
      });
      expect(status).toBe(409);
      expect(body.code).toBe('FLAGGED');
      expect(pushGradeUpdates).not.toHaveBeenCalled();
    });
  });
});

// A level the teacher removes on the card is omitted from gradeInfo, and the /observations write
// REPLACES the pair's levels in Schoology, so Prism's mirror must drop the omitted topic's row too
// (#176 live check: the student page, re-reading Prism right after a publish, still showed it).
describe('a removed level leaves Prism\'s copy when Schoology\'s does (#176)', () => {
  let courseId, studentId;
  const levels = (uid = 'uid-rm') => Object.fromEntries(
    getDb().prepare(`SELECT topic_id, points FROM mastery_scores WHERE student_uid = ? AND assignment_schoology_id = 'sa-rm'`).all(uid).map((r) => [r.topic_id, r.points])
  );
  const info = (points) => ({ grade: String(points), gradingScaleId: 1 });

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM resubmissions; DELETE FROM grades; DELETE FROM mastery_alignments; ' +
      'DELETE FROM mastery_scores; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM assignment_assignees; ' +
      'DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
    );
    courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-rm', 'Course')`).run().lastInsertRowid;
    studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-rm', 'Ada', 'Lovelace')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-other', 'Bob', 'Babbage')`).run();
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-rm')`).run(studentId, courseId);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-rm', 'Project')`).run(courseId);
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-rm', ?, 'RM.1', 'Cat')`).run(courseId);
    for (const t of ['t-keep', 't-drop']) {
      db.prepare(`INSERT INTO measurement_topics (id, course_id, category_id, external_id, title) VALUES (?, ?, 'cat-rm', ?, ?)`).run(t, courseId, t, t);
      db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-rm', ?, ?)`).run(t, courseId);
      db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('uid-rm', 'sa-rm', ?, 75, 'EX')`).run(t);
    }
    // Another student's level on the dropped topic must stay.
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('uid-other', 'sa-rm', 't-drop', 50, 'D')`).run();
    getSectionGrades.mockReset().mockResolvedValue([]);
    pushGradeUpdates.mockReset().mockResolvedValue({ status: 207 });
    writeMasteryScores.mockReset().mockResolvedValue({ ok: true });
    writeMasteryScoresBatch.mockReset().mockResolvedValue(undefined);
  });

  test('POST /write: the topic left out of gradeInfo loses its local row; the page shows only the kept one', async () => {
    const { status } = await post(`/api/mastery/${courseId}/write`, {
      enrollmentId: 'enr-rm', assignmentId: 'sa-rm', gradeInfo: { 't-keep': info(100) },
    });
    expect(status).toBe(200);
    expect(levels()).toEqual({ 't-keep': 100 });
    expect(levels('uid-other')).toEqual({ 't-drop': 50 });

    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-rm`);
    const ada = body.students.find((s) => s.schoology_uid === 'uid-rm');
    expect(Object.keys(ada.scores)).toEqual(['t-keep']);
  });

  test('POST /write: an empty gradeInfo (every level removed) clears the pair', async () => {
    expect((await post(`/api/mastery/${courseId}/write`, { enrollmentId: 'enr-rm', assignmentId: 'sa-rm', gradeInfo: {} })).status).toBe(200);
    expect(levels()).toEqual({});
    expect(levels('uid-other')).toEqual({ 't-drop': 50 });
  });

  test('POST /write: the same student\'s levels on another assignment survive the delete', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-other', 'Other')`).run(courseId);
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('uid-rm', 'sa-other', 't-drop', 25, 'EM')`).run();
    expect((await post(`/api/mastery/${courseId}/write`, { enrollmentId: 'enr-rm', assignmentId: 'sa-rm', gradeInfo: { 't-keep': info(100) } })).status).toBe(200);
    expect(levels()).toEqual({ 't-keep': 100 });
    const other = db.prepare(`SELECT topic_id, points FROM mastery_scores WHERE student_uid = 'uid-rm' AND assignment_schoology_id = 'sa-other'`).all();
    expect(other).toEqual([{ topic_id: 't-drop', points: 25 }]);
  });

  test('POST /write: a throw while mirroring leaves the old rows, not half a mirror', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The second entry has no grade to read, so the mirror throws after the first upsert ran.
      const { status } = await post(`/api/mastery/${courseId}/write`, {
        enrollmentId: 'enr-rm', assignmentId: 'sa-rm', gradeInfo: { 't-keep': info(100), 't-x': null },
      });
      expect(status).toBe(200);
      expect(levels()).toEqual({ 't-keep': 75, 't-drop': 75 });
    } finally {
      spy.mockRestore();
    }
  });

  // #182: Schoology accepted the write, so a failed local mirror is a warning, not an error.
  test('POST /write: a failed mirror after an accepted write answers 200 with a warning', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { status, body } = await post(`/api/mastery/${courseId}/write`, {
        enrollmentId: 'enr-rm', assignmentId: 'sa-rm', gradeInfo: { 't-keep': info(100), 't-x': null },
      });
      expect(status).toBe(200);
      expect(body.error).toBeUndefined();
      expect(body.warning).toMatch(/^Levels published to Schoology, but Prism's copy was not updated/);
      expect(writeMasteryScores).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('POST /send-all: a failed mirror marks only that entry with a warning; it stays published', async () => {
    getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-rm', enrollment_id: 'enr-rm', grade: 95, exception: 0, timestamp: 1779418446 }]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
        entries: [{
          uid: 'uid-rm', enrollmentId: 'enr-rm', assignmentId: 'sa-rm',
          scores: { gradeInfo: { 't-keep': info(100), 't-x': null }, gradingPeriodId: 1, gradingCategoryId: 2 },
          comment: { comment: 'note', commentStatus: true },
        }],
      });
      expect(status).toBe(200);
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toMatchObject({ uid: 'uid-rm', ok: true });
      expect(body.results[0].warning).toMatch(/^Levels published to Schoology, but Prism's copy was not updated/);
      expect(levels()).toEqual({ 't-keep': 75, 't-drop': 75 });
      // The comment, which comes after the levels, is still mirrored.
      expect(getDb().prepare(`SELECT grade_comment FROM grades WHERE assignment_id = (SELECT id FROM assignments WHERE schoology_assignment_id = 'sa-rm')`).get()?.grade_comment).toBe('note');
    } finally {
      spy.mockRestore();
    }
  });

  test('POST /write: a Schoology failure leaves the local rows alone', async () => {
    writeMasteryScores.mockRejectedValue(new Error('down'));
    const { status } = await post(`/api/mastery/${courseId}/write`, { enrollmentId: 'enr-rm', assignmentId: 'sa-rm', gradeInfo: { 't-keep': info(100) } });
    expect(status).not.toBe(200);
    expect(levels()).toEqual({ 't-keep': 75, 't-drop': 75 });
  });

  test('POST /send-all: the same rule for a scores entry', async () => {
    getSectionGrades.mockResolvedValue([{ assignment_id: 'sa-rm', enrollment_id: 'enr-rm', grade: 95, exception: 0, timestamp: 1779418446 }]);
    const { status, body } = await post(`/api/mastery/${courseId}/send-all`, {
      entries: [{
        uid: 'uid-rm', enrollmentId: 'enr-rm', assignmentId: 'sa-rm',
        scores: { gradeInfo: { 't-keep': info(100) }, gradingPeriodId: 1, gradingCategoryId: 2 },
        comment: { comment: 'note', commentStatus: true },
      }],
    });
    expect(body.error).toBeUndefined();
    expect(status).toBe(200);
    expect(levels()).toEqual({ 't-keep': 100 });
    expect(levels('uid-other')).toEqual({ 't-drop': 50 });
  });
});
