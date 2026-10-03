import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { addDays, isWeekday } from '../lib/schoolDays.js';
import { storeSchoolDays } from './schoolCalendar.js';
import { TriageError } from './triageCommon.js';
import {
  requestResubmission, extendResubmission, gradeStands, undoResubmission,
  listResubmissions, settleResubmissions, resubmissionByStudent, openRequestKeys, recordSchoologyUnsubmit,
  arrivedKeys,
} from './resubmissions.js';
import { captureFeedbackSnapshots } from './feedbackSnapshots.js';

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
  db.exec('DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM resubmissions; DELETE FROM settings; DELETE FROM school_days; DELETE FROM grades; DELETE FROM assignment_assignees; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
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

describe('extend / grade stands / undo', () => {
  test('extend sets lessons; grade stands only after the deadline; undo deletes', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(extendResubmission(db, r.id, 5)).toMatchObject({ lessons: 5, until: '2026-10-19' });
    expect(() => gradeStands(db, r.id, { today: '2026-10-16' })).toThrow(expect.objectContaining({ code: 'NOT_AT_DEADLINE' }));
    expect(() => gradeStands(db, r.id, { today: '2026-10-19' })).toThrow(expect.objectContaining({ code: 'NOT_AT_DEADLINE' })); // the student may still resubmit on the deadline day
    expect(listResubmissions(db, { id: r.id })[0].status).toBe('open');
    expect(gradeStands(db, r.id, { today: '2026-10-20' })).toMatchObject({ status: 'closed', outcome: 'grade_stands', closeNote: 'grade stands' });
    expect(listResubmissions(db, { id: r.id })[0].closedAt).toBeTruthy();
    expect(() => extendResubmission(db, r.id, 2)).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(() => gradeStands(db, r.id, { today: '2026-10-21' })).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(undoResubmission(db, r.id)).toEqual({ deleted: true });
    expect(listResubmissions(db, {})).toEqual([]);
  });
  test('M1: gradeStands is refused once a resubmission has arrived (give feedback instead)', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 60, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-05') });
    captureFeedbackSnapshots(db);
    const r = requestResubmission(db, { studentId: s, assignmentId: a, lessons: 1, requestedAt: sql('2026-10-12') });
    db.prepare('UPDATE grades SET latest_revision_at = ?').run(at('2026-10-14'));           // late, but it arrived
    captureFeedbackSnapshots(db);
    expect(() => gradeStands(db, r.id, { today: '2026-10-20' }))
      .toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE', message: 'A resubmission has arrived — give feedback instead' }));
    expect(listResubmissions(db, { id: r.id })[0].status).toBe('open');
    db.prepare('UPDATE grades SET score = 75, submitted_at = ?').run(at('2026-10-15'));                                      // answered, not yet settled
    expect(() => gradeStands(db, r.id, { today: '2026-10-20' }))
      .toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE', message: 'This resubmission has already been answered' }));
  });
  test('I2: outcome — grade stands / undone (auto-add undo) / any other close', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    db.prepare(`UPDATE resubmissions SET status = 'closed', close_note = 'Undone' WHERE id = ?`).run(r.id);
    expect(listResubmissions(db, { id: r.id })[0].outcome).toBe('undone');
    db.prepare(`UPDATE resubmissions SET close_note = 'Migrated (archived course)' WHERE id = ?`).run(r.id);
    expect(listResubmissions(db, { id: r.id })[0].outcome).toBe('closed');
    db.prepare(`UPDATE resubmissions SET close_note = 'grade stands' WHERE id = ?`).run(r.id);
    expect(listResubmissions(db, { id: r.id })[0].outcome).toBe('grade_stands');
  });
  test('gradeStands on an unknown id → NOT_FOUND', () => {
    expect(() => gradeStands(db, 999, { today: '2026-10-20' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

// State comes from visible-feedback snapshots (spec Amendment B): a capture records an
// arrival when latest_revision_at moves; the pair is answered once the visible feedback
// differs from the arrival's baseline.
describe('snapshot-based state', () => {
  const stateOf = (s, a) => resubmissionByStudent(db, a).get(s)?.state ?? null;
  const setGrade = (s, a, cols) => {
    const keys = Object.keys(cols);
    db.prepare(`UPDATE grades SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE student_id = ? AND assignment_id = ?`)
      .run(...keys.map((k) => cols[k]), s, a);
  };

  test('Review Focus 1: a hidden comment edited after a resubmission stays Arrived; a score change answers it', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    // Graded; the comment field holds a teacher-only note (Display off).
    grade(s, a, { score: 80, grade_comment: 'v1: weak eval', comment_status: null, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-05') });
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe(null);
    setGrade(s, a, { latest_revision_at: at('2026-10-13') });           // the student resubmits
    expect(captureFeedbackSnapshots(db)).toEqual({ arrivals: 1 });
    expect(stateOf(s, a)).toBe('arrived');
    // The teacher edits the hidden note (a Prism save also moves the grade time past
    // the revision). Nothing the student sees changed → still Arrived.
    setGrade(s, a, { grade_comment: 'v2: eval better, check refs', submitted_at: at('2026-10-14') });
    captureFeedbackSnapshots(db, { assignmentId: a });
    expect(stateOf(s, a)).toBe('arrived');
    expect(arrivedKeys(db, { assignmentId: a })).toEqual(new Set([`${s}:${a}`]));
    setGrade(s, a, { score: 90 });                                          // regraded
    expect(stateOf(s, a)).toBe(null);
    expect(arrivedKeys(db, { assignmentId: a }).size).toBe(0);
  });

  test('M4: hiding the visible comment (no other change) stays Arrived; a different visible comment answers it', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, grade_comment: 'Good start', comment_status: 1, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-05') });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { latest_revision_at: at('2026-10-13') });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { comment_status: null });                              // Display off while drafting
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save' });
    expect(stateOf(s, a)).toBe('arrived');
    setGrade(s, a, { grade_comment: '' , comment_status: 1 });             // visible text removed
    expect(stateOf(s, a)).toBe('arrived');
    setGrade(s, a, { grade_comment: 'v2: eval now complete', submitted_at: at('2026-10-14') });            // new visible comment
    expect(stateOf(s, a)).toBe(null);
  });

  test('an unchanged re-save of a visible comment stays Arrived; editing the visible comment answers it', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, grade_comment: 'Good start', comment_status: 1, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-05') });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { latest_revision_at: at('2026-10-13') });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { submitted_at: at('2026-10-14') });                    // re-saved, same text
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe('arrived');
    setGrade(s, a, { grade_comment: 'Good start. v2: eval now complete' });
    expect(stateOf(s, a)).toBe(null);
  });

  test('Review Focus 3: a status line hand-edited in Schoology counts as teacher text', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong'); const a = assignment('a1', 'Project');
    const line = 'Resubmission requested - due Thu 15/10.';
    for (const sid of [s, s2]) db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'ask')`).run(sid, a, line);
    // s: only Prism's exact line → no feedback the student was given; s2: the line was edited by hand.
    grade(s, a, { grade_comment: line, comment_status: 1, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-13') });
    grade(s2, a, { grade_comment: 'Resubmission requested - due Fri 16/10.', comment_status: 1, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-13') });
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe(null);
    expect(stateOf(s2, a)).toBe('arrived');
  });

  test('Review Focus 5 (first deploy): the old rule\'s resubmitted pairs with visible feedback are Arrived; others are not', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-08') });
    grade(s2, a, { score: 70, submitted_at: at('2026-10-08'), latest_revision_at: at('2026-10-06') });
    expect(stateOf(s, a)).toBe(null);                // no snapshot yet → readers never guess
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe('arrived');
    expect(stateOf(s2, a)).toBe(null);
    expect(arrivedKeys(db, { courseId })).toEqual(new Set([`${s}:${a}`]));
  });

  test('requested: ask on ungraded work → waiting; post-ask revision → arrived; visible comment → fulfilled; settle → done', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { latest_revision_at: 0 });
    captureFeedbackSnapshots(db);
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(stateOf(s, a)).toBe('waiting');
    setGrade(s, a, { latest_revision_at: at('2026-10-13') });
    captureFeedbackSnapshots(db);
    // arrivedOn (Amendment B card chip) is the arrival's local date; absent once not arrived.
    expect(resubmissionByStudent(db, a).get(s)).toMatchObject({ state: 'arrived', request: { id: r.id }, arrivedOn: '2026-10-13' });
    expect(arrivedKeys(db, { studentId: s })).toEqual(new Set([`${s}:${a}`]));
    setGrade(s, a, { grade_comment: 'note to self', comment_status: null });  // hidden → still arrived
    expect(stateOf(s, a)).toBe('arrived');
    expect(settleResubmissions(db, { assignmentId: a })).toBe(0);
    setGrade(s, a, { grade_comment: 'Much better — eval now complete', comment_status: 1, submitted_at: at('2026-10-14') });
    expect(stateOf(s, a)).toBe(null);                // fulfilled is hidden
    expect(settleResubmissions(db, { assignmentId: a })).toBe(1);
    expect(listResubmissions(db, { id: r.id })[0]).toMatchObject({ status: 'done', outcome: 'done' });
    expect(stateOf(s, a)).toBe(null);
  });

  test('an arrival before the ask does not answer it: ask → waiting until a post-ask revision', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-05') });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { latest_revision_at: at('2026-10-08') });
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe('arrived');
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(stateOf(s, a)).toBe('waiting');
    expect(arrivedKeys(db, { assignmentId: a }).size).toBe(0);
    setGrade(s, a, { latest_revision_at: at('2026-10-13') });
    captureFeedbackSnapshots(db);
    expect(resubmissionByStudent(db, a).get(s)).toMatchObject({ state: 'arrived', request: { id: r.id } });
    expect(listResubmissions(db, { id: r.id })[0].status).toBe('open');
  });
});

describe('settleResubmissions', () => {
  test('marks fulfilled requests done, leaves waiting ones', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 60, submitted_at: at('2026-10-08'), latest_revision_at: at('2026-10-06') });
    grade(s2, a, { score: 60, submitted_at: at('2026-10-08'), latest_revision_at: at('2026-10-06') });
    captureFeedbackSnapshots(db);
    const r1 = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    const r2 = requestResubmission(db, { studentId: s2, assignmentId: a, requestedAt: sql('2026-10-12') });
    db.prepare('UPDATE grades SET latest_revision_at = ? WHERE student_id = ?').run(at('2026-10-14'), s);
    captureFeedbackSnapshots(db);
    db.prepare('UPDATE grades SET score = 90, submitted_at = ? WHERE student_id = ?').run(at('2026-10-15'), s);
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

  test('one auto-add per unsubmit episode: closing it does not let the next sync re-add until a newer submission', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, exception: 0, first_submitted_at: 100, latest_revision_at: at('2026-10-10'), lti_submission_state: 'in_progress' });
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-10') })).toBe(true);
    const row = db.prepare(`SELECT id FROM resubmissions WHERE student_id = ? AND assignment_id = ?`).get(s, a);
    gradeStands(db, row.id, { today: '2026-12-31' });

    // A no-show (same latest_revision_at) must not reappear just because the
    // sync still finds it "in progress".
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-11') })).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM resubmissions WHERE student_id = ? AND assignment_id = ?`).get(s, a).n).toBe(1);

    // A genuinely newer submission (after the closed request's requested_at) is a new episode.
    db.prepare(`UPDATE grades SET latest_revision_at = ? WHERE student_id = ? AND assignment_id = ?`).run(at('2026-10-12'), s, a);
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') })).toBe(true);
  });
});

describe('recordSchoologyUnsubmit guards (final review 5b)', () => {
  const unsubmitted = (s, a, extra = {}) => grade(s, a, { score: 80, exception: 0, first_submitted_at: 100, lti_submission_state: 'in_progress', ...extra });
  test('archived course → false', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project'); unsubmitted(s, a);
    db.prepare('UPDATE courses SET archived = 1').run();
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a })).toBe(false);
  });
  test('excluded course → false', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project'); unsubmitted(s, a);
    db.prepare('UPDATE courses SET excluded = 1').run();
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a })).toBe(false);
  });
  test('an exception (≠ 0) → false', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project'); unsubmitted(s, a, { exception: 4 });
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a })).toBe(false);
  });
  test.each(['submitted', null, 'graded'])('state %s (not in_progress) → false', (state) => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project'); unsubmitted(s, a, { lti_submission_state: state });
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a })).toBe(false);
  });
});

describe('undo of an auto-added request (final review finding 4)', () => {
  test('closes it ("Undone") instead of deleting, so the next sync does not re-add it', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, exception: 0, first_submitted_at: 100, latest_revision_at: at('2026-10-10'), lti_submission_state: 'in_progress' });
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-10') })).toBe(true);
    const row = db.prepare(`SELECT id FROM resubmissions WHERE student_id = ? AND assignment_id = ?`).get(s, a);

    expect(undoResubmission(db, row.id)).toEqual({ deleted: false, closed: true });
    expect(listResubmissions(db, { id: row.id })[0]).toMatchObject({ status: 'closed', closeNote: 'Undone' });
    expect(listResubmissions(db, { id: row.id })[0].closedAt).toBeTruthy();
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-11') })).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM resubmissions`).get().n).toBe(1);
  });
  test('an app request is still deleted by undo', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    const r = requestResubmission(db, { studentId: s, assignmentId: a });
    expect(undoResubmission(db, r.id)).toEqual({ deleted: true });
  });
});

describe('lookups', () => {
  test('openRequestKeys and resubmissionByStudent', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(openRequestKeys(db, courseId)).toEqual(new Set([`${s}:${a}`]));
    expect(resubmissionByStudent(db, a).get(s)).toMatchObject({ state: 'waiting', request: { id: r.id, lessons: 3 }, arrivedOn: null });
  });
});

describe('arrivedKeys', () => {
  test('arrived pairs (requested or not), scoped by course / student / assignment; waiting pairs excluded', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong'); const s3 = student('u3', 'Zoe', 'Tan');
    const a = assignment('a1', 'Project'); const b = assignment('b1', 'Essay');
    grade(s, a, { score: 80, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-08') });
    grade(s2, b, { score: 80, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-08') });
    requestResubmission(db, { studentId: s3, assignmentId: a, requestedAt: sql('2026-10-12') });
    captureFeedbackSnapshots(db);
    expect(arrivedKeys(db, { courseId })).toEqual(new Set([`${s}:${a}`, `${s2}:${b}`]));
    expect(arrivedKeys(db, { studentId: s2 })).toEqual(new Set([`${s2}:${b}`]));
    expect(arrivedKeys(db, { assignmentId: a })).toEqual(new Set([`${s}:${a}`]));
  });
});
