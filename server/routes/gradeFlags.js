// Schoology's grade flags from Prism (#40): server/services/gradeFlags.js.
// GET  /api/grade-flags?studentId=&assignmentId=  → readFlagState (a fresh Schoology read)
// POST /api/grade-flags { studentId, assignmentId, code, expected, reason, restore } → setGradeFlag
// Errors are { error, code } with the triage routes' statuses, plus CHANGED 409,
// READBACK_MISMATCH 502 and SAVE_FAILED 500.
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { readFlagState, setGradeFlag } from '../services/gradeFlags.js';
import { TriageError } from '../services/triageCommon.js';

const router = Router();
const STATUS = {
  BAD_VALUE: 400, BAD_LINE: 400, NOT_FOUND: 404, NOT_ELIGIBLE: 409, BUSY: 409, CHANGED: 409,
  SCHOOLOGY_READ_FAILED: 502, SCHOOLOGY_WRITE_FAILED: 502, READBACK_MISMATCH: 502, SAVE_FAILED: 500,
};

function sendError(res, err) {
  if (err instanceof TriageError) return res.status(STATUS[err.code] || 400).json({ error: err.message, code: err.code });
  console.error('[grade-flags]', err);
  return res.status(500).json({ error: err.message });
}

router.get('/', async (req, res) => {
  const { studentId, assignmentId } = req.query;
  if (!studentId || !assignmentId) return res.status(400).json({ error: 'studentId and assignmentId are required', code: 'BAD_VALUE' });
  try {
    res.json(await readFlagState(getDb(), { studentId, assignmentId }));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/', async (req, res) => {
  const { studentId, assignmentId, code, expected, reason, restore } = req.body || {};
  try {
    res.json(await setGradeFlag(getDb(), { studentId, assignmentId, code, expected, reason: reason ?? null, restore: restore !== false }));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
