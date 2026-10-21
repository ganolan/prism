import { describe, test, expect } from 'vitest';
import { FLAG_CODES, isFlagCode, isNotDoingTask } from './flags.js';

describe('Schoology flag codes (#40, probed 21 October 2026)', () => {
  test('1 Exempt, 2 Incomplete, 3 Missing, 5 Absent, 6 Late; 4 is invalid', () => {
    expect(FLAG_CODES).toEqual([1, 2, 3, 5, 6]);
  });
  test('isFlagCode accepts numbers and numeric strings of those codes only', () => {
    for (const c of [1, 2, 3, 5, 6, '6']) expect(isFlagCode(c)).toBe(true);
    for (const c of [0, 4, 7, null, undefined, '', 'x']) expect(isFlagCode(c)).toBe(false);
  });
  test('isNotDoingTask: Exempt (1) and Absent (5) only, numbers or numeric strings', () => {
    for (const c of [1, 5, '5']) expect(isNotDoingTask(c)).toBe(true);
    for (const c of [0, 2, 3, 4, 6, null, undefined, '']) expect(isNotDoingTask(c)).toBe(false);
  });
});
