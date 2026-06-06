// Pure data handlers for PrisMCP tools. Each takes an open better-sqlite3 db
// and returns plain data; mcp/server.js wraps them in thin registerTool
// callbacks. Kept separate so they unit-test directly against a :memory: DB,
// mirroring the server/**/*.test.js pattern.

// Active courses = not archived, not excluded, not hidden. Mirrors the
// 'current' view in server/routes/courses.js, plus the excluded filter (#56,
// spec §3.1).
export function listCourses(db) {
  return db.prepare(`
    SELECT id, course_name, section_name, course_code, schoology_section_id
    FROM courses
    WHERE archived = 0 AND excluded = 0 AND hidden = 0
    ORDER BY course_name
  `).all();
}

// Assignments for a course (local course id), so a phrase like "the MAD
// project I just collected" can resolve to a concrete assignment (spec §3.1).
export function listAssignments(db, { course_id }) {
  const rows = db.prepare(`
    SELECT a.id, a.schoology_assignment_id, a.title, a.due_date, a.assignment_type,
           EXISTS (
             SELECT 1 FROM mastery_alignments ma
             WHERE ma.assignment_schoology_id = a.schoology_assignment_id
               AND ma.course_id = a.course_id
           ) AS has_aligned_topics,
           (SELECT MAX(g.submitted_at) FROM grades g WHERE g.assignment_id = a.id) AS latest_submitted_at
    FROM assignments a
    WHERE a.course_id = ?
    ORDER BY a.due_date, a.id
  `).all(Number(course_id));
  return rows.map(({ latest_submitted_at, ...r }) => ({
    ...r,
    has_aligned_topics: !!r.has_aligned_topics,
    // submitted_at is a Unix-seconds epoch (0 = never submitted, #13/#62);
    // surface the latest as an ISO string, null when nobody has submitted.
    latest_submission_at: latest_submitted_at > 0 ? new Date(latest_submitted_at * 1000).toISOString() : null,
  }));
}
