// Native dropbox submission files (#107): every revision's files for one
// (assignment, student), read on demand and cached, and each file streamed
// through Prism with the API signature. OneDrive work keeps its own "Open"
// links (the mastery submission-links route, #120).
import { Router } from 'express';
import { Readable } from 'stream';
import { getDb } from '../db/index.js';
import { featureGate } from '../middleware/featureGate.js';
import { FileError, revisionsFor, openSubmissionFile } from '../services/submissionFiles.js';
import { fileSummariesForAssignment } from '../services/submissionFileStore.js';
import { resolveAssignmentId } from '../services/idResolvers.js';

const router = Router();
router.use(featureGate('submission_files'));

const fail = (res, err, what) => {
  if (err instanceof FileError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`submission files ${what} failed:`, err);
  return res.status(500).json({ error: `Submission files failed: ${err.message}`, code: 'INTERNAL' });
};

// Chip counts for the assessment page: cache only, no reads.
router.get('/assignment/:assignmentId', (req, res) => {
  try {
    const db = getDb();
    const localId = resolveAssignmentId(db, req.params.assignmentId);
    if (!localId) throw new FileError('NOT_FOUND', `Unknown assignment ${req.params.assignmentId}`, 404);
    res.json({ students: fileSummariesForAssignment(db, localId) });
  } catch (err) { fail(res, err, 'summaries'); }
});

router.get('/:assignmentId/:studentId', async (req, res) => {
  try {
    res.json(await revisionsFor(getDb(), {
      assignmentId: req.params.assignmentId, studentId: req.params.studentId, force: req.query.refresh === '1',
    }));
  } catch (err) { fail(res, err, 'read'); }
});

// Images and PDFs open in the browser; anything else downloads. A student's
// HTML file must never run on Prism's origin, hence attachment + sandbox.
router.get('/:assignmentId/:studentId/:revisionId/files/:fileId', async (req, res) => {
  let f;
  try {
    f = await openSubmissionFile(getDb(), req.params);
  } catch (err) { return fail(res, err, 'download'); }
  const inline = /^image\/(png|jpeg|gif|webp)$|^application\/pdf$/.test(f.filemime);
  res.set('Content-Type', f.filemime);
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.set('X-Content-Type-Options', 'nosniff');
  // (Not on inline PDFs: Chrome's viewer refuses a sandboxed document.)
  if (!inline) res.set('Content-Security-Policy', 'sandbox');
  if (f.filesize) res.set('Content-Length', String(f.filesize));
  if (!f.body) return res.end();
  const stream = Readable.fromWeb(f.body);
  stream.on('error', (err) => { console.error('submission file stream failed:', err); res.destroy(err); });
  res.on('close', () => { if (!res.writableFinished) stream.destroy(); });
  stream.pipe(res);
});

export default router;
