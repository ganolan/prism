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
import {
  previewStatusLine, publishStatusLine, removeStatusLine, setStatusLineSource,
} from '../services/statusLinePublisher.js';
import { act as runAction, hasLine, pairOf } from '../services/triageActions.js';
import { statusLineUntil } from '../services/statusLineDue.js';
import { loadCalendar } from '../services/schoolCalendar.js';
import { todayLocal } from '../lib/schoolDays.js';

const router = Router();
const STATUS = {
  BAD_ACTION: 400, BAD_LESSONS: 400, BAD_VALUE: 400, NOT_FOUND: 404,
  NOT_ON_LIST: 409, NOT_AT_LIMIT: 409, NOT_ELIGIBLE: 409, ALREADY_OPEN: 409, NOT_AT_DEADLINE: 409,
  SCHOOLOGY_READ_FAILED: 502, SCHOOLOGY_WRITE_FAILED: 502, BUSY: 409, BAD_LINE: 400,
};
const optBool = (v) => (v === undefined ? undefined : v === 'true');
const flag = (v) => v === '1' || v === 'true';

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
// "Status lines"). The lock → validate → publish → record sequence lives in
// server/services/triageActions.js (shared with PrisMCP) — this just maps its
// outcome to an HTTP response.
async function act(res, opts, okStatus = 201) {
  try {
    const result = await runAction(getDb(), opts);
    res.status(okStatus).json(result);
  } catch (err) {
    if (err && err.code === 'RECORD_FAILED_AFTER_PUBLISH') {
      return res.status(500).json({ error: err.message, code: err.code, published: err.published, comment: err.comment });
    }
    return sendError(res, err);
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

// GET /api/triage/status-line/until?kind&studentId&assignmentId&lessons&resubmissionId
// → { until, lessons }: the due date the confirm modal's default line embeds, from the
// same calendar logic (and validation) as the action itself. No Schoology read.
router.get('/status-line/until', (req, res) => {
  const { kind, studentId, assignmentId, lessons, resubmissionId } = req.query;
  try {
    res.json(statusLineUntil(getDb(), { kind, studentId, assignmentId, lessons, resubmissionId }));
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
    pair: () => [studentId, assignmentId],
    validate: () => assertCanExtend(db, { studentId, assignmentId, lessons }),
    publish: hasLine(commentLine) && ((ctx) => publishStatusLine(db, {
      studentId: ctx.student.id, assignmentId: ctx.assignment.id, line: commentLine,
      kind: ctx.assignment.is_test === 1 ? 'make_up' : 'extension',
    })),
    record: (ctx, published) => {
      const x = recordExtension(db, { studentId, assignmentId, lessons, note, source: 'app' });
      if (published) setStatusLineSource(db, { studentId: ctx.student.id, assignmentId: ctx.assignment.id, type: 'extension', id: x.id });
      return x;
    },
  });
});

// DELETE /api/triage/extensions/:id?removeLine=1 — undo an extension; removeLine
// first removes the line THIS extension published (if it is still the stored line).
router.delete('/extensions/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  act(res, {
    pair: () => pairOf(db, 'extensions', id),
    validate: () => pairOf(db, 'extensions', id),
    publish: flag(req.query.removeLine) && ((p) => (p
      ? removeStatusLine(db, { studentId: p[0], assignmentId: p[1], source: { type: 'extension', id } })
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
    pair: () => [studentId, assignmentId],
    validate: () => assertCanRequest(db, { studentId, assignmentId, lessons }),
    publish: hasLine(commentLine) && ((ctx) => publishStatusLine(db, {
      studentId: ctx.student.id, assignmentId: ctx.assignment.id, line: commentLine, kind: 'ask',
    })),
    record: (ctx, published) => {
      const r = requestResubmission(db, { studentId, assignmentId, lessons, note, source: 'app' });
      if (published) setStatusLineSource(db, { studentId: ctx.student.id, assignmentId: ctx.assignment.id, type: 'resubmission', id: r.id });
      return r;
    },
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
    pair: () => pairOf(db, 'resubmissions', id),
    validate: () => (ending ? assertCanGradeStand(db, id, today) : assertCanExtendRequest(db, id, lessons)),
    publish: hasLine(commentLine) && (({ request }) => publishStatusLine(db, {
      studentId: request.student_id, assignmentId: request.assignment_id, line: commentLine,
      kind: ending ? 'grade_stands' : 'extend_resubmission',
    })),
    record: ({ request }, published) => {
      const r = ending ? gradeStands(db, id, { today }) : extendResubmission(db, id, lessons);
      if (published) setStatusLineSource(db, { studentId: request.student_id, assignmentId: request.assignment_id, type: 'resubmission', id: request.id });
      return r;
    },
  }, 200);
});

// DELETE /api/triage/resubmissions/:id?removeLine=1 — undo; removeLine first removes
// the line THIS request's ask / extend / grade stands published (if it is still the
// stored line) — never another request's live line.
router.delete('/resubmissions/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  act(res, {
    pair: () => pairOf(db, 'resubmissions', id),
    validate: () => pairOf(db, 'resubmissions', id),
    publish: flag(req.query.removeLine) && ((p) => (p
      ? removeStatusLine(db, { studentId: p[0], assignmentId: p[1], source: { type: 'resubmission', id } })
      : null)),
    record: () => undoResubmission(db, id),
  }, 200);
});

// PUT /api/triage/makeup-ignore/:assignmentId — { ignored: boolean }: ignore (or
// track again) one Schoology test/quiz for make-ups, for every student.
router.put('/makeup-ignore/:assignmentId', (req, res) => {
  write(res, () => setMakeUpIgnored(getDb(), req.params.assignmentId, req.body?.ignored), 200);
});

export default router;
