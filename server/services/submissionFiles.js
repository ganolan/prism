// Native dropbox submission files (#107): every revision of one student's
// submission with its files, read on demand when the teacher opens the
// student's work, cached in SQLite, and downloaded through Prism with the API's
// OAuth signature. Public REST API only: one GET per (student, assignment),
// `…/submissions/{aid}/{uid}?with_attachments=1` (verified 2026-10-17,
// .claude/schoology-api-reference.md "Native dropbox submission files"). No
// sync-time capture: the bulk read the sync uses (#55) returns only each
// student's latest revision and no files. Two queues read several pairs, one GET
// at a time (#162): one assignment's uploaders for PrisMCP's
// get_assignment_context, and one student's uploads for the student page.
import { getSubmissionRevisions, openFile } from './schoology.js';
import { resolveAssignmentId } from './idResolvers.js';
import { getRoster, getGradeMetaRows } from './assessmentContext.js';
import { readRevisions, storeRevisions, storeReadError, storedFile } from './submissionFileStore.js';
import { needsFollowUp } from '../lib/readFollowUp.js';

// Replaced in tests; the real calls reach Schoology.
export const fileDeps = {
  getSubmissionRevisions: (...a) => getSubmissionRevisions(...a),
  openFile: (...a) => openFile(...a),
  now: () => Math.floor(Date.now() / 1000),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export const OPEN_MAX_AGE_SEC = 300; // opening the list re-reads revisions older than 5 minutes
export const BACKGROUND_MAX_AGE_SEC = 600; // the student page's queue skips pairs read in the last 10
const QUEUE_DELAY_MS = 400; // the same pace as the comment queues

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
// `converted` is Schoology's own converted copy (a video as H.264 .mp4, a document
// or an image as .pdf; 2026-10-18), or null when it lists none.
export function storedRevisionFiles(r) {
  const files = r?.attachments?.files?.file;
  if (!Array.isArray(files) || !files.length) return null;
  return JSON.stringify(files.map((f) => ({
    id: f.id ?? f.fid ?? null, filename: f.filename ?? null, title: f.title ?? null, filesize: Number(f.filesize) || 0,
    filemime: f.filemime ?? null, extension: f.extension ?? null, md5: f.md5_checksum ?? null, download_path: f.download_path ?? null,
    converted: f.converted_download_path && String(f.converted_status) === '1' ? {
      filename: f.converted_filename ?? null, filesize: Number(f.converted_filesize) || 0, filemime: f.converted_filemime ?? null,
      extension: f.converted_extension ?? null, md5: f.converted_md5_checksum ?? null, download_path: f.converted_download_path,
    } : null,
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

const stale = (db, assignmentId, studentId, maxAgeSec, asOf = fileDeps.now()) => {
  const t = readRevisions(db, { assignmentId, studentId });
  return !t.read_at_epoch || asOf - t.read_at_epoch >= maxAgeSec;
};

// Read the pairs `duePairs(asOf)` lists ([{ assignment, course, student }], due
// as of `asOf`, epoch seconds) one GET at a time under `key`; a second call with
// the same key while one runs joins it. A stricter call (a smaller maxAgeSec: the
// grading sync's 0, or a 0 call joining a 0 job that started earlier;
// lib/readFollowUp.js) waits for it, then reads the pairs still
// due as of when the call was made (#170). Its `queued` is the joined job's; its
// `done` resolves { queued, refreshed, failed } over both reads (`failed` is the
// second read's: a failed read keeps the old read time, so it is tried again).
// Nothing due: no job.
const inflight = new Map(); // key → { info, done, maxAgeSec, asOf }
export function resetFileQueues() { inflight.clear(); }
function runQueue(db, key, { maxAgeSec, asOf = fileDeps.now() }, duePairs) {
  const running = inflight.get(key);
  if (running) {
    if (!needsFollowUp(running, { maxAgeSec, asOf })) return { ...running.info, done: running.done, joined: true };
    const done = running.done.then(async (first) => {
      const next = runQueue(db, key, { maxAgeSec, asOf }, duePairs);
      const rest = await next.done;
      return {
        queued: running.info.queued + (rest.queued ?? next.queued),
        refreshed: (first?.refreshed ?? 0) + rest.refreshed, failed: rest.failed,
      };
    });
    return { ...running.info, done, joined: true };
  }
  const pairs = duePairs(asOf);
  const info = { queued: pairs.length };
  if (!pairs.length) return { ...info, done: Promise.resolve({ refreshed: 0, failed: 0 }) };
  const done = (async () => {
    let refreshed = 0; let failed = 0;
    for (const [i, pair] of pairs.entries()) {
      if (i) await fileDeps.sleep(QUEUE_DELAY_MS);
      try { await fetchPair(db, pair); refreshed++; } catch { failed++; }
    }
    return { refreshed, failed };
  })().finally(() => inflight.delete(key));
  inflight.set(key, { info, done, maxAgeSec, asOf });
  return { ...info, done };
}

// One assignment's students whose files the sync saw (submission_type 'drop'), or
// whose files were read before (an upload after the last sync), read longer ago
// than maxAgeSec (PrisMCP get_assignment_context, #162). Refuses an OneDrive task.
// An archived course is different: its import skips the per-student submission
// check (#72), so the upload marks are patchy (a sample of 40 unmarked submitted
// archived grades found uploads in 20, 19/10/2026). There every student on the
// roster is read until one read succeeds, then never again: archived work does not
// change. So an agent can crawl archived tasks with no one opening a chip.
export function refreshAssignmentFiles(db, assignmentId, { maxAgeSec = OPEN_MAX_AGE_SEC } = {}) {
  const localId = resolveAssignmentId(db, assignmentId);
  const assignment = localId ? db.prepare('SELECT * FROM assignments WHERE id = ?').get(localId) : null;
  if (!assignment) throw new FileError('NOT_FOUND', `Unknown assignment ${assignmentId}`, 404);
  if (assignment.is_lti_submission) {
    throw new FileError('NOT_NATIVE', 'This task takes OneDrive or Google Drive work, not Schoology uploads.', 409);
  }
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(assignment.course_id);
  return runQueue(db, `a:${assignment.id}`, { maxAgeSec }, (asOf) => {
    const uploaded = new Set(getGradeMetaRows(db, assignment.schoology_assignment_id)
      .filter((g) => g.submission_type === 'drop').map((g) => g.student_id));
    const readBefore = new Set(db.prepare('SELECT student_id FROM submission_revision_reads WHERE assignment_id = ?')
      .all(assignment.id).map((r) => r.student_id));
    const due = course?.archived
      ? (st) => !readRevisions(db, { assignmentId: assignment.id, studentId: st.id }).read_at_epoch
      : (st) => (uploaded.has(st.id) || readBefore.has(st.id)) && stale(db, assignment.id, st.id, maxAgeSec, asOf);
    return getRoster(db, assignment.course_id, assignment)
      .filter((st) => st.schoology_uid && due(st))
      .map((student) => ({ assignment, course, student }));
  });
}

// ONE student's uploads across their current courses (the student page, #162):
// native tasks the sync saw them upload to, read longer ago than maxAgeSec.
// Archived courses are left to the chip (a read when it is opened): years of
// tasks would cost a GET each on every visit.
export function refreshStudentFiles(db, studentId, { maxAgeSec = BACKGROUND_MAX_AGE_SEC } = {}) {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(studentId));
  if (!student?.schoology_uid) throw new FileError('NOT_FOUND', `Unknown student ${studentId}`, 404);
  const rows = db.prepare(`
    SELECT a.id FROM grades g
    JOIN assignments a ON a.id = g.assignment_id
    JOIN courses c ON c.id = a.course_id AND COALESCE(c.archived, 0) = 0 AND COALESCE(c.excluded, 0) = 0
    JOIN enrolments e ON e.course_id = a.course_id AND e.student_id = g.student_id AND e.dropped_at IS NULL
    WHERE g.student_id = ? AND g.submission_type = 'drop' AND COALESCE(a.is_lti_submission, 0) = 0
      AND COALESCE(a.published, 1) = 1 AND a.removed_at IS NULL
  `).all(student.id);
  const courses = new Map();
  const courseOf = (id) => {
    if (!courses.has(id)) courses.set(id, db.prepare('SELECT * FROM courses WHERE id = ?').get(id));
    return courses.get(id);
  };
  return runQueue(db, `s:${student.id}`, { maxAgeSec }, (asOf) => rows.filter((r) => stale(db, r.id, student.id, maxAgeSec, asOf)).map((r) => {
    const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(r.id);
    return { assignment, course: courseOf(assignment.course_id), student };
  }));
}

// One cached file (or, with copy 'converted', Schoology's converted copy of it),
// opened with the API signature (the download path refuses an unsigned request)
// → { status (200 or 206), filename, filemime, filesize, contentRange, body (web stream) }.
// `range` is the browser's Range header, passed on so a video can seek.
export async function openSubmissionFile(db, { assignmentId, studentId, revisionId, fileId, copy = 'original', range = null }) {
  const pair = pairOf(db, { assignmentId, studentId });
  const stored = storedFile(db, { assignmentId: pair.assignment.id, studentId: pair.student.id, revisionId, fileId });
  const f = copy === 'converted' ? stored?.converted : stored;
  if (!f?.download_path) {
    throw new FileError('NOT_FOUND', copy === 'converted'
      ? 'Schoology has no converted copy of that file.'
      : 'That file is not in this submission. Refresh the list and try again.', 404);
  }
  const res = await fileDeps.openFile(f.download_path, { range });
  if (res.status === 416) {
    await res.body?.cancel?.().catch(() => {});
    throw new FileError('RANGE', 'That part of the file is out of range.', 416);
  }
  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel?.().catch(() => {});
    throw new FileError('SCHOOLOGY', `Schoology refused the download (${res.status}).`, 502);
  }
  return {
    status: res.status,
    filename: f.filename || stored.filename || 'file',
    filemime: f.filemime || res.contentType || 'application/octet-stream',
    filesize: res.contentLength || null, // Schoology's own length; the cached filesize could disagree
    contentRange: res.status === 206 ? res.contentRange : null,
    body: res.body,
  };
}
