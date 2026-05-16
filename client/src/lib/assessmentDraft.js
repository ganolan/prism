// Persists unsaved /assessment/ grading work (rubric selections, comment text,
// display toggle) to localStorage so it survives a page reload. See #47.

const PREFIX = 'prism:assessment-draft';

export function draftKey(courseId, assignmentId, enrollmentId) {
  return `${PREFIX}:${courseId}:${assignmentId}:${enrollmentId}`;
}

export function readDraft(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // localStorage unavailable or value corrupt — treat as no draft.
    return null;
  }
}

export function writeDraft(key, draft) {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // localStorage unavailable (private mode / quota) — degrade silently.
  }
}

export function clearDraft(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // localStorage unavailable — nothing to clear.
  }
}

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
