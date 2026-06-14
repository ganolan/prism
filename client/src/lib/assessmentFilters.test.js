import { describe, it, expect } from 'vitest';
import {
  normalizedSubmissionState, gradingStateOf, studentMatchesPill, passesFilters,
  countMatches, filterGroups, pillTone, TONE_VARS,
} from './assessmentFilters.js';

const LTI = { is_lti_submission: 1, due_date: '2026-06-01' };
const NON_LTI = { is_lti_submission: 0, due_date: '2026-06-01' };
const TOPICS = [{ id: 't1' }, { id: 't2' }];

const stu = (over = {}) => ({
  scores: {}, grade_comment: '', exception: 0, comment_status: 0,
  lti_submission_state: null, submission_type: null, submitted_at: 0,
  review_flag: null, resubmit_flag: null, ...over,
});

describe('normalizedSubmissionState', () => {
  it('LTI reads lti_submission_state', () => {
    expect(normalizedSubmissionState(stu({ lti_submission_state: 'in_progress' }), LTI)).toBe('in_progress');
  });
  it('LTI null is unknown', () => expect(normalizedSubmissionState(stu(), LTI)).toBe('unknown'));
  it('non-LTI is submitted vs not_started', () => {
    expect(normalizedSubmissionState(stu({ submission_type: 'drop' }), NON_LTI)).toBe('submitted');
    expect(normalizedSubmissionState(stu(), NON_LTI)).toBe('not_started');
  });
});

describe('gradingStateOf', () => {
  it('all topics + comment is complete', () =>
    expect(gradingStateOf(stu({ scores: { t1: { grade: 'EX' }, t2: { grade: 'D' } }, grade_comment: 'x' }), TOPICS)).toBe('complete'));
  it('nothing is ungraded', () => expect(gradingStateOf(stu(), TOPICS)).toBe('ungraded'));
  it('some missing is partial', () =>
    expect(gradingStateOf(stu({ scores: { t1: { grade: 'EX' } }, grade_comment: 'x' }), TOPICS)).toBe('partial'));
  it('excepted is complete', () => expect(gradingStateOf(stu({ exception: 3 }), TOPICS)).toBe('complete'));
});

describe('passesFilters (OR within group, AND across groups)', () => {
  const ctx = { assignment: LTI, topics: TOPICS };
  const submittedUngraded = stu({ lti_submission_state: 'submitted' });
  it('empty filter set shows everyone', () => {
    expect(passesFilters(submittedUngraded, new Set(), ctx)).toBe(true);
  });
  it('Submitted + Ungraded keeps a submitted-and-ungraded student', () => {
    expect(passesFilters(submittedUngraded, new Set(['submitted', 'ungraded']), ctx)).toBe(true);
  });
  it('Submitted + Graded drops a submitted-but-ungraded student (AND across groups)', () => {
    expect(passesFilters(submittedUngraded, new Set(['submitted', 'graded']), ctx)).toBe(false);
  });
  it('OR within the status group', () => {
    const inProgress = stu({ lti_submission_state: 'in_progress' });
    expect(passesFilters(inProgress, new Set(['submitted', 'in_progress']), ctx)).toBe(true);
  });
});

describe('filterGroups', () => {
  it('LTI assignment has three status pills', () =>
    expect(filterGroups(LTI)[0].pills.map(p => p.id)).toEqual(['submitted', 'in_progress', 'not_started']));
  it('non-LTI assignment has only the Submitted status pill', () =>
    expect(filterGroups(NON_LTI)[0].pills.map(p => p.id)).toEqual(['submitted']));
});

describe('countMatches', () => {
  it('counts students matching a single pill', () => {
    const students = [stu({ lti_submission_state: 'submitted' }), stu({ lti_submission_state: 'submitted' }), stu({ lti_submission_state: 'not_started' })];
    expect(countMatches(students, 'submitted', { assignment: LTI, topics: TOPICS })).toBe(2);
  });
});

describe('pillTone / TONE_VARS', () => {
  it('submitted is green; not_started overdue is red', () => {
    const overdue = { is_lti_submission: 1, due_date: '2000-01-01' };
    expect(pillTone('submitted', overdue)).toBe('green');
    expect(pillTone('not_started', overdue)).toBe('red');
  });
  it('every tone has CSS vars', () => {
    ['green', 'blue', 'amber', 'yellow', 'red', 'neutral', 'resubmit'].forEach(t => {
      expect(TONE_VARS[t]).toHaveProperty('bg');
      expect(TONE_VARS[t]).toHaveProperty('text');
    });
  });
});
