import { describe, test, expect } from 'vitest';
import {
  LEVELS, normalizeLevel, pointsToLevel, levelToPoints,
  levelToGradeScaled, gradeScaledValues, levelToLabel, schoologyScaleId, getScaleTable,
} from './proficiencyScale.js';

describe('proficiencyScale', () => {
  test('LEVELS is ordered best→worst', () => {
    expect(LEVELS).toEqual(['ED', 'EX', 'D', 'EM', 'IE']);
  });

  test('normalizeLevel accepts names and codes, case-insensitively', () => {
    expect(normalizeLevel('Exhibiting Depth')).toBe('ED');
    expect(normalizeLevel('  ed ')).toBe('ED');
    expect(normalizeLevel('IE')).toBe('IE');
  });

  test('normalizeLevel rejects numerics and unknowns', () => {
    expect(normalizeLevel('75')).toBeNull();
    expect(normalizeLevel(75)).toBeNull();
    expect(normalizeLevel('A+')).toBeNull();
  });

  test('pointsToLevel bands on the gradeScaled cutoffs', () => {
    expect(pointsToLevel(100)).toBe('ED');
    expect(pointsToLevel(87.5)).toBe('ED');
    expect(pointsToLevel(87.49)).toBe('EX');
    expect(pointsToLevel(80)).toBe('EX');
    expect(pointsToLevel(62.5)).toBe('EX');
    expect(pointsToLevel(12.5)).toBe('EM');
    expect(pointsToLevel(12.49)).toBe('IE');
    expect(pointsToLevel(0)).toBe('IE');
    expect(pointsToLevel(null)).toBeNull();
  });

  test('forward maps', () => {
    expect(levelToPoints('EX')).toBe(75);
    expect(levelToGradeScaled('EX')).toBe('62.50');
    expect(levelToLabel('EX')).toBe('Exhibiting');
    expect(schoologyScaleId()).toBe(21337256);
  });

  test('gradeScaledValues is the valid override set', () => {
    expect([...gradeScaledValues()].sort()).toEqual(['0.00', '12.50', '37.50', '62.50', '87.50']);
  });

  test('getScaleTable returns the ordered bundle', () => {
    expect(getScaleTable().map((l) => l.code)).toEqual(LEVELS);
  });
});
