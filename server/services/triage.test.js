import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { addDays, isWeekday, todayLocal } from '../lib/schoolDays.js';
import { storeSchoolDays } from './schoolCalendar.js';
import { updateTriageSettings } from './settings.js';
import { getTriage, recordReferral, undoReferral, listReferrals, toneFor, TriageError } from './triage.js';

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

beforeEach(() => {
  db = getDb();
  db.exec(
    'DELETE FROM referrals; DELETE FROM settings; DELETE FROM school_days; DELETE FROM mastery_scores; DELETE FROM mastery_alignments; ' +
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
    grade(a, id, { submission_type: 'drop', first_submitted_at: epoch('2026-10-05'), latest_revision_at: epoch('2026-10-05') });
    const row = getTriage(db, { today: TODAY }).lateWork[0];
    expect(row).toMatchObject({ kind: 'submitted_late', daysLate: 8, submittedOn: '2026-10-05', tone: 'red' });
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
    expect(t.referralCount).toBe(1);
    expect(listReferrals(db, {})).toHaveLength(1);
    expect(undoReferral(db, r.id)).toEqual({ deleted: true });
    expect(getTriage(db, { today: TODAY }).lateWork).toHaveLength(1);
  });

  test('exempt keeps its note and source', () => {
    const pair = atLimit();
    const r = recordReferral(db, { ...pair, action: 'exempt', note: 'agreed extension', source: 'mcp', today: TODAY });
    expect(r).toMatchObject({ action: 'exempt', note: 'agreed extension', source: 'mcp' });
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

  test('since (local date) includes a referral created today', () => {
    const pair = atLimit();
    recordReferral(db, { ...pair, action: 'referred', today: TODAY });
    expect(listReferrals(db, { since: todayLocal() })).toHaveLength(1);
  });
});
