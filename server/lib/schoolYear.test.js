import { describe, test, expect } from 'vitest';
import { schoolYearOf } from './schoolYear.js';

describe('schoolYearOf', () => {
  test.each([
    ['2025-2026: 08/14/2025 - 06/17/2026', '2025-26', 'Full year'],
    ['2024-2025: 08/13/24 - 06/15/25', '2024-25', 'Full year'],
    ['Semester 1: 08/14/2025 - 01/11/2026', '2025-26', 'Semester 1'],
    ['Semester 2: 01/12/2026 - 06/17/2026', '2025-26', 'Semester 2'],
    ['Semester 2: 1/09/23 - 6/14/23', '2022-23', 'Semester 2'],
    ['Semester 1: 08/15/23 - 01/07/24', '2023-24', 'Semester 1'],
    ['HS 26-27', '2026-27', 'Full year'],
    ['HS 26-27 S1', '2026-27', 'Semester 1'],
    ['HS 26-27 S2', '2026-27', 'Semester 2'],
    ['21-22 S2', '2021-22', 'Semester 2'],
    ['21-22 YR', '2021-22', 'Full year'],
    ['22-23 Summer', '2022-23', 'Summer'],
  ])('%s -> %s %s', (title, year, term) => {
    expect(schoolYearOf(title)).toEqual({ school_year: year, term });
  });

  test('a title with no year gives nulls rather than a guess', () => {
    expect(schoolYearOf('Master Course (non expiring)')).toEqual({ school_year: null, term: null });
    expect(schoolYearOf(null)).toEqual({ school_year: null, term: null });
    expect(schoolYearOf('')).toEqual({ school_year: null, term: null });
  });

  test('a date range is not mistaken for a two-digit year pair', () => {
    // "06/15/25" contains "15/25", never read as "15-25".
    expect(schoolYearOf('Semester 2: 01/06/25 - 06/15/25').school_year).toBe('2024-25');
  });
});
