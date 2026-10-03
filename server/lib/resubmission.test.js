import { describe, test, expect } from 'vitest';
import { hasFeedback, isResubmitted, resubmissionState, sqliteUtcToEpoch } from './resubmission.js';

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

describe('hasFeedback', () => {
  test('score, exception or a non-empty comment', () => {
    expect(hasFeedback({ score: 0 })).toBe(true);
    expect(hasFeedback({ score: null, exception: 3 })).toBe(true);
    expect(hasFeedback({ score: null, exception: 0, grade_comment: ' Fix the intro ' })).toBe(true);
    expect(hasFeedback({ score: null, exception: 0, grade_comment: '   ' })).toBe(false);
    expect(hasFeedback(null)).toBe(false);
  });
});

describe('isResubmitted — comment-only feedback counts', () => {
  test('a revision after a comment-only grade time is a resubmission', () => {
    expect(isResubmitted({ score: null, exception: 0, grade_comment: 'Redo Q2', submitted_at: 100, latest_revision_at: 200 })).toBe(true);
  });
  test('no feedback at all is never a resubmission', () => {
    expect(isResubmitted({ score: null, exception: 0, grade_comment: '', submitted_at: 100, latest_revision_at: 200 })).toBe(false);
  });
});

describe('sqliteUtcToEpoch', () => {
  test('reads SQLite UTC datetimes', () => {
    expect(sqliteUtcToEpoch('2026-10-12 04:00:00')).toBe(Date.parse('2026-10-12T04:00:00Z') / 1000);
    expect(sqliteUtcToEpoch(null)).toBe(0);
  });
});

describe('resubmissionState', () => {
  const graded = { score: 80, exception: 0, grade_comment: '', submitted_at: 1000 };
  test('unrequested: arrived when the revision is newer than the grade time', () => {
    expect(resubmissionState({ ...graded, latest_revision_at: 2000 })).toBe('arrived');
    expect(resubmissionState({ ...graded, latest_revision_at: 900 })).toBe(null);
  });
  test('unrequested: a review covering the revision hides it; a newer one reappears', () => {
    expect(resubmissionState({ ...graded, latest_revision_at: 2000 }, { reviewedThrough: 2000 })).toBe(null);
    expect(resubmissionState({ ...graded, latest_revision_at: 3000 }, { reviewedThrough: 2000 })).toBe('arrived');
  });
  test('request: waiting until a revision newer than both the grade time and the ask', () => {
    expect(resubmissionState({ ...graded, latest_revision_at: 900 }, { requestedAt: 1500 })).toBe('waiting');
    expect(resubmissionState({ ...graded, latest_revision_at: 1200 }, { requestedAt: 1500 })).toBe('waiting');
    expect(resubmissionState({ ...graded, latest_revision_at: 1600 }, { requestedAt: 1500 })).toBe('arrived');
  });
  test('request: works with no grades row and no feedback (baseline = the ask)', () => {
    expect(resubmissionState({}, { requestedAt: 1500 })).toBe('waiting');
    expect(resubmissionState({ latest_revision_at: 1600 }, { requestedAt: 1500 })).toBe('arrived');
  });
  test('request: fulfilled once regraded after the post-ask revision', () => {
    expect(resubmissionState({ ...graded, submitted_at: 1700, latest_revision_at: 1600 }, { requestedAt: 1500 })).toBe('fulfilled');
  });
  test('request: reviewed post-ask revision is fulfilled; reviewed pre-ask revision is still waiting', () => {
    expect(resubmissionState({ ...graded, latest_revision_at: 1600 }, { requestedAt: 1500, reviewedThrough: 1600 })).toBe('fulfilled');
    expect(resubmissionState({ ...graded, latest_revision_at: 1200 }, { requestedAt: 1500, reviewedThrough: 1200 })).toBe('waiting');
  });
});
