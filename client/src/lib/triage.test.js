import { describe, it, expect } from 'vitest';
import { meterPct, courseTriageSummary, courseRedLine, waitsByAssignment, courseLabel, redCount, APPROX_TITLE } from './triage.js';

const T = {
  lateWork: [
    { courseId: 1, tone: 'red' }, { courseId: 1, tone: 'amber' }, { courseId: 2, tone: 'green' },
  ],
  feedbackOwed: [
    { courseId: 1, owed: 7, oldestWaitDays: 8, day: 9, tone: 'amber', schoologyAssignmentId: 'a1' },
    { courseId: 1, owed: 3, oldestWaitDays: 11, day: 12, tone: 'red', schoologyAssignmentId: 'a2' },
  ],
  makeUps: [
    { courseId: 1, tone: 'amber' }, { courseId: 1, tone: 'red' }, { courseId: 2, tone: 'green' }, { courseId: 3, tone: 'amber' },
  ],
};

describe('triage helpers', () => {
  it('meterPct clamps to 4–100', () => {
    expect(meterPct(0, 8)).toBe(4);
    expect(meterPct(4, 8)).toBe(50);
    expect(meterPct(20, 8)).toBe(100);
  });

  it('courseTriageSummary counts per course; oldestDay is the worst feedback day number (due date = day 1)', () => {
    expect(courseTriageSummary(T, 1)).toEqual({
      atLimit: 1, late: 1, toGrade: 10, oldestDay: 12, waitTone: 'red', makeUps: 2, makeUpTone: 'red',
      resubmissions: 0, resubmissionTone: 'green', worstTone: 'red', redMakeUps: 1, redResubmissions: 0, feedbackRed: true,
    });
    expect(courseTriageSummary(T, 2)).toMatchObject({ makeUps: 1, makeUpTone: 'green' });
    expect(courseTriageSummary(T, 3)).toMatchObject({ makeUps: 1, makeUpTone: 'amber' });
    expect(courseTriageSummary(null, 1)).toEqual({
      atLimit: 0, late: 0, toGrade: 0, oldestDay: 0, waitTone: 'green', makeUps: 0, makeUpTone: 'green',
      resubmissions: 0, resubmissionTone: 'green', worstTone: 'green', redMakeUps: 0, redResubmissions: 0, feedbackRed: false,
    });
  });

  it('worstTone, redMakeUps, redResubmissions and feedbackRed reflect the four lists for the course', () => {
    // course 2: only a green late row and a green make-up — nothing red or amber anywhere.
    expect(courseTriageSummary(T, 2)).toMatchObject({ worstTone: 'green', redMakeUps: 0, redResubmissions: 0, feedbackRed: false });
    // course 3: a single amber make-up — worst tone is amber, not red.
    expect(courseTriageSummary(T, 3)).toMatchObject({ worstTone: 'amber', redMakeUps: 0, feedbackRed: false });
  });

  it('waitsByAssignment keys by Schoology id', () => {
    expect(Object.keys(waitsByAssignment(T))).toEqual(['a1', 'a2']);
  });

  it('courseLabel prefixes the block so sections of one course differ', () => {
    expect(courseLabel({ courseName: 'AP COMPUTER SCIENCE PRINCIPLES', blockNumber: '7' })).toBe('[BK 7] AP COMPUTER SCIENCE PRINCIPLES');
    expect(courseLabel({ courseName: 'AP CSP', blockNumber: null })).toBe('AP CSP');
    expect(courseLabel({ courseName: 'AP CSP' })).toBe('AP CSP');
  });

  it('APPROX_TITLE explains the ≈ marker', () => {
    expect(APPROX_TITLE).toMatch(/weekdays/);
  });
});

describe('courseTriageSummary — resubmissions', () => {
  it('counts resubmissions per course and in the red total', () => {
    const t = { lateWork: [], feedbackOwed: [], makeUps: [], resubmissions: [
      { courseId: 5, tone: 'red' }, { courseId: 5, tone: 'green' }, { courseId: 6, tone: 'amber' },
    ] };
    expect(courseTriageSummary(t, 5)).toMatchObject({ resubmissions: 2, resubmissionTone: 'red', worstTone: 'red', redResubmissions: 1 });
    expect(redCount(t)).toBe(1);
  });
});

describe('courseRedLine', () => {
  it('joins red-only segments with middle dots, in order: at limit, make-ups, resubmissions, feedback', () => {
    const summary = { atLimit: 2, redMakeUps: 1, redResubmissions: 5, feedbackRed: true, toGrade: 5, oldestDay: 16 };
    expect(courseRedLine(summary)).toBe('2 at limit · 1 make-up · 5 resubmissions · 5 to grade · 15 school days waiting');
  });

  it('singularises make-up and resubmission at 1, pluralises above 1', () => {
    expect(courseRedLine({ atLimit: 0, redMakeUps: 1, redResubmissions: 0, feedbackRed: false })).toBe('1 make-up');
    expect(courseRedLine({ atLimit: 0, redMakeUps: 2, redResubmissions: 0, feedbackRed: false })).toBe('2 make-ups');
    expect(courseRedLine({ atLimit: 0, redMakeUps: 0, redResubmissions: 1, feedbackRed: false })).toBe('1 resubmission');
    expect(courseRedLine({ atLimit: 0, redMakeUps: 0, redResubmissions: 3, feedbackRed: false })).toBe('3 resubmissions');
  });

  it('includes the feedback segment only when feedbackRed is true, using toGrade and oldestDay', () => {
    expect(courseRedLine({ atLimit: 0, redMakeUps: 0, redResubmissions: 0, feedbackRed: true, toGrade: 7, oldestDay: 9 })).toBe('7 to grade · 8 school days waiting');
    expect(courseRedLine({ atLimit: 0, redMakeUps: 0, redResubmissions: 0, feedbackRed: false, toGrade: 7, oldestDay: 9 })).toBe('');
  });

  it('is empty when nothing is red', () => {
    expect(courseRedLine({ atLimit: 0, redMakeUps: 0, redResubmissions: 0, feedbackRed: false })).toBe('');
  });
});

describe('redCount', () => {
  it('counts red rows across make-ups, late work and feedback owed', () => {
    const t = {
      makeUps: [{ tone: 'red' }, { tone: 'amber' }],
      lateWork: [{ tone: 'red' }, { tone: 'red' }, { tone: 'green' }],
      feedbackOwed: [{ tone: 'red' }],
    };
    expect(redCount(t)).toBe(4);
  });

  it('is 0 for no payload or missing lists', () => {
    expect(redCount(null)).toBe(0);
    expect(redCount({ lateWork: [] })).toBe(0);
  });
});
