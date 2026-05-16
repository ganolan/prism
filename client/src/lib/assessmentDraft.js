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
