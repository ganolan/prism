import { describe, test, expect } from 'vitest';
import { FLAG_CODES, FINAL_FLAGS, isFlagCode, isExempt, isFinalFlag, isMarker } from './flags.js';

describe('Schoology flag codes (#40, probed 21 October 2026)', () => {
  test('1 Exempt, 2 Incomplete, 3 Missing, 5 Absent, 6 Late; 4 is invalid', () => {
    expect(FLAG_CODES).toEqual([1, 2, 3, 5, 6]);
  });
  test('isFlagCode accepts numbers and numeric strings of those codes only', () => {
    for (const c of [1, 2, 3, 5, 6, '6']) expect(isFlagCode(c)).toBe(true);
    for (const c of [0, 4, 7, null, undefined, '', 'x']) expect(isFlagCode(c)).toBe(false);
  });
  test('isExempt: Exempt (1) only, number or numeric string; Absent (5) is a marker, not a decision', () => {
    for (const c of [1, '1']) expect(isExempt(c)).toBe(true);
    for (const c of [0, 2, 3, 4, 5, '5', 6, null, undefined, '']) expect(isExempt(c)).toBe(false);
  });
  test('final flags: Exempt (1) and Missing (3); markers: Incomplete (2), Absent (5), Late (6) (Graham, 21 Oct 2026)', () => {
    expect(FINAL_FLAGS).toEqual([1, 3]);
    for (const c of [1, 3, '3']) expect(isFinalFlag(c)).toBe(true);
    for (const c of [0, 2, 4, 5, 6, null, undefined, '']) expect(isFinalFlag(c)).toBe(false);
    for (const c of [2, 5, 6, '6']) expect(isMarker(c)).toBe(true);
    for (const c of [0, 1, 3, 4, null, undefined, '']) expect(isMarker(c)).toBe(false);
  });
});
