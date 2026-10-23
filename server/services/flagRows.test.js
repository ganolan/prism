import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { addDays, isWeekday } from '../lib/schoolDays.js';
import { storeSchoolDays, loadCalendar } from './schoolCalendar.js';
import { getTriage } from './triage.js';
import { flagTone, FLAG_ADVICE } from './flagRows.js';

// #174: Triage's Flags panel (docs/superpowers/specs/2026-10-23-triage-flags-panel-design.md).
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


// The course's PowerSchool term (Task 2): semester 1 ends 18/12/2026.
const term = (start = '2026-08-20', end = '2026-12-18') =>
  db.prepare('UPDATE courses SET term_start = ?, term_end = ? WHERE id = ?').run(start, end, courseId);
const flagged = (studentId, assignmentId, code, on, cols = {}) =>
  grade(studentId, assignmentId, { exception: code, submitted_at: epoch(on), ...cols });
const flags = (opts = {}) => getTriage(db, { today: TODAY, ...opts }).flags;

describe('Flags panel rows', () => {
  beforeEach(() => term());

  test('Late, Incomplete and Absent each give a row with their advice, counted from the flag date', () => {
    const ada = student('u1', 'Ada', 'Lovelace');
    const late = assignment('a1', 'Essay', '2026-10-05');
    const inc = assignment('a2', 'Lab', '2026-10-06');
    const abs = assignment('a3', 'Quiz', '2026-10-07');
    flagged(ada, late, 6, '2026-10-12');
    flagged(ada, inc, 2, '2026-10-12');
    flagged(ada, abs, 5, '2026-10-12');
    const rows = flags();
    expect(rows.map((r) => [r.title, r.flag, r.advice])).toEqual(expect.arrayContaining([
      ['Essay', 6, 'Grade the work, or mark it Missing if it is too late to count.'],
      ['Lab', 2, 'Set a date to finish, then grade it.'],
      ['Quiz', 5, 'Arrange a make-up, or mark it Exempt if the absence is excused.'],
    ]));
    expect(rows).toHaveLength(3);
    const essay = rows.find((r) => r.title === 'Essay');
    expect(essay).toMatchObject({
      kind: 'flag', studentId: ada, studentName: 'Ada Lovelace', firstName: 'Ada', courseId, courseName: 'AP CSP',
      assignmentId: late, schoologyAssignmentId: 'a1', dueDate: '2026-10-05', aligned: true, exception: 6,
      flagSeenOn: '2026-10-12', day: 5, submittedAfter: false, semesterEnd: '2026-12-18', tone: 'green',
    });
  });

  test('Exempt never gives a row', () => {
    const ada = student('u1', 'Ada', 'Lovelace');
    flagged(ada, assignment('a1', 'Essay', '2026-10-05'), 1, '2026-10-12');
    expect(flags()).toEqual([]);
  });

  test('Missing gives a row only when the student submitted after the flag', () => {
    const ada = student('u1', 'Ada', 'Lovelace');
    const bo = student('u2', 'Bo', 'Kim');
    const a = assignment('a1', 'Essay', '2026-10-05');
    flagged(ada, a, 3, '2026-10-12', { submission_type: 'drop', latest_revision_at: epoch('2026-10-09') });
    flagged(bo, a, 3, '2026-10-12', { submission_type: 'drop', latest_revision_at: epoch('2026-10-14') });
    const rows = flags();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ studentId: bo, flag: 3, submittedAfter: true, advice: 'Clear the flag and grade the work.' });
  });

  test('Late with a later submission is marked submittedAfter', () => {
    const ada = student('u1', 'Ada', 'Lovelace');
    flagged(ada, assignment('a1', 'Essay', '2026-10-05'), 6, '2026-10-12', { submission_type: 'drop', latest_revision_at: epoch('2026-10-14') });
    expect(flags()[0]).toMatchObject({ flag: 6, submittedAfter: true });
  });

  test('a cleared flag whose saved grade is waiting gives a saved_grade row, counted from saved_at', () => {
    const ada = student('u1', 'Ada', 'Lovelace');
    const bo = student('u2', 'Bo', 'Kim');
    const cy = student('u3', 'Cy', 'Ng');
    const a = assignment('a1', 'Essay', '2026-10-05');
    const save = (sid, restoredAt = null) => db.prepare(
      `INSERT INTO excused_grades (student_id, assignment_id, flag, saved_json, saved_at, restored_at) VALUES (?, ?, 6, '{}', '2026-10-08 02:00:00', ?)`,
    ).run(sid, a, restoredAt);
    grade(ada, a, { exception: 0 });
    save(ada);
    grade(bo, a, { exception: 0 });
    save(bo, '2026-10-09 02:00:00');
    flagged(cy, a, 6, '2026-10-12');
    save(cy);
    const rows = flags();
    expect(rows.map((r) => [r.studentId, r.kind])).toEqual(expect.arrayContaining([[ada, 'saved_grade'], [cy, 'flag']]));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.studentId === ada)).toMatchObject({
      flag: 0, exception: 0, flagSeenOn: '2026-10-08', day: 7, advice: 'Restore the saved grade, or publish a new one.',
    });
  });

  test('the semester is the one that contains the due date; an ended one stays red', () => {
    term('2026-08-20', '2026-12-18');
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived, term_start, term_end) VALUES ('sec-2', 'S2', 1, '2027-01-11', '2027-06-10')`).run();
    const ada = student('u1', 'Ada', 'Lovelace');
    flagged(ada, assignment('a1', 'Essay', '2026-10-05'), 6, '2026-10-12');
    const [row] = flags({ today: '2027-01-20' });
    expect(row).toMatchObject({ semesterEnd: '2026-12-18', tone: 'red' });
  });

  test('a task with no due date takes the semester of the flag date', () => {
    const ada = student('u1', 'Ada', 'Lovelace');
    const a = assignment('a1', 'Essay', '2026-10-05');
    db.prepare('UPDATE assignments SET due_date = NULL WHERE id = ?').run(a);
    flagged(ada, a, 6, '2026-10-12');
    expect(flags()[0]).toMatchObject({ dueDate: null, semesterEnd: '2026-12-18' });
  });

  test('no stored term → no semester end, green, and the ring limit is the day', () => {
    db.exec('UPDATE courses SET term_start = NULL, term_end = NULL');
    const ada = student('u1', 'Ada', 'Lovelace');
    flagged(ada, assignment('a1', 'Essay', '2026-10-05'), 6, '2026-10-12');
    expect(flags()[0]).toMatchObject({ semesterEnd: null, tone: 'green', day: 5, limit: 5 });
  });

  test('the ring limit is the semester end as a day number from the flag date', () => {
    term('2026-08-20', '2026-10-30');
    const ada = student('u1', 'Ada', 'Lovelace');
    flagged(ada, assignment('a1', 'Essay', '2026-10-05'), 6, '2026-10-12');
    // 13/10 to 30/10: 14 school days after the flag date → day 15.
    expect(flags()[0]).toMatchObject({ day: 5, limit: 15 });
  });

  test('a student the task is not assigned to, a dropped student, and an unpublished task give no row', () => {
    const ada = student('u1', 'Ada', 'Lovelace');
    const gone = student('u2', 'Bo', 'Kim', { dropped: true });
    const onlyCy = assignment('a1', 'Essay', '2026-10-05', { assignees: ['u3'] });
    flagged(ada, onlyCy, 6, '2026-10-12');
    flagged(gone, assignment('a2', 'Lab', '2026-10-05'), 6, '2026-10-12');
    const hidden = assignment('a3', 'Draft', '2026-10-05');
    db.prepare('UPDATE assignments SET published = 0 WHERE id = ?').run(hidden);
    flagged(ada, hidden, 6, '2026-10-12');
    expect(flags()).toEqual([]);
  });

  test('formative work gives a row only with includeFormative', () => {
    const ada = student('u1', 'Ada', 'Lovelace');
    flagged(ada, assignment('a1', 'Warm-up', '2026-10-05', { summative: false }), 6, '2026-10-12');
    expect(flags({ includeFormative: false })).toEqual([]);
    expect(flags({ includeFormative: true })).toHaveLength(1);
  });

  test('a studentId view lists only that student', () => {
    const ada = student('u1', 'Ada', 'Lovelace');
    const bo = student('u2', 'Bo', 'Kim');
    const a = assignment('a1', 'Essay', '2026-10-05');
    flagged(ada, a, 6, '2026-10-12');
    flagged(bo, a, 6, '2026-10-12');
    expect(getTriage(db, { today: TODAY, studentId: bo }).flags.map((r) => r.studentId)).toEqual([bo]);
  });

  test('rows sort red first, then the longest wait, then name; counts.flagsOverdue counts red', () => {
    term('2026-08-20', '2026-10-20');
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name, term_start, term_end) VALUES ('sec-x', 'X', '2026-10-21', '2026-12-18')`).run();
    const ada = student('u1', 'Ada', 'Lovelace');
    const bo = student('u2', 'Bo', 'Kim');
    const early = assignment('a1', 'Essay', '2026-10-05');   // semester ends 20/10: red
    const later = assignment('a2', 'Lab', '2026-10-26');     // due later: semester ends 18/12, green
    flagged(ada, early, 6, '2026-10-14');
    flagged(bo, early, 6, '2026-10-12');
    flagged(ada, later, 2, '2026-09-01');
    const t = getTriage(db, { today: TODAY });
    expect(t.flags.map((r) => [r.studentName, r.title, r.tone])).toEqual([
      ['Bo Kim', 'Essay', 'red'],
      ['Ada Lovelace', 'Essay', 'red'],
      ['Ada Lovelace', 'Lab', 'green'],
    ]);
    expect(t.counts.flagsOverdue).toBe(2);
  });

  test('flagged work keeps its Make-ups and Feedback owed rows (Graham, 23 October 2026)', () => {
    const ada = student('u1', 'Ada', 'Lovelace');
    const quiz = testItem('t1', 'Unit test', '2026-10-12');
    missed(ada, quiz, { exception: 5, submitted_at: epoch('2026-10-13') });
    const essay = assignment('a1', 'Essay', '2026-10-05');
    flagged(ada, essay, 6, '2026-10-12', { submission_type: 'drop', latest_revision_at: epoch('2026-10-05'), first_submitted_at: epoch('2026-10-05') });
    const t = getTriage(db, { today: TODAY, now: AFTER_SCHOOL });
    expect(t.makeUps.map((r) => r.assignmentId)).toEqual([quiz]);
    expect(t.feedbackOwed.find((r) => r.assignmentId === essay)).toMatchObject({ owed: 1 });
    expect(t.flags.map((r) => r.assignmentId).sort()).toEqual([quiz, essay].sort());
  });
});

describe('flagTone', () => {
  // School days from today to the end, both counted: green over 10, amber over the last 10, red over
  // the last 5 and after the end. Calendar weekdays 01/09 to 30/10 (01/10, 02/10 off).
  const cal = () => loadCalendar(db);
  test('follows the semester end', () => {
    const end = '2026-10-30';
    expect(flagTone(cal(), '2026-10-16', end)).toBe('green'); // 11 left
    expect(flagTone(cal(), '2026-10-19', end)).toBe('amber'); // 10 left
    expect(flagTone(cal(), '2026-10-23', end)).toBe('amber'); // 6 left
    expect(flagTone(cal(), '2026-10-26', end)).toBe('red');   // 5 left
    expect(flagTone(cal(), '2026-10-30', end)).toBe('red');   // the last day
    expect(flagTone(cal(), '2026-11-02', end)).toBe('red');   // after the end
  });
  test('no semester end → green', () => {
    expect(flagTone(cal(), '2026-10-16', null)).toBe('green');
  });
  test('advice copy', () => {
    expect(Object.keys(FLAG_ADVICE).sort()).toEqual(['2', '3', '5', '6', 'saved_grade']);
  });
});
