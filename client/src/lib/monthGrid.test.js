import { describe, it, expect } from 'vitest';
import { monthGrid, monthRange, stepMonth, monthOf } from './monthGrid.js';

describe('monthGrid (#39)', () => {
  it('October 2026: weeks of Monday to Friday, days outside the month empty, no weekends', () => {
    const g = monthGrid(2026, 9);
    expect(g.label).toBe('October 2026');
    expect(g.weeks[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02']); // 1 Oct 2026 is a Thursday
    expect(g.weeks[1]).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    expect(g.weeks.at(-1)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']);
    expect(g.weeks.flat().filter(Boolean)).toHaveLength(22);
  });
  it('ranges and steps across a year end', () => {
    expect(monthRange(2026, 1)).toEqual(['2026-02-01', '2026-02-28']);
    expect(stepMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    expect(monthOf('2026-10-29')).toEqual({ year: 2026, month: 9 });
  });
});
