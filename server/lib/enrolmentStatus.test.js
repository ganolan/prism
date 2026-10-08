import { describe, test, expect } from 'vitest';
import { isActiveEnrolment, droppedAtFor } from './enrolmentStatus.js';

describe('droppedAtFor', () => {
  const now = '2026-10-08T00:00:00Z';

  test('a current section: active stays enrolled, status 5 is dropped now', () => {
    expect(droppedAtFor({ status: '1' }, { now })).toBeNull();
    expect(droppedAtFor({ status: '5' }, { now })).toBe(now);
  });

  test('an archived section reports everyone as "2": that keeps them enrolled, not dropped', () => {
    expect(droppedAtFor({ status: '2' }, { archivedSection: true, now })).toBeNull();
  });

  test('an archived section keeps a drop Prism recorded while the course was current', () => {
    expect(droppedAtFor({ status: '2' }, { archivedSection: true, previousDroppedAt: '2026-03-01T00:00:00Z', now })).toBe('2026-03-01T00:00:00Z');
  });

  test('"2" outside an archived section is still an unknown code, so dropped (visible)', () => {
    expect(droppedAtFor({ status: '2' }, { now })).toBe(now);
  });
});

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
