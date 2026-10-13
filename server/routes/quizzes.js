// Linked quizzes (docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md).
// Combining reads each test's question list through the browser session first,
// so a parity mismatch is refused before anything is stored.
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { featureGate } from '../middleware/featureGate.js';
import { QuizError } from '../services/quizError.js';
import {
  createGroup, linkResult, unlinkResult, deleteGroup, getGroup, listGroups, groupForAssignment,
  setQuestionTags, listCandidates, attemptLinks, attemptLinksForStudent, setCommentTemplate,
} from '../services/quizGroups.js';
import { compareQuestionLists } from '../services/quizParity.js';
import { readQuestionLists, loadGroup } from '../services/quizLoader.js';
import { groupStats } from '../services/quizStats.js';
import { frqResponses } from '../services/frqResponses.js';
import { setFrqMark } from '../services/frqMarks.js';
import { quizResults } from '../services/quizResults.js';
import { rebuildOverallSuggestion } from '../services/quizOverall.js';
import { postWritebacks } from '../services/quizWriteback.js';

const router = Router();
router.use(featureGate('quizzes'));

const STATUS = { NOT_FOUND: 404, NOT_ELIGIBLE: 400, PARITY: 409, BUSY: 409, UNSAFE: 409, NO_SESSION: 503, UNREACHABLE: 502 };
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, getDb()));
  } catch (err) {
    if (err instanceof QuizError) {
      return res.status(STATUS[err.code] ?? 500).json({ error: err.message, code: err.code, differences: err.differences });
    }
    console.error('quizzes route failed:', err);
    res.status(500).json({ error: 'Quiz request failed', code: 'INTERNAL' });
  }
};

router.get('/', handle((req, db) => ({ groups: listGroups(db, { courseId: req.query.course_id }) })));
router.get('/candidates', handle((req, db) => listCandidates(db, { courseId: req.query.course_id })));
router.get('/for-assignment/:ref', handle((req, db) => ({ group: groupForAssignment(db, req.params.ref) })));
router.get('/attempt-links', handle((req, db) => ({
  links: req.query.student_id
    ? attemptLinksForStudent(db, { studentId: req.query.student_id })
    : attemptLinks(db, { assignmentRef: req.query.assignment_id }),
})));

router.post('/check-parity', handle(async (req, db) => {
  const refs = req.body.assignment_ids || [];
  if (!refs.length) throw new QuizError('NOT_ELIGIBLE', 'Choose at least one test');
  const lists = await readQuestionLists(db, { assignmentRefs: refs });
  return compareQuestionLists(lists);
}));

router.post('/', handle(async (req, db) => {
  const refs = req.body.assignment_ids || [];
  const lists = await readQuestionLists(db, { assignmentRefs: refs });
  return { group: createGroup(db, { courseId: req.body.course_id, assignmentRefs: refs, title: req.body.title, questionLists: lists }) };
}));

router.put('/:id/link', handle((req, db) => ({
  group: req.body.result_assignment_id == null
    ? unlinkResult(db, { groupId: req.params.id })
    : linkResult(db, { groupId: req.params.id, resultRef: req.body.result_assignment_id }),
})));

router.delete('/:id', handle((req, db) => { deleteGroup(db, { groupId: req.params.id }); return { ok: true }; }));

router.post('/:id/load', handle(async (req, db) => {
  const summary = await loadGroup(db, { groupId: req.params.id });
  return { summary, group: getGroup(db, req.params.id) };
}));

router.get('/:id/stats', handle((req, db) => groupStats(db, { groupId: req.params.id })));
router.put('/:id/template', handle((req, db) => ({ group: setCommentTemplate(db, { groupId: req.params.id, template: req.body.template }) })));
router.put('/:id/tags', handle((req, db) => setQuestionTags(db, { groupId: req.params.id, tags: req.body.tags, texts: req.body.texts })));
router.get('/:id/results', handle((req, db) => quizResults(db, { groupId: req.params.id })));
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
