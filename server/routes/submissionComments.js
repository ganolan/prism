// Submission comment threads (docs/superpowers/specs/2026-10-17-submission-comments-design.md).
// Reads are cached and lazy; posting and deleting reach Schoology at once, and
// the client confirms before calling them because students see a post at once.
import express, { Router } from 'express';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { getDb } from '../db/index.js';
import { featureGate } from '../middleware/featureGate.js';
import { CommentError, threadFor, refreshAssignment, refreshStudent, postComment, deleteComment, postCommentWithFile, commentFile, markThreadSeen } from '../services/submissionComments.js';
import { summariesForAssignment, summariesForCourse, summariesForStudent } from '../services/submissionCommentStore.js';
import { resolveAssignmentId } from '../services/idResolvers.js';
import { sendFile } from './fileResponse.js';

const router = Router();
router.use(featureGate('submission_comments'));

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, getDb()));
  } catch (err) {
    if (err instanceof CommentError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('submission comments route failed:', err);
    res.status(500).json({ error: `Submission comments failed: ${err.message}`, code: 'INTERNAL' });
  }
};

// Badges for the assessment page; also queues a background read of the
// assignment's submitted cells (unless ?refresh=0).
router.get('/assignment/:assignmentId', handle((req, db) => {
  const localId = resolveAssignmentId(db, req.params.assignmentId);
  if (!localId) throw new CommentError('NOT_FOUND', `Unknown assignment ${req.params.assignmentId}`, 404);
  let refresh = null;
  if (req.query.refresh !== '0') {
    const job = refreshAssignment(db, localId);
    job.done?.catch((err) => console.error('submission comment refresh failed:', err));
    refresh = { queued: job.queued, joined: !!job.joined };
  }
  return { students: summariesForAssignment(db, localId), refresh };
}));

// Badges for the student page (#135): this student's cached summaries only, keyed
// by Schoology assignment id; also queues a background read of their submitted
// assignments' threads (unless ?refresh=0).
router.get('/student/:studentId', handle((req, db) => {
  const student = db.prepare('SELECT id FROM students WHERE id = ?').get(Number(req.params.studentId));
  if (!student) throw new CommentError('NOT_FOUND', `Unknown student ${req.params.studentId}`, 404);
  let refresh = null;
  if (req.query.refresh !== '0') {
    const job = refreshStudent(db, student.id);
    job.done?.catch((err) => console.error('submission comment refresh failed:', err));
    refresh = { queued: job.queued, joined: !!job.joined };
  }
  return { assignments: summariesForStudent(db, student.id), refresh };
}));

// Badges for the gradebook: cache only, no reads.
router.get('/course/:courseId', handle((req, db) => ({ assignments: summariesForCourse(db, Number(req.params.courseId)) })));

router.get('/:assignmentId/:studentId', handle((req, db) =>
  threadFor(db, { assignmentId: req.params.assignmentId, studentId: req.params.studentId, force: req.query.refresh === '1' })));

// The popover showed the thread: mark it seen (clears the unread marker). → the thread.
router.post('/:assignmentId/:studentId/seen', handle((req, db) =>
  markThreadSeen(db, { assignmentId: req.params.assignmentId, studentId: req.params.studentId })));

router.post('/:assignmentId/:studentId', handle((req, db) =>
  postComment(db, { assignmentId: req.params.assignmentId, studentId: req.params.studentId, text: req.body?.text })));

// A comment with a file: { text, fileName, data (base64) }. Goes through
// Schoology's web form with the saved browser session (the REST API drops files).
const MAX_FILE_BYTES = 15 * 1024 * 1024;
router.post('/:assignmentId/:studentId/file', express.json({ limit: '25mb' }), handle(async (req, db) => {
  const { text, fileName, data } = req.body || {};
  const name = basename(String(fileName || '')).replace(/[\\/:*?"<>|]/g, '_').trim();
  if (!name || !data) throw new CommentError('NO_FILE', 'Choose a file to attach.');
  const bytes = Buffer.from(String(data), 'base64');
  if (!bytes.length) throw new CommentError('NO_FILE', 'The file is empty.');
  if (bytes.length > MAX_FILE_BYTES) throw new CommentError('TOO_LARGE', 'A file can be at most 15 MB.');
  const dir = await mkdtemp(join(tmpdir(), 'prism-comment-'));
  try {
    const filePath = join(dir, name);
    await writeFile(filePath, bytes);
    return await postCommentWithFile(db, { assignmentId: req.params.assignmentId, studentId: req.params.studentId, text, filePath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}));

// A comment's file, streamed from Schoology with the API signature, inline when
// Prism's viewer can show it (#162: images, videos, audio, PDFs, with byte
// ranges); anything else downloads, sandboxed. ?download=1 always downloads.
router.get('/:assignmentId/:studentId/:commentId/files/:fid', async (req, res) => {
  let f;
  try {
    f = await commentFile(getDb(), { ...req.params, range: req.get('range') || null });
  } catch (err) {
    if (err instanceof CommentError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('submission comment file failed:', err);
    return res.status(500).json({ error: `Could not fetch the file: ${err.message}`, code: 'INTERNAL' });
  }
  sendFile(req, res, f);
});

router.delete('/:assignmentId/:studentId/:commentId', handle((req, db) =>
  deleteComment(db, { assignmentId: req.params.assignmentId, studentId: req.params.studentId, commentId: req.params.commentId })));

export default router;
