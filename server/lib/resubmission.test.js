import { describe, test, expect } from 'vitest';
import { isResubmitted } from './resubmission.js';

describe('isResubmitted', () => {
  test('true when latest revision is newer than the grade time', () => {
    expect(isResubmitted({ score: 80, submitted_at: 1000, latest_revision_at: 2000 })).toBe(true);
  });

  test('false when the latest revision predates the grade time', () => {
    expect(isResubmitted({ score: 80, submitted_at: 2000, latest_revision_at: 1000 })).toBe(false);
  });

  test('false when there is no grade (score null, no exception)', () => {
    expect(isResubmitted({ score: null, submitted_at: 1000, latest_revision_at: 2000 })).toBe(false);
  });

  test('true for an exception row that was resubmitted against', () => {
    expect(isResubmitted({ score: null, exception: 4, submitted_at: 1000, latest_revision_at: 2000 })).toBe(true);
  });

  test('false when submitted_at is 0 (grade time unknown)', () => {
    expect(isResubmitted({ score: 80, submitted_at: 0, latest_revision_at: 2000 })).toBe(false);
  });

  test('false when latest_revision_at is 0 (no revision data)', () => {
    expect(isResubmitted({ score: 80, submitted_at: 1000, latest_revision_at: 0 })).toBe(false);
  });

  test('false when the revision and grade times are equal', () => {
    expect(isResubmitted({ score: 80, submitted_at: 1000, latest_revision_at: 1000 })).toBe(false);
  });

  test('false for null / undefined input', () => {
    expect(isResubmitted(null)).toBe(false);
    expect(isResubmitted(undefined)).toBe(false);
  });
});
