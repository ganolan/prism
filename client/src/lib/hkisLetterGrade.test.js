import { describe, it, expect } from 'vitest';
import { HKIS_CHART, CHART_COUNTS, comboKey, comboLevels, hkisLetterGrade, isInferred } from './hkisLetterGrade.js';
import { computeLetterGrade } from './masteryLevels.js';

// Every combination of ED/EX/D/EM for n categories, as count keys.
function allKeys(n) {
  const keys = [];
  for (let ed = 0; ed <= n; ed++) for (let ex = 0; ed + ex <= n; ex++) for (let d = 0; ed + ex + d <= n; d++) {
    keys.push(`${ed}${ex}${d}${n - ed - ex - d}`);
  }
  return keys;
}

describe('HKIS letter grade chart', () => {
  it('lists every combination exactly once for 2 to 5 categories', () => {
    for (const n of CHART_COUNTS) {
      const listed = Object.values(HKIS_CHART[n]).flat();
      expect(new Set(listed).size).toBe(listed.length);
      expect([...listed].sort()).toEqual(allKeys(n).sort());
    }
  });

  it('grades every cell of the chart as the chart states', () => {
    for (const n of CHART_COUNTS) {
      for (const [letter, keys] of Object.entries(HKIS_CHART[n])) {
        for (const key of keys) expect(hkisLetterGrade(comboLevels(key))).toBe(letter);
      }
    }
  });

  it('matches cells from the HKIS chart', () => {
    expect(hkisLetterGrade(['ED', 'EM'])).toBe('C');
    expect(hkisLetterGrade(['EM', 'EM'])).toBe('D');
    expect(hkisLetterGrade(['ED', 'ED', 'ED', 'EX'])).toBe('A');
    expect(hkisLetterGrade(['ED', 'EX', 'EX'])).toBe('A-');
    expect(hkisLetterGrade(['EX', 'EX', 'EM', 'EM'])).toBe('D');
    expect(hkisLetterGrade(['ED', 'ED', 'ED', 'EM', 'EM'])).toBe('C');
  });

  it('ignores the order of the categories', () => {
    expect(hkisLetterGrade(['D', 'EX', 'ED'])).toBe(hkisLetterGrade(['ED', 'EX', 'D']));
  });

  it('gives F for any IE', () => {
    expect(hkisLetterGrade(['ED', 'IE'])).toBe('F');
    expect(hkisLetterGrade(['ED', 'ED', 'ED', 'ED', 'IE'])).toBe('F');
  });

  it('uses C for the one combination missing from the chart, and marks it', () => {
    expect(hkisLetterGrade(['ED', 'EX', 'D', 'D', 'EM'])).toBe('C');
    expect(isInferred(5, '1121')).toBe(true);
    expect(isInferred(4, '1111')).toBe(false);
  });

  it('gives no grade while a category has no level, or outside 2 to 5 categories', () => {
    expect(hkisLetterGrade([])).toBeNull();
    expect(hkisLetterGrade(['ED', null])).toBeNull();
    expect(hkisLetterGrade(['ED'])).toBeNull();
    expect(hkisLetterGrade(['ED', 'ED', 'ED', 'ED', 'ED', 'ED'])).toBeNull();
  });

  it('is what computeLetterGrade returns', () => {
    expect(computeLetterGrade(['ED', 'EM'])).toBe('C');
    expect(computeLetterGrade(['ED'])).toBeNull();
  });

  it('counts levels into a key and back', () => {
    expect(comboKey(['EX', 'ED', 'ED'])).toBe('2100');
    expect(comboLevels('1021')).toEqual(['ED', 'D', 'D', 'EM']);
  });
});
