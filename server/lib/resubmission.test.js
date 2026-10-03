import { describe, test, expect } from 'vitest';
import { hasFeedback, isResubmitted, resubmissionStateFromSnapshot, sqliteUtcToEpoch } from './resubmission.js';
import { fingerprint } from './feedbackFingerprint.js';

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

describe('resubmissionStateFromSnapshot', () => {
  const fpWithFeedback = fingerprint({ score: 80, exception: 0, comment: '', commentStatus: 0, levels: [] });
  const fpNoFeedback = fingerprint({ score: null, exception: 0, comment: '', commentStatus: 0, levels: [] });
  const fpChanged = fingerprint({ score: 90, exception: 0, comment: '', commentStatus: 0, levels: [] });

  test('unrequested: arrived when an arrival with feedback matches the current fingerprint', () => {
    const snapshot = { arrival_revision_at: 2000, arrival_baseline: fpWithFeedback };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpWithFeedback })).toBe('arrived');
  });

  test('unrequested: acknowledged once the current fingerprint differs from the baseline', () => {
    const snapshot = { arrival_revision_at: 2000, arrival_baseline: fpWithFeedback };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged })).toBe(null);
  });

  test('unrequested: a first submission (baseline without prior feedback) is never arrived', () => {
    const snapshot = { arrival_revision_at: 2000, arrival_baseline: fpNoFeedback };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpNoFeedback })).toBe(null);
  });

  test('unrequested: no arrival at all is null', () => {
    expect(resubmissionStateFromSnapshot({ snapshot: null, currentFingerprint: fpWithFeedback })).toBe(null);
    expect(resubmissionStateFromSnapshot({ snapshot: { arrival_revision_at: 0, arrival_baseline: fpWithFeedback }, currentFingerprint: fpWithFeedback })).toBe(null);
  });

  test('requested: waiting when there is no arrival after the ask', () => {
    expect(resubmissionStateFromSnapshot({ snapshot: null, currentFingerprint: fpWithFeedback, requestedAt: 1500 })).toBe('waiting');
    const snapshot = { arrival_revision_at: 1200, arrival_baseline: fpWithFeedback };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpWithFeedback, requestedAt: 1500 })).toBe('waiting');
  });

  test('requested: arrived when the post-ask arrival baseline matches the current fingerprint', () => {
    const snapshot = { arrival_revision_at: 1600, arrival_baseline: fpWithFeedback };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpWithFeedback, requestedAt: 1500 })).toBe('arrived');
  });

  test('requested: fulfilled once the current fingerprint moves past the post-ask arrival baseline', () => {
    const snapshot = { arrival_revision_at: 1600, arrival_baseline: fpWithFeedback };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, requestedAt: 1500 })).toBe('fulfilled');
  });

  test('requested: a pre-ask arrival does not satisfy the ask — still waiting', () => {
    const snapshot = { arrival_revision_at: 1400, arrival_baseline: fpWithFeedback };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpWithFeedback, requestedAt: 1500 })).toBe('waiting');
  });
});
