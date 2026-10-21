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
  resubmit_flag: null, ...over,
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
  it('the grade time (submitted_at) is not a submission (2026-10-19)', () => {
    expect(normalizedSubmissionState(stu({ submitted_at: 1700000000 }), NON_LTI)).toBe('not_started');
  });
  it('paper work (accepts_submissions 0) is not tracked; a test attempt counts', () => {
    expect(normalizedSubmissionState(stu(), { ...NON_LTI, accepts_submissions: 0 })).toBe('not_tracked');
    expect(normalizedSubmissionState(stu({ test_attempt: 'took' }), { ...NON_LTI, accepts_submissions: 0, is_test: 1 })).toBe('submitted');
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
  it('Excused, Incomplete and Missing are complete', () => {
    for (const exception of [1, 2, 3]) expect(gradingStateOf(stu({ exception }), TOPICS)).toBe('complete');
  });
  it('Late (4) is a flag, not a grade: ungraded until graded (server parity, #40)', () => {
    expect(gradingStateOf(stu({ exception: 4 }), TOPICS)).toBe('ungraded');
    expect(gradingStateOf(stu({ exception: 4 }), [])).toBe('ungraded');
    expect(gradingStateOf(stu({ exception: 4, scores: { t1: { grade: 'EX' }, t2: { grade: 'D' } }, grade_comment: 'x' }), TOPICS)).toBe('complete');
  });
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
  it('there is no review pill: Flag for review is gone (#40)', () => {
    expect(filterGroups(LTI).flatMap(g => g.pills).map(p => p.id)).not.toContain('review');
    expect(filterGroups(LTI).map(g => g.key)).not.toContain('flag');
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
  it('partly graded, feedback hidden and resubmitted', () => {
    expect(ids(stu({ scores: { t1: { grade: 'EX' } }, grade_comment: 'Good', comment_status: 0 })))
      .toEqual(['partly_graded', 'feedback_hidden']);
    expect(ids(stu({ resubmission: { state: 'arrived' }, scores: { t1: { grade: 'EX' }, t2: { grade: 'EX' } }, grade_comment: 'x', comment_status: 1 })))
      .toEqual(['resubmitted']);
    expect(ids(stu({ review_flag: { id: 1 } }))).not.toContain('flagged'); // Flag for review is gone (#40)
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
  it('unread comment: from the submission-comment summary', () => {
    const withComments = { ...ctx, commentSummaryOf: (s) => s.summary };
    expect(ids(stu({ summary: { count: 2, unread: 1 } }), withComments)).toEqual(['unread_comment']);
    expect(ids(stu({ summary: { count: 2, unread: 0 } }), withComments)).toEqual([]);
    expect(ids(stu({ summary: { count: 2, unread: 1 } }))).toEqual([]); // no summaries loaded
  });
  it('countReasons counts each reason across students', () => {
    const c = countReasons([stu({ attention: { handedIn: true, reasons: [] } }), stu({ grade_comment: 'x', comment_status: 0 })], ctx);
    expect(c).toMatchObject({ to_grade: 1, feedback_hidden: 1, late: 0 });
    expect(c).not.toHaveProperty('flagged');
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
    expect(reasonText({ id: 'referred_missing', referredOn: '2026-10-12' })).toBe('Referred 12/10, not submitted');
    expect(reasonText({ id: 'to_grade' })).toBe('To grade');
    expect(reasonText({ id: 'unread_comment', count: 1 })).toBe('Unread comment');
    expect(reasonText({ id: 'unread_comment', count: 3 })).toBe('3 unread comments');
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
  it('drops the retired Flag for review ids (old links keep working, with no filter)', () => {
    expect(parseFilterParam('flagged,review').size).toBe(0);
  });
  it('a group name stands for every reason in its row', () => {
    expect([...parseFilterParam('action')]).toEqual(['to_grade', 'partly_graded', 'draft', 'feedback_hidden', 'resubmitted', 'unread_comment', 'referral', 'resubmission_overdue', 'make_up']);
    expect([...parseFilterParam('watch,submitted,resubmit')]).toEqual(['not_started_soon', 'in_progress_late', 'late', 'referred_missing', 'resubmission_pending', 'submitted']);
  });
});
