// Submission comment threads (docs/superpowers/specs/2026-10-17-submission-comments-design.md).
// Reads are cached and lazy; posting and deleting reach Schoology at once, and
// the client confirms before calling them because students see a post at once.
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { featureGate } from '../middleware/featureGate.js';
import { CommentError, threadFor, refreshAssignment, postComment, deleteComment } from '../services/submissionComments.js';
import { summariesForAssignment, summariesForCourse } from '../services/submissionCommentStore.js';
import { resolveAssignmentId } from '../services/idResolvers.js';

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

// Badges for the gradebook: cache only, no reads.
router.get('/course/:courseId', handle((req, db) => ({ assignments: summariesForCourse(db, Number(req.params.courseId)) })));

router.get('/:assignmentId/:studentId', handle((req, db) =>
  threadFor(db, { assignmentId: req.params.assignmentId, studentId: req.params.studentId, force: req.query.refresh === '1' })));

router.post('/:assignmentId/:studentId', handle((req, db) =>
  postComment(db, { assignmentId: req.params.assignmentId, studentId: req.params.studentId, text: req.body?.text })));

router.delete('/:assignmentId/:studentId/:commentId', handle((req, db) =>
  deleteComment(db, { assignmentId: req.params.assignmentId, studentId: req.params.studentId, commentId: req.params.commentId })));

export default router;
