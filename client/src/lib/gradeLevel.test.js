import { describe, it, expect } from 'vitest';
import { schoolYearEndYear, gradYearToLevel, formatGradeBadge } from './gradeLevel.js';

const JAN_2026 = new Date('2026-01-15'); // school year ending 2026
const AUG_2025 = new Date('2025-08-15'); // first day of school year ending 2026
const JUL_2025 = new Date('2025-07-15'); // still school year ending 2025

describe('schoolYearEndYear', () => {
  it('rolls over in August (month index >= 7)', () => {
    expect(schoolYearEndYear(AUG_2025)).toBe(2026);
    expect(schoolYearEndYear(JAN_2026)).toBe(2026);
    expect(schoolYearEndYear(JUL_2025)).toBe(2025);
  });
});

describe('gradYearToLevel', () => {
  it('derives the current grade from grad_year', () => {
    expect(gradYearToLevel(2026, JAN_2026)).toBe(12);
    expect(gradYearToLevel(2027, JAN_2026)).toBe(11);
    expect(gradYearToLevel(2029, JAN_2026)).toBe(9);
  });
  it('returns null for a graduated student (derived grade out of 1–12)', () => {
    expect(gradYearToLevel(2025, JAN_2026)).toBeNull(); // would be grade 13
  });
  it('returns null when grad_year is missing', () => {
    expect(gradYearToLevel(null, JAN_2026)).toBeNull();
    expect(gradYearToLevel(0, JAN_2026)).toBeNull();
  });
});

describe('formatGradeBadge', () => {
  it('labels an active student with grade and class', () => {
    expect(formatGradeBadge(2027, JAN_2026)).toEqual({ grade: 11, classOf: 2027, label: 'Grade 11 · Class of 2027' });
  });
  it('labels a departed student with class only', () => {
    expect(formatGradeBadge(2025, JAN_2026)).toEqual({ grade: null, classOf: 2025, label: 'Class of 2025' });
  });
  it('returns null when grad_year is missing', () => {
    expect(formatGradeBadge(null, JAN_2026)).toBeNull();
  });
});
