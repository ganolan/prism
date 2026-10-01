import { describe, it, expect } from 'vitest';
import { meterPct, courseTriageSummary, waitsByAssignment, courseLabel, APPROX_TITLE } from './triage.js';

const T = {
  lateWork: [
    { courseId: 1, tone: 'red' }, { courseId: 1, tone: 'amber' }, { courseId: 2, tone: 'green' },
  ],
  feedbackOwed: [
    { courseId: 1, owed: 7, oldestWaitDays: 8, tone: 'amber', schoologyAssignmentId: 'a1' },
    { courseId: 1, owed: 3, oldestWaitDays: 11, tone: 'red', schoologyAssignmentId: 'a2' },
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

  it('courseTriageSummary counts per course', () => {
    expect(courseTriageSummary(T, 1)).toEqual({ atLimit: 1, late: 1, toGrade: 10, oldestWait: 11, waitTone: 'red', makeUps: 2, makeUpTone: 'red' });
    expect(courseTriageSummary(T, 2)).toMatchObject({ makeUps: 1, makeUpTone: 'green' });
    expect(courseTriageSummary(T, 3)).toMatchObject({ makeUps: 1, makeUpTone: 'amber' });
    expect(courseTriageSummary(null, 1)).toEqual({ atLimit: 0, late: 0, toGrade: 0, oldestWait: 0, waitTone: 'green', makeUps: 0, makeUpTone: 'green' });
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
