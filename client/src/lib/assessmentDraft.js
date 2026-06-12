// Stale-draft detection for the /assessment/ page (#47). Draft persistence
// itself now lives in the DB (assessmentDraftSaver.js + /api/assessment-drafts);
// this signature lets a card detect when synced Schoology values changed
// underneath a stored draft so the stale draft is discarded.

// A deterministic signature of the synced Schoology values a draft was diffed
// against. Comparing a draft's stored signature to a freshly-recomputed one
// detects when Schoology data changed underneath the draft (#47).
export function draftBaseline(student, topics) {
  // Build `scores` from topic ids sorted (as strings) so JSON.stringify emits
  // keys in a stable order regardless of the `topics` array order — equal
  // synced state must always produce an equal signature.
  const scores = {};
  const sortedIds = topics
    .map((t) => t.id)
    .sort((a, b) => String(a).localeCompare(String(b)));
  for (const id of sortedIds) {
    scores[id] = student.scores?.[id]?.grade ?? null;
  }
  return JSON.stringify({
    grade_comment: student.grade_comment ?? '',
    comment_status: student.comment_status ?? null,
    exception: student.exception ?? null,
    scores,
  });
}
