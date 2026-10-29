import { Router } from 'express';
import { featureGate } from '../middleware/featureGate.js';
import { getDb } from '../db/index.js';
import { readLesson, saveLesson } from '../services/attendanceMarking.js';

// #39: a course's attendance, taken in Prism and saved to PowerSchool (services/attendanceMarking.js).
const router = Router();

const STATUS = { NOT_FOUND: 404, BAD_VALUE: 400, OFFICE: 400, NOT_CURRENT: 409, LINKED: 409, NO_LESSON: 409, NO_SECTION: 409, CHANGED: 409, MISMATCH: 502 };
const LOGIN = 'Not logged in to Schoology: run `npm run mastery:login` and retry.';
function fail(res, err) {
  if (err.code === 'SESSION_EXPIRED') return res.status(409).json({ error: LOGIN, needsLogin: true });
  if (err.code === 'PS_SECURITY') return res.status(502).json({ error: 'PowerSchool logged a security violation; nothing more was sent.' });
  const status = STATUS[err.code];
  if (status) return res.status(status).json({ error: err.message, code: err.code, ...(err.lesson ? { lesson: err.lesson } : {}) });
  console.error('[attendance] Error:', err);
  return res.status(502).json({ error: `PowerSchool could not be read: ${err.message}` });
}

// GET /api/attendance/:courseId?date=YYYY-MM-DD — one lesson: codes, each student's mark, office marks, taken.
router.get('/:courseId', featureGate('attendance'), async (req, res) => {
  try { res.json(await readLesson(getDb(), Number(req.params.courseId), String(req.query.date || ''))); } catch (err) { fail(res, err); }
});

// POST /api/attendance/:courseId { date, marks: { [ps_student_id]: code }, fingerprint } — save to PowerSchool,
// read back. → { lesson, changed }.
router.post('/:courseId', featureGate('attendance'), async (req, res) => {
  try { res.json(await saveLesson(getDb(), Number(req.params.courseId), req.body || {})); } catch (err) { fail(res, err); }
});

export default router;
