import { describe, it, expect } from 'vitest';
import {
  normalizedSubmissionState, gradingStateOf, studentMatchesPill, passesFilters,
  countMatches, filterGroups, pillTone, TONE_VARS, studentReasons, reasonText, reasonTone, countReasons, parseFilterParam,
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
  it('no topics (unaligned, #41): a plain score counts as graded, nothing as ungraded', () => {
    expect(gradingStateOf(stu({ score: 0 }), [])).toBe('complete');
    expect(gradingStateOf(stu({ score: 100 }), [])).toBe('complete');
    expect(gradingStateOf(stu({ score: null }), [])).toBe('ungraded');
    expect(gradingStateOf(stu({ grade_comment: 'note' }), [])).toBe('complete');
  });
  it('all topics + comment is complete', () =>
    expect(gradingStateOf(stu({ scores: { t1: { grade: 'EX' }, t2: { grade: 'D' } }, grade_comment: 'x' }), TOPICS)).toBe('complete'));
  it('nothing is ungraded', () => expect(gradingStateOf(stu(), TOPICS)).toBe('ungraded'));
  it('some missing is partial', () =>
    expect(gradingStateOf(stu({ scores: { t1: { grade: 'EX' } }, grade_comment: 'x' }), TOPICS)).toBe('partial'));
  it('excepted is complete', () => expect(gradingStateOf(stu({ exception: 3 }), TOPICS)).toBe('complete'));
  // Final review M3 (server gradingState parity): Prism's own status line is not feedback.
  it('a comment that is only the stored status line is not a comment', () => {
    const line = 'Resubmission requested - due Thu 15/10.';
    const status_line = { line, kind: 'ask' };
    const scores = { t1: { grade: 'EX' }, t2: { grade: 'D' } };
    expect(gradingStateOf(stu({ scores, grade_comment: line, status_line }), TOPICS)).toBe('partial');
    expect(gradingStateOf(stu({ grade_comment: line, status_line }), TOPICS)).toBe('ungraded');
    expect(gradingStateOf(stu({ grade_comment: line, status_line }), [])).toBe('ungraded');
    expect(gradingStateOf(stu({ scores, grade_comment: `${line}\n\nWell done`, status_line }), TOPICS)).toBe('complete');
    // A hand-edited line is the teacher's text.
    expect(gradingStateOf(stu({ scores, grade_comment: `${line} (edited)`, status_line }), TOPICS)).toBe('complete');
  });
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
  it('non-LTI assignment has Submitted + Unsubmitted status pills', () => {
    const pills = filterGroups(NON_LTI)[0].pills;
    expect(pills.map(p => p.id)).toEqual(['submitted', 'not_started']);
    expect(pills.map(p => p.label)).toEqual(['Submitted', 'Unsubmitted']);
  });
});

describe('non-LTI Unsubmitted filter', () => {
  const ctx = { assignment: NON_LTI, topics: TOPICS };
  const submitted = stu({ submission_type: 'drop' });
  const unsubmitted = stu();
  it("the Unsubmitted pill (id 'not_started') matches an unsubmitted non-LTI student", () => {
    expect(studentMatchesPill(unsubmitted, 'not_started', ctx)).toBe(true);
    expect(studentMatchesPill(submitted, 'not_started', ctx)).toBe(false);
  });
  it('filtering to Unsubmitted hides submitted students', () => {
    expect(passesFilters(unsubmitted, new Set(['not_started']), ctx)).toBe(true);
    expect(passesFilters(submitted, new Set(['not_started']), ctx)).toBe(false);
  });
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

describe('studentMatchesPill (visibility + flag + resubmit)', () => {
  const ctx = { assignment: LTI, topics: TOPICS };
  it('visible matches comment_status === 1', () => {
    expect(studentMatchesPill(stu({ comment_status: 1 }), 'visible', ctx)).toBe(true);
    expect(studentMatchesPill(stu({ comment_status: 0 }), 'visible', ctx)).toBe(false);
  });
  it('not_visible matches feedback that exists but is hidden', () => {
    expect(studentMatchesPill(stu({ grade_comment: 'Good', comment_status: 0 }), 'not_visible', ctx)).toBe(true);
    expect(studentMatchesPill(stu({ grade_comment: 'Good', comment_status: 1 }), 'not_visible', ctx)).toBe(false);
    expect(studentMatchesPill(stu({ comment_status: 0 }), 'not_visible', ctx)).toBe(false); // nothing to show yet
  });
  it('review matches a review_flag', () => {
    expect(studentMatchesPill(stu({ review_flag: { id: 1 } }), 'review', ctx)).toBe(true);
    expect(studentMatchesPill(stu(), 'review', ctx)).toBe(false);
  });
  it('resubmit matches a resubmit_flag', () => {
    expect(studentMatchesPill(stu({ resubmit_flag: { id: 2 } }), 'resubmit', ctx)).toBe(true);
    expect(studentMatchesPill(stu(), 'resubmit', ctx)).toBe(false);
  });
});

describe('studentReasons (Needs action + Watch)', () => {
  const ctx = { assignment: LTI, topics: TOPICS, hasDraft: () => false };
  const ids = (s, c = ctx) => studentReasons(s, c).map(r => r.id);

  it('to grade: handed in (server) and nothing graded', () => {
    expect(ids(stu({ attention: { handedIn: true, reasons: [] } }))).toEqual(['to_grade']);
    expect(ids(stu({ attention: { handedIn: false, reasons: [] } }))).toEqual([]);
  });
  it('without server attention, falls back to the submission state', () => {
    expect(ids(stu({ lti_submission_state: 'submitted' }))).toEqual(['to_grade']);
  });
  it('a Prism draft replaces to grade / partly graded', () => {
    const drafted = { ...ctx, hasDraft: () => true };
    expect(ids(stu({ attention: { handedIn: true, reasons: [] } }), drafted)).toEqual(['draft']);
    expect(ids(stu({ scores: { t1: { grade: 'EX' } } }), drafted)).toEqual(['draft']);
  });
  it('partly graded, feedback hidden, resubmitted and flagged', () => {
    expect(ids(stu({ scores: { t1: { grade: 'EX' } }, grade_comment: 'Good', comment_status: 0 })))
      .toEqual(['partly_graded', 'feedback_hidden']);
    expect(ids(stu({ resubmission: { state: 'arrived' }, scores: { t1: { grade: 'EX' }, t2: { grade: 'EX' } }, grade_comment: 'x', comment_status: 1 })))
      .toEqual(['resubmitted']);
    expect(ids(stu({ review_flag: { id: 1 }, exception: 1 }))).toEqual(['flagged']);
  });
  it('excused: no grading reasons', () => {
    expect(ids(stu({ exception: 1, attention: { handedIn: true, reasons: [] } }))).toEqual([]);
  });
  it('server reasons join in REASONS order; unknown ids are dropped', () => {
    const s = stu({ attention: { handedIn: true, reasons: [{ id: 'resubmission_pending', until: '2026-10-20' }, { id: 'referral', kind: 'outstanding', daysLate: 9 }, { id: 'nope' }] } });
    expect(ids(s)).toEqual(['to_grade', 'referral', 'resubmission_pending']);
  });
  it('passesFilters: any selected reason matches; Refine still narrows', () => {
    const late = stu({ attention: { handedIn: false, reasons: [{ id: 'late', daysLate: 2, tone: 'green' }] } });
    const toGrade = stu({ lti_submission_state: 'submitted', attention: { handedIn: true, reasons: [] } });
    const sel = new Set(['to_grade', 'late']);
    expect(passesFilters(late, sel, ctx)).toBe(true);
    expect(passesFilters(toGrade, sel, ctx)).toBe(true);
    expect(passesFilters(late, new Set(['to_grade', 'late', 'submitted']), ctx)).toBe(false);
  });
  it('countReasons counts each reason across students', () => {
    const c = countReasons([stu({ attention: { handedIn: true, reasons: [] } }), stu({ review_flag: { id: 2 } })], ctx);
    expect(c).toMatchObject({ to_grade: 1, flagged: 1, late: 0 });
  });
});

describe('reasonText / reasonTone', () => {
  it('names the detail in school days and DD/MM dates', () => {
    expect(reasonText({ id: 'referral', kind: 'outstanding', daysLate: 9 })).toBe('Referral to decide, 9 school days late');
    expect(reasonText({ id: 'referral', kind: 'submitted_late', daysLate: 8 })).toBe('Referral to decide, submitted 8 school days late');
    expect(reasonText({ id: 'late', daysLate: 1 })).toBe('Late, 1 school day');
    expect(reasonText({ id: 'in_progress_late', daysLate: 3 })).toBe('In progress, 3 school days late');
    expect(reasonText({ id: 'not_started_soon', schoolDaysLeft: 0 })).toBe('Not started, due today');
    expect(reasonText({ id: 'not_started_soon', schoolDaysLeft: 2 })).toBe('Not started, due in 2 school days');
    expect(reasonText({ id: 'resubmission_pending', until: '2026-10-20' })).toBe('Resubmission due 20/10');
    expect(reasonText({ id: 'resubmission_overdue', until: '2026-10-14' })).toBe('Resubmission overdue, due 14/10');
    expect(reasonText({ id: 'to_grade' })).toBe('To grade');
  });
  it('late clocks take the triage tone; others their fixed tone', () => {
    expect(reasonTone({ id: 'late', tone: 'amber' })).toBe('yellow');
    expect(reasonTone({ id: 'late', tone: 'green' })).toBe('neutral');
    expect(reasonTone({ id: 'referral', tone: 'red' })).toBe('red');
    expect(reasonTone({ id: 'draft' })).toBe('blue');
  });
});

describe('parseFilterParam', () => {
  it('keeps known reason and Refine ids, drops the rest', () => {
    expect([...parseFilterParam('to_grade, draft,submitted,bogus')]).toEqual(['to_grade', 'draft', 'submitted']);
    expect(parseFilterParam(null).size).toBe(0);
  });
});
