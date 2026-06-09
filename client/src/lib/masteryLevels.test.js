import { describe, test, expect } from 'vitest';
import { makeScaleHelpers, LEVELS, LEVEL_COLORS, LEVEL_LABELS, masteryCodeForLevel } from './masteryLevels.js';

const TABLE = [
  { code: 'ED', label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' },
  { code: 'EX', label: 'Exhibiting', points: 75, gradeScaled: '62.50' },
  { code: 'D', label: 'Developing', points: 50, gradeScaled: '37.50' },
  { code: 'EM', label: 'Emerging', points: 25, gradeScaled: '12.50' },
  { code: 'IE', label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' },
];

test('static exports', () => {
  expect(LEVELS).toEqual(['ED', 'EX', 'D', 'EM', 'IE']);
  expect(LEVEL_COLORS.ED.headerFill).toBe('#bfdbfe');
  expect(LEVEL_LABELS.EX).toBe('Exhibiting');
  expect(masteryCodeForLevel('Exhibiting')).toBe('EX');
});

test('makeScaleHelpers binds the table', () => {
  const h = makeScaleHelpers(TABLE);
  expect(h.pointsToLevel(80)).toBe('EX');
  expect(h.pointsToLevel(12.49)).toBe('IE');
  expect(h.levelToPoints('EX')).toBe(75);
  expect(h.levelToGradeScaled('EX')).toBe('62.50');
  expect(h.computeLetterGrade(['ED', 'ED'])).toBe('A');
});

test('client LEVEL_LABELS matches the canonical labels (drift guard)', () => {
  expect(TABLE.map((l) => LEVEL_LABELS[l.code])).toEqual(TABLE.map((l) => l.label));
});
