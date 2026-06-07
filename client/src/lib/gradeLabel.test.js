import { describe, it, expect } from 'vitest';
import { submissionStatus, gradeLabel } from './gradeLabel.js';

const PAST = '2020-01-01 00:00:00';
const FUTURE = '2999-01-01 00:00:00';
// due ~3 days out → 'soon'; >1 week out → 'early'
const SOON = new Date(Date.now() + 3 * 864e5).toISOString();
const EARLY = new Date(Date.now() + 30 * 864e5).toISOString();

const kinds = (badges) => badges.map((b) => b.kind);
const tone = (badges, kind) => badges.find(b => b.kind === kind)?.tone;

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
  it('null state (no session): nothing before due, neutral Ungraded once overdue', () => {
    expect(lti(null, SOON)).toEqual([]);
    expect(tone(lti(null, PAST), 'ungraded')).toBe('neutral');
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

describe('gradeLabel', () => {
  it('returns Pending for an ungraded row', () => {
    expect(gradeLabel({ score: null })).toEqual({ text: 'Pending', kind: 'pending' });
  });

  it('renders numeric score / max when the scale has no levels', () => {
    expect(gradeLabel({ score: 8, max_points: 10 })).toEqual({ text: '8 / 10', kind: 'numeric' });
  });
});
