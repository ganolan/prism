// Pure helpers for Schoology submission revisions. Shared by the per-student
// getSubmissionStatus and the bulk #55 native-dropbox path so both derive the
// exact same per-student summary.

// Reduce a student's revision array to { ...latestRevision, latestRevisionAt }.
// latest = highest revision_id; latestRevisionAt = newest NON-draft `created`
// (0 if none). A draft revision is "in progress", not a submission, so it must
// not seed the resubmit baseline (#49). Returns null for an empty list.
export function summarizeRevisions(revisions) {
  if (!Array.isArray(revisions) || revisions.length === 0) return null;
  const latest = revisions.reduce((m, r) =>
    (Number(r.revision_id) > Number(m.revision_id) ? r : m));
  const latestRevisionAt = revisions
    .filter(r => Number(r.draft) !== 1)
    .reduce((m, r) => Math.max(m, Number(r.created) || 0), 0);
  return { ...latest, latestRevisionAt };
}

// Group a flat revision array (the bulk GET /submissions/{aid} response) by uid,
// summarizing each student's revisions. Returns Map<string uid, summary>.
export function groupRevisionsByUid(revisions) {
  const byUid = new Map();
  for (const r of (revisions || [])) {
    const uid = String(r.uid);
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(r);
  }
  const out = new Map();
  for (const [uid, revs] of byUid) out.set(uid, summarizeRevisions(revs));
  return out;
}
