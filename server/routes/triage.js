// Late-work referral watch + feedback owed (server/services/triage.js).
import { Router } from 'express';
import { getDb } from '../db/index.js';
import {
  getTriage, listReferrals, recordReferral, undoReferral,
  listExtensions, recordExtension, undoExtension, setMakeUpIgnored, assertCanExtend, TriageError,
} from '../services/triage.js';
import {
  listResubmissions, requestResubmission, extendResubmission, gradeStands, undoResubmission,
  assertCanRequest, assertCanExtendRequest, assertCanGradeStand,
} from '../services/resubmissions.js';
import { previewStatusLine, publishStatusLine, removeStatusLine } from '../services/statusLinePublisher.js';
import { loadCalendar } from '../services/schoolCalendar.js';
import { todayLocal } from '../lib/schoolDays.js';

const router = Router();
const STATUS = {
  BAD_ACTION: 400, BAD_LESSONS: 400, BAD_VALUE: 400, NOT_FOUND: 404,
  NOT_ON_LIST: 409, NOT_AT_LIMIT: 409, NOT_ELIGIBLE: 409, ALREADY_OPEN: 409, NOT_AT_DEADLINE: 409,
  SCHOOLOGY_READ_FAILED: 502, SCHOOLOGY_WRITE_FAILED: 502,
};
const optBool = (v) => (v === undefined ? undefined : v === 'true');
const flag = (v) => v === '1' || v === 'true';
// A status line to publish with the action: omitted / '' → Prism-only (as before).
const hasLine = (commentLine) => commentLine != null && commentLine !== '';
const RESUBMISSION_LINE_KINDS = ['ask', 'extend_resubmission', 'grade_stands'];
const EXTENSION_LINE_KINDS = ['extension', 'make_up'];

function sendError(res, err) {
  if (err instanceof TriageError) return res.status(STATUS[err.code] || 400).json({ error: err.message, code: err.code });
  console.error('[triage]', err);
  return res.status(500).json({ error: err.message });
}

// Runs a write; a TriageError becomes its HTTP status + { error, code }.
function write(res, fn, okStatus = 201) {
  try {
    res.status(okStatus).json(fn());
  } catch (err) {
    if (err instanceof TriageError) return res.status(STATUS[err.code] || 400).json({ error: err.message, code: err.code });
    throw err;
  }
}

// An action that may publish to the student's Schoology comment (spec Amendment B,
// "Status lines"): validate the Prism action → publish (optional) → record in Prism.
// A failed validation or publish changes nothing. If the record step fails AFTER a
// publish, the comment is already on Schoology: say so plainly (500) so the teacher
// knows, and log it.
async function act(res, { validate, publish = null, record }, okStatus = 201) {
  let ctx;
  let published = null;
  try {
    ctx = validate();
    if (publish) published = await publish(ctx);
  } catch (err) {
    return sendError(res, err);
  }
  try {
    const result = record(ctx);
    return res.status(okStatus).json(published ? { ...result, statusLine: published } : result);
  } catch (err) {
    // A no-op removal (no stored line / hand-edited) wrote nothing to Schoology.
    if (!published || published.removed === false) return sendError(res, err);
    console.error('[triage] status line published to Schoology, but recording the action in Prism failed:', err);
    return res.status(500).json({
      error: `The comment WAS published to the student's Schoology comment, but Prism could not record the action (${err.message}). Check the comment in Schoology, then reload and retry the action.`,
      code: 'RECORD_FAILED_AFTER_PUBLISH',
      published: true,
      comment: published.comment ?? null,
    });
  }
}

// GET /api/triage/status-line/preview?studentId&assignmentId&line — the confirm
// modal's fresh read: { currentComment, visible, storedLine, resultingComment, hiddenWarning }.
router.get('/status-line/preview', async (req, res) => {
  const { studentId, assignmentId, line } = req.query;
  try {
    res.json(await previewStatusLine(getDb(), { studentId, assignmentId, line: line ?? '' }));
  } catch (err) {
    sendError(res, err);
  }
});

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

// POST /api/triage/extensions — { studentId, assignmentId, lessons (1–60 school days), note?, commentLine? }
// commentLine → published first (kind 'make_up' for a Schoology test, else 'extension').
router.post('/extensions', (req, res) => {
  const { studentId, assignmentId, lessons, note, commentLine } = req.body || {};
  const db = getDb();
  act(res, {
    validate: () => assertCanExtend(db, { studentId, assignmentId, lessons }),
    publish: hasLine(commentLine) && ((ctx) => publishStatusLine(db, {
      studentId: ctx.student.id, assignmentId: ctx.assignment.id, line: commentLine,
      kind: ctx.assignment.is_test === 1 ? 'make_up' : 'extension',
    })),
    record: () => recordExtension(db, { studentId, assignmentId, lessons, note, source: 'app' }),
  });
});

// DELETE /api/triage/extensions/:id?removeLine=1 — undo an extension; removeLine
// first removes the stored extension/make-up line from the student's comment.
router.delete('/extensions/:id', (req, res) => {
  const db = getDb();
  act(res, {
    validate: () => db.prepare('SELECT student_id, assignment_id FROM extensions WHERE id = ?').get(Number(req.params.id)),
    publish: flag(req.query.removeLine) && ((x) => (x
      ? removeStatusLine(db, { studentId: x.student_id, assignmentId: x.assignment_id, kinds: EXTENSION_LINE_KINDS })
      : null)),
    record: () => undoExtension(db, req.params.id),
  }, 200);
});

// Resubmissions (asks). GET = history, newest first.
router.get('/resubmissions', (req, res) => {
  res.json(listResubmissions(getDb(), { courseId: req.query.courseId ?? null }));
});

// POST /api/triage/resubmissions — { studentId, assignmentId, lessons?, note?, commentLine? }
// (lessons default: settings). Eligibility + no open request are checked before
// commentLine is published (kind 'ask').
router.post('/resubmissions', (req, res) => {
  const { studentId, assignmentId, lessons, note, commentLine } = req.body || {};
  const db = getDb();
  act(res, {
    validate: () => assertCanRequest(db, { studentId, assignmentId, lessons }),
    publish: hasLine(commentLine) && ((ctx) => publishStatusLine(db, {
      studentId: ctx.student.id, assignmentId: ctx.assignment.id, line: commentLine, kind: 'ask',
    })),
    record: () => requestResubmission(db, { studentId, assignmentId, lessons, note, source: 'app' }),
  });
});

// PUT /api/triage/resubmissions/:id — { lessons, commentLine? } extends;
// { gradeStands: true, commentLine? } ends the request once its deadline has passed
// (409 NOT_AT_DEADLINE before — checked before anything is published).
// { close: true } is accepted as an alias until the client moves over.
router.put('/resubmissions/:id', (req, res) => {
  const { lessons, close, gradeStands: stands, commentLine } = req.body || {};
  const db = getDb();
  const { id } = req.params;
  const today = todayLocal();
  const ending = Boolean(stands || close);
  act(res, {
    validate: () => (ending ? assertCanGradeStand(db, id, today) : assertCanExtendRequest(db, id, lessons)),
    publish: hasLine(commentLine) && (({ request }) => publishStatusLine(db, {
      studentId: request.student_id, assignmentId: request.assignment_id, line: commentLine,
      kind: ending ? 'grade_stands' : 'extend_resubmission',
    })),
    record: () => (ending ? gradeStands(db, id, { today }) : extendResubmission(db, id, lessons)),
  }, 200);
});

// DELETE /api/triage/resubmissions/:id?removeLine=1 — undo; removeLine first removes
// the stored ask / extend / grade-stands line from the student's comment.
router.delete('/resubmissions/:id', (req, res) => {
  const db = getDb();
  act(res, {
    validate: () => db.prepare('SELECT student_id, assignment_id FROM resubmissions WHERE id = ?').get(Number(req.params.id)),
    publish: flag(req.query.removeLine) && ((r) => (r
      ? removeStatusLine(db, { studentId: r.student_id, assignmentId: r.assignment_id, kinds: RESUBMISSION_LINE_KINDS })
      : null)),
    record: () => undoResubmission(db, req.params.id),
  }, 200);
});

// PUT /api/triage/makeup-ignore/:assignmentId — { ignored: boolean }: ignore (or
// track again) one Schoology test/quiz for make-ups, for every student.
router.put('/makeup-ignore/:assignmentId', (req, res) => {
  write(res, () => setMakeUpIgnored(getDb(), req.params.assignmentId, req.body?.ignored), 200);
});

export default router;
