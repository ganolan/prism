// Shared id resolvers. A caller may reference a student or assignment by its
// local Prism id OR by a Schoology id (and, for students, a PowerSchool id);
// these resolve any of those to the local row id, or null. Extracted from
// inbox.js so the inbox importer and the PrisMCP server share one resolution
// rule (spec §6). Each returns the local integer id, or null when unresolved.

export function resolveStudentId(db, rawId) {
  // Try as internal id first, then schoology_uid, then powerschool_id.
  let row = db.prepare('SELECT id FROM students WHERE id = ?').get(rawId);
  if (row) return row.id;
  row = db.prepare('SELECT id FROM students WHERE schoology_uid = ?').get(String(rawId));
  if (row) return row.id;
  row = db.prepare('SELECT id FROM students WHERE powerschool_id = ?').get(String(rawId));
  if (row) return row.id;
  return null;
}

export function resolveAssignmentId(db, rawId) {
  let row = db.prepare('SELECT id FROM assignments WHERE id = ?').get(rawId);
  if (row) return row.id;
  row = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(rawId));
  if (row) return row.id;
  return null;
}
