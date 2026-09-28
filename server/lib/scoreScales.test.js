import { describe, test, expect } from 'vitest';
import { findScoreScale, levelForScore, isScalePoints } from './scoreScales.js';

const COMPLETION = {
  schoologyScaleId: 7165818, name: 'Completion Scale', bulkLevel: 'C',
  levels: [{ code: 'C', label: 'Completed', points: 100, cutoff: 80 }, { code: 'I', label: 'Incomplete', points: 0, cutoff: 0 }],
};
const GAS = {
  schoologyScaleId: 23495360, name: 'General Academic Scale (Unaligned)',
  levels: [
    { code: 'ED', label: 'Exhibiting Depth', points: 100, cutoff: 87.5 },
    { code: 'EX', label: 'Exhibiting', points: 75, cutoff: 62.5 },
    { code: 'D', label: 'Developing', points: 50, cutoff: 37.5 },
    { code: 'EM', label: 'Emerging', points: 25, cutoff: 12.5 },
    { code: 'IE', label: 'Insufficient Evidence', points: 0, cutoff: 0 },
  ],
};
const SCALES = [COMPLETION, GAS];

describe('findScoreScale', () => {
  test('matches the assignment\'s Schoology scale id (string or number)', () => {
    expect(findScoreScale(SCALES, '23495360')).toBe(GAS);
    expect(findScoreScale(SCALES, 7165818)).toBe(COMPLETION);
  });
  test('null for an unsupported or missing scale', () => {
    expect(findScoreScale(SCALES, '21337256')).toBeNull();
    expect(findScoreScale(SCALES, null)).toBeNull();
    expect(findScoreScale(undefined, '7165818')).toBeNull();
  });
});

describe('levelForScore', () => {
  test('buckets by cutoff — the highest level whose cutoff ≤ score', () => {
    expect(levelForScore(GAS, 100)).toBe('ED');
    expect(levelForScore(GAS, 75)).toBe('EX');
    expect(levelForScore(GAS, 50)).toBe('D');
    expect(levelForScore(GAS, 25)).toBe('EM');
    expect(levelForScore(GAS, 0)).toBe('IE');
  });
  test('legacy off-average scores still resolve (as Schoology buckets them)', () => {
    expect(levelForScore(GAS, 95)).toBe('ED');
    expect(levelForScore(GAS, 87.5)).toBe('ED');
    expect(levelForScore(GAS, 80)).toBe('EX');
    expect(levelForScore(GAS, 62.5)).toBe('EX');
    expect(levelForScore(COMPLETION, 80)).toBe('C');
    expect(levelForScore(COMPLETION, 79)).toBe('I');
  });
  test('null when there is no score', () => {
    expect(levelForScore(GAS, null)).toBeNull();
    expect(levelForScore(GAS, undefined)).toBeNull();
    expect(levelForScore(GAS, '')).toBeNull();
  });
});

describe('isScalePoints', () => {
  test('only a level\'s own points value may be written', () => {
    expect(isScalePoints(GAS, 75)).toBe(true);
    expect(isScalePoints(GAS, '50')).toBe(true);
    expect(isScalePoints(GAS, 80)).toBe(false);
    expect(isScalePoints(COMPLETION, 100)).toBe(true);
    expect(isScalePoints(COMPLETION, 'abc')).toBe(false);
  });
});
