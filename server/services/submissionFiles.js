// Native dropbox submission files (#107): every revision of one student's
// submission with its files, read on demand when the teacher opens the
// student's work, cached in SQLite, and downloaded through Prism with the API's
// OAuth signature. Public REST API only: one GET per (student, assignment),
// `…/submissions/{aid}/{uid}?with_attachments=1` (verified 2026-10-17,
// .claude/schoology-api-reference.md "Native dropbox submission files"). No
// sync-time capture: the bulk read the sync uses (#55) returns only each
// student's latest revision and no files.
import { getSubmissionRevisions, openFile } from './schoology.js';
import { resolveAssignmentId } from './idResolvers.js';
import { readRevisions, storeRevisions, storeReadError, storedFile } from './submissionFileStore.js';

// Replaced in tests; the real calls reach Schoology.
export const fileDeps = {
  getSubmissionRevisions: (...a) => getSubmissionRevisions(...a),
  openFile: (...a) => openFile(...a),
  now: () => Math.floor(Date.now() / 1000),
};

export const OPEN_MAX_AGE_SEC = 300; // opening the list re-reads revisions older than 5 minutes

export class FileError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// The assignment (Schoology or local id), its section and the student, or an error.
function pairOf(db, { assignmentId, studentId }) {
  const localId = resolveAssignmentId(db, assignmentId);
  const assignment = localId ? db.prepare('SELECT * FROM assignments WHERE id = ?').get(localId) : null;
  if (!assignment) throw new FileError('NOT_FOUND', `Unknown assignment ${assignmentId}`, 404);
  // OneDrive/Google Drive work is not in the revisions API (it returns empty
  // drafts); those tasks link to the student's own copy instead (#120).
  if (assignment.is_lti_submission) {
    throw new FileError('NOT_NATIVE', 'This task takes OneDrive or Google Drive work, not Schoology uploads.', 409);
  }
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(assignment.course_id);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(studentId));
  if (!student?.schoology_uid) throw new FileError('NOT_FOUND', `Unknown student ${studentId}`, 404);
  const enrolled = db.prepare('SELECT 1 FROM enrolments WHERE student_id = ? AND course_id = ?').get(student.id, course.id);
  if (!enrolled) throw new FileError('NOT_FOUND', `Student ${studentId} is not in this course`, 404);
  return { assignment, course, student };
}

// A revision's files as stored: the fields Prism uses, or null when it has none.
// A revision file's own key is `id` (`fid` is null on revisions, unlike comment files).
export function storedRevisionFiles(r) {
  const files = r?.attachments?.files?.file;
  if (!Array.isArray(files) || !files.length) return null;
  return JSON.stringify(files.map((f) => ({
    id: f.id ?? f.fid ?? null, filename: f.filename ?? null, title: f.title ?? null, filesize: Number(f.filesize) || 0,
    filemime: f.filemime ?? null, extension: f.extension ?? null, md5: f.md5_checksum ?? null, download_path: f.download_path ?? null,
  })));
}

async function fetchPair(db, { assignment, course, student }) {
  const ids = { assignmentId: assignment.id, studentId: student.id };
  try {
    const raw = await fileDeps.getSubmissionRevisions(course.schoology_section_id, assignment.schoology_assignment_id, student.schoology_uid);
    const rows = raw.map((r) => ({
      revision_id: String(r.revision_id),
      created: Number(r.created) || 0,
      late: Number(r.late) ? 1 : 0,
      draft: Number(r.draft) ? 1 : 0,
      num_items: r.num_items == null ? null : Number(r.num_items),
      files: storedRevisionFiles(r),
    }));
    storeRevisions(db, { ...ids, rows, readAt: fileDeps.now() });
  } catch (err) {
    storeReadError(db, { ...ids, error: err.message });
    throw err;
  }
  return readRevisions(db, ids);
}

// The student's revisions, newest first: cached when fresh, otherwise read
// first. A failed read returns the cached revisions with `error` set.
export async function revisionsFor(db, { assignmentId, studentId, force = false, maxAgeSec = OPEN_MAX_AGE_SEC }) {
  const pair = pairOf(db, { assignmentId, studentId });
  const ids = { assignmentId: pair.assignment.id, studentId: pair.student.id };
  const cached = readRevisions(db, ids);
  if (!force && cached.read_at_epoch && fileDeps.now() - cached.read_at_epoch < maxAgeSec) return cached;
  try {
    return await fetchPair(db, pair);
  } catch (err) {
    return { ...readRevisions(db, ids), error: err.message };
  }
}

// One cached file, opened with the API signature (the download path refuses an
// unsigned request) → { filename, filemime, filesize, body (web stream) }.
export async function openSubmissionFile(db, { assignmentId, studentId, revisionId, fileId }) {
  const pair = pairOf(db, { assignmentId, studentId });
  const f = storedFile(db, { assignmentId: pair.assignment.id, studentId: pair.student.id, revisionId, fileId });
  if (!f?.download_path) throw new FileError('NOT_FOUND', 'That file is not in this submission. Refresh the list and try again.', 404);
  const res = await fileDeps.openFile(f.download_path);
  if (res.status !== 200) {
    await res.body?.cancel?.().catch(() => {});
    throw new FileError('SCHOOLOGY', `Schoology refused the download (${res.status}).`, 502);
  }
  return {
    filename: f.filename || 'file',
    filemime: f.filemime || res.contentType || 'application/octet-stream',
    filesize: res.contentLength || null, // Schoology's own length; the cached filesize could disagree
    body: res.body,
  };
}
