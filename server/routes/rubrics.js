import { Router } from 'express';
import multer from 'multer';
import { featureGate, getRubricConfig } from '../middleware/featureGate.js';
import { getDb } from '../db/index.js';
import { listRubrics, saveRubric, getRubric, deleteRubric, renameRubric, findRubricByContentHash } from '../services/rubricStore.js';
import { hashRubricContent } from '../services/rubricHash.js';
import { parseRubricCsv, templateCsv, exportRubricCsv } from '../services/rubricCsv.js';
import { getFeedbackRows, rowLevelsError, saveRowLevels, getRowLevels } from '../services/feedbackRows.js';
import { getAlignedTopics, scoreScaleFor } from '../services/assessmentContext.js';
import { attachRubric, getAttachmentForAssignment, getAttachmentsForAssignments, setMapping, reorderCriteria, detachAttachment } from '../services/rubricAttach.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });
router.use(featureGate('rubric_descriptors'));

router.get('/', (req, res) => res.json(listRubrics(getDb())));
router.get('/config', (req, res) => res.json(getRubricConfig()));

router.get('/template', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="rubric-template.csv"');
  res.send(templateCsv());
});

router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const name = (req.body.name || req.file.originalname || 'Untitled rubric').replace(/\.csv$/i, '');
  try {
    const content = parseRubricCsv(req.file.buffer.toString('utf-8'), { name });
    const existing = findRubricByContentHash(getDb(), hashRubricContent(content));
    if (existing) {
      return res.json({ id: existing.id, name: existing.name, criteria_count: content.criteria.length, reused: true, match: 'exact' });
    }
    const id = saveRubric(getDb(), content);
    res.json({ id, name, criteria_count: content.criteria.length, reused: false });
  } catch (err) {
    res.status(400).json({ error: `CSV parse error: ${err.message}` });
  }
});

router.get('/:id/export', (req, res) => {
  const rubric = getRubric(getDb(), Number(req.params.id));
  if (!rubric) return res.status(404).json({ error: 'Rubric not found' });
  res.setHeader('Content-Type', 'text/csv');
  const safeName = String(rubric.name).replace(/["\r\n]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
  res.send(exportRubricCsv(rubric));
});

router.post('/attach', (req, res) => {
  const { rubricId, courseId, assignmentId } = req.body;
  try {
    const result = attachRubric(getDb(), { rubricId, courseId, assignmentId });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/assignment/:assignmentId', (req, res) => {
  res.json(getAttachmentForAssignment(getDb(), req.params.assignmentId));
});

// GET /api/rubrics/assignments?ids=a,b,c → { attachments: { [schoology aid]: attachment } }.
// One request for a page that lists many assignments (the student page, #135).
const MAX_BATCH_IDS = 500;
router.get('/assignments', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_BATCH_IDS);
  res.json({ attachments: getAttachmentsForAssignments(getDb(), ids) });
});

router.put('/attachment/:attachmentId/mapping', (req, res) => {
  const { criterionId, topicId } = req.body;
  try {
    setMapping(getDb(), Number(req.params.attachmentId), criterionId, topicId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id/reorder', (req, res) => {
  reorderCriteria(getDb(), Number(req.params.id), req.body.orderedCriterionIds || []);
  res.json({ ok: true });
});

router.delete('/attachment/:attachmentId', (req, res) => {
  detachAttachment(getDb(), Number(req.params.attachmentId));
  res.json({ ok: true });
});

// Save a student's feedback-row levels without touching Schoology (spec
// 2026-10-13 §5): the card's Save when only rows changed.
router.put('/row-levels/:assignmentSchoologyId/:studentUid', (req, res) => {
  const db = getDb();
  const { assignmentSchoologyId, studentUid } = req.params;
  const row = db.prepare('SELECT * FROM assignments WHERE schoology_assignment_id = ?').get(String(assignmentSchoologyId));
  const scale = row ? scoreScaleFor(row, getAlignedTopics(db, row.course_id, row.schoology_assignment_id).length) : null;
  const rows = getFeedbackRows(db, assignmentSchoologyId, scale)?.rows ?? [];
  const error = rowLevelsError(rows, req.body?.rowLevels);
  if (error) return res.status(400).json({ error });
  saveRowLevels(db, { assignmentSchoologyId, studentUid, rowLevels: req.body.rowLevels });
  res.json({ ok: true, row_levels: getRowLevels(db, assignmentSchoologyId)[studentUid] || {} });
});

router.patch('/:id', (req, res) => {
  try {
    renameRubric(getDb(), Number(req.params.id), req.body.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  deleteRubric(getDb(), Number(req.params.id));
  res.json({ ok: true });
});

export default router;
