import { describe, it, expect } from 'vitest';
import { submissionStatus, gradeLabel, ltiStatusUnavailable } from './gradeLabel.js';

const PAST = '2020-01-01 00:00:00';
const FUTURE = '2999-01-01 00:00:00';
// due ~3 days out → 'soon'; >1 week out → 'early'
const SOON = new Date(Date.now() + 3 * 864e5).toISOString();
const EARLY = new Date(Date.now() + 30 * 864e5).toISOString();

const kinds = (badges) => badges.map((b) => b.kind);
const tone = (badges, kind) => badges.find(b => b.kind === kind)?.tone;

describe('submissionStatus: late OneDrive (LTI) work', () => {
  it('a submitted-late LTI cell is Submitted with a late mark, like native work', () => {
    expect(submissionStatus({ score: null, is_lti_submission: 1, lti_submission_state: 'submitted', late: true, due_date: '2026-01-01' }))
      .toEqual([{ kind: 'submitted', label: 'Submitted', tone: 'green', late: true }]);
    expect(submissionStatus({ score: null, is_lti_submission: 0, submission_type: 'drop', late: 1, due_date: '2026-01-01' }))
      .toEqual([{ kind: 'submitted', label: 'Submitted', tone: 'green', late: true }]);
  });
  it('a late flag with no submission behind it shows nothing (a stale or draft value, 2026-10-19)', () => {
    expect(submissionStatus({ score: null, is_lti_submission: 0, late: 1, due_date: FUTURE })).toEqual([]);
  });
  it('the grade time (submitted_at) is not a submission: a teacher comment alone is not "Submitted"', () => {
    expect(submissionStatus({ score: null, is_lti_submission: 0, submitted_at: 1700000000, due_date: '2020-01-01 15:00:00' }).map((b) => b.kind))
      .toEqual(['missing']);
    expect(submissionStatus({ score: null, is_lti_submission: 0, submission_type: 'drop', due_date: '2020-01-01 15:00:00' }).map((b) => b.kind))
      .toEqual(['submitted']);
  });
  it('paper / gradebook-only work has no submission badges; a test is still tracked', () => {
    expect(submissionStatus({ score: null, is_lti_submission: 0, accepts_submissions: 0, due_date: '2020-01-01 15:00:00' })).toEqual([]);
    expect(submissionStatus({ score: null, is_lti_submission: 0, accepts_submissions: 0, is_test: 1, submission_type: 'assessment', due_date: '2020-01-01 15:00:00' }).map((b) => b.kind))
      .toEqual(['submitted']);
  });
  it('late only matters once submitted', () => {
    expect(submissionStatus({ score: null, is_lti_submission: 1, lti_submission_state: 'in_progress', late: true, due_date: null }).map((b) => b.kind))
      .toEqual(['in-progress']);
  });
});

describe('submissionStatus — lti true state (#62)', () => {
  const lti = (state, due) => submissionStatus({ score: null, is_lti_submission: 1, lti_submission_state: state, due_date: due });

  it('submitted → green Submitted regardless of due date', () => {
    expect(lti('submitted', PAST)).toEqual([{ kind: 'submitted', label: 'Submitted', tone: 'green' }]);
  });
  it('in_progress → blue before due, yellow once overdue', () => {
    expect(tone(lti('in_progress', SOON), 'in-progress')).toBe('blue');
    expect(tone(lti('in_progress', PAST), 'in-progress')).toBe('yellow');
  });
  it('not_started → grey when early/none, red from a week out through overdue', () => {
    expect(tone(lti('not_started', EARLY), 'not-started')).toBe('neutral');
    expect(tone(lti('not_started', null), 'not-started')).toBe('neutral');
    expect(tone(lti('not_started', SOON), 'not-started')).toBe('red');
    expect(tone(lti('not_started', PAST), 'not-started')).toBe('red');
  });
  it('null state → no badge regardless of due date (a capture failure surfaces via lti_fetch_status, not a per-cell "Ungraded" dot)', () => {
    expect(lti(null, SOON)).toEqual([]);
    expect(lti(null, PAST)).toEqual([]);
  });
  it('null state but GHD submission_type present → Submitted (green)', () => {
    const b = submissionStatus({ score: null, is_lti_submission: 1, lti_submission_state: null, submission_type: 'drop', due_date: PAST });
    expect(b).toEqual([{ kind: 'submitted', label: 'Submitted', tone: 'green' }]);
  });
  it('graded lti → no status badge', () => {
    expect(submissionStatus({ score: 14, is_lti_submission: 1, lti_submission_state: 'submitted', due_date: PAST })).toEqual([]);
  });
  it('a non-late exception still takes precedence', () => {
    expect(submissionStatus({ score: null, is_lti_submission: 1, exception: 1, due_date: PAST }))
      .toEqual([{ kind: 'exception', label: 'Excused', tone: 'blue' }]);
  });
});

describe('submissionStatus — non-lti consolidated (#62)', () => {
  const nl = (opts) => submissionStatus({ score: null, is_lti_submission: 0, ...opts });
  it('submitted → green Submitted', () => {
    expect(nl({ submission_type: 'drop', due_date: PAST })).toEqual([{ kind: 'submitted', label: 'Submitted', tone: 'green' }]);
  });
  it('not submitted + overdue → red Missing only (no Not Started)', () => {
    const b = nl({ submitted_at: 0, due_date: PAST });
    expect(kinds(b)).toEqual(['missing']);
    expect(tone(b, 'missing')).toBe('red');
  });
  it('not submitted + before due → no badge', () => {
    expect(nl({ submitted_at: 0, due_date: FUTURE })).toEqual([]);
  });
  it('graded → no status badge', () => {
    expect(submissionStatus({ score: 9, is_lti_submission: 0, due_date: PAST })).toEqual([]);
  });
});

describe('ltiStatusUnavailable — whole-assignment fetch failure (#76 follow-up)', () => {
  const base = { is_lti_submission: 1, lti_fetch_status: 'failed', score: null, exception: 0 };
  it('failed fetch on an ungraded, non-excepted lti cell → true', () => {
    expect(ltiStatusUnavailable(base)).toBe(true);
  });
  it("'ok' / null fetch status → false (we only flag a recorded failure)", () => {
    expect(ltiStatusUnavailable({ ...base, lti_fetch_status: 'ok' })).toBe(false);
    expect(ltiStatusUnavailable({ ...base, lti_fetch_status: null })).toBe(false);
  });
  it('graded cell → false even when the fetch failed', () => {
    expect(ltiStatusUnavailable({ ...base, score: 12 })).toBe(false);
  });
  it('excepted cell → false even when the fetch failed', () => {
    expect(ltiStatusUnavailable({ ...base, exception: 1 })).toBe(false);
  });
  it('non-lti assignment → false', () => {
    expect(ltiStatusUnavailable({ ...base, is_lti_submission: 0 })).toBe(false);
  });
});

describe('gradeLabel', () => {
  it('returns Pending for an ungraded row', () => {
    expect(gradeLabel({ score: null })).toEqual({ text: 'Pending', kind: 'pending' });
  });

  it('renders numeric score / max when the scale has no levels', () => {
    expect(gradeLabel({ score: 8, max_points: 10 })).toEqual({ text: '8 / 10', kind: 'numeric' });
  });

  it('the Late flag (exception 4) keeps the grade: it shows the scale level, never "Late"', () => {
    const scales = { 7: { levels: [{ name: 'Exhibiting', average: 87.5 }, { name: 'Developing', average: 62.5 }] } };
    expect(gradeLabel({ score: 87.5, max_points: 100, exception: 4, grading_scale_id: 7, scales }))
      .toEqual({ text: 'Exhibiting', kind: 'scale' });
    expect(gradeLabel({ score: 8, max_points: 10, exception: 4 })).toEqual({ text: '8 / 10', kind: 'numeric' });
    expect(gradeLabel({ score: null, exception: 4 })).toEqual({ text: 'Pending', kind: 'pending' });
  });

  it('Excused, Incomplete and Missing still replace the grade', () => {
    expect(gradeLabel({ score: 5, exception: 1 })).toEqual({ text: 'Excused', kind: 'exception' });
    expect(gradeLabel({ score: 5, exception: 2 })).toEqual({ text: 'Incomplete', kind: 'exception' });
    expect(gradeLabel({ score: 5, exception: 3 })).toEqual({ text: 'Missing', kind: 'exception' });
  });
});

describe('submissionStatus: the Late flag (exception 4)', () => {
  it('keeps the submission badge, marks it flagged, and is never an exception badge', () => {
    const b = submissionStatus({ score: null, exception: 4, is_lti_submission: 0, submission_type: 'drop', due_date: PAST });
    expect(b).toEqual([{ kind: 'submitted', label: 'Submitted', tone: 'green', flagged: true }]);
    expect(b.some((x) => x.kind === 'exception')).toBe(false);
  });
  it('flagged and submitted late carries both marks', () => {
    expect(submissionStatus({ score: null, exception: 4, late: true, is_lti_submission: 1, lti_submission_state: 'submitted', due_date: PAST }))
      .toEqual([{ kind: 'submitted', label: 'Submitted', tone: 'green', late: true, flagged: true }]);
  });
  it('flagged with nothing submitted still shows the status it already had (no late badge of its own)', () => {
    expect(submissionStatus({ score: null, exception: 4, is_lti_submission: 0, due_date: PAST }).map((b) => b.kind)).toEqual(['missing']);
    expect(submissionStatus({ score: 9, exception: 4, is_lti_submission: 0, submission_type: 'drop', due_date: PAST })).toEqual([]);
  });
});
