import { describe, test, expect } from 'vitest';
import { isActiveEnrolment } from './enrolmentStatus.js';

describe('isActiveEnrolment (#128)', () => {
  test('status "1" (the observed active value) is active', () => {
    expect(isActiveEnrolment({ status: '1' })).toBe(true);
  });

  test('status "5" (the observed dropped value) is not active', () => {
    expect(isActiveEnrolment({ status: '5' })).toBe(false);
  });

  test('accepts a numeric status — Schoology types are inconsistent', () => {
    expect(isActiveEnrolment({ status: 1 })).toBe(true);
    expect(isActiveEnrolment({ status: 5 })).toBe(false);
  });

  test('missing or empty status is treated as active, never a roster wipe', () => {
    expect(isActiveEnrolment({})).toBe(true);
    expect(isActiveEnrolment({ status: null })).toBe(true);
    expect(isActiveEnrolment({ status: '' })).toBe(true);
  });

  test('an unrecognised code is inactive — surfaced by the roster dropped count', () => {
    // Deliberate: unknown codes land somewhere visible rather than silently
    // rejoining the roster. See the module docstring for the rationale.
    expect(isActiveEnrolment({ status: '9' })).toBe(false);
  });

  test('a non-object is not active', () => {
    expect(isActiveEnrolment(null)).toBe(false);
    expect(isActiveEnrolment(undefined)).toBe(false);
  });
});
