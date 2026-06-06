import { describe, it, expect } from 'vitest';
import { filterRecentAssignments, clampDays } from './recentWindow.js';

// Fixed reference instant → cutoff for 30 days is 2026-05-07.
const NOW = '2026-06-06T00:00:00.000Z';
const recent = { id: 'r', due: '2026-06-01' };  // within window
const old = { id: 'o', due: '2026-01-01' };     // > 30 days ago
const future = { id: 'f', due: '2026-12-01' };  // not yet due
const undated = { id: 'u', due: null };         // no due date
const all = [recent, old, future, undated];

describe('filterRecentAssignments', () => {
  it('passes everything through with no skips when recentOnly is off', () => {
    expect(filterRecentAssignments(all, false, 30, NOW)).toEqual({ target: all, windowSkipped: 0 });
  });

  it('keeps recent + future dated, skips old + undated when recentOnly is on', () => {
    const { target, windowSkipped } = filterRecentAssignments(all, true, 30, NOW);
    expect(target.map((a) => a.id)).toEqual(['r', 'f']);
    expect(windowSkipped).toBe(2);
  });

  it('treats an unparseable due date as undated (skipped)', () => {
    const { target } = filterRecentAssignments([{ id: 'x', due: 'not-a-date' }], true, 30, NOW);
    expect(target).toEqual([]);
  });

  it('widens the window with a larger recentDays', () => {
    const { target } = filterRecentAssignments(all, true, 365, NOW);
    expect(target.map((a) => a.id)).toEqual(['r', 'o', 'f']); // old now inside 365d
  });
});

describe('clampDays', () => {
  it('floors and clamps into 1..365, defaulting on non-numbers', () => {
    expect(clampDays(30)).toBe(30);
    expect(clampDays(0)).toBe(1);
    expect(clampDays(500)).toBe(365);
    expect(clampDays(12.9)).toBe(12);
    expect(clampDays('abc')).toBe(30);
    expect(clampDays(undefined)).toBe(30);
    expect(clampDays(50, 7)).toBe(50);
  });
});
