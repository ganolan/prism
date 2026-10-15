// server/lib/assessmentDraft.js: a mirror of client/src/lib/assessmentDraft.js, so
// triage's Loose ends can tell a live Prism draft from a stale one (Schoology changed
// under it; the /assessment/ card discards those when it opens). Keep the two
// identical: client/src/lib/assessmentDraft.test.js checks parity against this module.

// A deterministic signature of the synced Schoology values a draft was diffed
// against. Comparing a draft's stored signature to a freshly-recomputed one
// detects when Schoology data changed underneath the draft (#47).
//
// rowLevels (feedback rows, spec 2026-10-13): a score-scale task's row finals
// ({ criterion: level }). The card passes them with no topics, so the signature
// never depends on whether the rubric has loaded or been attached yet. An empty
// set adds nothing, so a score-scale draft with no row finals keeps the same
// signature as before feedback rows existed.
export function draftBaseline(student, topics, { includeScore = topics.length === 0, rowLevels } = {}) {
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
    // The plain score is part of the baseline on any score-scale task (#41).
    // By default only when there are no topics, so drafts on aligned
    // assignments keep their signature.
    ...(includeScore ? { score: student.score ?? null } : {}),
    ...(rowLevels && Object.keys(rowLevels).length > 0 ? { row_levels: sortedObject(rowLevels) } : {}),
  });
}

function sortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort((a, b) => a.localeCompare(b))) out[k] = obj[k];
  return out;
}
