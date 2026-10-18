import { describe, test, expect } from 'vitest';
import {
  currentSchoolYearEndYear,
  gradeLevelToGradYear,
  pickInSessionRange,
  extractGradeLevels,
  userDcidFromLaunchForm,
  parseGradeLevel,
  studentIdFromPhotoUrl,
  extractStudentListGradeLevels,
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

describe('parseGradeLevel', () => {
  test('integers stay, digit strings become integers', () => {
    expect(parseGradeLevel(10)).toBe(10);
    expect(parseGradeLevel('11')).toBe(11);
    expect(parseGradeLevel('09')).toBe(9);
    expect(parseGradeLevel(' 9')).toBe(9);
  });
  test('anything else is null', () => {
    expect(parseGradeLevel(null)).toBeNull();
    expect(parseGradeLevel('')).toBeNull();
    expect(parseGradeLevel('K')).toBeNull();
    expect(parseGradeLevel(10.5)).toBeNull();
    expect(parseGradeLevel('10a')).toBeNull();
  });
});

describe('studentIdFromPhotoUrl', () => {
  test('reads the PowerSchool studentid from the photo path', () => {
    expect(studentIdFromPhotoUrl('/teachers/stpnormal/41683ph.jpeg')).toBe('41683');
    expect(studentIdFromPhotoUrl('https://powerschool.hkis.edu.hk/teachers/stpnormal/7ph.jpeg?x=1')).toBe('7');
  });
  test('null when the path has no id', () => {
    expect(studentIdFromPhotoUrl('')).toBeNull();
    expect(studentIdFromPhotoUrl(null)).toBeNull();
    expect(studentIdFromPhotoUrl('/images/nophoto.png')).toBeNull();
  });
});

describe('extractStudentListGradeLevels', () => {
  const list = (students) => ({ 'student-list': { students } });
  const roster = [
    { studentid: 41683, studentdcid: 41533 },
    { studentid: '50001', studentdcid: '58808' },
    {},
  ];
  test('joins each student to its dcid through the photo URL and the roster', () => {
    const json = list([
      { id: '1234567', gradeLevel: '10', photoURL: '/teachers/stpnormal/41683ph.jpeg' },
      { id: '7654321', gradeLevel: '09', photoURL: '/teachers/stpnormal/50001ph.jpeg' },
    ]);
    expect(extractStudentListGradeLevels(json, roster)).toEqual({
      grades: [{ dcid: '41533', gradeLevel: 10 }, { dcid: '58808', gradeLevel: 9 }],
      listed: 2, unjoined: 0, noGrade: 0,
    });
  });
  test('counts students it cannot join or that carry no grade, and skips them', () => {
    const json = list([
      { id: '1', gradeLevel: '10', photoURL: '/teachers/stpnormal/99999ph.jpeg' }, // not on the roster
      { id: '2', gradeLevel: '10', photoURL: '' },                                  // no id in the photo path
      { id: '3', gradeLevel: '', photoURL: '/teachers/stpnormal/41683ph.jpeg' },    // no grade
    ]);
    expect(extractStudentListGradeLevels(json, roster)).toEqual({ grades: [], listed: 3, unjoined: 2, noGrade: 1 });
  });
  test('empty or garbage input', () => {
    expect(extractStudentListGradeLevels(null, roster)).toEqual({ grades: [], listed: 0, unjoined: 0, noGrade: 0 });
    expect(extractStudentListGradeLevels(list([{ gradeLevel: '10', photoURL: '/teachers/stpnormal/41683ph.jpeg' }]), null))
      .toEqual({ grades: [], listed: 1, unjoined: 1, noGrade: 0 });
  });
});
