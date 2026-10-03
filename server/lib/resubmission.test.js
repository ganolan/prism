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
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, gradedAt: 2500 })).toBe(null);
  });

  // Final review C1: a changed fingerprint only answers the arrival when the teacher wrote
  // after it — grades.submitted_at (gradedAt) or a Prism save stamp (fingerprint_at).
  test('a changed fingerprint with no teacher write after the arrival is still arrived', () => {
    const snapshot = { arrival_revision_at: 2000, arrival_baseline: fpWithFeedback, fingerprint_at: 0 };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, gradedAt: 1900 })).toBe('arrived');
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, gradedAt: 2000 })).toBe('arrived');
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged })).toBe('arrived');
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, gradedAt: 1900, requestedAt: 1500 })).toBe('arrived');
  });
  test('a Prism save stamp after the arrival counts as the teacher write', () => {
    const snapshot = { arrival_revision_at: 2000, arrival_baseline: fpWithFeedback, fingerprint_at: 2100 };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, gradedAt: 1900 })).toBe(null);
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, gradedAt: 1900, requestedAt: 1500 })).toBe('fulfilled');
  });
  test('R2: a Prism save after the arrival kept as arrival_write_at counts as the teacher write', () => {
    const snapshot = { arrival_revision_at: 2000, arrival_baseline: fpWithFeedback, fingerprint_at: 0, arrival_write_at: 2100 };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, gradedAt: 1900 })).toBe(null);
    expect(resubmissionStateFromSnapshot({ snapshot: { ...snapshot, arrival_write_at: 1950 }, currentFingerprint: fpChanged, gradedAt: 1900 })).toBe('arrived');
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
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, requestedAt: 1500, gradedAt: 1700 })).toBe('fulfilled');
  });

  // Fix round 1 (Concern 3): acknowledging needs NEW visible content.
  const vis = (comment, extra = {}) => fingerprint({ score: 80, comment, commentStatus: comment == null ? 0 : 1, ...extra });
  test('hiding or removing the visible comment alone is not feedback — still arrived', () => {
    const snapshot = { arrival_revision_at: 2000, arrival_baseline: vis('Good start') };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis(null) })).toBe('arrived');
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis('') })).toBe('arrived');
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis(null), requestedAt: 1500 })).toBe('arrived');
  });
  test('a different non-empty visible comment, score, exception or level acknowledges', () => {
    const snapshot = { arrival_revision_at: 2000, arrival_baseline: vis('Good start') };
    const g = { gradedAt: 2500 };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis('v2 is better'), ...g })).toBe(null);
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis(null, { score: 90 }), ...g })).toBe(null);
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis('Good start', { exception: 4 }), ...g })).toBe(null);
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis('Good start', { levels: [{ topic_id: 't', grade: 'EX' }] }), ...g })).toBe(null);
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis('v2 is better'), requestedAt: 1500, ...g })).toBe('fulfilled');
  });

  test('requested: a pre-ask arrival does not satisfy the ask — still waiting', () => {
    const snapshot = { arrival_revision_at: 1400, arrival_baseline: fpWithFeedback };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpWithFeedback, requestedAt: 1500 })).toBe('waiting');
  });
});
