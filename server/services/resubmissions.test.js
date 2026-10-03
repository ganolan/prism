import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { addDays, isWeekday } from '../lib/schoolDays.js';
import { storeSchoolDays } from './schoolCalendar.js';
import { TriageError } from './triageCommon.js';
import {
  requestResubmission, extendResubmission, closeResubmission, markResubmissionReviewed, undoResubmission,
  listResubmissions, settleResubmissions, resubmissionByStudent, openRequestKeys, recordSchoologyUnsubmit,
} from './resubmissions.js';

const at = (iso) => Date.parse(`${iso}T04:00:00Z`) / 1000; // noon HKT
const sql = (iso) => `${iso} 04:00:00`;                     // same instant as SQLite UTC text

let db, courseId;
function seedCalendar() {
  const days = [];
  for (let d = '2026-09-01'; d <= '2026-10-30'; d = addDays(d, 1)) days.push({ date: d, inSession: isWeekday(d), cycleLetter: null, raw: '{}' });
  storeSchoolDays(db, days, '2026-10-01T00:00:00Z');
}
function student(uid, first, last) {
  const id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, ?)`).run(uid, first, last).lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(id, courseId);
  return id;
}
function assignment(sid, title) {
  return db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, published) VALUES (?, ?, ?, '2026-10-05 15:30:00', 1)`)
    .run(courseId, sid, title).lastInsertRowid;
}
function grade(studentId, assignmentId, cols) {
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
    .run(studentId, assignmentId, ...keys.map((k) => cols[k]));
}

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM resubmissions; DELETE FROM settings; DELETE FROM school_days; DELETE FROM grades; DELETE FROM assignment_assignees; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AIML')`).run().lastInsertRowid;
  seedCalendar();
});

describe('requestResubmission', () => {
  test('defaults to the settings lessons and returns the history row', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    const r = requestResubmission(db, { studentId: s, assignmentId: a, note: 'redo the eval', requestedAt: sql('2026-10-12') });
    expect(r).toMatchObject({ kind: 'request', status: 'open', outcome: 'asked', lessons: 3, requestedOn: '2026-10-12', until: '2026-10-15', note: 'redo the eval', studentName: 'Maya Chen', title: 'Project' });
  });
  test('works on an ungraded pair (no grades row)', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    expect(() => requestResubmission(db, { studentId: s, assignmentId: a })).not.toThrow();
  });
  test('rejects a second open request, bad lessons, an untargeted student, an archived course', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    requestResubmission(db, { studentId: s, assignmentId: a });
    expect(() => requestResubmission(db, { studentId: s, assignmentId: a })).toThrow(expect.objectContaining({ code: 'ALREADY_OPEN' }));
    const a2 = assignment('a2', 'Other');
    expect(() => requestResubmission(db, { studentId: s, assignmentId: a2, lessons: 0 })).toThrow(expect.objectContaining({ code: 'BAD_LESSONS' }));
    const outsider = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u9', 'No', 'One')`).run().lastInsertRowid;
    expect(() => requestResubmission(db, { studentId: outsider, assignmentId: a2 })).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    db.prepare('UPDATE courses SET archived = 1').run();
    expect(() => requestResubmission(db, { studentId: s, assignmentId: a2 })).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
  });
});

describe('extend / close / undo', () => {
  test('extend sets lessons; close records the note; undo deletes', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(extendResubmission(db, r.id, 5)).toMatchObject({ lessons: 5, until: '2026-10-19' });
    expect(closeResubmission(db, r.id, 'grade stands')).toMatchObject({ status: 'closed', outcome: 'closed', closeNote: 'grade stands' });
    expect(() => extendResubmission(db, r.id, 2)).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(undoResubmission(db, r.id)).toEqual({ deleted: true });
    expect(listResubmissions(db, {})).toEqual([]);
  });
});

describe('markResubmissionReviewed', () => {
  test('only for an arrived pair; marks a post-ask open request done', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, submitted_at: at('2026-10-08'), latest_revision_at: at('2026-10-06') });
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(() => markResubmissionReviewed(db, { studentId: s, assignmentId: a })).toThrow(expect.objectContaining({ code: 'NOT_ON_LIST' }));
    db.prepare('UPDATE grades SET latest_revision_at = ?').run(at('2026-10-14'));
    const review = markResubmissionReviewed(db, { studentId: s, assignmentId: a });
    expect(review).toMatchObject({ kind: 'review', outcome: 'reviewed', revisionAt: at('2026-10-14') });
    expect(listResubmissions(db, { id: r.id })[0].status).toBe('done');
  });
  test('Review Focus 2: an ask after an arrival is Waiting at once; only a post-ask revision arrives', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-08') }); // arrived
    expect(resubmissionByStudent(db, a).get(s).state).toBe('arrived');
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(resubmissionByStudent(db, a).get(s).state).toBe('waiting');
    expect(() => markResubmissionReviewed(db, { studentId: s, assignmentId: a })).toThrow(expect.objectContaining({ code: 'NOT_ON_LIST' }));
    db.prepare('UPDATE grades SET latest_revision_at = ?').run(at('2026-10-13'));
    expect(resubmissionByStudent(db, a).get(s).state).toBe('arrived');
    expect(listResubmissions(db, { id: r.id })[0].status).toBe('open');
  });
  test('Review Focus 3: a newer revision after a review shows as arrived again', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-08') });
    markResubmissionReviewed(db, { studentId: s, assignmentId: a });
    expect(resubmissionByStudent(db, a).get(s)?.state ?? null).toBe(null);
    db.prepare('UPDATE grades SET latest_revision_at = ?').run(at('2026-10-13'));
    expect(resubmissionByStudent(db, a).get(s).state).toBe('arrived');
  });
});

describe('settleResubmissions', () => {
  test('marks fulfilled requests done, leaves waiting ones', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 90, submitted_at: at('2026-10-15'), latest_revision_at: at('2026-10-14') });
    grade(s2, a, { score: 60, submitted_at: at('2026-10-08'), latest_revision_at: at('2026-10-06') });
    const r1 = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    const r2 = requestResubmission(db, { studentId: s2, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(settleResubmissions(db, { assignmentId: a })).toBe(1);
    expect(listResubmissions(db, { id: r1.id })[0]).toMatchObject({ status: 'done', outcome: 'done' });
    expect(listResubmissions(db, { id: r2.id })[0].status).toBe('open');
  });
});

describe('recordSchoologyUnsubmit', () => {
  test('needs graded + earlier submission + in progress + no open request + current course', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, exception: 0, first_submitted_at: 100, lti_submission_state: 'in_progress' });
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a })).toBe(true);
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a })).toBe(false); // already open
    const s2 = student('u2', 'Ethan', 'Wong');
    grade(s2, a, { score: 0, exception: 0, first_submitted_at: 0, lti_submission_state: 'in_progress' });
    expect(recordSchoologyUnsubmit(db, { studentId: s2, assignmentId: a })).toBe(false);
  });
});

describe('lookups', () => {
  test('openRequestKeys and resubmissionByStudent', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(openRequestKeys(db, courseId)).toEqual(new Set([`${s}:${a}`]));
    expect(resubmissionByStudent(db, a).get(s)).toMatchObject({ state: 'waiting', request: { id: r.id, lessons: 3 } });
  });
});
