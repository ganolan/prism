// The task write shared by the full sync (a section's whole task list) and Sync Assignment
// (one task, #58), so the two cannot disagree.
// Schoology returns `assignees` as a JSON-encoded string on the REST
// assignment endpoint (e.g. `"[1234,5678]"`), but other shapes are
// possible (plain array, `{assignee: [...]}` envelope). The values inside
// are **enrollment IDs**, not user UIDs — callers must map through the
// section's enrollments to recover the actual student UID. Normalize to a
// flat array of id strings; empty/missing → []. See #54.
function parseAssignees(raw) {
  if (raw == null || raw === '') return [];
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return []; }
  }
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'object' && Array.isArray(v.assignee)) return v.assignee.map(String);
  return [];
}

// Schoology REST type 'assessment' = a test or quiz.
export const isTest = (a) => a.type === 'assessment';

// `assignments`: REST task records (the section list, or one GET /sections/{id}/assignments/{aid}).
// `enrolmentIdToUid`: Map of enrolment id → uid, for the assignees. `complete`: the records are the
// section's whole list, so a stored task missing from it was deleted in Schoology (soft-removed).
export function writeAssignments(db, { courseId, assignments, now, enrolmentIdToUid, complete }) {
  const upsertAssignment = db.prepare(`
    INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, max_points, assignment_type, is_lti_submission, grading_category_id, grading_scale_id, folder_id, count_in_grade, published, display_weight, num_assignees, web_url, accepts_submissions, is_test, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(schoology_assignment_id) DO UPDATE SET
      title = excluded.title,
      due_date = excluded.due_date,
      max_points = excluded.max_points,
      assignment_type = excluded.assignment_type,
      is_lti_submission = excluded.is_lti_submission,
      grading_category_id = excluded.grading_category_id,
      grading_scale_id = excluded.grading_scale_id,
      folder_id = excluded.folder_id,
      count_in_grade = excluded.count_in_grade,
      published = excluded.published,
      display_weight = excluded.display_weight,
      num_assignees = excluded.num_assignees,
      web_url = excluded.web_url,
      accepts_submissions = excluded.accepts_submissions,
      is_test = excluded.is_test,
      removed_at = NULL,
      synced_at = excluded.synced_at
  `);
  // Schoology's section list is authoritative: an assignment missing from it was
  // deleted there (direct GET 404s). Soft-remove it so listings hide it while its
  // grades/notes/flags survive. Keeps the first removal date, like dropped_at.
  const markMissingRemoved = db.prepare(`
    UPDATE assignments SET removed_at = ?
    WHERE course_id = ? AND removed_at IS NULL
      AND schoology_assignment_id NOT IN (SELECT value FROM json_each(?))
  `);
  const deleteAssignees = db.prepare(`DELETE FROM assignment_assignees WHERE assignment_id = ?`);
  const insertAssignee = db.prepare(`INSERT OR IGNORE INTO assignment_assignees (assignment_id, schoology_uid) VALUES (?, ?)`);
  const selectAssignment = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?');
  const write = db.transaction((rows) => {
    for (const a of rows) {
      upsertAssignment.run(
        courseId, String(a.id), a.title, a.due || null, a.max_points ?? null,
        a.type || 'assignment',
        a.assignment_type === 'lti_submission' ? 1 : 0,
        a.grading_category ? String(a.grading_category) : null,
        a.grading_scale ? String(a.grading_scale) : null,
        a.folder_id ? String(a.folder_id) : null,
        a.count_in_grade ?? 1,
        a.published ?? 1,
        a.display_weight ?? 0,
        Number.isFinite(Number(a.num_assignees)) ? Number(a.num_assignees) : null,
        a.web_url || null,
        // Triage: allow_dropbox covers native dropbox AND OneDrive/GDrive LTI.
        (a.allow_dropbox === '1' || a.allow_dropbox === 1) ? 1 : 0,
        // Make-up tests: a Schoology test/quiz (assignment_type is not reliable —
        // masterySync overwrites it).
        isTest(a) ? 1 : 0,
        now
      );
      const row = selectAssignment.get(String(a.id));
      if (row) {
        deleteAssignees.run(row.id);
        for (const enrolmentId of parseAssignees(a.assignees)) {
          const uid = enrolmentIdToUid.get(String(enrolmentId));
          if (uid) insertAssignee.run(row.id, uid);
        }
      }
    }
    // An empty list is more likely a bad read than a teacher deleting everything.
    if (complete && rows.length > 0) {
      markMissingRemoved.run(now, courseId, JSON.stringify(rows.map(a => String(a.id))));
    }
  });
  write(assignments);
}
