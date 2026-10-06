import { describe, test, expect } from 'vitest';
import { makeCalendar } from '../lib/schoolDays.js';
import { buildTimeline } from './submissionTimeline.js';

// Mon 05/10 .. Fri 16/10 2026; Thu 08/10 is a holiday; weekends 10-11 off.
const rows = [];
for (let d = 1; d <= 23; d++) {
  const date = `2026-10-${String(d).padStart(2, '0')}`;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  rows.push({ date, in_session: dow !== 0 && dow !== 6 && d !== 8 ? 1 : 0 });
}
const cal = makeCalendar(rows);
// Local epoch seconds for a 'YYYY-MM-DD HH:MM' wall time (tests run in any TZ).
const at = (s) => Math.floor(new Date(s.replace(' ', 'T') + ':00').getTime() / 1000);

const lti = { due_date: '2026-10-06 15:00:00', is_lti_submission: 1, accepts_submissions: 1 };
const native = { due_date: '2026-10-06 15:00:00', is_lti_submission: 0, accepts_submissions: 1 };
const base = { cal, today: '2026-10-14', referralLimitDays: 8 };

describe('buildTimeline: submitted work', () => {
  test('on time: before the deadline', () => {
    const t = buildTimeline({ ...base, assignment: lti, grade: { lti_submission_state: 'submitted', first_submitted_at: at('2026-10-06 14:10'), latest_revision_at: at('2026-10-06 14:10'), late: 0 } });
    expect(t).toMatchObject({
      due: { date: '2026-10-06', time: '15:00' }, deadline: '2026-10-06',
      submission: { state: 'submitted', firstAt: at('2026-10-06 14:10'), late: false, day: null, schoologyLate: false },
      overdue: null,
    });
  });

  test('late the same day: day 1 with the minutes', () => {
    const t = buildTimeline({ ...base, assignment: lti, grade: { lti_submission_state: 'submitted', first_submitted_at: at('2026-10-06 15:42'), late: 1 } });
    expect(t.submission).toMatchObject({ late: true, day: 1, lateMinutes: 42, schoologyLate: true });
  });

  test('late by school days: skips the holiday and the weekend', () => {
    // 07 = day 2, (08 holiday), 09 = day 3, 12 = day 4
    const t = buildTimeline({ ...base, assignment: native, grade: { submission_type: 'drop', first_submitted_at: at('2026-10-12 09:00'), latest_revision_at: at('2026-10-13 10:00'), late: 1 } });
    expect(t.submission).toMatchObject({ late: true, day: 4, latestAt: at('2026-10-13 10:00'), lateMinutes: null });
  });

  test('an extension moves the deadline: on time against it, even if Schoology says late', () => {
    const t = buildTimeline({
      ...base, assignment: lti, extension: { lessons: 2, note: 'sick' },
      grade: { lti_submission_state: 'submitted', first_submitted_at: at('2026-10-09 10:00'), late: 1 },
    });
    expect(t.extension).toEqual({ schoolDays: 2, until: '2026-10-09', note: 'sick' });
    expect(t.deadline).toBe('2026-10-09');
    expect(t.submission).toMatchObject({ late: false, day: null, schoologyLate: true });
  });

  test('day N counts from the extended deadline (deadline = day 1)', () => {
    const t = buildTimeline({
      ...base, assignment: lti, extension: { lessons: 2 },
      grade: { lti_submission_state: 'submitted', first_submitted_at: at('2026-10-13 10:00') },
    });
    expect(t.submission).toMatchObject({ late: true, day: 3 }); // 09 = 1, 12 = 2, 13 = 3
  });

  test('no submission time stored: falls back to Schoology\'s late flag', () => {
    const late = buildTimeline({ ...base, assignment: native, grade: { submission_type: 'drop', late: 1 } });
    expect(late.submission).toMatchObject({ state: 'submitted', firstAt: null, late: true, day: null });
    const onTime = buildTimeline({ ...base, assignment: native, grade: { submission_type: 'drop', late: 0 } });
    expect(onTime.submission.late).toBe(false);
  });

  test('Schoology\'s Late exception (4) counts as late', () => {
    const t = buildTimeline({ ...base, assignment: native, grade: { exception: 4 } });
    expect(t.submission.schoologyLate).toBe(true);
  });
});

describe('buildTimeline: missing work', () => {
  test('not submitted past the deadline: the clock day today', () => {
    // today 14/10: 06 = 1, 07 = 2, 09 = 3, 12 = 4, 13 = 5, 14 = 6
    const t = buildTimeline({ ...base, assignment: lti, grade: { lti_submission_state: 'in_progress' } });
    expect(t.submission.state).toBe('in_progress');
    expect(t.overdue).toEqual({ day: 6, overLimit: false });
  });

  test('no grade row at all is not submitted; over the limit after day 8 (summative only)', () => {
    const t = buildTimeline({ ...base, today: '2026-10-19', assignment: { ...native, aligned: 1 }, grade: null });
    expect(t.submission.state).toBe('not_submitted');
    expect(t.overdue).toEqual({ day: 9, overLimit: true }); // 15 = 7, 16 = 8, 19 = 9
  });

  test('formative work is never "over the limit": referral is for summative work only', () => {
    const t = buildTimeline({ ...base, today: '2026-10-19', assignment: { ...native, aligned: 0 }, grade: null });
    expect(t.overdue).toEqual({ day: 9, overLimit: false });
  });

  test('before the deadline nothing is overdue; excused or graded work has no clock', () => {
    expect(buildTimeline({ ...base, today: '2026-10-05', assignment: native, grade: null }).overdue).toBeNull();
    expect(buildTimeline({ ...base, assignment: lti, grade: { exception: 1 } }).submission.state).toBe('excused');
    expect(buildTimeline({ ...base, assignment: lti, grade: { exception: 1 } }).overdue).toBeNull();
    expect(buildTimeline({ ...base, assignment: native, grade: { score: 80 } }).overdue).toBeNull();
  });

  test('no submission signal synced is unknown, never "not submitted" (Prism must not accuse on missing data)', () => {
    const lti0 = buildTimeline({ ...base, assignment: lti, grade: null });
    expect(lti0.submission.state).toBe('unknown');
    expect(lti0.overdue).toBeNull();
    const untested = buildTimeline({ ...base, assignment: { ...native, accepts_submissions: null }, grade: null });
    expect(untested.submission.state).toBe('unknown');
    expect(untested.overdue).toBeNull();
  });

  test('tests: took / missed (on the clock from the test day) / other copy / not read yet', () => {
    const test = { due_date: '2026-10-06 10:00:00', is_test: 1, accepts_submissions: 0 };
    expect(buildTimeline({ ...base, assignment: test, grade: { test_attempt: 'took' } }).submission.state).toBe('submitted');
    const missed = buildTimeline({ ...base, assignment: test, grade: { test_attempt: 'none' } });
    expect(missed.submission.state).toBe('not_started');
    expect(missed.overdue).toEqual({ day: 6, overLimit: false });
    expect(buildTimeline({ ...base, assignment: test, grade: { test_attempt: 'not_assigned' } }).submission.state).toBe('not_assigned');
    expect(buildTimeline({ ...base, assignment: test, grade: null })).toMatchObject({ submission: { state: 'unknown' }, overdue: null });
  });

  test('work that is not handed in online has no submission story', () => {
    const t = buildTimeline({ ...base, assignment: { ...native, accepts_submissions: 0 }, grade: null });
    expect(t.submission.state).toBe('untracked');
    expect(t.overdue).toBeNull();
  });
});

describe('buildTimeline: resubmission and referral', () => {
  test('carries the ask, its deadline and the arrival (flagging a late arrival)', () => {
    const t = buildTimeline({
      ...base, assignment: lti, grade: { lti_submission_state: 'submitted' },
      resubmission: { state: 'arrived', arrivedOn: '2026-10-13', request: { requestedOn: '2026-10-07', until: '2026-10-12' } },
    });
    expect(t.resubmission).toEqual({ state: 'arrived', askedOn: '2026-10-07', until: '2026-10-12', arrivedOn: '2026-10-13', afterDeadline: true });
  });

  test('a referral records the day it was made', () => {
    const t = buildTimeline({ ...base, assignment: lti, grade: null, referral: { created_at: '2026-10-19 12:00:00', days_late: 8 } });
    expect(t.referral).toMatchObject({ day: 9 });
    expect(t.referral.on).toMatch(/^2026-10-19$/);
  });
});
