import { describe, test, expect } from 'vitest';
import { hasFeedback, isResubmitted, resubmissionStateFromSnapshot, sqliteUtcToEpoch, changedParts, feedbackAnswered, PART_SCORE, PART_LEVELS, PART_COMMENT } from './resubmission.js';
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
  // after it — grades.submitted_at (gradedAt) or a Prism save after it (arrival_parts, round 4).
  test('a changed fingerprint with no teacher write after the arrival is still arrived', () => {
    const snapshot = { arrival_revision_at: 2000, arrival_baseline: fpWithFeedback, fingerprint_at: 0 };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, gradedAt: 1900 })).toBe('arrived');
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, gradedAt: 2000 })).toBe('arrived');
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged })).toBe('arrived');
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, gradedAt: 1900, requestedAt: 1500 })).toBe('arrived');
  });
  // Round 4: a Prism save after the arrival is evidence only for the parts it changed
  // (snapshot.arrival_parts) — a save stamp alone no longer answers.
  test('a Prism save after the arrival that changed the score counts (arrival_parts)', () => {
    const snapshot = { arrival_revision_at: 2000, arrival_baseline: fpWithFeedback, arrival_parts: PART_SCORE };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, gradedAt: 1900 })).toBe(null);
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpChanged, gradedAt: 1900, requestedAt: 1500 })).toBe('fulfilled');
  });
  test('round 4: each changed part needs its own evidence after the arrival', () => {
    const base = fingerprint({ score: 80, comment: 'Good', commentStatus: 1, levels: [{ topic_id: 't', grade: 'D' }] });
    const levels = fingerprint({ score: 80, comment: 'Good', commentStatus: 1, levels: [{ topic_id: 't', grade: 'EX' }] });
    const comment = fingerprint({ score: 80, comment: 'Better', commentStatus: 1, levels: [{ topic_id: 't', grade: 'D' }] });
    const state = (current, parts, gradedAt = 1900) => resubmissionStateFromSnapshot({
      snapshot: { arrival_revision_at: 2000, arrival_baseline: base, arrival_parts: parts }, currentFingerprint: current, gradedAt,
    });
    // Levels: only a Prism save after the arrival that changed levels — never a grade write alone.
    expect(state(levels, 0, 2500)).toBe('arrived');
    expect(state(levels, PART_SCORE | PART_COMMENT, 2500)).toBe('arrived');
    expect(state(levels, PART_LEVELS)).toBe(null);
    // Score / comment: a Prism save that changed them, or a Schoology grade write after the arrival.
    const score = fingerprint({ score: 90, comment: 'Good', commentStatus: 1, levels: [{ topic_id: 't', grade: 'D' }] });
    expect(state(score, PART_LEVELS)).toBe('arrived');
    expect(state(score, PART_SCORE)).toBe(null);
    expect(state(score, 0, 2500)).toBe(null);
    expect(state(comment, PART_SCORE)).toBe('arrived');
    expect(state(comment, PART_COMMENT)).toBe(null);
    expect(state(comment, 0, 2500)).toBe(null);
  });
  test('changedParts / feedbackAnswered without evidence (any change counts)', () => {
    const a = fingerprint({ score: 80, comment: 'x', commentStatus: 1, levels: [{ topic_id: 't', grade: 'D' }] });
    expect(changedParts(a, a)).toBe(0);
    expect(changedParts(a, fingerprint({ score: 90, comment: 'x', commentStatus: 1, levels: [{ topic_id: 't', grade: 'D' }] }))).toBe(PART_SCORE);
    expect(changedParts(a, fingerprint({ score: 80, comment: 'x', commentStatus: 0, levels: [{ topic_id: 't', grade: 'EX' }] }))).toBe(PART_LEVELS | PART_COMMENT);
    expect(feedbackAnswered(a, fingerprint({ score: 80, comment: 'x', commentStatus: 1, levels: [] }))).toBe(true);
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
    const g = { gradedAt: 2500 };    // a Schoology grade write after the arrival
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis('v2 is better'), ...g })).toBe(null);
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis(null, { score: 90 }), ...g })).toBe(null);
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis('Good start', { exception: 4 }), ...g })).toBe(null);
    // A level change needs a Prism save after the arrival that changed levels (round 4).
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis('Good start', { levels: [{ topic_id: 't', grade: 'EX' }] }), ...g })).toBe('arrived');
    expect(resubmissionStateFromSnapshot({ snapshot: { ...snapshot, arrival_parts: PART_LEVELS }, currentFingerprint: vis('Good start', { levels: [{ topic_id: 't', grade: 'EX' }] }), ...g })).toBe(null);
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: vis('v2 is better'), requestedAt: 1500, ...g })).toBe('fulfilled');
  });

  test('requested: a pre-ask arrival does not satisfy the ask — still waiting', () => {
    const snapshot = { arrival_revision_at: 1400, arrival_baseline: fpWithFeedback };
    expect(resubmissionStateFromSnapshot({ snapshot, currentFingerprint: fpWithFeedback, requestedAt: 1500 })).toBe('waiting');
  });
});
