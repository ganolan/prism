// Submission comment threads: read from Schoology into the cache, post a text
// comment, delete one of the teacher's own. Public REST API only (verified
// 2026-10-17, .claude/schoology-api-reference.md "Submission comment threads").
// There is no bulk read, so each (assignment, student) costs one GET: reads are
// lazy (on open) plus a background queue over an assignment's submitted cells.
import {
  getSubmissionComments, postSubmissionComment, deleteSubmissionComment, getMyUserId, getSectionEnrollments, downloadFile,
} from './schoology.js';
import { authorRole } from '../lib/submissionComments.js';
import { resolveAssignmentId } from './idResolvers.js';
import { normalizeSubmissionStatus, getGradeMetaRows, getRoster } from './assessmentContext.js';
import { readThread, storeThread, storeReadError, markSeen } from './submissionCommentStore.js';
import { noteSessionLive } from './schoologySession.js';
import { cookieJar, getPage, drupalSettings, formFields, uploadAttachment, submitAjaxForm, WebSessionError } from './schoologyWeb.js';
import { basename } from 'path';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

// Replaced in tests; the real calls reach Schoology. Wrapped so a test that
// mocks schoology.js without these exports can still import this module.
export const commentDeps = {
  getSubmissionComments: (...a) => getSubmissionComments(...a),
  postSubmissionComment: (...a) => postSubmissionComment(...a),
  deleteSubmissionComment: (...a) => deleteSubmissionComment(...a),
  getMyUserId: (...a) => getMyUserId(...a),
  getSectionEnrollments: (...a) => getSectionEnrollments(...a),
  downloadFile: (...a) => downloadFile(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Math.floor(Date.now() / 1000),
  cookieJar: () => cookieJar(),
  fetch: (...a) => fetch(...a),
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
export function resetCommentCaches() { teacherCache.clear(); myUid = null; inflight.clear(); studentInflight.clear(); }

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

// A comment's files as stored: the fields Prism uses, or null when it has none.
export function storedAttachments(c) {
  const files = c?.attachments?.files?.file;
  if (!Array.isArray(files) || !files.length) return null;
  return JSON.stringify(files.map((f) => ({
    fid: f.fid ?? f.id ?? null, filename: f.filename ?? null, title: f.title ?? null, filesize: Number(f.filesize) || 0,
    filemime: f.filemime ?? null, extension: f.extension ?? null, md5: f.md5_checksum ?? null, download_path: f.download_path ?? null,
  })));
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
        attachments: storedAttachments(c),
      };
    });
    storeThread(db, { assignmentId: assignment.id, studentId: student.id, rows, readAt: commentDeps.now() });
  } catch (err) {
    storeReadError(db, { assignmentId: assignment.id, studentId: student.id, error: err.message });
    throw err;
  }
  return readThread(db, { assignmentId: assignment.id, studentId: student.id });
}

// The teacher saw the thread in the popover (POST .../seen): mark every comment in it seen.
export function markThreadSeen(db, { assignmentId, studentId }) {
  const pair = pairOf(db, { assignmentId, studentId });
  return markSeen(db, { assignmentId: pair.assignment.id, studentId: pair.student.id });
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

// Sync's Comments phase (18/10/2026): read the threads Sync can reach, so unread
// student comments show on every task, not only ones opened in Prism since. Scope:
// current courses; published tasks that take Schoology submissions other than OneDrive /
// Google Drive (those have no comment thread), due in the last `days` days or with a
// submission in that time; within each, refreshAssignment's students (submitted, or
// already holding cached comments) whose thread is older than maxAgeSec.
// → { assignments, refreshed, failed }.
export async function refreshRecentComments(db, { days = 30, maxAgeSec = BACKGROUND_MAX_AGE_SEC, onAssignment = null } = {}) {
  const since = commentDeps.now() - days * 86400;
  const sinceDate = new Date(since * 1000).toISOString().slice(0, 10);
  const today = new Date(commentDeps.now() * 1000).toISOString().slice(0, 10);
  const tasks = db.prepare(`
    SELECT a.id, a.title FROM assignments a JOIN courses c ON c.id = a.course_id
    WHERE c.archived = 0 AND c.excluded = 0 AND COALESCE(a.published, 1) = 1 AND a.removed_at IS NULL
      AND COALESCE(a.is_lti_submission, 0) = 0 AND COALESCE(a.accepts_submissions, 1) = 1
      AND ((a.due_date IS NOT NULL AND substr(a.due_date, 1, 10) BETWEEN ? AND ?)
        OR EXISTS (SELECT 1 FROM grades g WHERE g.assignment_id = a.id
                   AND MAX(COALESCE(g.submitted_at, 0), COALESCE(g.latest_revision_at, 0)) >= ?))
    ORDER BY c.course_name, a.due_date
  `).all(sinceDate, today, since);
  let refreshed = 0; let failed = 0;
  for (const t of tasks) {
    const job = refreshAssignment(db, t.id, { maxAgeSec });
    const r = (await job.done) || { refreshed: 0, failed: 0 };
    refreshed += r.refreshed; failed += r.failed;
    onAssignment?.({ title: t.title, queued: job.queued, ...r });
  }
  return { assignments: tasks.length, refreshed, failed };
}

// Background refresh of ONE student's threads across their courses (the student
// page, #135): assignments they submitted, or whose thread is already cached, read
// longer ago than maxAgeSec, one GET at a time. A second call joins the running job.
const studentInflight = new Map();
export function refreshStudent(db, studentId, { maxAgeSec = BACKGROUND_MAX_AGE_SEC } = {}) {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(studentId));
  if (!student?.schoology_uid) throw new CommentError('NOT_FOUND', `Unknown student ${studentId}`, 404);
  if (studentInflight.has(student.id)) {
    const running = studentInflight.get(student.id);
    return { ...running.info, done: running.done, joined: true };
  }
  const cachedIds = new Set(db.prepare('SELECT DISTINCT assignment_id FROM submission_comments WHERE student_id = ?')
    .all(student.id).map((r) => r.assignment_id));
  const rows = db.prepare(`
    SELECT a.*, g.lti_submission_state, g.submission_type, g.submitted_at AS g_submitted_at
    FROM enrolments e
    JOIN assignments a ON a.course_id = e.course_id AND COALESCE(a.published, 1) = 1 AND a.removed_at IS NULL
    LEFT JOIN grades g ON g.student_id = e.student_id AND g.assignment_id = a.id
    WHERE e.student_id = ? AND e.dropped_at IS NULL
  `).all(student.id);
  const due = rows.filter((a) => {
    const status = normalizeSubmissionStatus({
      is_lti_submission: a.is_lti_submission, lti_submission_state: a.lti_submission_state,
      submission_type: a.submission_type, submitted_at: a.g_submitted_at,
    });
    if (status !== 'submitted' && !cachedIds.has(a.id)) return false;
    const t = readThread(db, { assignmentId: a.id, studentId: student.id });
    return !t.read_at_epoch || commentDeps.now() - t.read_at_epoch >= maxAgeSec;
  });
  const courses = new Map();
  const courseOf = (id) => {
    if (!courses.has(id)) courses.set(id, db.prepare('SELECT * FROM courses WHERE id = ?').get(id));
    return courses.get(id);
  };
  const info = { queued: due.length };
  const done = (async () => {
    let refreshed = 0; let failed = 0;
    for (const [i, row] of due.entries()) {
      if (i) await commentDeps.sleep(QUEUE_DELAY_MS);
      const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(row.id);
      try { await fetchPair(db, { assignment, course: courseOf(row.course_id), student }); refreshed++; } catch { failed++; }
    }
    return { refreshed, failed };
  })().finally(() => studentInflight.delete(student.id));
  studentInflight.set(student.id, { info, done });
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

// ── Post with a file: the web form over plain HTTP ──
// The REST endpoint drops attachments (16 Oct 2026), so a comment with a file
// goes through the dropbox page's own form, sent with fetch and the saved
// session's cookies (no browser; AGENTS.md): read the page for the CSRF token
// and the form's fields, upload the file in plupload's chunks, then submit the
// form as its AJAX Post button does. Confirmed from the REST thread
// (?with_attachments=1): a new comment of ours whose file has the same MD5 as
// the one sent. Schoology renames files ("Chen, Victor.png" → Chen_Victor.png),
// so the check is the checksum, not the name.
const FORM_ID = 's-drop-item-add-comment-form';
const SESSION_MESSAGE = 'The saved Schoology session has expired: sign in again from Settings (Schoology connection), then post again. Nothing was posted.';
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', pdf: 'application/pdf', txt: 'text/plain' };

// filePath is a local file whose name is the one to upload under (the route
// writes the upload under its own name in a temporary folder).
export async function postCommentWithFile(db, { assignmentId, studentId, text = '', filePath }) {
  const body = String(text ?? '').trim();
  if (body.length > MAX_COMMENT_LENGTH) throw new CommentError('TOO_LONG', `A comment holds at most ${MAX_COMMENT_LENGTH} characters.`);
  if (!filePath) throw new CommentError('NO_FILE', 'Choose a file to attach.');
  const fileName = basename(filePath);
  const bytes = readFileSync(filePath);
  const md5 = createHash('md5').update(bytes).digest('hex');
  const pair = pairOf(db, { assignmentId, studentId });
  const before = new Set((await commentDeps.getSubmissionComments(
    pair.course.schoology_section_id, pair.assignment.schoology_assignment_id, pair.student.schoology_uid)).map((c) => String(c.id)));

  const jar = commentDeps.cookieJar();
  if (!jar) throw new CommentError('SCHOOLOGY_SESSION', SESSION_MESSAGE, 503);
  const io = { fetchImpl: commentDeps.fetch };
  const viewPath = `/assignment/${pair.assignment.schoology_assignment_id}/dropbox/view/${pair.student.schoology_uid}`;
  try {
    const page = await getPage(jar, viewPath, io);
    noteSessionLive('connected');
    const settings = drupalSettings(page.html);
    const form = formFields(page.html, FORM_ID);
    if (!form || !settings?.s_attachment) {
      throw new CommentError('NO_UPLOAD', 'Schoology shows no comment form with file upload on this submission. Nothing was posted.', 409);
    }
    const fid = await uploadAttachment(jar, settings, {
      name: fileName, bytes, mime: MIME[fileName.split('.').pop().toLowerCase()] || 'application/octet-stream',
    }, io);
    const fields = { ...form.inputs, comment: body, 'file[files]': JSON.stringify({ [fid]: '' }) };
    if (form.submit) fields[form.submit.name] = form.submit.value;
    const sent = await submitAjaxForm(jar, page.url, fields, io);
    if (sent.status !== 200) {
      throw new CommentError('SCHOOLOGY', `Schoology refused the comment form (${sent.status}). Refresh the thread before posting again.`, 502);
    }
  } catch (err) {
    if (err instanceof WebSessionError) {
      if (err.code === 'SESSION_EXPIRED') {
        noteSessionLive('expired', 'A submission comment post was sent to the login page');
        throw new CommentError('SCHOOLOGY_SESSION', SESSION_MESSAGE, 503);
      }
      throw new CommentError(err.code === 'UPLOAD_FAILED' ? 'UPLOAD_FAILED' : 'SCHOOLOGY', `${err.message}. Nothing was posted.`, 502);
    }
    throw err;
  }

  const thread = await fetchPair(db, pair);
  const added = thread.comments.filter((c) => !before.has(c.id) && c.is_mine);
  if (!added.length) {
    throw new CommentError('UNCONFIRMED', 'Schoology took the form, but no new comment shows in the thread. Refresh the thread before posting again.', 502);
  }
  const rows = db.prepare(`SELECT schoology_comment_id, attachments FROM submission_comments WHERE assignment_id = ? AND student_id = ?`)
    .all(pair.assignment.id, pair.student.id).filter((r) => added.some((c) => c.id === r.schoology_comment_id));
  const match = rows.find((r) => {
    try { return (JSON.parse(r.attachments || '[]') || []).some((f) => f.md5 === md5); } catch { return false; }
  });
  if (!match) {
    throw new CommentError('FILE_MISSING', `The comment was posted, but Schoology shows no copy of ${fileName} on it with the same checksum. Delete it and post again.`, 502);
  }
  return { ...thread, posted_id: match.schoology_comment_id };
}

// One file of a cached comment, downloaded with the API's OAuth signature (the
// download path refuses an unsigned request) → { filename, filemime, body }.
export async function commentFile(db, { assignmentId, studentId, commentId, fid }) {
  const pair = pairOf(db, { assignmentId, studentId });
  const row = db.prepare('SELECT attachments FROM submission_comments WHERE schoology_comment_id = ? AND assignment_id = ? AND student_id = ?')
    .get(String(commentId), pair.assignment.id, pair.student.id);
  let files = [];
  try { files = JSON.parse(row?.attachments || '[]') || []; } catch { files = []; }
  const f = files.find((x) => String(x.fid) === String(fid));
  if (!f?.download_path) throw new CommentError('NOT_FOUND', 'That file is not in this thread. Refresh the thread and try again.', 404);
  const res = await commentDeps.downloadFile(f.download_path);
  if (res.status !== 200) throw new CommentError('SCHOOLOGY', `Schoology refused the download (${res.status}).`, 502);
  return { filename: f.filename || 'file', filemime: f.filemime || res.contentType || 'application/octet-stream', body: res.body };
}
