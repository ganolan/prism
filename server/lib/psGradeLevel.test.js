import { describe, test, expect } from 'vitest';
import {
  currentSchoolYearEndYear,
  gradeLevelToGradYear,
  pickInSessionRange,
  extractGradeLevels,
  userDcidFromLaunchForm,
} from './psGradeLevel.js';

describe('currentSchoolYearEndYear', () => {
  test('rolls over in August', () => {
    expect(currentSchoolYearEndYear(new Date('2025-08-15'))).toBe(2026);
    expect(currentSchoolYearEndYear(new Date('2026-01-15'))).toBe(2026);
    expect(currentSchoolYearEndYear(new Date('2025-07-15'))).toBe(2025);
  });
});

describe('gradeLevelToGradYear', () => {
  test('grad_year = schoolYearEndYear + (12 − gradeLevel)', () => {
    expect(gradeLevelToGradYear(12, 2026)).toBe(2026);
    expect(gradeLevelToGradYear(11, 2026)).toBe(2027);
    expect(gradeLevelToGradYear(9, 2026)).toBe(2029);
  });
  test('returns null for a non-integer grade', () => {
    expect(gradeLevelToGradYear(null, 2026)).toBeNull();
    expect(gradeLevelToGradYear('11', 2026)).toBeNull();
  });
});

describe('pickInSessionRange', () => {
  const cal = {
    '2026-06-01': { inSession: true },
    '2026-06-02': { inSession: true },
    '2026-06-03': { inSession: false }, // weekend/holiday
    '2026-06-04': { inSession: true },
    '2026-06-05': { inSession: true },
    '2026-06-08': { inSession: true },
  };
  // in-session sorted: [06-01, 06-02, 06-04, 06-05, 06-08]
  test('window ending at the most recent in-session day on or before today', () => {
    expect(pickInSessionRange({ calenderDays: cal }, '2026-06-06', 3)).toEqual({ startDate: '2026-06-02', endDate: '2026-06-05' });
  });
  test('clamps to the earliest in-session day when the window is larger than history', () => {
    expect(pickInSessionRange({ calenderDays: cal }, '2026-06-30', 10)).toEqual({ startDate: '2026-06-01', endDate: '2026-06-08' });
  });
  test('spans forward from the earliest in-session day when the year has not started', () => {
    expect(pickInSessionRange({ calenderDays: cal }, '2026-05-01', 3)).toEqual({ startDate: '2026-06-01', endDate: '2026-06-04' });
  });
  test('null when no in-session days exist', () => {
    expect(pickInSessionRange({ calenderDays: { '2026-06-03': { inSession: false } } }, '2026-06-10', 3)).toBeNull();
    expect(pickInSessionRange({}, '2026-06-10', 3)).toBeNull();
  });
});

describe('extractGradeLevels', () => {
  test('pulls { dcid, gradeLevel } from the nested roster', () => {
    const json = {
      sectionAttendances: [{
        studentAttendance: [
          { dcid: 42302, gradeLevel: 10, lastName: 'X' },
          { dcid: 52516, gradeLevel: 11, lastName: 'Y' },
          { dcid: 99999, lastName: 'Z' }, // no gradeLevel → skipped
        ],
      }],
    };
    expect(extractGradeLevels(json)).toEqual([
      { dcid: '42302', gradeLevel: 10 },
      { dcid: '52516', gradeLevel: 11 },
    ]);
  });
  test('empty/garbage input → []', () => {
    expect(extractGradeLevels(null)).toEqual([]);
    expect(extractGradeLevels({})).toEqual([]);
  });
});

describe('userDcidFromLaunchForm', () => {
  test('extracts custom_userdcid and strips the realm prefix', () => {
    expect(userDcidFromLaunchForm('<input name="custom_userdcid" value="2_10405">')).toBe('10405');
  });
  test('null when absent or empty', () => {
    expect(userDcidFromLaunchForm('<input name="custom_sectiondcid" value="49355">')).toBeNull();
    expect(userDcidFromLaunchForm('<input name="custom_userdcid" value="">')).toBeNull();
  });
});
