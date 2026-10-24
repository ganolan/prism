import { describe, it, expect } from 'vitest';
import { studentRows, withHeld, rowWhen, NEEDS_ATTENTION_LABELS, flagOnRow } from './needsAttention.js';

const SETTINGS = { referralLimitDays: 8, makeUpRedDay: 4, makeUpAmberDay: 2, feedbackLimitDays: 10, warnLeadDays: 3 };
const late = (o) => ({ kind: 'outstanding', studentId: 1, assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', courseId: 5, daysLate: 2, day: 3, tone: 'green', ...o });
const makeUp = (o) => ({ studentId: 1, assignmentId: 20, schoologyAssignmentId: 'q20', title: 'Unit 1 test', courseId: 5, day: 2, tone: 'amber', ...o });
const resub = (o) => ({ id: 30, state: 'waiting', studentId: 1, assignmentId: 31, schoologyAssignmentId: 'r31', title: 'Essay', courseId: 5, day: 2, limit: 5, tone: 'green', ...o });
const flag = (o) => ({ kind: 'flag', flag: 2, exception: 2, studentId: 1, assignmentId: 40, schoologyAssignmentId: 'f40', title: 'Lab', courseId: 5, day: 3, limit: 50, tone: 'green', ...o });
const triage = (parts) => ({ settings: SETTINGS, lateWork: [], makeUps: [], resubmissions: [], flags: [], feedbackOwed: [], unfinishedGrading: [], ...parts });
const kinds = (out) => out.flatMap((s) => s.rows.map((r) => r.kind));
const ALL = [1, 2, 3, 4];

describe('studentRows', () => {
  it('late work: outstanding is overdue, submitted late at the limit is late_at_limit, below the limit is out', () => {
    const out = studentRows(triage({ lateWork: [
      late({ studentId: 1 }),
      late({ studentId: 2, kind: 'submitted_late', tone: 'red', daysLate: 9, day: 10 }),
      late({ studentId: 3, kind: 'submitted_late', tone: 'amber', daysLate: 6, day: 7 }),
    ] }), ALL);
    expect(out.map((s) => [s.studentId, s.rows.map((r) => r.kind)])).toEqual([[2, ['late_at_limit']], [1, ['overdue']]]);
    const overdue = out[1].rows[0];
    expect(overdue).toMatchObject({ limit: 8, day: 3, tone: 'green', label: 'Overdue' });
    expect(overdue.row.title).toBe('CP2');
  });

  it('make-ups are make_up, with the make-up red day as the limit', () => {
    const [s] = studentRows(triage({ makeUps: [makeUp()] }), ALL);
    expect(s.rows[0]).toMatchObject({ kind: 'make_up', label: 'Make-up test', limit: 4, day: 2, tone: 'amber' });
  });

  it('resubmissions: waiting is pending, or overdue when red; arrived is out', () => {
    const out = studentRows(triage({ resubmissions: [
      resub({ studentId: 1 }),
      resub({ id: 32, studentId: 2, tone: 'red', day: 7 }),
      resub({ id: 33, studentId: 3, state: 'arrived', tone: 'red', day: 12, limit: 10 }),
    ] }), ALL);
    expect(out.map((s) => [s.studentId, kinds([s])])).toEqual([[2, ['resub_overdue']], [1, ['resub_pending']]]);
    expect(out[0].rows[0]).toMatchObject({ label: 'Resubmission overdue', limit: 5 });
    expect(out[1].rows[0].label).toBe('Resubmission pending');
  });

  it('flags: Incomplete and Absent only; Missing, Late and saved grades are out', () => {
    const out = studentRows(triage({ flags: [
      flag({ studentId: 1, flag: 2 }),
      flag({ studentId: 2, flag: 5, exception: 5 }),
      flag({ studentId: 3, flag: 3, exception: 3 }),
      flag({ studentId: 3, flag: 6, exception: 6, assignmentId: 41 }),
      flag({ studentId: 4, kind: 'saved_grade', flag: 0, exception: 0 }),
    ] }), ALL);
    expect(out.map((s) => s.studentId).sort()).toEqual([1, 2]);
    const byStudent = Object.fromEntries(out.map((s) => [s.studentId, s.rows[0]]));
    expect(byStudent[1]).toMatchObject({ kind: 'incomplete', label: 'Incomplete', limit: 50 });
    expect(byStudent[2]).toMatchObject({ kind: 'absent', label: 'Absent' });
  });

  it('orders a student\'s rows red, amber, green, then the larger share of the limit', () => {
    const [s] = studentRows(triage({
      lateWork: [late({ assignmentId: 1, tone: 'green', day: 2 }), late({ assignmentId: 2, tone: 'green', day: 5 })],
      makeUps: [makeUp({ tone: 'amber', day: 2 })],
      flags: [flag({ tone: 'red', day: 40 })],
      resubmissions: [resub({ tone: 'red', day: 7 })],
    }), ALL);
    // red: resub 7/5 = 1.4 before the flag 40/50 = 0.8; amber; then green 5/8 before 2/8.
    expect(s.rows.map((r) => r.kind)).toEqual(['resub_overdue', 'incomplete', 'make_up', 'overdue', 'overdue']);
    expect(s.rows.slice(3).map((r) => r.day)).toEqual([5, 2]);
  });

  it('orders students by their most urgent row, the same way', () => {
    const out = studentRows(triage({
      lateWork: [late({ studentId: 1, tone: 'amber', day: 6 }), late({ studentId: 2, tone: 'red', day: 9 }), late({ studentId: 3, tone: 'amber', day: 7 })],
      makeUps: [makeUp({ studentId: 4, tone: 'green', day: 1 })],
    }), ALL);
    expect(out.map((s) => s.studentId)).toEqual([2, 3, 1, 4]);
  });

  it('leaves out students who are not active (dropped)', () => {
    const out = studentRows(triage({ lateWork: [late({ studentId: 1 }), late({ studentId: 9 })], flags: [flag({ studentId: 9 })] }), [1]);
    expect(out.map((s) => s.studentId)).toEqual([1]);
  });

  it('gives every row a distinct key', () => {
    const [s] = studentRows(triage({
      lateWork: [late({ assignmentId: 1 }), late({ assignmentId: 2 })],
      resubmissions: [resub({ id: 1 }), resub({ id: 2 })],
    }), ALL);
    expect(new Set(s.rows.map((r) => r.key)).size).toBe(4);
  });

  it('no triage, no rows', () => {
    expect(studentRows(null, ALL)).toEqual([]);
  });

  it('labels are the spec\'s words', () => {
    expect(Object.values(NEEDS_ATTENTION_LABELS)).toEqual([
      'Overdue', 'Late, handed in', 'Make-up test', 'Resubmission pending', 'Resubmission overdue', 'Incomplete', 'Absent',
    ]);
  });
});

describe('withHeld', () => {
  it('keeps a row an action took off triage in its place, once', () => {
    const before = studentRows(triage({ lateWork: [late({ studentId: 1, tone: 'red', day: 9 }), late({ studentId: 1, assignmentId: 2 }), late({ studentId: 2, tone: 'amber', day: 6 })] }), ALL);
    const referred = before[0].rows[0];
    const after = studentRows(triage({ lateWork: [late({ studentId: 1, assignmentId: 2 }), late({ studentId: 2, tone: 'amber', day: 6 })] }), ALL);
    const out = withHeld(after, [referred]);
    expect(out.map((s) => s.studentId)).toEqual([1, 2]);
    expect(out[0].rows.map((r) => r.key)).toEqual(before[0].rows.map((r) => r.key));
    // Still listed by triage: not added twice.
    expect(withHeld(before, [referred])[0].rows).toHaveLength(2);
  });
  it('brings back a student whose only row was held', () => {
    const e = studentRows(triage({ makeUps: [makeUp({ studentId: 3 })] }), ALL)[0].rows[0];
    expect(withHeld([], [e])).toEqual([{ studentId: 3, rows: [e] }]);
  });
});

describe('rowWhen (the muted line, in the rail\'s numbers)', () => {
  const one = (parts) => studentRows(triage(parts), ALL)[0].rows[0];
  it('late work: school days late, then N left, last day, or at the limit', () => {
    expect(rowWhen(one({ lateWork: [late({ day: 8, tone: 'amber' })] }))).toBe('7 school days late, last day');
    expect(rowWhen(one({ lateWork: [late({ day: 6, tone: 'amber' })] }))).toBe('5 school days late, 2 left');
    expect(rowWhen(one({ lateWork: [late({ day: 2 })] }))).toBe('1 school day late, 6 left');
    expect(rowWhen(one({ lateWork: [late({ day: 10, tone: 'red' })] }))).toBe('9 school days late, at the limit');
    expect(rowWhen(one({ lateWork: [late({ kind: 'submitted_late', day: 11, tone: 'red' })] }))).toBe('10 school days late, at the limit');
  });
  it('make-ups count from the test; the last day is the one before the red day', () => {
    expect(rowWhen(one({ makeUps: [makeUp({ day: 1, tone: 'green' })] }))).toBe('0 school days since the test, 2 left');
    expect(rowWhen(one({ makeUps: [makeUp({ day: 3, tone: 'amber' })] }))).toBe('2 school days since the test, last day');
    expect(rowWhen(one({ makeUps: [makeUp({ day: 4, tone: 'red' })] }))).toBe('3 school days since the test, at the limit');
  });
  it('resubmissions count from the ask', () => {
    expect(rowWhen(one({ resubmissions: [resub({ day: 2 })] }))).toBe('1 school day since asked, 3 left');
    expect(rowWhen(one({ resubmissions: [resub({ day: 7, tone: 'red' })] }))).toBe('6 school days since asked, past the deadline');
  });
  it('flags count from the flag, with the Flags panel\'s advice', () => {
    expect(rowWhen(one({ flags: [flag({ day: 4, advice: 'Set a date to finish, then grade it.' })] })))
      .toBe('3 school days since flagged. Set a date to finish, then grade it.');
  });
});

describe('flagOnRow', () => {
  const gradebook = { grades: { 1: { 9: { exception: 3 }, 10: { exception: 0 } } } };
  it('reads the flag code the gradebook holds for the row\'s student and task', () => {
    expect(flagOnRow(gradebook, { studentId: 1, assignmentId: 9 })).toBe(3);
    expect(flagOnRow(gradebook, { studentId: 1, assignmentId: 10 })).toBe(0);
    expect(flagOnRow(gradebook, { studentId: 2, assignmentId: 9 })).toBe(0);
    expect(flagOnRow(null, { studentId: 1, assignmentId: 9 })).toBe(0);
  });
});
