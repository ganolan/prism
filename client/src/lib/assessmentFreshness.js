// #52: what Schoology owns on the assessment page (each student's levels, grade comment, display status
// and exception), so a background refresh can tell whether anything there changed.
export function schoologyFingerprint(data) {
  const students = (data?.students || [])
    .map((s) => [String(s.schoology_uid ?? s.id), s.scores || {}, s.grade_comment || '', s.comment_status ?? null, s.exception || 0])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const topics = (data?.topics || []).map((t) => t.id).sort();
  return JSON.stringify({ students, topics });
}

export const sameInSchoology = (a, b) => schoologyFingerprint(a) === schoologyFingerprint(b);

// After a background refresh: 'none' (Schoology's side unchanged), 'reload' (changed, nothing unsaved:
// swap the new data in), or 'ask' (changed while a card holds unsaved changes: a reload would drop a
// draft that no longer matches Schoology, so the page asks for a save or discard first).
export function afterRefresh(current, next, pendingByUid = {}) {
  if (!next || sameInSchoology(current, next)) return 'none';
  return Object.values(pendingByUid).some(Boolean) ? 'ask' : 'reload';
}
