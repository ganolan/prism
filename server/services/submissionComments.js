// Submission comment threads: read from Schoology into the cache, post a text
// comment, delete one of the teacher's own. Public REST API only (verified
// 2026-10-17, .claude/schoology-api-reference.md "Submission comment threads").
// There is no bulk read, so each (assignment, student) costs one GET: reads are
// lazy (on open) plus a background queue over an assignment's submitted cells.
import {
  getSubmissionComments, postSubmissionComment, deleteSubmissionComment, getMyUserId, getSectionEnrollments,
} from './schoology.js';
import { authorRole } from '../lib/submissionComments.js';
import { resolveAssignmentId } from './idResolvers.js';
import { normalizeSubmissionStatus, getGradeMetaRows, getRoster } from './assessmentContext.js';
import { readThread, storeThread, storeReadError } from './submissionCommentStore.js';

// Replaced in tests; the real calls reach Schoology. Wrapped so a test that
// mocks schoology.js without these exports can still import this module.
export const commentDeps = {
  getSubmissionComments: (...a) => getSubmissionComments(...a),
  postSubmissionComment: (...a) => postSubmissionComment(...a),
  deleteSubmissionComment: (...a) => deleteSubmissionComment(...a),
  getMyUserId: (...a) => getMyUserId(...a),
  getSectionEnrollments: (...a) => getSectionEnrollments(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Math.floor(Date.now() / 1000),
};

export const OPEN_MAX_AGE_SEC = 300;        // a popover re-reads a thread older than 5 minutes
export const BACKGROUND_MAX_AGE_SEC = 600;  // the background queue skips threads read in the last 10
const QUEUE_DELAY_MS = 400;                 // REST allows about 50 requests a minute
const TEACHERS_TTL_SEC = 3600;
export const MAX_COMMENT_LENGTH = 10000;

export class CommentError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// Section admins (teachers) and Prism's own uid, cached per section for an hour.
const teacherCache = new Map();
let myUid = null;
export function resetCommentCaches() { teacherCache.clear(); myUid = null; inflight.clear(); }

async function teachersFor(sectionId) {
  myUid ??= String(await commentDeps.getMyUserId());
  const hit = teacherCache.get(sectionId);
  if (hit && commentDeps.now() - hit.at < TEACHERS_TTL_SEC) return { myUid, admins: hit.admins };
  const admins = new Map();
  for (const e of await commentDeps.getSectionEnrollments(sectionId)) {
    if (String(e.admin) === '1') admins.set(String(e.uid), e.name_display || [e.name_first, e.name_last].filter(Boolean).join(' '));
  }
  teacherCache.set(sectionId, { at: commentDeps.now(), admins });
  return { myUid, admins };
}

// The assignment (Schoology or local id), its section and the student, or a 404.
function pairOf(db, { assignmentId, studentId }) {
  const localId = resolveAssignmentId(db, assignmentId);
  const assignment = localId ? db.prepare('SELECT * FROM assignments WHERE id = ?').get(localId) : null;
  if (!assignment) throw new CommentError('NOT_FOUND', `Unknown assignment ${assignmentId}`, 404);
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(assignment.course_id);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(studentId));
  if (!student?.schoology_uid) throw new CommentError('NOT_FOUND', `Unknown student ${studentId}`, 404);
  const enrolled = db.prepare('SELECT 1 FROM enrolments WHERE student_id = ? AND course_id = ?').get(student.id, course.id);
  if (!enrolled) throw new CommentError('NOT_FOUND', `Student ${studentId} is not in this course`, 404);
  return { assignment, course, student };
}

function studentName(st) {
  return [st.preferred_name_teacher || st.preferred_name || st.first_name, st.last_name].filter(Boolean).join(' ');
}

// Read one pair's thread from Schoology and replace the cache. Throws on a failed read
// (after recording the error against the pair).
async function fetchPair(db, { assignment, course, student }) {
  try {
    const [raw, teachers] = await Promise.all([
      commentDeps.getSubmissionComments(course.schoology_section_id, assignment.schoology_assignment_id, student.schoology_uid),
      teachersFor(course.schoology_section_id),
    ]);
    const teacherUids = new Set([teachers.myUid, ...teachers.admins.keys()]);
    const rows = raw.map((c) => {
      const role = authorRole(c.uid, { studentUid: student.schoology_uid, teacherUids });
      const uid = String(c.uid);
      return {
        schoology_comment_id: String(c.id),
        author_uid: uid,
        author_role: role,
        author_name: role === 'student' ? studentName(student) : (teachers.admins.get(uid) || null),
        is_mine: uid === teachers.myUid ? 1 : 0,
        body: String(c.comment ?? ''),
        created: Number(c.created) || 0,
      };
    });
    storeThread(db, { assignmentId: assignment.id, studentId: student.id, rows, readAt: commentDeps.now() });
  } catch (err) {
    storeReadError(db, { assignmentId: assignment.id, studentId: student.id, error: err.message });
    throw err;
  }
  return readThread(db, { assignmentId: assignment.id, studentId: student.id });
}

// The thread for the popover: cached when fresh, otherwise read first. A failed
// read returns the cached thread with `error` set instead of throwing.
export async function threadFor(db, { assignmentId, studentId, force = false, maxAgeSec = OPEN_MAX_AGE_SEC }) {
  const pair = pairOf(db, { assignmentId, studentId });
  const cached = readThread(db, { assignmentId: pair.assignment.id, studentId: pair.student.id });
  if (!force && cached.read_at_epoch && commentDeps.now() - cached.read_at_epoch < maxAgeSec) return cached;
  try {
    return await fetchPair(db, pair);
  } catch (err) {
    return { ...readThread(db, { assignmentId: pair.assignment.id, studentId: pair.student.id }), error: err.message };
  }
}

// Students whose thread the background queue reads: submitted, or already
// holding cached comments (so a teacher reply shows up).
export function studentsToRefresh(db, assignment) {
  const metaByUid = Object.fromEntries(getGradeMetaRows(db, assignment.schoology_assignment_id).map((g) => [g.schoology_uid, g]));
  const withComments = new Set(db.prepare('SELECT DISTINCT student_id FROM submission_comments WHERE assignment_id = ?')
    .all(assignment.id).map((r) => r.student_id));
  return getRoster(db, assignment.course_id, assignment).filter((st) => {
    const m = metaByUid[st.schoology_uid] || {};
    const status = normalizeSubmissionStatus({
      is_lti_submission: assignment.is_lti_submission, lti_submission_state: m.lti_submission_state,
      submission_type: m.submission_type, submitted_at: m.submitted_at,
    });
    return status === 'submitted' || withComments.has(st.id);
  });
}

// Background refresh of one assignment's submitted cells older than maxAgeSec,
// one GET at a time. A second call while one runs returns the running job.
const inflight = new Map();
export function refreshAssignment(db, assignmentId, { maxAgeSec = BACKGROUND_MAX_AGE_SEC } = {}) {
  const localId = resolveAssignmentId(db, assignmentId);
  const assignment = localId ? db.prepare('SELECT * FROM assignments WHERE id = ?').get(localId) : null;
  if (!assignment) throw new CommentError('NOT_FOUND', `Unknown assignment ${assignmentId}`, 404);
  if (inflight.has(assignment.id)) {
    const running = inflight.get(assignment.id);
    return { ...running.info, done: running.done, joined: true };
  }
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(assignment.course_id);
  const due = studentsToRefresh(db, assignment).filter((st) => {
    const t = readThread(db, { assignmentId: assignment.id, studentId: st.id });
    return !t.read_at_epoch || commentDeps.now() - t.read_at_epoch >= maxAgeSec;
  });
  const info = { queued: due.length };
  const done = (async () => {
    let refreshed = 0; let failed = 0;
    for (const [i, student] of due.entries()) {
      if (i) await commentDeps.sleep(QUEUE_DELAY_MS);
      try { await fetchPair(db, { assignment, course, student }); refreshed++; } catch { failed++; }
    }
    return { refreshed, failed };
  })().finally(() => inflight.delete(assignment.id));
  inflight.set(assignment.id, { info, done });
  return { ...info, done };
}

// Post a text comment (students see it at once: the UI confirms first).
export async function postComment(db, { assignmentId, studentId, text }) {
  const body = String(text ?? '').trim();
  if (!body) throw new CommentError('EMPTY', 'Write a comment before posting.');
  if (body.length > MAX_COMMENT_LENGTH) throw new CommentError('TOO_LONG', `A comment holds at most ${MAX_COMMENT_LENGTH} characters.`);
  const pair = pairOf(db, { assignmentId, studentId });
  const res = await commentDeps.postSubmissionComment(
    pair.course.schoology_section_id, pair.assignment.schoology_assignment_id, pair.student.schoology_uid, body);
  if (res.status !== 200 && res.status !== 201) {
    throw new CommentError('SCHOOLOGY', `Schoology refused the comment (${res.status}); nothing was posted.`, 502);
  }
  return fetchPair(db, pair).catch((err) => ({
    ...readThread(db, { assignmentId: pair.assignment.id, studentId: pair.student.id }),
    error: `Posted, but the thread could not be read again: ${err.message}`,
  }));
}

// Delete one of the teacher's own comments, checked against the cache.
export async function deleteComment(db, { assignmentId, studentId, commentId }) {
  const pair = pairOf(db, { assignmentId, studentId });
  const row = db.prepare('SELECT * FROM submission_comments WHERE schoology_comment_id = ? AND assignment_id = ? AND student_id = ?')
    .get(String(commentId), pair.assignment.id, pair.student.id);
  if (!row) throw new CommentError('NOT_FOUND', 'That comment is not in this thread. Refresh the thread and try again.', 404);
  if (!row.is_mine) throw new CommentError('NOT_YOURS', 'Only your own comments can be deleted from Prism.', 403);
  const res = await commentDeps.deleteSubmissionComment(
    pair.course.schoology_section_id, pair.assignment.schoology_assignment_id, pair.student.schoology_uid, row.schoology_comment_id);
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
    throw new CommentError('SCHOOLOGY', `Schoology refused the delete (${res.status}); the comment is still there.`, 502);
  }
  return fetchPair(db, pair).catch((err) => {
    db.prepare('DELETE FROM submission_comments WHERE id = ?').run(row.id);
    return { ...readThread(db, { assignmentId: pair.assignment.id, studentId: pair.student.id }), error: err.message };
  });
}
