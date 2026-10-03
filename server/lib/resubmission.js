// Resubmission detection (#49 Part B; triage resubmissions 2026-10-03;
// snapshot-based state added Amendment B 2026-10-03).
// Grade time = grades.submitted_at (the REST grade timestamp; a teacher write —
// score, exception OR comment — sets it, a submission alone never does).
// Resubmission time = grades.latest_revision_at (native: newest non-draft
// revision; LTI: the grader's submissionDate).
import { hasPriorFeedback } from './feedbackFingerprint.js';

const parseFp = (fp) => { try { return JSON.parse(fp) || {}; } catch { return {}; } };

// Has the teacher given NEW visible feedback since the baseline? A changed score,
// exception or rubric level, or a non-empty visible comment that differs from the
// baseline's. Hiding or deleting the visible comment alone is not feedback.
export function feedbackAnswered(baselineFp, currentFp) {
  if (baselineFp === currentFp) return false;
  const b = parseFp(baselineFp);
  const c = parseFp(currentFp);
  if ((b.s ?? null) !== (c.s ?? null) || (Number(b.e) || 0) !== (Number(c.e) || 0)) return true;
  if (JSON.stringify(b.l || []) !== JSON.stringify(c.l || [])) return true;
  return Boolean(c.c) && c.c !== b.c;
}

// Feedback given = a score, an exception, or a non-empty comment.
export function hasFeedback(grade) {
  if (!grade) return false;
  if (grade.score != null) return true;
  if ((Number(grade.exception) || 0) > 0) return true;
  return String(grade.grade_comment ?? '').trim().length > 0;
}

// "Resubmitted since last feedback": feedback exists and the latest revision is newer.
export function isResubmitted(grade) {
  if (!hasFeedback(grade)) return false;
  const submittedAt = Number(grade.submitted_at) || 0;
  const latestRevisionAt = Number(grade.latest_revision_at) || 0;
  if (submittedAt <= 0 || latestRevisionAt <= 0) return false;
  return latestRevisionAt > submittedAt;
}

// SQLite datetime('now') text (UTC, 'YYYY-MM-DD HH:MM:SS') → epoch seconds.
export function sqliteUtcToEpoch(text) {
  if (!text) return 0;
  const ms = Date.parse(`${String(text).replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

// Amendment B: state from visible-feedback snapshots rather than raw timestamps.
// snapshot = { arrival_revision_at, arrival_baseline } | null — the current open arrival
// (if any) and the fingerprint captured as its baseline (the feedback before the resubmission).
//   'arrived'   — a resubmission to look at (current fingerprint still equals the baseline)
//   'waiting'   — asked, no arrival after the ask yet
//   'fulfilled' — asked, arrived after the ask, and new visible feedback since (feedbackAnswered)
//   null        — nothing to show (unrequested, no arrival, or already acknowledged)
export function resubmissionStateFromSnapshot({ snapshot, currentFingerprint, requestedAt = 0 } = {}) {
  const hasArrival = Boolean(snapshot && snapshot.arrival_revision_at);
  if (requestedAt > 0) {
    const arrivedAfterAsk = hasArrival && Number(snapshot.arrival_revision_at) > requestedAt;
    if (!arrivedAfterAsk) return 'waiting';
    return feedbackAnswered(snapshot.arrival_baseline, currentFingerprint) ? 'fulfilled' : 'arrived';
  }
  if (hasArrival && hasPriorFeedback(snapshot.arrival_baseline) && !feedbackAnswered(snapshot.arrival_baseline, currentFingerprint)) {
    return 'arrived';
  }
  return null;
}
