// Cached submission comment threads: database reads and the replace-on-refresh
// write. No Schoology calls here (server/services/submissionComments.js does
// those), so assessmentContext and the routes can read the cache without
// pulling in the API client.
import { describeComment, threadSummary } from '../lib/submissionComments.js';

const isoOf = (secs) => (Number(secs) > 0 ? new Date(Number(secs) * 1000).toISOString() : null);

// One pair's cached thread, oldest first. read_at is null when never read.
export function readThread(db, { assignmentId, studentId }) {
  const rows = db.prepare(`
    SELECT * FROM submission_comments WHERE assignment_id = ? AND student_id = ?
    ORDER BY created, CAST(schoology_comment_id AS INTEGER)
  `).all(assignmentId, studentId);
  const read = db.prepare('SELECT read_at, error FROM submission_comment_reads WHERE assignment_id = ? AND student_id = ?')
    .get(assignmentId, studentId);
  const comments = rows.map(describeComment);
  return { comments, summary: threadSummary(comments), read_at: isoOf(read?.read_at), read_at_epoch: read?.read_at ?? 0, error: read?.error ?? null };
}

// Replace a pair's thread with what Schoology returned (already classified rows).
export function storeThread(db, { assignmentId, studentId, rows, readAt = Math.floor(Date.now() / 1000) }) {
  db.transaction(() => {
    db.prepare('DELETE FROM submission_comments WHERE assignment_id = ? AND student_id = ?').run(assignmentId, studentId);
    const ins = db.prepare(`
      INSERT INTO submission_comments (schoology_comment_id, assignment_id, student_id, author_uid, author_role, author_name, is_mine, body, created)
      VALUES (@schoology_comment_id, @assignment_id, @student_id, @author_uid, @author_role, @author_name, @is_mine, @body, @created)
      ON CONFLICT(schoology_comment_id) DO UPDATE SET
        assignment_id = excluded.assignment_id, student_id = excluded.student_id, author_uid = excluded.author_uid,
        author_role = excluded.author_role, author_name = excluded.author_name, is_mine = excluded.is_mine,
        body = excluded.body, created = excluded.created
    `);
    for (const r of rows) ins.run({ ...r, assignment_id: assignmentId, student_id: studentId });
    db.prepare(`
      INSERT INTO submission_comment_reads (assignment_id, student_id, read_at, error) VALUES (?, ?, ?, NULL)
      ON CONFLICT(assignment_id, student_id) DO UPDATE SET read_at = excluded.read_at, error = NULL
    `).run(assignmentId, studentId, readAt);
  })();
}

// A failed read keeps the cached comments and the last good read_at.
export function storeReadError(db, { assignmentId, studentId, error }) {
  db.prepare(`
    INSERT INTO submission_comment_reads (assignment_id, student_id, read_at, error) VALUES (?, ?, 0, ?)
    ON CONFLICT(assignment_id, student_id) DO UPDATE SET error = excluded.error
  `).run(assignmentId, studentId, String(error).slice(0, 300));
}

// Every cached thread of one assignment (local id), keyed by local student id.
export function threadsForAssignment(db, assignmentId) {
  const out = {};
  const pairs = db.prepare('SELECT student_id FROM submission_comment_reads WHERE assignment_id = ?').all(assignmentId);
  for (const { student_id } of pairs) out[student_id] = readThread(db, { assignmentId, studentId: student_id });
  return out;
}

// Summaries only ({count, student_text, student_words, read_at}), for badges.
// courseId → { [schoology assignment id]: { [student id]: summary } }.
export function summariesForCourse(db, courseId) {
  const rows = db.prepare(`
    SELECT r.assignment_id, r.student_id, a.schoology_assignment_id FROM submission_comment_reads r
    JOIN assignments a ON a.id = r.assignment_id WHERE a.course_id = ?
  `).all(courseId);
  const out = {};
  for (const r of rows) {
    const t = readThread(db, { assignmentId: r.assignment_id, studentId: r.student_id });
    (out[r.schoology_assignment_id] ??= {})[r.student_id] = { ...t.summary, read_at: t.read_at };
  }
  return out;
}

export function summariesForAssignment(db, assignmentId) {
  const out = {};
  for (const [sid, t] of Object.entries(threadsForAssignment(db, assignmentId))) out[sid] = { ...t.summary, read_at: t.read_at };
  return out;
}
