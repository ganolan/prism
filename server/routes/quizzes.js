// Linked quizzes (docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md).
// Combining reads each test's question list through the browser session first,
// so a parity mismatch is refused before anything is stored.
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { featureGate } from '../middleware/featureGate.js';
import { QuizError } from '../services/quizError.js';
import {
  createGroup, linkResult, unlinkResult, deleteGroup, getGroup, listGroups, groupForAssignment,
  setQuestionTags, listCandidates, attemptLinks, attemptLinksForStudent, setCommentTemplate, checkGroupTests,
} from '../services/quizGroups.js';
import { compareQuestionLists } from '../services/quizParity.js';
import { readQuestionLists } from '../services/quizLoader.js';
import { loadQuizQueued } from '../services/quizRun.js';
import { groupStats } from '../services/quizStats.js';
import { courseTagResults } from '../services/quizTagResults.js';
import { frqResponses } from '../services/frqResponses.js';
import { setFrqMark } from '../services/frqMarks.js';
import { quizResults } from '../services/quizResults.js';
import { quizAttempts } from '../services/quizAttempts.js';
import { rebuildOverallSuggestion } from '../services/quizOverall.js';
import { postWritebacks } from '../services/quizWriteback.js';

const router = Router();
router.use(featureGate('quizzes'));

const STATUS = { NOT_FOUND: 404, NOT_ELIGIBLE: 400, PARITY: 409, BUSY: 409, UNSAFE: 409, NO_SESSION: 503, UNREACHABLE: 502 };
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, getDb()));
  } catch (err) {
    // The load is still running past the wait: the page follows the run by its id.
    if (err instanceof QuizError && err.code === 'PENDING') return res.status(202).json({ runId: err.runId });
    if (err instanceof QuizError) {
      return res.status(STATUS[err.code] ?? 500).json({ error: err.message, code: err.code, differences: err.differences });
    }
    console.error('quizzes route failed:', err);
    res.status(500).json({ error: 'Quiz request failed', code: 'INTERNAL' });
  }
};

router.get('/', handle((req, db) => ({ groups: listGroups(db, { courseId: req.query.course_id }) })));
router.get('/candidates', handle((req, db) => listCandidates(db, { courseId: req.query.course_id })));
// One tag across every quiz group in a course (#139). The tag goes in the query: codes carry dots.
router.get('/tag-results', handle((req, db) => courseTagResults(db, { courseId: req.query.course_id, tag: req.query.tag })));
router.get('/for-assignment/:ref', handle((req, db) => ({ group: groupForAssignment(db, req.params.ref) })));
router.get('/attempt-links', handle((req, db) => ({
  links: req.query.student_id
    ? attemptLinksForStudent(db, { studentId: req.query.student_id })
    : attemptLinks(db, { assignmentRef: req.query.assignment_id }),
})));

router.post('/check-parity', handle(async (req, db) => {
  const refs = req.body.assignment_ids || [];
  checkGroupTests(db, { assignmentRefs: refs, parityOnly: true });
  const lists = await readQuestionLists(db, { assignmentRefs: refs });
  return compareQuestionLists(lists);
}));

router.post('/', handle(async (req, db) => {
  const refs = req.body.assignment_ids || [];
  checkGroupTests(db, { courseId: req.body.course_id, assignmentRefs: refs });
  const lists = await readQuestionLists(db, { assignmentRefs: refs });
  return { group: createGroup(db, { courseId: req.body.course_id, assignmentRefs: refs, title: req.body.title, questionLists: lists }) };
}));

router.put('/:id/link', handle((req, db) => ({
  group: req.body.result_assignment_id == null
    ? unlinkResult(db, { groupId: req.params.id })
    : linkResult(db, { groupId: req.params.id, resultRef: req.body.result_assignment_id }),
})));

router.delete('/:id', handle((req, db) => { deleteGroup(db, { groupId: req.params.id }); return { ok: true }; }));

// A queue run (quizRun.js): answers 202 { runId } when it is still going after the wait.
router.post('/:id/load', handle(async (req, db) => {
  const summary = await loadQuizQueued(db, req.params.id);
  return { summary, group: getGroup(db, req.params.id) };
}));

router.get('/:id/stats', handle((req, db) => groupStats(db, { groupId: req.params.id })));
router.put('/:id/template', handle((req, db) => ({ group: setCommentTemplate(db, { groupId: req.params.id, template: req.body.template }) })));
router.put('/:id/tags', handle((req, db) => setQuestionTags(db, { groupId: req.params.id, tags: req.body.tags, texts: req.body.texts })));
router.get('/:id/results', handle((req, db) => quizResults(db, { groupId: req.params.id })));
// #200: the Attempts tab: every question and every student's answers, from Prism's stored copy.
router.get('/:id/attempts', handle((req, db) => quizAttempts(db, { groupId: req.params.id })));
router.post('/:id/overall/:studentId/rebuild', handle((req, db) => ({
  student: rebuildOverallSuggestion(db, { groupId: req.params.id, studentId: req.params.studentId }),
})));
// Post accepted FRQ marks to Schoology (spec §14): limit 1 posts the first one only.
router.post('/:id/writeback', featureGate('quiz_writeback'), handle((req, db) =>
  postWritebacks(db, { groupId: req.params.id, limit: req.body?.limit ?? null })));
router.get('/:id/frq', handle((req, db) => frqResponses(db, { groupId: req.params.id, position: req.query.question ?? null })));
router.put('/:id/frq/:attemptId/:position', handle((req, db) => ({
  mark: setFrqMark(db, {
    groupId: req.params.id, attemptId: req.params.attemptId, position: req.params.position,
    action: req.body.action, cells: req.body.cells, comment: req.body.comment,
  }),
})));

export default router;
