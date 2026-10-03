// Resubmission detection (#49 Part B; triage resubmissions 2026-10-03).
// Grade time = grades.submitted_at (the REST grade timestamp; a teacher write —
// score, exception OR comment — sets it, a submission alone never does).
// Resubmission time = grades.latest_revision_at (native: newest non-draft
// revision; LTI: the grader's submissionDate).

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

// One student × assessment. requestedAt = epoch of an OPEN request (0 = none);
// reviewedThrough = the newest revision a "Reviewed" mark covered (0 = none).
//   'arrived'   — a resubmission to look at
//   'waiting'   — asked, nothing new yet
//   'fulfilled' — asked, resubmitted after the ask, and regraded/reviewed since (hide; settle → done)
//   null        — nothing to show
export function resubmissionState(grade, { requestedAt = 0, reviewedThrough = 0 } = {}) {
  const g = grade || {};
  const latest = Number(g.latest_revision_at) || 0;
  const gradedAt = Number(g.submitted_at) || 0;
  const reviewed = latest > 0 && latest <= reviewedThrough;
  if (requestedAt > 0) {
    if (latest > requestedAt && (gradedAt >= latest || reviewed)) return 'fulfilled';
    if (latest > Math.max(gradedAt, requestedAt) && !reviewed) return 'arrived';
    return 'waiting';
  }
  return isResubmitted(g) && !reviewed ? 'arrived' : null;
}
