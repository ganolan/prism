import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { addDays, isWeekday, todayLocal } from '../lib/schoolDays.js';
import { storeSchoolDays } from './schoolCalendar.js';
import { updateTriageSettings } from './settings.js';
import {
  getTriage, recordReferral, undoReferral, listReferrals, recordExtension, undoExtension, listExtensions, toneFor, TriageError,
  setMakeUpIgnored,
} from './triage.js';
import { requestResubmission, gradeStands } from './resubmissions.js';
import { captureFeedbackSnapshots } from './feedbackSnapshots.js';

const TODAY = '2026-10-16'; // Fri

// Calendar 01/09–30/10/2026: weekdays in session except 01/10 + 02/10.
function seedCalendar(db) {
  const days = [];
  for (let d = '2026-09-01'; d <= '2026-10-30'; d = addDays(d, 1)) {
    const off = !isWeekday(d) || d === '2026-10-01' || d === '2026-10-02';
    days.push({ date: d, inSession: !off, cycleLetter: null, raw: '{}' });
  }
  storeSchoolDays(db, days, '2026-10-01T00:00:00Z');
}

const epoch = (iso) => Date.parse(`${iso}T04:00:00Z`) / 1000; // same date in UTC and HK

let db, courseId, topicCount;
function student(uid, first, last, { dropped = false } = {}) {
  const id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, ?)`).run(uid, first, last).lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, dropped_at) VALUES (?, ?, ?)`).run(id, courseId, dropped ? '2026-09-10' : null);
  return id;
}
// accepts: assignments.accepts_submissions (1 = Schoology dropbox/LTI, 0 = paper /
// gradebook-only, null = not yet synced).
function assignment(sid, title, due, { summative = true, lti = 0, assignees = null, accepts = 1 } = {}) {
  const id = db.prepare(`
    INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, is_lti_submission, num_assignees, published, accepts_submissions)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(courseId, sid, title, `${due} 15:30:00`, lti, assignees ? assignees.length : null, accepts).lastInsertRowid;
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
// A Schoology test (no dropbox): is_test = 1 + the attempt-read status. Due 14:00 local.
function testItem(sid, title, due, { status = 'ok', ...opts } = {}) {
  const id = assignment(sid, title, due, { accepts: 0, ...opts });
  db.prepare(`UPDATE assignments SET is_test = 1, test_fetch_status = ?, due_date = ? WHERE id = ?`).run(status, `${due} 14:00:00`, id);
  return id;
}
// The sync's per-pair attempt marker (grades.test_attempt) from a good read.
const took = (studentId, assignmentId) => grade(studentId, assignmentId, { submission_type: 'assessment', test_attempt: 'took' });
const missed = (studentId, assignmentId, cols = {}) => grade(studentId, assignmentId, { test_attempt: 'none', ...cols });
const AFTER_SCHOOL = `${TODAY} 16:00:00`;

beforeEach(() => {
  db = getDb();
  db.exec(
    'DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM referrals; DELETE FROM extensions; DELETE FROM resubmissions; DELETE FROM settings; DELETE FROM school_days; DELETE FROM mastery_scores; DELETE FROM mastery_alignments; ' +
    'DELETE FROM assignment_assignees; DELETE FROM grades; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
    'DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses; DELETE FROM sync_log;',
  );
  topicCount = 0;
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AP CSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'X', 'Cat')`).run(courseId);
  seedCalendar(db);
});

describe('toneFor', () => {
  test('green below limit-lead, amber from limit-lead, red from limit', () => {
    expect(toneFor(4, 8, 3)).toBe('green');
    expect(toneFor(5, 8, 3)).toBe('amber');
    expect(toneFor(8, 8, 3)).toBe('red');
  });
});

describe('getTriage — late work', () => {
  test('never-engaged student (no grades row) is outstanding, counted in school days', () => {
    const maya = student('u1', 'Maya', 'Chen');
    assignment('a1', 'Create Task CP2', '2026-10-05'); // Mon; 06..16/10 = 9 school days
    const t = getTriage(db, { today: TODAY });
    expect(t.lateWork).toHaveLength(1);
    expect(t.lateWork[0]).toMatchObject({
      kind: 'outstanding', studentId: maya, studentName: 'Maya Chen', title: 'Create Task CP2',
      dueDate: '2026-10-05', daysLate: 9, tone: 'red', approx: false, courseName: 'AP CSP',
    });
    expect(t.counts.atReferralLimit).toBe(1);
  });

  test('due today or not yet due → not listed', () => {
    student('u1', 'Maya', 'Chen');
    assignment('a1', 'Due today', TODAY);
    assignment('a2', 'Future', '2026-10-20');
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('formative work never appears on the late list', () => {
    student('u1', 'Maya', 'Chen');
    assignment('f1', 'Practice', '2026-10-05', { summative: false });
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('submitted before the limit clears; excused never listed', () => {
    const a = student('u1', 'Ada', 'L');
    const b = student('u2', 'Bo', 'M');
    const id = assignment('a1', 'Essay', '2026-10-05');
    grade(a, id, { submission_type: 'drop', latest_revision_at: epoch('2026-10-07'), first_submitted_at: epoch('2026-10-07') });
    grade(b, id, { exception: 1 });
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('Missing exception still counts as outstanding (grade timestamp is not a submission)', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Essay', '2026-10-05');
    // Real Missing rows carry score 0.0 (a grade-entry artifact, not a mark).
    grade(a, id, { exception: 3, submitted_at: epoch('2026-10-06'), score: 0 });
    expect(getTriage(db, { today: TODAY }).lateWork[0]).toMatchObject({ kind: 'outstanding', daysLate: 9 });
  });

  test('Missing with score 0 and no submission is outstanding (exception 3 is never "scored")', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Essay', '2026-09-21');
    grade(a, id, { exception: 3, score: 0 });
    const row = getTriage(db, { today: TODAY }).lateWork[0];
    expect(row).toMatchObject({ kind: 'outstanding', daysLate: 17, tone: 'red' });
  });

  test('comment-only grade entry (no submission) stays outstanding, not feedback-owed', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Essay', '2026-10-05');
    grade(a, id, { grade_comment: 'please submit', submitted_at: epoch('2026-10-06') });
    const t = getTriage(db, { today: TODAY });
    expect(t.lateWork[0]).toMatchObject({ kind: 'outstanding', daysLate: 9 });
    expect(t.feedbackOwed).toEqual([]);
  });

  test('scored on paper with no submission → not outstanding', () => {
    const a = student('u1', 'Ada', 'L');
    assignment('a1', 'Paper test', '2026-10-05');
    scoreTopic('u1', 'a1');
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('scored on paper with no first-submission time is never flagged late (known limit)', () => {
    const a = student('u1', 'Ada', 'L');
    assignment('a1', 'Paper test', '2026-09-21'); // long past due — would be 17 school days if guessed
    scoreTopic('u1', 'a1');
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('submitted after crossing the limit stays listed (sticky), tagged submitted_late', () => {
    const a = student('u1', 'Ada', 'L');
    // Due Mon 21/09; first submitted Mon 05/10 → 22–25/09 (4) + 28–30/09 (3) + 05/10 (1) = 8 (01/10 + 02/10 off).
    const id = assignment('a1', 'Essay', '2026-09-21');
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05'), latest_revision_at: epoch('2026-10-05'), late: 1 });
    const row = getTriage(db, { today: TODAY }).lateWork[0];
    expect(row).toMatchObject({ kind: 'submitted_late', daysLate: 8, submittedOn: '2026-10-05', tone: 'red' });
  });

  test('submitted after the limit but Schoology says on time (late = 0) → not listed', () => {
    const a = student('u1', 'Ada', 'L');
    // e.g. a per-student due-date extension Prism can't see: trust Schoology's late flag.
    const id = assignment('a1', 'Essay', '2026-09-21');
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05'), latest_revision_at: epoch('2026-10-05'), late: 0 });
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('on-time first submission, late resubmission → not listed', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Essay', '2026-09-21');
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-09-21'), latest_revision_at: epoch('2026-10-14') });
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('non-assignee of an individually-assigned task is not listed', () => {
    student('u1', 'Ada', 'L');
    student('u2', 'Bo', 'M');
    assignment('a1', 'Extra-time copy', '2026-10-05', { assignees: ['u2'] });
    expect(getTriage(db, { today: TODAY }).lateWork.map((r) => r.studentName)).toEqual(['Bo M']);
  });

  test('dropped student is not listed', () => {
    student('u1', 'Ada', 'L', { dropped: true });
    assignment('a1', 'Essay', '2026-10-05');
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('LTI in-progress counts as not submitted', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'OneDrive essay', '2026-10-05', { lti: 1 });
    grade(a, id, { lti_submission_state: 'in_progress' });
    expect(getTriage(db, { today: TODAY }).lateWork).toHaveLength(1);
  });

  test('LTI state wins over a stale submission_type', () => {
    const a = student('u1', 'Ada', 'L');
    const b = student('u2', 'Bo', 'M');
    const id = assignment('a1', 'OneDrive essay', '2026-10-05', { lti: 1 });
    grade(a, id, { lti_submission_state: 'in_progress', submission_type: 'drop' });
    grade(b, id, { lti_submission_state: 'not_started', submission_type: 'drop' });
    expect(getTriage(db, { today: TODAY }).lateWork.map((r) => [r.studentName, r.kind]))
      .toEqual([['Ada L', 'outstanding'], ['Bo M', 'outstanding']]);
  });

  test('blockNumber rides on every late-work row', () => {
    db.prepare(`UPDATE courses SET block_number = '7' WHERE id = ?`).run(courseId);
    student('u1', 'Ada', 'L');
    assignment('a1', 'Essay', '2026-10-05');
    expect(getTriage(db, { today: TODAY }).lateWork[0]).toMatchObject({ courseName: 'AP CSP', blockNumber: '7' });
  });

  test('settings move the thresholds', () => {
    student('u1', 'Ada', 'L');
    assignment('a1', 'Essay', '2026-10-12'); // 13..16/10 = 4 school days
    expect(getTriage(db, { today: TODAY }).lateWork[0].tone).toBe('green');
    updateTriageSettings(db, { referralLimitDays: 4 });
    expect(getTriage(db, { today: TODAY }).lateWork[0].tone).toBe('red');
  });

  test('courseId and studentId filters', () => {
    const a = student('u1', 'Ada', 'L');
    student('u2', 'Bo', 'M');
    assignment('a1', 'Essay', '2026-10-05');
    const other = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-2', 'AIML')`).run().lastInsertRowid;
    expect(getTriage(db, { today: TODAY, courseId: other }).lateWork).toEqual([]);
    expect(getTriage(db, { today: TODAY, studentId: a }).lateWork.map((r) => r.studentId)).toEqual([a]);
  });

  test('archived and hidden courses are excluded from the all-courses view', () => {
    student('u1', 'Ada', 'L');
    assignment('a1', 'Essay', '2026-10-05');
    db.prepare('UPDATE courses SET hidden = 1 WHERE id = ?').run(courseId);
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
    expect(getTriage(db, { today: TODAY, courseId }).lateWork).toHaveLength(1); // course page still shows it
    db.prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
    expect(getTriage(db, { today: TODAY, courseId }).lateWork).toEqual([]);
  });

  test('no calendar → weekday count flagged approx', () => {
    db.exec('DELETE FROM school_days;');
    student('u1', 'Ada', 'L');
    assignment('a1', 'Essay', '2026-09-30'); // weekdays 01/10..16/10 = 12 (holidays not known)
    const t = getTriage(db, { today: TODAY });
    expect(t.lateWork[0]).toMatchObject({ daysLate: 12, approx: true });
    expect(t.calendar.source).toBe('weekdays');
    expect(t.approx).toBe(true);
  });
});

describe('getTriage — assignments without a submission channel', () => {
  test('accepts_submissions 0, nobody scored → nobody late; whole roster owed feedback, waiting from due', () => {
    student('u1', 'Ada', 'L');
    student('u2', 'Bo', 'M');
    const c = student('u3', 'Cy', 'N');
    const id = assignment('t1', 'Values Theory Test', '2026-10-05', { accepts: 0 }); // 06..16/10 = 9 school days
    grade(c, id, { exception: 1 }); // excused → not counted
    const t = getTriage(db, { today: TODAY });
    expect(t.lateWork).toEqual([]);
    expect(t.feedbackOwed).toEqual([expect.objectContaining({
      title: 'Values Theory Test', owed: 2, submittedTotal: 2, oldestWaitDays: 9, tone: 'amber',
    })]);
  });

  test('accepts_submissions 0: graded students are done, the rest still owed', () => {
    const a = student('u1', 'Ada', 'L');
    student('u2', 'Bo', 'M');
    const id = assignment('t1', 'Paper test', '2026-10-12', { accepts: 0 });
    grade(a, id, { grade_comment: 'Well done' });
    scoreTopic('u1', 't1');
    expect(getTriage(db, { today: TODAY }).feedbackOwed[0]).toMatchObject({ owed: 1, submittedTotal: 2, oldestWaitDays: 4 });
  });

  test('accepts_submissions NULL and no submission signal → not outstanding', () => {
    student('u1', 'Ada', 'L');
    student('u2', 'Bo', 'M');
    assignment('a1', 'Not yet synced', '2026-10-05', { accepts: null });
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('accepts_submissions NULL with one real submission → the others are outstanding', () => {
    const a = student('u1', 'Ada', 'L');
    student('u2', 'Bo', 'M');
    const id = assignment('a1', 'Not yet synced', '2026-10-05', { accepts: null });
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05'), late: 0 });
    expect(getTriage(db, { today: TODAY }).lateWork.map((r) => [r.studentName, r.kind])).toEqual([['Bo M', 'outstanding']]);
  });

  test('accepts_submissions NULL: tracking is decided over the whole roster, so a student filter and recordReferral agree with the dashboard', () => {
    const a = student('u1', 'Ada', 'L');
    const bo = student('u2', 'Bo', 'M');
    const id = assignment('a1', 'Not yet synced', '2026-10-05', { accepts: null }); // Bo: 9 school days → red
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05'), late: 0 });
    expect(getTriage(db, { today: TODAY, studentId: bo }).lateWork.map((r) => r.studentName)).toEqual(['Bo M']);
    expect(recordReferral(db, { studentId: bo, assignmentId: id, action: 'referred', today: TODAY }))
      .toMatchObject({ action: 'referred', studentName: 'Bo M', daysLate: 9 });
  });
});

describe('getTriage — feedback owed', () => {
  test('submitted + ungraded or partial is owed; complete is not; oldest wait from max(due, first submitted)', () => {
    const a = student('u1', 'Ada', 'L');
    const b = student('u2', 'Bo', 'M');
    const c = student('u3', 'Cy', 'N');
    const id = assignment('a1', 'Model Card', '2026-10-05');
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-02') });               // on time → waits from due (9)
    grade(b, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-12'), grade_comment: 'part' }); // late, partial → from 12/10 (4)
    grade(c, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05'), grade_comment: 'Done' });
    scoreTopic('u3', 'a1');                                                                             // complete
    const t = getTriage(db, { today: TODAY });
    expect(t.feedbackOwed).toEqual([expect.objectContaining({
      title: 'Model Card', owed: 2, submittedTotal: 3, oldestWaitDays: 9, tone: 'amber', aligned: true,
    })]);
  });

  test('formative only when includeFormative (or the settings default)', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('f1', 'Practice', '2026-10-05', { summative: false });
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05') });
    expect(getTriage(db, { today: TODAY }).feedbackOwed).toEqual([]);
    expect(getTriage(db, { today: TODAY, includeFormative: true }).feedbackOwed).toHaveLength(1);
    updateTriageSettings(db, { showFormativeDefault: true });
    const t = getTriage(db, { today: TODAY });
    expect(t.includeFormative).toBe(true);
    expect(t.feedbackOwed).toHaveLength(1);
  });

  test('blockNumber rides on every feedback-owed row', () => {
    db.prepare(`UPDATE courses SET block_number = '3' WHERE id = ?`).run(courseId);
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Model Card', '2026-10-05');
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05') });
    expect(getTriage(db, { today: TODAY }).feedbackOwed[0]).toMatchObject({ blockNumber: '3' });
  });

  test('a scored formative (no topics) is complete', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('f1', 'Practice', '2026-10-05', { summative: false });
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05'), score: 1 });
    expect(getTriage(db, { today: TODAY, includeFormative: true }).feedbackOwed).toEqual([]);
  });
});

describe('getTriage — make-up tests', () => {
  const now = AFTER_SCHOOL;

  test('a targeted student with no attempt is listed; takers are not; school days since the test, worst first', () => {
    db.prepare(`UPDATE courses SET block_number = '7' WHERE id = ?`).run(courseId);
    const ada = student('u1', 'Ada', 'L');
    const bo = student('u2', 'Bo', 'M');
    const t1 = testItem('t1', 'Unit 1 test', '2026-10-13'); // Tue: 14, 15, 16 = 3 → red
    const t2 = testItem('t2', 'Unit 2 quiz', '2026-10-15'); // Thu: 16 = 1 → amber
    const t3 = testItem('t3', 'Unit 3 test', TODAY);        // today, over at 14:00 → 0, green
    took(bo, t1); took(bo, t2); took(bo, t3);
    missed(ada, t1); missed(ada, t2); missed(ada, t3);
    const t = getTriage(db, { today: TODAY, now });
    expect(t.makeUps.map((r) => [r.title, r.studentName, r.daysSince, r.tone])).toEqual([
      ['Unit 1 test', 'Ada L', 3, 'red'], ['Unit 2 quiz', 'Ada L', 1, 'amber'], ['Unit 3 test', 'Ada L', 0, 'green'],
    ]);
    expect(t.makeUps[0]).toEqual({
      studentId: ada, studentUid: 'u1', studentName: 'Ada L', courseId, courseName: 'AP CSP', blockNumber: '7',
      assignmentId: t1, schoologyAssignmentId: 't1', title: 'Unit 1 test', dueDate: '2026-10-13',
      daysSince: 3, day: 4, tone: 'red', approx: false, extension: null,
    });
    expect(t.counts.makeUpsOverdue).toBe(1);
    expect(t.makeUpsUnchecked).toBe(0);
    expect(t.lateWork).toEqual([]); // a missed test is not late work
  });

  test('a test due today counts only once it is over (local due datetime vs local now)', () => {
    const ada = student('u1', 'Ada', 'L');
    missed(ada, testItem('t1', 'Unit 1 test', TODAY)); // 14:00
    expect(getTriage(db, { today: TODAY, now: `${TODAY} 13:59:59` }).makeUps).toEqual([]);
    expect(getTriage(db, { today: TODAY, now: `${TODAY} 14:00:00` }).makeUps).toHaveLength(1);
    expect(getTriage(db, { today: TODAY }).makeUps).toHaveLength(1); // an injected past day = the end of that day
    expect(getTriage(db, { today: '2026-10-15' }).makeUps).toEqual([]); // not yet due
  });

  test('without an injected today, "is it over?" uses the real clock; an injected today never does', () => {
    const ada = student('u1', 'Ada', 'L');
    missed(ada, testItem('t1', 'Unit 1 test', TODAY)); // 14:00
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 16, 10, 0, 0)); // Fri 16/10 10:00 local — before the test ends
      expect(getTriage(db, {}).makeUps).toEqual([]);
      expect(getTriage(db, { today: TODAY }).makeUps).toHaveLength(1); // injected → the end of that day
      expect(getTriage(db, { today: TODAY, now: `${TODAY} 10:00:00` }).makeUps).toEqual([]);
      vi.setSystemTime(new Date(2026, 9, 16, 15, 0, 0)); // after it
      expect(getTriage(db, {}).makeUps).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('only an explicit "no attempt" cell lists a student: no cell (NULL) is unknown, not_assigned is not targeted', () => {
    const ada = student('u1', 'Ada', 'L');
    const bo = student('u2', 'Bo', 'M');
    const cy = student('u3', 'Cy', 'N');
    const id = testItem('t1', 'Unit 1 test', '2026-10-15'); // open to all (no assignees)
    missed(ada, id);
    grade(bo, id, { test_attempt: 'not_assigned' }); // on the * copy
    expect(cy).toBeGreaterThan(0);                    // Cy: no grades row at all → unknown
    expect(getTriage(db, { today: TODAY, now }).makeUps.map((r) => r.studentName)).toEqual(['Ada L']);
  });

  test('not listed: excused, scored by hand or in mastery, dropped, on the other (*) copy', () => {
    const ada = student('u1', 'Ada', 'L');
    const bo = student('u2', 'Bo', 'M');
    student('u3', 'Cy', 'N', { dropped: true });
    const dee = student('u4', 'Dee', 'O');
    student('u5', 'Eve', 'P'); // not an assignee
    const id = testItem('t1', 'Unit 1 test', '2026-10-15', { assignees: ['u1', 'u2', 'u3', 'u4'] }); // Eve sits the * copy
    const cy = db.prepare(`SELECT id FROM students WHERE schoology_uid = 'u3'`).get().id;
    const eve = db.prepare(`SELECT id FROM students WHERE schoology_uid = 'u5'`).get().id;
    missed(ada, id, { exception: 1 });
    missed(bo, id, { score: 12 });
    missed(cy, id);
    missed(dee, id);
    scoreTopic('u4', 't1');
    missed(eve, id);
    expect(getTriage(db, { today: TODAY, now }).makeUps).toEqual([]);
  });

  test('a real submission counts as sitting it', () => {
    const ada = student('u1', 'Ada', 'L');
    missed(ada, testItem('t1', 'Unit 1 test', '2026-10-15'), { submission_type: 'drop' });
    expect(getTriage(db, { today: TODAY, now }).makeUps).toEqual([]);
  });

  test('Missing (exception 3, score 0.0) is still a make-up', () => {
    const ada = student('u1', 'Ada', 'L');
    const id = testItem('t1', 'Unit 1 test', '2026-10-15');
    missed(ada, id, { exception: 3, score: 0 });
    expect(getTriage(db, { today: TODAY, now }).makeUps).toHaveLength(1);
  });

  test('a failed or never-run attempt read is unknown, not missed: no rows, counted as unchecked', () => {
    const ada = student('u1', 'Ada', 'L');
    missed(ada, testItem('t1', 'Failed read', '2026-10-15', { status: 'failed' })); // a stale cell from an older read
    testItem('t2', 'Never read', '2026-10-15', { status: null });
    testItem('t3', 'Not yet due', '2026-10-20', { status: null });
    testItem('t4', 'Unaligned quiz', '2026-10-15', { status: null, summative: false });
    const t = getTriage(db, { today: TODAY, now });
    expect(t.makeUps).toEqual([]);
    expect(t.makeUpsUnchecked).toBe(3);
  });

  test('every Schoology test/quiz counts, aligned or not (the mastery grade sits on a separate "- Result" item)', () => {
    const ada = student('u1', 'Ada', 'L');
    const bo = student('u2', 'Bo', 'M');
    const quiz = testItem('q1', 'Unit 1 quiz', '2026-10-15', { summative: false }); // numeric scale, no topics
    assignment('r1', 'Unit 1 quiz - Result', '2026-10-15', { accepts: 0 });          // gradebook-only, is_test 0
    took(ada, quiz);
    missed(bo, quiz);
    const t = getTriage(db, { today: TODAY, now }); // Show formative off
    expect(t.makeUps.map((r) => [r.studentId, r.title, r.tone])).toEqual([[bo, 'Unit 1 quiz', 'amber']]);
    expect(recordExtension(db, { studentId: bo, assignmentId: quiz, lessons: 1 })).toMatchObject({ until: '2026-10-16' });
    expect(getTriage(db, { today: TODAY, now }).makeUps[0]).toMatchObject({ daysSince: 0, tone: 'green' });
  });

  test('only Schoology tests: unpublished, non-test and archived-course work are not make-ups', () => {
    const ada = student('u1', 'Ada', 'L');
    const id = testItem('t1', 'Unit 1 test', '2026-10-15');
    missed(ada, id);
    db.prepare('UPDATE assignments SET published = 0 WHERE id = ?').run(id);
    assignment('p1', 'Paper test', '2026-10-15', { accepts: 0 });
    expect(getTriage(db, { today: TODAY, now }).makeUps).toEqual([]);
    db.prepare('UPDATE assignments SET published = 1 WHERE id = ?').run(id);
    db.prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
    expect(getTriage(db, { today: TODAY, now, courseId }).makeUps).toEqual([]);
  });

  test('an extension moves the clock ("sitting it Thursday"): green until then, counted from it', () => {
    const ada = student('u1', 'Ada', 'L');
    const id = testItem('t1', 'Unit 1 test', '2026-10-13'); // 3 → red
    missed(ada, id);
    const e = recordExtension(db, { studentId: ada, assignmentId: id, lessons: 2, note: 'sits Thu' }); // until Thu 15/10
    expect(getTriage(db, { today: TODAY, now }).makeUps[0]).toMatchObject({
      dueDate: '2026-10-13', daysSince: 1, tone: 'amber', extension: { id: e.id, lessons: 2, until: '2026-10-15', note: 'sits Thu' },
    });
    recordExtension(db, { studentId: ada, assignmentId: id, lessons: 5 }); // until Tue 20/10
    expect(getTriage(db, { today: TODAY, now }).makeUps[0]).toMatchObject({ daysSince: 0, tone: 'green' });
  });

  test('the make-up settings move the tones', () => {
    const ada = student('u1', 'Ada', 'L');
    missed(ada, testItem('t1', 'Unit 1 test', '2026-10-15')); // day 2
    expect(getTriage(db, { today: TODAY, now }).makeUps[0].tone).toBe('amber');
    updateTriageSettings(db, { makeUpAmberDay: 3, makeUpRedDay: 5 });
    expect(getTriage(db, { today: TODAY, now }).makeUps[0].tone).toBe('green');
    updateTriageSettings(db, { makeUpAmberDay: 1, makeUpRedDay: 2 });
    expect(getTriage(db, { today: TODAY, now }).makeUps[0].tone).toBe('red');
  });

  test('studentId filter', () => {
    const ada = student('u1', 'Ada', 'L');
    const bo = student('u2', 'Bo', 'M');
    const id = testItem('t1', 'Unit 1 test', '2026-10-13');
    missed(ada, id); missed(bo, id);
    const t = getTriage(db, { today: TODAY, now, studentId: ada });
    expect(t.makeUps.map((r) => r.studentId)).toEqual([ada]);
    expect(t.counts.makeUpsOverdue).toBe(1);
  });

  test('feedback owed on a checked test: only takers count as handed in (not the whole roster)', () => {
    const ada = student('u1', 'Ada', 'L');
    const bo = student('u2', 'Bo', 'M');
    const id = testItem('t1', 'Unit 1 test', '2026-10-12'); // 13..16/10 = 4 school days
    grade(ada, id, { test_attempt: 'took' }); // the per-pair marker alone counts as handed in
    missed(bo, id);
    expect(getTriage(db, { today: TODAY, now }).feedbackOwed).toEqual([expect.objectContaining({
      title: 'Unit 1 test', owed: 1, submittedTotal: 1, oldestWaitDays: 4,
    })]);
    // Attempts unknown → the paper rule (whole targeted roster handed in at the due date) still applies.
    db.prepare(`UPDATE assignments SET test_fetch_status = 'failed' WHERE id = ?`).run(id);
    expect(getTriage(db, { today: TODAY, now }).feedbackOwed[0]).toMatchObject({ owed: 2, submittedTotal: 2 });
  });
});

describe('make-up tracking: ignore a quiz for all students', () => {
  const now = AFTER_SCHOOL;

  test('an ignored test lists nobody and is counted in makeUpsIgnored (not unchecked); tracking it again restores the rows', () => {
    const ada = student('u1', 'Ada', 'L');
    const quiz = testItem('q1', 'Practice quiz', '2026-10-15', { summative: false });
    missed(ada, quiz);
    testItem('q2', 'Unread quiz', '2026-10-15', { status: null });
    testItem('q3', 'Future quiz', '2026-10-20');
    expect(setMakeUpIgnored(db, quiz, true)).toEqual({ assignmentId: quiz, title: 'Practice quiz', ignored: true });
    setMakeUpIgnored(db, db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = 'q3'`).get().id, true);
    const t = getTriage(db, { today: TODAY, now });
    expect(t.makeUps).toEqual([]);
    expect(t.makeUpsIgnored).toBe(1); // past-due only (q3 isn't due yet)
    expect(t.makeUpsUnchecked).toBe(1);
    expect(setMakeUpIgnored(db, quiz, false)).toMatchObject({ ignored: false });
    expect(getTriage(db, { today: TODAY, now }).makeUps).toHaveLength(1);
  });

  test('only a Schoology test in a current course; ignored must be a boolean', () => {
    const quiz = testItem('q1', 'Quiz', '2026-10-15');
    const essay = assignment('a1', 'Essay', '2026-10-15');
    const code = (...args) => { try { setMakeUpIgnored(db, ...args); } catch (err) { expect(err).toBeInstanceOf(TriageError); return err.code; } return 'OK'; };
    expect(code(9999, true)).toBe('NOT_FOUND');
    expect(code(essay, true)).toBe('NOT_ELIGIBLE');
    expect(code(quiz, 'yes')).toBe('BAD_VALUE');
    expect(code(quiz, true)).toBe('OK');
    db.prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
    expect(code(quiz, false)).toBe('NOT_ELIGIBLE');
  });
});

describe('getTriage — lastSyncAt', () => {
  test('is the newest completed sync, ignoring running and failed ones', () => {
    const log = db.prepare(`INSERT INTO sync_log (sync_type, status, started_at, completed_at) VALUES (?, ?, ?, ?)`);
    log.run('full', 'completed', '2026-10-15T01:00:00Z', '2026-10-15T01:20:00Z');
    log.run('mastery', 'completed', '2026-10-15T01:05:00Z', '2026-10-15T01:06:00Z');
    log.run('full', 'error', '2026-10-16T01:00:00Z', '2026-10-16T01:02:00Z');
    log.run('full', 'running', '2026-10-16T02:00:00Z', null);
    expect(getTriage(db, { today: TODAY }).lastSyncAt).toBe('2026-10-15T01:20:00Z');
  });

  test('null when no sync has completed', () => {
    db.prepare(`INSERT INTO sync_log (sync_type, status, started_at) VALUES ('full', 'running', '2026-10-16T02:00:00Z')`).run();
    expect(getTriage(db, { today: TODAY }).lastSyncAt).toBeNull();
  });
});

describe('referrals', () => {
  function atLimit() {
    const a = student('u1', 'Maya', 'Chen');
    const id = assignment('a1', 'CP2', '2026-10-05');
    return { studentId: a, assignmentId: id };
  }

  test('record → leaves the late list, appears in history; undo → back', () => {
    const pair = atLimit();
    const r = recordReferral(db, { ...pair, action: 'referred', today: TODAY });
    expect(r).toMatchObject({ action: 'referred', daysLate: 9, studentName: 'Maya Chen', title: 'CP2', source: 'app' });
    const t = getTriage(db, { today: TODAY });
    expect(t.lateWork).toEqual([]);
    expect(t.historyCount).toBe(1);
    expect(listReferrals(db, {})).toHaveLength(1);
    expect(undoReferral(db, r.id)).toEqual({ deleted: true });
    expect(getTriage(db, { today: TODAY }).lateWork).toHaveLength(1);
  });

  test('a referral keeps its note and source', () => {
    const pair = atLimit();
    const r = recordReferral(db, { ...pair, action: 'referred', note: 'emailed AO', source: 'mcp', today: TODAY });
    expect(r).toMatchObject({ action: 'referred', note: 'emailed AO', source: 'mcp' });
  });

  test("'exempt' is no longer an action (extensions replace it)", () => {
    const pair = atLimit();
    expect(() => recordReferral(db, { ...pair, action: 'exempt', today: TODAY }))
      .toThrow(expect.objectContaining({ code: 'BAD_ACTION' }));
  });

  test('rejects a bad action, an unknown assignment, and a pair not on the list', () => {
    const pair = atLimit();
    expect(() => recordReferral(db, { ...pair, action: 'nope', today: TODAY })).toThrow(TriageError);
    expect(() => recordReferral(db, { ...pair, assignmentId: 9999, action: 'referred', today: TODAY }))
      .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    const future = assignment('a9', 'Not due', '2026-10-30');
    expect(() => recordReferral(db, { studentId: pair.studentId, assignmentId: future, action: 'referred', today: TODAY }))
      .toThrow(expect.objectContaining({ code: 'NOT_ON_LIST' }));
  });

  test('rejects a missing studentId', () => {
    const pair = atLimit();
    expect(() => recordReferral(db, { ...pair, studentId: 9999, action: 'referred', today: TODAY }))
      .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  test("'referred' only at the limit (red)", () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Essay', '2026-10-12'); // 4 school days → green
    expect(() => recordReferral(db, { studentId: a, assignmentId: id, action: 'referred', today: TODAY }))
      .toThrow(expect.objectContaining({ code: 'NOT_AT_LIMIT' }));
  });

  test('referral rows carry blockNumber; studentId filter', () => {
    db.prepare(`UPDATE courses SET block_number = '7' WHERE id = ?`).run(courseId);
    const pair = atLimit();
    const other = student('u2', 'Bo', 'M');
    recordReferral(db, { ...pair, action: 'referred', today: TODAY });
    recordReferral(db, { studentId: other, assignmentId: pair.assignmentId, action: 'referred', today: TODAY });
    expect(listReferrals(db, {})[0]).toMatchObject({ blockNumber: '7' });
    expect(listReferrals(db, { studentId: other }).map((r) => r.studentName)).toEqual(['Bo M']);
  });

  test('since (local date) includes a referral created today', () => {
    const pair = atLimit();
    recordReferral(db, { ...pair, action: 'referred', today: TODAY });
    expect(listReferrals(db, { since: todayLocal() })).toHaveLength(1);
  });
});

describe('extensions (extend by N lessons = school days)', () => {
  test('hides the student until the extended date passes, then counts late from it', () => {
    const maya = student('u1', 'Maya', 'Chen');
    const id = assignment('a1', 'CP2', '2026-10-05'); // 9 school days late → red
    const e = recordExtension(db, { studentId: maya, assignmentId: id, lessons: 3, note: 'sick week' });
    // 06, 07, 08/10 → until Thu 08/10; 09, 12–16/10 = 6 school days late → amber.
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([expect.objectContaining({
      kind: 'outstanding', dueDate: '2026-10-05', daysLate: 6, tone: 'amber',
      extension: { id: e.id, lessons: 3, until: '2026-10-08', note: 'sick week' },
    })]);
    expect(getTriage(db, { today: '2026-10-08' }).lateWork).toEqual([]); // the extended date itself
    recordExtension(db, { studentId: maya, assignmentId: id, lessons: 9 }); // until 16/10 = today
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('crosses the 01/10–02/10 holidays in school days', () => {
    const maya = student('u1', 'Maya', 'Chen');
    const id = assignment('a1', 'CP2', '2026-09-29'); // Tue
    expect(recordExtension(db, { studentId: maya, assignmentId: id, lessons: 2 })).toMatchObject({ until: '2026-10-05' });
  });

  test('submitted_late is measured from the extended date', () => {
    const a = student('u1', 'Ada', 'L');
    // Due Mon 21/09 (day 1), first submitted Mon 05/10 = day 9 → red without the extension.
    const id = assignment('a1', 'Essay', '2026-09-21');
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05'), latest_revision_at: epoch('2026-10-05'), late: 1 });
    expect(getTriage(db, { today: TODAY }).lateWork[0]).toMatchObject({ kind: 'submitted_late', daysLate: 8, extension: null });
    recordExtension(db, { studentId: a, assignmentId: id, lessons: 1 }); // until 22/09 → day 8
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
  });

  test('feedback wait still starts at max(due, first submitted)', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Model Card', '2026-10-05');
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-02') });
    recordExtension(db, { studentId: a, assignmentId: id, lessons: 3 });
    expect(getTriage(db, { today: TODAY }).feedbackOwed[0]).toMatchObject({ oldestWaitDays: 9 });
  });

  test('only the extended student moves', () => {
    const a = student('u1', 'Ada', 'L');
    student('u2', 'Bo', 'M');
    const id = assignment('a1', 'Essay', '2026-10-05');
    recordExtension(db, { studentId: a, assignmentId: id, lessons: 20 });
    expect(getTriage(db, { today: TODAY }).lateWork.map((r) => [r.studentName, r.daysLate])).toEqual([['Bo M', 9]]);
  });

  test('can be granted before the due date; returns the stored row with names and until', () => {
    db.prepare(`UPDATE courses SET block_number = '7' WHERE id = ?`).run(courseId);
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Future', '2026-10-20'); // Tue
    expect(recordExtension(db, { studentId: a, assignmentId: id, lessons: 3, note: 'trip', source: 'mcp' })).toMatchObject({
      studentId: a, studentName: 'Ada L', assignmentId: id, title: 'Future', courseId, courseName: 'AP CSP', blockNumber: '7',
      dueDate: '2026-10-20', lessons: 3, note: 'trip', source: 'mcp', until: '2026-10-23',
    });
  });

  test('re-extending stamps updated_at and overwrites source; since/order use the latest time', () => {
    const a = student('u1', 'Ada', 'L');
    const b = student('u2', 'Bo', 'M');
    const id = assignment('a1', 'Essay', '2026-10-05');
    const first = recordExtension(db, { studentId: a, assignmentId: id, lessons: 2 });
    expect(first.updatedAt).toBeNull();
    recordExtension(db, { studentId: b, assignmentId: id, lessons: 2 });
    db.prepare(`UPDATE extensions SET created_at = '2026-01-05 01:00:00'`).run(); // both granted long ago
    const again = recordExtension(db, { studentId: a, assignmentId: id, lessons: 4, source: 'mcp' });
    expect(again).toMatchObject({ id: first.id, lessons: 4, source: 'mcp', createdAt: '2026-01-05 01:00:00' });
    expect(again.updatedAt).toEqual(expect.any(String));
    expect(listExtensions(db, { since: todayLocal() }).map((x) => x.studentName)).toEqual(['Ada L']);
    expect(listExtensions(db, {}).map((x) => x.studentName)).toEqual(['Ada L', 'Bo M']); // re-extended first
  });

  test('re-extending the same pair replaces lessons and note (one row)', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Essay', '2026-10-05');
    const first = recordExtension(db, { studentId: a, assignmentId: id, lessons: 2, note: 'one' });
    const second = recordExtension(db, { studentId: a, assignmentId: id, lessons: 5 });
    expect(second).toMatchObject({ id: first.id, lessons: 5, note: null, until: '2026-10-12' });
    expect(listExtensions(db, {})).toHaveLength(1);
  });

  test('validation: lessons 1–60 integer, known student/assignment, summative, current course, targets the student', () => {
    const a = student('u1', 'Ada', 'L');
    const dropped = student('u2', 'Bo', 'M', { dropped: true });
    const other = student('u3', 'Cy', 'N');
    const id = assignment('a1', 'Essay', '2026-10-05');
    const code = (args) => {
      try { recordExtension(db, args); } catch (err) { expect(err).toBeInstanceOf(TriageError); return err.code; }
      return 'OK';
    };
    for (const lessons of [0, 61, 2.5, 'x', null]) expect(code({ studentId: a, assignmentId: id, lessons })).toBe('BAD_LESSONS');
    expect(code({ studentId: 9999, assignmentId: id, lessons: 3 })).toBe('NOT_FOUND');
    expect(code({ studentId: a, assignmentId: 9999, lessons: 3 })).toBe('NOT_FOUND');
    expect(code({ studentId: a, assignmentId: assignment('f1', 'Practice', '2026-10-05', { summative: false }), lessons: 3 })).toBe('NOT_ELIGIBLE');
    expect(code({ studentId: dropped, assignmentId: id, lessons: 3 })).toBe('NOT_ELIGIBLE');
    expect(code({ studentId: other, assignmentId: assignment('a2', 'Copy', '2026-10-05', { assignees: ['u1'] }), lessons: 3 })).toBe('NOT_ELIGIBLE');
    const undated = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'a3', 'Undated', 1)`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('a3', 'topic-a1', ?)`).run(courseId);
    expect(code({ studentId: a, assignmentId: undated, lessons: 3 })).toBe('NOT_ELIGIBLE');
    expect(code({ studentId: a, assignmentId: id, lessons: 60 })).toBe('OK');
    db.prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
    expect(code({ studentId: a, assignmentId: id, lessons: 3 })).toBe('NOT_ELIGIBLE');
  });

  test('undo puts the pair back on the list', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Essay', '2026-10-05');
    const e = recordExtension(db, { studentId: a, assignmentId: id, lessons: 20 });
    expect(getTriage(db, { today: TODAY }).lateWork).toEqual([]);
    expect(undoExtension(db, e.id)).toEqual({ deleted: true });
    expect(undoExtension(db, e.id)).toEqual({ deleted: false });
    expect(getTriage(db, { today: TODAY }).lateWork).toHaveLength(1);
  });

  test('an extended pair can still be referred once red again (days counted from the extended date)', () => {
    const a = student('u1', 'Ada', 'L');
    const id = assignment('a1', 'Essay', '2026-09-21');
    recordExtension(db, { studentId: a, assignmentId: id, lessons: 1 }); // until 22/09 → 16 school days late
    expect(recordReferral(db, { studentId: a, assignmentId: id, action: 'referred', today: TODAY })).toMatchObject({ daysLate: 16 });
  });

  test('historyCount = referrals + extensions in scope; listExtensions filters', () => {
    const a = student('u1', 'Ada', 'L');
    const b = student('u2', 'Bo', 'M');
    const id = assignment('a1', 'Essay', '2026-10-05');
    recordReferral(db, { studentId: a, assignmentId: id, action: 'referred', today: TODAY });
    const e = recordExtension(db, { studentId: b, assignmentId: id, lessons: 2 });
    expect(getTriage(db, { today: TODAY }).historyCount).toBe(2);
    const other = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-2', 'AIML')`).run().lastInsertRowid;
    expect(getTriage(db, { today: TODAY, courseId: other }).historyCount).toBe(0);
    expect(listExtensions(db, { courseId }).map((r) => r.id)).toEqual([e.id]);
    expect(listExtensions(db, { courseId: other })).toEqual([]);
    expect(listExtensions(db, { studentId: a })).toEqual([]);
    expect(listExtensions(db, { id: e.id })[0]).toMatchObject({ studentName: 'Bo M' });
    expect(listExtensions(db, { since: todayLocal() })).toHaveLength(1);
  });
});

// Teacher's policy (2026-10-02): the due date is day 1; work may be submitted
// through day 8; still missing (or submitted) on day 9 = referral. Display-only:
// `day` = school days since + 1; thresholds and tones are unchanged.
describe('day numbering (the due / test date is day 1)', () => {
  const DUE = '2026-10-05'; // Mon = day 1
  const DAY8 = '2026-10-14'; // 06–09/10 + 12–14/10 = 7 school days after
  const DAY9 = '2026-10-15';

  test('outstanding: day 8 is the last allowed day (amber, no referral); day 9 is red and referable', () => {
    const maya = student('u1', 'Maya', 'Chen');
    const id = assignment('a1', 'CP2', DUE);
    expect(getTriage(db, { today: DUE }).lateWork).toEqual([]); // day 1: not late
    expect(getTriage(db, { today: '2026-10-06' }).lateWork[0]).toMatchObject({ day: 2, daysLate: 1, tone: 'green' });
    expect(getTriage(db, { today: DAY8 }).lateWork[0]).toMatchObject({ kind: 'outstanding', day: 8, daysLate: 7, tone: 'amber' });
    expect(() => recordReferral(db, { studentId: maya, assignmentId: id, action: 'referred', today: DAY8 }))
      .toThrow(expect.objectContaining({ code: 'NOT_AT_LIMIT', message: expect.stringMatching(/day 8.*after day 8/) }));
    expect(getTriage(db, { today: DAY9 }).lateWork[0]).toMatchObject({ kind: 'outstanding', day: 9, daysLate: 8, tone: 'red' });
    expect(recordReferral(db, { studentId: maya, assignmentId: id, action: 'referred', today: DAY9 }))
      .toMatchObject({ action: 'referred', daysLate: 8, day: 9 });
  });

  test('a submission on day 8 is not flagged; on day 9 it is submitted_late, submittedDay 9', () => {
    const ada = student('u1', 'Ada', 'L');
    const bo = student('u2', 'Bo', 'M');
    const id = assignment('a1', 'Essay', DUE);
    grade(ada, id, { submission_type: 'drop', first_submitted_at: epoch(DAY8), latest_revision_at: epoch(DAY8), late: 1 });
    grade(bo, id, { submission_type: 'drop', first_submitted_at: epoch(DAY9), latest_revision_at: epoch(DAY9), late: 1 });
    const rows = getTriage(db, { today: TODAY }).lateWork;
    expect(rows.map((r) => r.studentName)).toEqual(['Bo M']);
    expect(rows[0]).toMatchObject({ kind: 'submitted_late', submittedOn: DAY9, submittedDay: 9, daysLate: 8, tone: 'red' });
    expect(rows[0].day).toBe(9); // a submitted_late clock stops at the submission (day = daysLate + 1)
  });

  test('an extension makes the extended date day 1', () => {
    const maya = student('u1', 'Maya', 'Chen');
    const id = assignment('a1', 'CP2', DUE);
    recordExtension(db, { studentId: maya, assignmentId: id, lessons: 3 }); // until Thu 08/10 = day 1
    expect(getTriage(db, { today: '2026-10-08' }).lateWork).toEqual([]);
    expect(getTriage(db, { today: TODAY }).lateWork[0]).toMatchObject({ day: 7, daysLate: 6, tone: 'amber' });
  });

  test('feedback owed: day 10 is amber (last day), day 11 is red', () => {
    student('u1', 'Ada', 'L');
    assignment('t1', 'Paper test', DUE, { accepts: 0 });
    expect(getTriage(db, { today: '2026-10-06' }).feedbackOwed[0]).toMatchObject({ day: 2, oldestWaitDays: 1, tone: 'green' });
    expect(getTriage(db, { today: TODAY }).feedbackOwed[0]).toMatchObject({ day: 10, oldestWaitDays: 9, tone: 'amber' });
    expect(getTriage(db, { today: '2026-10-19' }).feedbackOwed[0]).toMatchObject({ day: 11, oldestWaitDays: 10, tone: 'red' });
  });

  test('make-ups: the test day is day 1 (green), day 2 amber, day 4 red', () => {
    const ada = student('u1', 'Ada', 'L');
    missed(ada, testItem('t1', 'Unit 1 test', '2026-10-13')); // Tue
    const at = (today) => getTriage(db, { today, now: `${today} 16:00:00` }).makeUps[0];
    expect(at('2026-10-13')).toMatchObject({ day: 1, daysSince: 0, tone: 'green' });
    expect(at('2026-10-14')).toMatchObject({ day: 2, daysSince: 1, tone: 'amber' });
    expect(at('2026-10-15')).toMatchObject({ day: 3, tone: 'amber' });
    expect(at('2026-10-16')).toMatchObject({ day: 4, daysSince: 3, tone: 'red' });
  });
});

describe('resubmissions list', () => {
  const sqlAt = (iso) => `${iso} 04:00:00`;
  test('waiting: day 1 = ask day, red after the lessons deadline', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'CP1', '2026-09-21');
    grade(s, a, { score: 60, submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-09-21') });
    requestResubmission(db, { studentId: s, assignmentId: a, lessons: 3, requestedAt: sqlAt('2026-10-09') }); // Fri
    const t = getTriage(db, { today: TODAY }); // Fri 16/10: Mon 12 … Fri 16 = 5 school days after the ask
    expect(t.resubmissions).toHaveLength(1);
    expect(t.resubmissions[0]).toMatchObject({ state: 'waiting', day: 6, limit: 4, tone: 'red', until: '2026-10-14', requestedOn: '2026-10-09', lessons: 3 });
    expect(t.counts.resubmissionsOverdue).toBe(1);
  });
  test('arrived (unrequested, summative): clock from the resubmission date, feedback limit', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'CP1', '2026-09-21');
    grade(s, a, { score: 60, submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-10-14') });
    expect(getTriage(db, { today: TODAY }).resubmissions).toEqual([]); // no snapshot yet — readers never write
    captureFeedbackSnapshots(db);
    const r = getTriage(db, { today: TODAY }).resubmissions[0];
    expect(r).toMatchObject({ state: 'arrived', id: null, arrivedOn: '2026-10-14', day: 3, limit: 10, tone: 'green', afterDeadline: false });
  });
  test('arrived after a red deadline is tagged afterDeadline; arrived sorts before waiting', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong'); const a = assignment('a1', 'CP1', '2026-09-21');
    grade(s, a, { score: 60, submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-10-15') });
    requestResubmission(db, { studentId: s, assignmentId: a, lessons: 1, requestedAt: sqlAt('2026-10-09') });
    requestResubmission(db, { studentId: s2, assignmentId: a, lessons: 3, requestedAt: sqlAt('2026-10-09') });
    captureFeedbackSnapshots(db);
    const rows = getTriage(db, { today: TODAY }).resubmissions;
    expect(rows.map((r) => [r.studentName, r.state])).toEqual([['Maya Chen', 'arrived'], ['Ethan Wong', 'waiting']]);
    expect(rows[0].afterDeadline).toBe(true);
  });
  test('formative: unrequested arrivals only with includeFormative; asks always', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong');
    const f = assignment('f1', 'Warm-up', '2026-09-21', { summative: false });
    grade(s, f, { score: null, grade_comment: 'try again', comment_status: 1, submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-10-14') });
    requestResubmission(db, { studentId: s2, assignmentId: f, requestedAt: sqlAt('2026-10-15') });
    captureFeedbackSnapshots(db);
    expect(getTriage(db, { today: TODAY, includeFormative: false }).resubmissions.map((r) => r.studentName)).toEqual(['Ethan Wong']);
    expect(getTriage(db, { today: TODAY, includeFormative: true }).resubmissions).toHaveLength(2);
  });
  test('requested arrival on ungraded work clears when visible feedback is given', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'CP1', '2026-09-21');
    const req = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sqlAt('2026-10-09') }); // ungraded work
    grade(s, a, { latest_revision_at: epoch('2026-10-14') });                                              // arrival
    captureFeedbackSnapshots(db);
    expect(getTriage(db, { today: TODAY }).resubmissions).toMatchObject([{ state: 'arrived', id: req.id, arrivedOn: '2026-10-14' }]);
    db.prepare(`UPDATE grades SET grade_comment = 'Hidden draft', comment_status = NULL, submitted_at = ?`).run(epoch('2026-10-15')); // a teacher write, hidden
    expect(getTriage(db, { today: TODAY }).resubmissions).toMatchObject([{ state: 'arrived', id: req.id }]);
    db.prepare(`UPDATE grades SET comment_status = 1`).run();
    expect(getTriage(db, { today: TODAY }).resubmissions).toEqual([]);
  });
  test('answered (regraded) / grade-stands / excused rows do not show', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong'); const s3 = student('u3', 'Zoe', 'Tan');
    const a = assignment('a1', 'CP1', '2026-09-21');
    grade(s, a, { score: 60, submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-10-14') });
    const r2 = requestResubmission(db, { studentId: s2, assignmentId: a, lessons: 1, requestedAt: sqlAt('2026-10-12') });
    gradeStands(db, r2.id, { today: TODAY });
    grade(s3, a, { score: null, exception: 1, submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-10-14') });
    captureFeedbackSnapshots(db);
    expect(getTriage(db, { today: TODAY }).resubmissions.map((r) => r.studentId)).toEqual([s]);
    db.prepare('UPDATE grades SET score = 80, submitted_at = ? WHERE student_id = ?').run(epoch('2026-10-15'), s); // regraded
    const t = getTriage(db, { today: TODAY });
    expect(t.resubmissions).toEqual([]);
    expect(t.resubmissionHistoryCount).toBe(1);
  });
  test('Review Focus 5: a dropped student or an archived course drops the row; history keeps it', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'CP1', '2026-09-21');
    requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sqlAt('2026-10-12') });
    db.prepare(`UPDATE enrolments SET dropped_at = '2026-10-13' WHERE student_id = ?`).run(s);
    expect(getTriage(db, { today: TODAY }).resubmissions).toEqual([]);
    db.prepare(`UPDATE enrolments SET dropped_at = NULL`).run();
    db.prepare(`UPDATE courses SET archived = 1`).run();
    expect(getTriage(db, { today: TODAY }).resubmissions).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM resubmissions').get().n).toBe(1);
  });
  test('studentId filter', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong'); const a = assignment('a1', 'CP1', '2026-09-21');
    requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sqlAt('2026-10-12') });
    requestResubmission(db, { studentId: s2, assignmentId: a, requestedAt: sqlAt('2026-10-12') });
    expect(getTriage(db, { today: TODAY, studentId: s2 }).resubmissions.map((r) => r.studentId)).toEqual([s2]);
  });
});
