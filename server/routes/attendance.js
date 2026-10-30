import { Router } from 'express';
import { featureGate } from '../middleware/featureGate.js';
import { getDb } from '../db/index.js';
import { readLesson, saveLesson, lessonDays } from '../services/attendanceMarking.js';
import { todayLocal } from '../lib/schoolDays.js';
import { storeLesson } from '../services/attendanceRecord.js';

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

// GET /api/attendance/:courseId/days?from=YYYY-MM-DD&to=YYYY-MM-DD — the calendar: each lesson day and whether
// attendance is taken (null after today). At most 45 days.
router.get('/:courseId/days', featureGate('attendance'), async (req, res) => {
  try {
    res.json({ today: todayLocal(), days: await lessonDays(getDb(), Number(req.params.courseId), String(req.query.from || ''), String(req.query.to || ''), { today: todayLocal() }) });
  } catch (err) { fail(res, err); }
});

// A lesson just read from PowerSchool replaces that day's stored marks (#208), so the roster's absences follow it.
// Storing never fails the answer.
function keep(courseId, lesson) {
  try { storeLesson(getDb(), courseId, lesson); } catch (err) { console.error('[attendance] could not store the lesson:', err.message); }
}

// GET /api/attendance/:courseId?date=YYYY-MM-DD — one lesson: codes, each student's mark, office marks, taken.
router.get('/:courseId', featureGate('attendance'), async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const lesson = await readLesson(getDb(), courseId, String(req.query.date || ''));
    keep(courseId, lesson);
    res.json(lesson);
  } catch (err) { fail(res, err); }
});

// POST /api/attendance/:courseId { date, marks: { [ps_student_id]: code }, fingerprint } — save to PowerSchool,
// read back. → { lesson, changed }.
router.post('/:courseId', featureGate('attendance'), async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const saved = await saveLesson(getDb(), courseId, req.body || {});
    keep(courseId, saved.lesson);
    res.json(saved);
  } catch (err) { fail(res, err); }
});

export default router;
