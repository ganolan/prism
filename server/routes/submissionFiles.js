// Native dropbox submission files (#107): every revision's files for one
// (assignment, student), read on demand and cached, and each file streamed
// through Prism with the API signature. OneDrive work keeps its own "Open"
// links (the mastery submission-links route, #120).
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { sendFile } from './fileResponse.js';
import { featureGate } from '../middleware/featureGate.js';
import { FileError, revisionsFor, openSubmissionFile, refreshStudentFiles } from '../services/submissionFiles.js';
import { fileSummariesForAssignment, fileSummariesForStudent } from '../services/submissionFileStore.js';
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

// Chips for the student page (#162): this student's cached summaries only, keyed
// by Schoology assignment id; also queues a background read of their uploads in
// current courses (unless ?refresh=0). Nothing about another student.
router.get('/student/:studentId', (req, res) => {
  try {
    const db = getDb();
    const student = db.prepare('SELECT id FROM students WHERE id = ?').get(Number(req.params.studentId));
    if (!student) throw new FileError('NOT_FOUND', `Unknown student ${req.params.studentId}`, 404);
    let refresh = null;
    if (req.query.refresh !== '0') {
      const job = refreshStudentFiles(db, student.id);
      job.done?.catch((err) => console.error('submission files refresh failed:', err));
      refresh = { queued: job.queued, joined: !!job.joined };
    }
    res.json({ assignments: fileSummariesForStudent(db, student.id), refresh });
  } catch (err) { fail(res, err, 'student summaries'); }
});

router.get('/:assignmentId/:studentId', async (req, res) => {
  try {
    res.json(await revisionsFor(getDb(), {
      assignmentId: req.params.assignmentId, studentId: req.params.studentId, force: req.query.refresh === '1',
    }));
  } catch (err) { fail(res, err, 'read'); }
});

// One file, inline when Prism's viewer can show it (fileResponse.js).
// ?copy=converted serves Schoology's converted copy (an .mp4 of a video, a .pdf
// of a document); ?download=1 always downloads.
router.get('/:assignmentId/:studentId/:revisionId/files/:fileId', async (req, res) => {
  let f;
  try {
    f = await openSubmissionFile(getDb(), {
      ...req.params, copy: req.query.copy === 'converted' ? 'converted' : 'original', range: req.get('range') || null,
    });
  } catch (err) { return fail(res, err, 'download'); }
  sendFile(req, res, f);
});

export default router;
