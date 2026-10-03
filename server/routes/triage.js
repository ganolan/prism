// Late-work referral watch + feedback owed (server/services/triage.js).
import { Router } from 'express';
import { getDb } from '../db/index.js';
import {
  getTriage, listReferrals, recordReferral, undoReferral,
  listExtensions, recordExtension, undoExtension, setMakeUpIgnored, TriageError,
} from '../services/triage.js';
import {
  listResubmissions, requestResubmission, extendResubmission, gradeStands, undoResubmission,
} from '../services/resubmissions.js';
import { loadCalendar } from '../services/schoolCalendar.js';

const router = Router();
const STATUS = {
  BAD_ACTION: 400, BAD_LESSONS: 400, BAD_VALUE: 400, NOT_FOUND: 404,
  NOT_ON_LIST: 409, NOT_AT_LIMIT: 409, NOT_ELIGIBLE: 409, ALREADY_OPEN: 409, NOT_AT_DEADLINE: 409,
};
const optBool = (v) => (v === undefined ? undefined : v === 'true');

// Runs a write; a TriageError becomes its HTTP status + { error, code }.
function write(res, fn, okStatus = 201) {
  try {
    res.status(okStatus).json(fn());
  } catch (err) {
    if (err instanceof TriageError) return res.status(STATUS[err.code] || 400).json({ error: err.message, code: err.code });
    throw err;
  }
}

// GET /api/triage?courseId=&includeFormative= — both lists (all current courses when no courseId).
router.get('/', (req, res) => {
  res.json(getTriage(getDb(), {
    courseId: req.query.courseId ?? null,
    includeFormative: optBool(req.query.includeFormative),
  }));
});

// GET /api/triage/calendar — school-calendar freshness only (source,
// totalSchoolDays, syncedAt). SyncConfig uses this to decide whether the
// PowerSchool step should be pre-ticked, without paying for the full triage
// payload (every current course's late-work + feedback-owed computation).
router.get('/calendar', (req, res) => {
  const cal = loadCalendar(getDb());
  res.json({ source: cal.source, totalSchoolDays: cal.totalSchoolDays, syncedAt: cal.syncedAt });
});

// GET /api/triage/referrals?courseId= — referral history, newest first.
router.get('/referrals', (req, res) => {
  res.json(listReferrals(getDb(), { courseId: req.query.courseId ?? null }));
});

// POST /api/triage/referrals — { studentId, assignmentId, action: 'referred', note? }
router.post('/referrals', (req, res) => {
  const { studentId, assignmentId, action, note } = req.body || {};
  write(res, () => recordReferral(getDb(), { studentId, assignmentId, action, note, source: 'app' }));
});

// DELETE /api/triage/referrals/:id — undo a referral.
router.delete('/referrals/:id', (req, res) => {
  res.json(undoReferral(getDb(), req.params.id));
});

// GET /api/triage/extensions?courseId= — per-student deadline extensions, newest first.
router.get('/extensions', (req, res) => {
  res.json(listExtensions(getDb(), { courseId: req.query.courseId ?? null }));
});

// POST /api/triage/extensions — { studentId, assignmentId, lessons (1–60 school days), note? }
router.post('/extensions', (req, res) => {
  const { studentId, assignmentId, lessons, note } = req.body || {};
  write(res, () => recordExtension(getDb(), { studentId, assignmentId, lessons, note, source: 'app' }));
});

// DELETE /api/triage/extensions/:id — undo an extension.
router.delete('/extensions/:id', (req, res) => {
  res.json(undoExtension(getDb(), req.params.id));
});

// Resubmissions (asks). GET = history, newest first.
router.get('/resubmissions', (req, res) => {
  res.json(listResubmissions(getDb(), { courseId: req.query.courseId ?? null }));
});

// POST /api/triage/resubmissions — { studentId, assignmentId, lessons?, note? } (lessons default: settings)
router.post('/resubmissions', (req, res) => {
  const { studentId, assignmentId, lessons, note } = req.body || {};
  write(res, () => requestResubmission(getDb(), { studentId, assignmentId, lessons, note, source: 'app' }));
});

// PUT /api/triage/resubmissions/:id — { lessons } extends; { gradeStands: true }
// ends the request once its deadline has passed (409 NOT_AT_DEADLINE before).
// { close: true } is accepted as an alias until the client moves over.
router.put('/resubmissions/:id', (req, res) => {
  const { lessons, close, gradeStands: stands } = req.body || {};
  write(res, () => (stands || close
    ? gradeStands(getDb(), req.params.id)
    : extendResubmission(getDb(), req.params.id, lessons)), 200);
});

// DELETE /api/triage/resubmissions/:id — undo an ask.
router.delete('/resubmissions/:id', (req, res) => {
  res.json(undoResubmission(getDb(), req.params.id));
});

// PUT /api/triage/makeup-ignore/:assignmentId — { ignored: boolean }: ignore (or
// track again) one Schoology test/quiz for make-ups, for every student.
router.put('/makeup-ignore/:assignmentId', (req, res) => {
  write(res, () => setMakeUpIgnored(getDb(), req.params.assignmentId, req.body?.ignored), 200);
});

export default router;
