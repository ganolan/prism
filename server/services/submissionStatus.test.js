import { describe, test, expect, beforeEach } from 'vitest';

import { vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { getSubmissionStatus } from './submissionStatus.js';

const TODAY = '2026-10-16';

let db, courseId, topicCount;

function student(uid, first, last, { email = `${first.toLowerCase()}.${last.toLowerCase()}@example.test`, dropped = false } = {}) {
  const id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name, email) VALUES (?, ?, ?, ?)`)
    .run(uid, first, last, email).lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, dropped_at) VALUES (?, ?, ?)`).run(id, courseId, dropped ? '2026-09-10' : null);
  return id;
}

// accepts: assignments.accepts_submissions (1 = Schoology dropbox/LTI, 0 = paper /
// gradebook-only, null = not yet synced). due = 'YYYY-MM-DD' or null (no due date).
function assignment(sid, title, due, { summative = true, lti = 0, test = false, accepts = 1, assignees = null, published = 1 } = {}) {
  const id = db.prepare(`
    INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, is_lti_submission, is_test, num_assignees, published, accepts_submissions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(courseId, sid, title, due ? `${due} 15:30:00` : null, lti, test ? 1 : 0, assignees ? assignees.length : null, published, accepts).lastInsertRowid;
  if (summative) {
    topicCount += 1;
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES (?, 'cat-1', ?, ?, 'T')`).run(`topic-${sid}`, courseId, `X.${topicCount}`);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES (?, ?, ?)`).run(sid, `topic-${sid}`, courseId);
  }
  for (const uid of assignees || []) db.prepare(`INSERT INTO assignment_assignees (assignment_id, schoology_uid) VALUES (?, ?)`).run(id, uid);
  return id;
}

function grade(studentId, assignmentId, cols) {
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
    .run(studentId, assignmentId, ...keys.map((k) => cols[k]));
}

function scoreTopic(uid, sid) {
  db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES (?, ?, ?, 75, 'EX')`).run(uid, sid, `topic-${sid}`);
}

// Flatten { studentName, items } into [{ name, title, status, owing }] for easy matching.
function flat(result) {
  return result.students.flatMap((s) => s.items.map((i) => ({ name: s.studentName, title: i.title, status: i.status, owing: i.owing })));
}

beforeEach(() => {
  db = getDb();
  db.exec(
    'DELETE FROM mastery_scores; DELETE FROM mastery_alignments; DELETE FROM assignment_assignees; DELETE FROM grades; ' +
    'DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM enrolments; DELETE FROM assignments; ' +
    'DELETE FROM students; DELETE FROM courses;',
  );
  topicCount = 0;
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AP CSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'X', 'Cat')`).run(courseId);
});

describe('getSubmissionStatus - LTI (OneDrive) assignments', () => {
  test('not_started and in_progress owe; submitted does not; no signal at all is unknown', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const bo = student('u2', 'Bo', 'Mar');
    const cy = student('u3', 'Cy', 'Ng');
    const dee = student('u4', 'Dee', 'Oh');
    const id = assignment('a1', 'OneDrive Essay', '2026-10-05', { lti: 1 });
    grade(ada, id, { lti_submission_state: 'not_started' });
    grade(bo, id, { lti_submission_state: 'in_progress' });
    grade(cy, id, { lti_submission_state: 'submitted' });
    // dee: no grades row and no submission_type → unknown.
    const r = getSubmissionStatus(db, { today: TODAY, status: 'all', courseId });
    expect(flat(r)).toEqual(expect.arrayContaining([
      { name: 'Ada Lin', title: 'OneDrive Essay', status: 'not_started', owing: true },
      { name: 'Bo Mar', title: 'OneDrive Essay', status: 'in_progress', owing: true },
      { name: 'Cy Ng', title: 'OneDrive Essay', status: 'submitted', owing: false },
      { name: 'Dee Oh', title: 'OneDrive Essay', status: 'unknown', owing: false },
    ]));
    expect(r.counts.unknown).toBe(1);
    expect(r.unknownHint).toBe(
      '1 items have no submission data (OneDrive work or tests whose attempts were not read): run a full sync with the Schoology session connected, then ask again.',
    );
  });

  test('a corroborating submission_type counts as submitted with no lti_submission_state', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const id = assignment('a1', 'OneDrive Essay', '2026-10-05', { lti: 1 });
    grade(ada, id, { submission_type: 'drop' });
    expect(flat(getSubmissionStatus(db, { today: TODAY, status: 'all', courseId }))).toEqual([
      { name: 'Ada Lin', title: 'OneDrive Essay', status: 'submitted', owing: false },
    ]);
  });

  test('null unknownHint and zero unknown count when nothing is unknown', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const id = assignment('a1', 'OneDrive Essay', '2026-10-05', { lti: 1 });
    grade(ada, id, { lti_submission_state: 'submitted' });
    const r = getSubmissionStatus(db, { today: TODAY, status: 'all', courseId });
    expect(r.counts.unknown).toBe(0);
    expect(r.unknownHint).toBeNull();
  });
});

describe('getSubmissionStatus - dropbox (native Schoology submissions)', () => {
  test('submission_type set is submitted; never submitted owes; submitted_at alone does not count', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const bo = student('u2', 'Bo', 'Mar');
    const cy = student('u3', 'Cy', 'Ng');
    const id = assignment('a1', 'Essay', '2026-10-05', { accepts: 1 });
    grade(ada, id, { submission_type: 'drop' });
    // bo: never submitted.
    // cy: a plain teacher grade-entry event stamps submitted_at with no real submission.
    grade(cy, id, { submitted_at: Math.floor(Date.now() / 1000) });
    const r = getSubmissionStatus(db, { today: TODAY, status: 'all', courseId });
    expect(flat(r)).toEqual(expect.arrayContaining([
      { name: 'Ada Lin', title: 'Essay', status: 'submitted', owing: false },
      { name: 'Bo Mar', title: 'Essay', status: 'not_started', owing: true },
      { name: 'Cy Ng', title: 'Essay', status: 'not_started', owing: true },
    ]));
  });
});

describe('getSubmissionStatus - Schoology tests', () => {
  test('took is submitted, none is not_started, not_assigned is skipped, no cell is unknown', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const bo = student('u2', 'Bo', 'Mar');
    const cy = student('u3', 'Cy', 'Ng');
    const dee = student('u4', 'Dee', 'Oh');
    const id = assignment('t1', 'Unit test', '2026-10-05', { test: true, accepts: 0 });
    grade(ada, id, { test_attempt: 'took' });
    grade(bo, id, { test_attempt: 'none' });
    grade(cy, id, { test_attempt: 'not_assigned' });
    // dee: no grades row at all → unknown.
    const r = getSubmissionStatus(db, { today: TODAY, status: 'all', courseId });
    const items = flat(r);
    expect(items).toEqual(expect.arrayContaining([
      { name: 'Ada Lin', title: 'Unit test', status: 'submitted', owing: false },
      { name: 'Bo Mar', title: 'Unit test', status: 'not_started', owing: true },
      { name: 'Dee Oh', title: 'Unit test', status: 'unknown', owing: false },
    ]));
    expect(items.find((i) => i.name === 'Cy Ng')).toBeUndefined(); // not_assigned → skipped entirely
    expect(r.counts.unknown).toBe(1);
  });
});

describe('getSubmissionStatus - paper / gradebook-only work', () => {
  test('never owes, status is not_tracked, regardless of submission signal', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const bo = student('u2', 'Bo', 'Mar');
    const id = assignment('a1', 'Paper quiz', '2026-10-05', { accepts: 0 });
    grade(ada, id, { score: 8 });
    // bo: nothing at all.
    const r = getSubmissionStatus(db, { today: TODAY, status: 'all', courseId });
    expect(flat(r)).toEqual(expect.arrayContaining([
      { name: 'Ada Lin', title: 'Paper quiz', status: 'not_tracked', owing: false },
      { name: 'Bo Mar', title: 'Paper quiz', status: 'not_tracked', owing: false },
    ]));
  });
});

describe('getSubmissionStatus - excused, scored, late', () => {
  test('exception 1 is excused and never owes, even when never submitted', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const id = assignment('a1', 'Essay', '2026-10-05', { accepts: 1 });
    grade(ada, id, { exception: 1 });
    expect(flat(getSubmissionStatus(db, { today: TODAY, status: 'all', courseId }))).toEqual([
      { name: 'Ada Lin', title: 'Essay', status: 'excused', owing: false },
    ]);
  });

  test('scored but never submitted (e.g. paper mark entered by hand) does not owe', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const id = assignment('a1', 'Essay', '2026-10-05', { accepts: 1 });
    scoreTopic('u1', 'a1');
    const r = getSubmissionStatus(db, { today: TODAY, status: 'all', courseId });
    expect(r.students[0].items[0]).toMatchObject({ status: 'not_started', owing: false, scored: true });
  });

  test('submitted and late carries Schoology\'s late flag, still submitted', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const id = assignment('a1', 'Essay', '2026-10-05', { accepts: 1 });
    grade(ada, id, { submission_type: 'drop', late: 1 });
    expect(flat(getSubmissionStatus(db, { today: TODAY, status: 'all', courseId }))[0]).toMatchObject({ status: 'submitted', owing: false });
    expect(getSubmissionStatus(db, { today: TODAY, status: 'all', courseId }).students[0].items[0].late).toBe(true);
  });

  test('late is false on time, null when Schoology has not reported it', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const bo = student('u2', 'Bo', 'Mar');
    const id = assignment('a1', 'Essay', '2026-10-05', { accepts: 1 });
    grade(ada, id, { submission_type: 'drop', late: 0 });
    // bo: no grades row at all.
    const r = getSubmissionStatus(db, { today: TODAY, status: 'all', courseId });
    const byName = Object.fromEntries(r.students.map((s) => [s.studentName, s.items[0]]));
    expect(byName['Ada Lin'].late).toBe(false);
    expect(byName['Bo Mar'].late).toBeNull();
  });
});

describe('getSubmissionStatus - filters', () => {
  test('summativeOnly keeps only aligned work', () => {
    const ada = student('u1', 'Ada', 'Lin');
    assignment('a1', 'Summative Essay', '2026-10-05', { summative: true });
    assignment('f1', 'Practice', '2026-10-05', { summative: false });
    const r = getSubmissionStatus(db, { today: TODAY, courseId, summativeOnly: true });
    expect(r.students[0].items.map((i) => i.title)).toEqual(['Summative Essay']);
    expect(r.students[0].items[0].summative).toBe(true);
  });

  test('pastDueOnly keeps only past-due work; undated work is kept unless pastDueOnly', () => {
    const ada = student('u1', 'Ada', 'Lin');
    assignment('a1', 'Past due', '2026-10-05');
    assignment('a2', 'Due today', TODAY);
    assignment('a3', 'Future', '2026-10-20');
    assignment('a4', 'No due date', null);
    const all = getSubmissionStatus(db, { today: TODAY, courseId, status: 'all' });
    expect(all.students[0].items.map((i) => i.title).sort()).toEqual(['Due today', 'Future', 'No due date', 'Past due'].sort());
    const past = getSubmissionStatus(db, { today: TODAY, courseId, status: 'all', pastDueOnly: true });
    expect(past.students[0].items.map((i) => i.title)).toEqual(['Past due']);
    expect(past.students[0].items[0].pastDue).toBe(true);
    const dueToday = all.students[0].items.find((i) => i.title === 'Due today');
    expect(dueToday.pastDue).toBe(false); // due today is not yet past due
    const noDue = all.students[0].items.find((i) => i.title === 'No due date');
    expect(noDue.dueDate).toBeNull();
    expect(noDue.pastDue).toBe(false);
  });

  test('assignmentId restricts to that assignment, in its own course', () => {
    student('u1', 'Ada', 'Lin');
    const id = assignment('a1', 'Essay', '2026-10-05');
    assignment('a2', 'Other essay', '2026-10-05');
    const r = getSubmissionStatus(db, { today: TODAY, assignmentId: id, status: 'all' });
    expect(r.students).toHaveLength(1);
    expect(r.students[0].items.map((i) => i.title)).toEqual(['Essay']);
    expect(() => getSubmissionStatus(db, { today: TODAY, assignmentId: 999999, status: 'all' })).toThrow('No assignment with id 999999');
  });

  test('student filter: local id or case-insensitive name fragment', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const bo = student('u2', 'Bo', 'Mar');
    assignment('a1', 'Essay', '2026-10-05');
    expect(getSubmissionStatus(db, { today: TODAY, courseId, status: 'all', student: 'ada' }).students.map((s) => s.studentName)).toEqual(['Ada Lin']);
    expect(getSubmissionStatus(db, { today: TODAY, courseId, status: 'all', student: bo }).students.map((s) => s.studentName)).toEqual(['Bo Mar']);
  });

  test('assignees restriction: a non-assignee of an individually-assigned task gets no item for it', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const bo = student('u2', 'Bo', 'Mar');
    assignment('a1', 'Extra-time copy', '2026-10-05', { assignees: ['u2'] });
    const r = getSubmissionStatus(db, { today: TODAY, courseId, status: 'all' });
    expect(r.students.map((s) => s.studentName)).toEqual(['Bo Mar']);
  });

  test('a dropped student is excluded entirely', () => {
    student('u1', 'Ada', 'Lin', { dropped: true });
    assignment('a1', 'Essay', '2026-10-05');
    expect(getSubmissionStatus(db, { today: TODAY, courseId, status: 'all' }).students).toEqual([]);
  });

  test('status not_submitted keeps only owing items, and only students with at least one', () => {
    const ada = student('u1', 'Ada', 'Lin');
    const bo = student('u2', 'Bo', 'Mar');
    const id = assignment('a1', 'Essay', '2026-10-05', { accepts: 1 });
    grade(ada, id, { submission_type: 'drop' }); // submitted, not owing
    // bo: never submitted → owing.
    const r = getSubmissionStatus(db, { today: TODAY, courseId });
    expect(r.students.map((s) => s.studentName)).toEqual(['Bo Mar']);
    expect(r.students[0].items).toHaveLength(1);
  });

  test("status 'all' without a course, assignment or student throws", () => {
    expect(() => getSubmissionStatus(db, { today: TODAY, status: 'all' })).toThrow(
      'status "all" needs a course, assignment_id or student (it lists every item); use status "not_submitted" for a whole-school view',
    );
  });

  test("status 'all' with just a course lists every item, owing or not", () => {
    const ada = student('u1', 'Ada', 'Lin');
    const id = assignment('a1', 'Essay', '2026-10-05', { accepts: 1 });
    grade(ada, id, { submission_type: 'drop' });
    const r = getSubmissionStatus(db, { today: TODAY, courseId, status: 'all' });
    expect(r.students[0].items).toHaveLength(1);
    expect(r.students[0].items[0]).toMatchObject({ status: 'submitted', owing: false });
  });
});

describe('getSubmissionStatus - email projection', () => {
  test('builds a deduped, case-insensitive email string and counts missing emails', () => {
    const ada = student('u1', 'Ada', 'Lin', { email: 'Ada.Lin@example.test' });
    const bo = student('u2', 'Bo', 'Mar', { email: null });
    const cy = student('u3', 'Cy', 'Ng', { email: 'ada.lin@example.test' }); // same address, different case
    const id = assignment('a1', 'Essay', '2026-10-05', { accepts: 1 });
    // All three never submitted → all owing, all in scope.
    void id;
    const r = getSubmissionStatus(db, { today: TODAY, courseId });
    expect(r.students.map((s) => s.studentName).sort()).toEqual(['Ada Lin', 'Bo Mar', 'Cy Ng']);
    // Ada and Cy share an address differing only by case: deduped to one entry.
    expect(r.emails).toBe('Ada.Lin@example.test');
    expect(r.counts.missingEmail).toBe(1);
    expect(r.counts.students).toBe(3);
    expect(r.counts.items).toBe(3);
  });
});
