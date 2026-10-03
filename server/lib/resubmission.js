// Resubmission detection (#49 Part B; triage resubmissions 2026-10-03;
// snapshot-based state added Amendment B 2026-10-03).
// Grade time = grades.submitted_at (the REST grade timestamp; a teacher write —
// score, exception OR comment — sets it, a submission alone never does).
// Resubmission time = grades.latest_revision_at (native: newest non-draft
// revision; LTI: the grader's submissionDate).
import { hasPriorFeedback } from './feedbackFingerprint.js';

const parseFp = (fp) => { try { return JSON.parse(fp) || {}; } catch { return {}; } };

// Was a teacher write at time t after revision r? An lti revision time has no seconds,
// so on lti work a write within r's minute may precede the real submission: only
// t >= r + 60 counts as after it (and t <= r + 59 as at-or-before it). Applies to Prism
// saves and to the Schoology grade time (grades.submitted_at) alike.
export const wroteAfter = (t, r, lti = false) => (lti ? t >= r + 60 : t > r);

// The parts of visible feedback (residual review round 4): bits of
// feedback_snapshots.arrival_parts, recording which parts a Prism save after the
// arrival changed.
export const PART_SCORE = 1;    // score or exception
export const PART_LEVELS = 2;   // rubric levels
export const PART_COMMENT = 4;  // the visible comment (status line stripped)

const scoreDiffers = (b, c) => (b.s ?? null) !== (c.s ?? null) || (Number(b.e) || 0) !== (Number(c.e) || 0);
const levelsDiffer = (b, c) => JSON.stringify(b.l || []) !== JSON.stringify(c.l || []);

// Which parts differ between two fingerprints (PART_* bits).
export function changedParts(beforeFp, afterFp) {
  if (beforeFp === afterFp) return 0;
  const b = parseFp(beforeFp);
  const c = parseFp(afterFp);
  return (scoreDiffers(b, c) ? PART_SCORE : 0) | (levelsDiffer(b, c) ? PART_LEVELS : 0)
    | ((b.c || '') !== (c.c || '') ? PART_COMMENT : 0);
}

// Round 6: merge the given parts (PART_* bits) of `fromFp` into `baseFp` — score+exception,
// levels and visible comment separately — leaving the other parts as they were. Same key
// order as feedbackFingerprint.fingerprint(), so equal feedback stays an equal string.
// Round 7: a hide is never absorbed — an empty visible comment never replaces a non-empty
// one (hiding is never feedback, so re-showing the same text must not read as new).
export function absorbParts(baseFp, fromFp, parts) {
  if (!parts || baseFp == null) return parts && baseFp == null ? fromFp : baseFp;
  const b = parseFp(baseFp);
  const f = parseFp(fromFp);
  const take = (bit, keys) => keys.reduce((o, k) => ({ ...o, [k]: (parts & bit) ? f[k] : b[k] }), {});
  const { s, e } = take(PART_SCORE, ['s', 'e']);
  const { l } = take(PART_LEVELS, ['l']);
  let { c } = take(PART_COMMENT, ['c']);
  if (!c && b.c) c = b.c;
  return JSON.stringify({ s: s ?? null, e: Number(e) || 0, l: l || [], c: c ?? '' });
}

// Has the teacher given NEW visible feedback since the baseline? A changed score,
// exception or rubric level, or a non-empty visible comment that differs from the
// baseline's. Hiding or deleting the visible comment alone is not feedback.
// evidence (round 4) = { parts, gradedAfter }: each changed part counts only with
// evidence after the arrival for THAT part — rubric levels: a Prism save after it that
// changed levels (PART_LEVELS; levels a mastery pull brings never answer on their own);
// score/exception and the visible comment: a Prism save after it that changed them, or
// a Schoology grade write after it (gradedAfter = grades.submitted_at > the arrival).
// No evidence argument = any change counts.
export function feedbackAnswered(baselineFp, currentFp, evidence = null) {
  if (baselineFp === currentFp) return false;
  const b = parseFp(baselineFp);
  const c = parseFp(currentFp);
  const parts = evidence == null ? ~0 : (Number(evidence.parts) || 0);
  const graded = evidence == null || Boolean(evidence.gradedAfter);
  if (scoreDiffers(b, c) && (graded || (parts & PART_SCORE))) return true;
  if (levelsDiffer(b, c) && (parts & PART_LEVELS)) return true;
  return Boolean(c.c) && c.c !== b.c && (graded || Boolean(parts & PART_COMMENT));
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
// snapshot = { arrival_revision_at, arrival_baseline, arrival_parts } | null — the current
// open arrival (if any), the fingerprint captured as its baseline (the feedback before the
// resubmission), and the last Prism save stamp. gradedAt = grades.submitted_at (the REST
// grade time: any teacher write sets it, a submission never does).
// Answered = new visible feedback since the baseline, each changed part backed by a
// teacher write after the arrival for that part (feedbackAnswered with evidence:
// snapshot.arrival_parts — the parts Prism saves after the arrival changed — and
// gradedAt > arrival_revision_at for a Schoology grade write; residual review round 4).
// Final review C1: feedback given before the resubmission never answers it.
//   'arrived'   — a resubmission to look at (not answered yet)
//   'waiting'   — asked, no arrival after the ask yet
//   'fulfilled' — asked, arrived after the ask, and answered
//   null        — nothing to show (unrequested, no arrival, or already acknowledged)
// lti = the assignment is lti_submission work (assignments.is_lti_submission): the
// minute rule in wroteAfter applies to gradedAt.
export function resubmissionStateFromSnapshot({ snapshot, currentFingerprint, requestedAt = 0, gradedAt = 0, lti = false } = {}) {
  const hasArrival = Boolean(snapshot && snapshot.arrival_revision_at);
  const arrivalAt = hasArrival ? Number(snapshot.arrival_revision_at) : 0;
  const answered = () => feedbackAnswered(snapshot.arrival_baseline, currentFingerprint, {
    parts: snapshot.arrival_parts, gradedAfter: wroteAfter(Number(gradedAt) || 0, arrivalAt, lti),
  });
  if (requestedAt > 0) {
    const arrivedAfterAsk = hasArrival && arrivalAt > requestedAt;
    if (!arrivedAfterAsk) return 'waiting';
    return answered() ? 'fulfilled' : 'arrived';
  }
  if (hasArrival && hasPriorFeedback(snapshot.arrival_baseline) && !answered()) {
    return 'arrived';
  }
  return null;
}
