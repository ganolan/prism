// Late-work referral watch + feedback owed (server/services/triage.js).
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { getTriage, listReferrals, recordReferral, undoReferral, TriageError } from '../services/triage.js';

const router = Router();
const STATUS = { BAD_ACTION: 400, NOT_FOUND: 404, NOT_ON_LIST: 409, NOT_AT_LIMIT: 409 };
const optBool = (v) => (v === undefined ? undefined : v === 'true');

// GET /api/triage?courseId=&includeFormative= — both lists (all current courses when no courseId).
router.get('/', (req, res) => {
  res.json(getTriage(getDb(), {
    courseId: req.query.courseId ?? null,
    includeFormative: optBool(req.query.includeFormative),
  }));
});

// GET /api/triage/referrals?courseId= — referred / exempt history, newest first.
router.get('/referrals', (req, res) => {
  res.json(listReferrals(getDb(), { courseId: req.query.courseId ?? null }));
});

// POST /api/triage/referrals — { studentId, assignmentId, action: 'referred'|'exempt', note? }
router.post('/referrals', (req, res) => {
  const { studentId, assignmentId, action, note } = req.body || {};
  try {
    res.status(201).json(recordReferral(getDb(), { studentId, assignmentId, action, note, source: 'app' }));
  } catch (err) {
    if (err instanceof TriageError) return res.status(STATUS[err.code] || 400).json({ error: err.message, code: err.code });
    throw err;
  }
});

// DELETE /api/triage/referrals/:id — undo a referral / exemption.
router.delete('/referrals/:id', (req, res) => {
  res.json(undoReferral(getDb(), req.params.id));
});

export default router;
