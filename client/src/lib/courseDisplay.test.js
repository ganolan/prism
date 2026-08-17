import { describe, it, expect } from 'vitest';
import { parseGradingPeriod, groupBySemester, groupByYearAndSemester, formatLastSynced } from './courseDisplay.js';

describe('parseGradingPeriod', () => {
  it('extracts academic year and Semester 1', () => {
    expect(parseGradingPeriod('Semester 1: 08/14/2025 - 01/11/2026'))
      .toEqual({ academicYear: '2025-26', semester: 'Semester 1' });
  });
  it('defaults to Full Year when no semester marker', () => {
    expect(parseGradingPeriod('08/14/2025 - 06/01/2026').semester).toBe('Full Year');
  });
  it('returns Unknown for empty input', () => {
    expect(parseGradingPeriod('')).toEqual({ academicYear: 'Unknown', semester: 'Unknown' });
  });
  it('prefers the explicit 4-digit year range over date inference', () => {
    expect(parseGradingPeriod('2024-2025: 08/13/24 - 06/15/25'))
      .toEqual({ academicYear: '2024-25', semester: 'Full Year' });
  });
  it('handles single-digit months (was Unknown before)', () => {
    expect(parseGradingPeriod('Semester 1: 8/15/22 - 1/08/23'))
      .toEqual({ academicYear: '2022-23', semester: 'Semester 1' });
  });
  it('reads an abbreviated year range + YR token', () => {
    expect(parseGradingPeriod('22-23 YR · 8/07/22 - 6/14/23'))
      .toEqual({ academicYear: '2022-23', semester: 'Full Year' });
  });
  it('reads an abbreviated year range + S2 token', () => {
    expect(parseGradingPeriod('21-22 S2 · 1/04/22 - 6/15/22'))
      .toEqual({ academicYear: '2021-22', semester: 'Semester 2' });
  });
  it('recognises a Summer term', () => {
    expect(parseGradingPeriod('22-23 Summer · 6/06/22 - 6/20/22'))
      .toEqual({ academicYear: '2022-23', semester: 'Summer' });
  });
  it('returns Unknown year (Full Year) for a string with no date/year/term', () => {
    expect(parseGradingPeriod('mystery')).toEqual({ academicYear: 'Unknown', semester: 'Full Year' });
  });
});

describe('groupBySemester', () => {
  it('orders Full Year first, then Semester 1, then Semester 2', () => {
    const groups = groupBySemester([
      { id: 1, grading_period: 'Semester 2: 01/06/2026 - 06/15/2026' },
      { id: 2, grading_period: '2025-2026: 08/14/2025 - 06/01/2026' }, // Full Year
      { id: 3, grading_period: 'Semester 1: 08/14/2025 - 01/11/2026' },
    ]);
    expect(groups.map((g) => g.semester)).toEqual(['Full Year', 'Semester 1', 'Semester 2']);
    expect(groups.map((g) => g.courses.map((c) => c.id))).toEqual([[2], [3], [1]]);
  });

  it('keeps Summer and Unknown after the numbered semesters', () => {
    const groups = groupBySemester([
      { id: 1, grading_period: '' },                                     // Unknown
      { id: 2, grading_period: '25-26 Summer · 6/06/26 - 6/20/26' },
      { id: 3, grading_period: 'Semester 2: 01/06/2026 - 06/15/2026' },
    ]);
    expect(groups.map((g) => g.semester)).toEqual(['Semester 2', 'Summer', 'Unknown']);
  });

  it('accepts a getPeriod accessor', () => {
    const groups = groupBySemester(
      [{ sectionId: 'x', gradingPeriod: '22-23 YR · 8/07/22 - 6/14/23' }],
      (s) => s.gradingPeriod,
    );
    expect(groups[0].semester).toBe('Full Year');
  });

  it('returns [] for no courses', () => {
    expect(groupBySemester([])).toEqual([]);
  });
});

describe('groupByYearAndSemester', () => {
  it('groups by year (desc, Unknown last) then ordered semesters', () => {
    const groups = groupByYearAndSemester([
      { id: 1, grading_period: 'Semester 2: 01/06/2025 - 06/15/2025' }, // 2024-25 S2
      { id: 2, grading_period: 'Semester 1: 08/14/2024 - 01/11/2025' }, // 2024-25 S1
      { id: 3, grading_period: 'Semester 1: 08/14/2025 - 01/11/2026' }, // 2025-26 S1
      { id: 4, grading_period: 'mystery' },                              // Unknown / Full Year
      { id: 5, grading_period: '2024-2025: 08/13/24 - 06/15/25' },       // 2024-25 Full Year
    ]);
    expect(groups.map((g) => g.year)).toEqual(['2025-26', '2024-25', 'Unknown']);
    const y2024 = groups.find((g) => g.year === '2024-25');
    expect(y2024.semesters.map((s) => s.semester)).toEqual(['Full Year', 'Semester 1', 'Semester 2']);
    expect(y2024.semesters[0].courses.map((c) => c.id)).toEqual([5]);
    const unknown = groups.find((g) => g.year === 'Unknown');
    expect(unknown.semesters[0].courses.map((c) => c.id)).toEqual([4]);
  });

  it('accepts a getPeriod accessor for discovery rows', () => {
    const groups = groupByYearAndSemester(
      [{ sectionId: 'x', gradingPeriod: '22-23 YR · 8/07/22 - 6/14/23' }],
      (s) => s.gradingPeriod,
    );
    expect(groups[0].year).toBe('2022-23');
    expect(groups[0].semesters[0].semester).toBe('Full Year');
  });

  it('returns [] for no courses', () => {
    expect(groupByYearAndSemester([])).toEqual([]);
  });
});

describe('formatLastSynced', () => {
  it('returns "never synced" for null', () => {
    expect(formatLastSynced(null)).toBe('never synced');
  });
  it('formats an ISO timestamp', () => {
    expect(formatLastSynced('2026-05-31T00:00:00Z')).toMatch(/^synced /);
  });
  it('returns "never synced" for an unparseable string', () => {
    expect(formatLastSynced('not-a-date')).toBe('never synced');
  });
  it('formats in UK/AU DD/MM/YYYY order', () => {
    // noon UTC → same calendar day in all realistic timezones
    expect(formatLastSynced('2026-05-20T12:00:00Z')).toBe('synced 20/05/2026');
  });
});
