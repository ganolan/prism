// Group an ordered list of assignments by their Schoology folder, for the
// course Assessments tab (#22). The input order is preserved both for the
// folder groups (first-appearance order) and the assignments within them, so
// the result matches Schoology's own gradebook ordering.

// '0' and null/undefined both mean "no folder" in Schoology's data.
function noFolder(id) {
  return id == null || id === '0';
}

// Build a "Parent / Child" display title by walking the parent_id chain.
// Returns null when the folder is unknown (not synced).
function folderTitle(folderId, folderById) {
  const parts = [];
  let cursor = folderId;
  const seen = new Set();
  while (!noFolder(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = folderById[cursor];
    if (!folder) return parts.length ? parts.join(' / ') : null;
    parts.unshift(folder.title);
    cursor = folder.parent_id;
  }
  return parts.length ? parts.join(' / ') : null;
}

export function groupAssignmentsByFolder(assignments, folders = []) {
  const folderById = {};
  for (const f of folders) folderById[f.schoology_folder_id] = f;

  const groups = [];
  const groupByKey = {};
  for (const a of assignments) {
    const folderId = noFolder(a.folder_id) ? null : a.folder_id;
    const key = folderId ?? '__none__';
    if (!groupByKey[key]) {
      groupByKey[key] = {
        folderId,
        title: folderId ? folderTitle(folderId, folderById) : null,
        assignments: [],
      };
      groups.push(groupByKey[key]);
    }
    groupByKey[key].assignments.push(a);
  }
  return groups;
}
