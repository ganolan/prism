import { describe, it, expect } from 'vitest';
import { parseGradingPeriod, groupByAcademicYear, formatLastSynced } from './courseDisplay.js';

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
});

describe('groupByAcademicYear', () => {
  it('groups and sorts years descending', () => {
    const groups = groupByAcademicYear([
      { id: 1, grading_period: 'Semester 1: 08/14/2024 - 01/11/2025' },
      { id: 2, grading_period: 'Semester 1: 08/14/2025 - 01/11/2026' },
    ]);
    expect(groups.map((g) => g.year)).toEqual(['2025-26', '2024-25']);
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
