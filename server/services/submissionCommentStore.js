// Cached submission comment threads: database reads and the replace-on-refresh
// write. No Schoology calls here (server/services/submissionComments.js does
// those), so assessmentContext and the routes can read the cache without
// pulling in the API client.
import { describeComment, threadSummary } from '../lib/submissionComments.js';

const isoOf = (secs) => (Number(secs) > 0 ? new Date(Number(secs) * 1000).toISOString() : null);

// One pair's cached thread, oldest first. read_at is null when never read.
// summary.unread: student comments with typed text or a file that are newer than the
// newest comment the teacher has seen in Prism (markSeen); the automatic "Revision N
// submitted" lines and the teacher's own comments never count. Each comment carries
// `unread` too, for the popover.
export function readThread(db, { assignmentId, studentId }) {
  const rows = db.prepare(`
    SELECT * FROM submission_comments WHERE assignment_id = ? AND student_id = ?
    ORDER BY created, CAST(schoology_comment_id AS INTEGER)
  `).all(assignmentId, studentId);
  const read = db.prepare('SELECT read_at, error FROM submission_comment_reads WHERE assignment_id = ? AND student_id = ?')
    .get(assignmentId, studentId);
  const seen = db.prepare('SELECT seen_created FROM submission_comment_seen WHERE assignment_id = ? AND student_id = ?')
    .get(assignmentId, studentId)?.seen_created ?? 0;
  const comments = rows.map((r) => {
    const c = describeComment(r);
    return { ...c, unread: isStudentWork(c) && Number(r.created) > seen };
  });
  const summary = { ...threadSummary(comments), unread: comments.filter((c) => c.unread).length };
  return { comments, summary, read_at: isoOf(read?.read_at), read_at_epoch: read?.read_at ?? 0, error: read?.error ?? null };
}

const isStudentWork = (c) => c.author_role === 'student' && !!(c.student_text || c.attachments?.length);

// The teacher opened the thread: everything in it now is seen.
export function markSeen(db, { assignmentId, studentId }) {
  const newest = db.prepare('SELECT MAX(created) AS m FROM submission_comments WHERE assignment_id = ? AND student_id = ?')
    .get(assignmentId, studentId)?.m ?? 0;
  db.prepare(`
    INSERT INTO submission_comment_seen (assignment_id, student_id, seen_created, seen_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(assignment_id, student_id) DO UPDATE SET seen_created = MAX(seen_created, excluded.seen_created), seen_at = excluded.seen_at
  `).run(assignmentId, studentId, newest);
  return readThread(db, { assignmentId, studentId });
}

// Replace a pair's thread with what Schoology returned (already classified rows).
export function storeThread(db, { assignmentId, studentId, rows, readAt = Math.floor(Date.now() / 1000) }) {
  db.transaction(() => {
    db.prepare('DELETE FROM submission_comments WHERE assignment_id = ? AND student_id = ?').run(assignmentId, studentId);
    const ins = db.prepare(`
      INSERT INTO submission_comments (schoology_comment_id, assignment_id, student_id, author_uid, author_role, author_name, is_mine, body, created, attachments)
      VALUES (@schoology_comment_id, @assignment_id, @student_id, @author_uid, @author_role, @author_name, @is_mine, @body, @created, @attachments)
      ON CONFLICT(schoology_comment_id) DO UPDATE SET
        assignment_id = excluded.assignment_id, student_id = excluded.student_id, author_uid = excluded.author_uid,
        author_role = excluded.author_role, author_name = excluded.author_name, is_mine = excluded.is_mine,
        body = excluded.body, created = excluded.created, attachments = excluded.attachments
    `);
    for (const r of rows) ins.run({ attachments: null, ...r, assignment_id: assignmentId, student_id: studentId });
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

// One student's unread comments in one course (the roster's comments pop-up, #160), oldest first:
// [{ schoologyAssignmentId, title, created (ISO), studentText, attachments }]. The same rule as
// the summaries' unread count (readThread): typed text or a file, newer than the last seen; the
// automatic lines and the teacher's comments never count. Cached threads only, no Schoology read,
// and nothing is marked seen. Only while the student is enrolled in the course: a student who
// dropped it lists nothing, as the roster asks only for enrolled students (#189).
export function unreadCommentsForStudent(db, courseId, studentId) {
  const rows = db.prepare(`
    SELECT r.assignment_id, a.schoology_assignment_id, a.title FROM submission_comment_reads r
    JOIN assignments a ON a.id = r.assignment_id
    JOIN enrolments e ON e.student_id = r.student_id AND e.course_id = a.course_id AND e.dropped_at IS NULL
    WHERE a.course_id = ? AND r.student_id = ?
  `).all(courseId, studentId);
  const out = [];
  for (const r of rows) {
    for (const c of readThread(db, { assignmentId: r.assignment_id, studentId }).comments) {
      if (c.unread) out.push({ schoologyAssignmentId: r.schoology_assignment_id, title: r.title, created: c.created, studentText: c.student_text, attachments: c.attachments });
    }
  }
  return out.sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''));
}

// One student's cached summaries across every course (the student page, #135):
// studentId → { [schoology assignment id]: summary }. Nothing about other students.
export function summariesForStudent(db, studentId) {
  const rows = db.prepare(`
    SELECT r.assignment_id, a.schoology_assignment_id FROM submission_comment_reads r
    JOIN assignments a ON a.id = r.assignment_id WHERE r.student_id = ?
  `).all(studentId);
  const out = {};
  for (const r of rows) {
    const t = readThread(db, { assignmentId: r.assignment_id, studentId });
    out[r.schoology_assignment_id] = { ...t.summary, read_at: t.read_at };
  }
  return out;
}

export function summariesForAssignment(db, assignmentId) {
  const out = {};
  for (const [sid, t] of Object.entries(threadsForAssignment(db, assignmentId))) out[sid] = { ...t.summary, read_at: t.read_at };
  return out;
}
