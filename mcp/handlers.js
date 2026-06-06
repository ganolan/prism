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
