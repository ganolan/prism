// The full submission picture for one student × assignment: due date, any
// extension, when the work was submitted and how late, the clock day it is on
// if still missing, and any resubmission ask / referral. One builder feeds the
// /assessment/ cards, the gradebook, the student page and PrisMCP, so they all
// say the same thing.
//
// Counted on the triage clock: school days, the (extended) deadline = day 1,
// day `referralLimitDays` (8) the last allowed day. "Submitted" means what
// triage means (isSubmitted): LTI state, else a real submission signal; never
// the REST grade time. Lateness compares the first submission Prism has seen
// with the deadline's date + due time, so a Prism extension counts; with no
// stored time it falls back to Schoology's own late flag.
import { getTriageSettings } from './settings.js';
import { loadCalendar } from './schoolCalendar.js';
import { isSubmitted } from './triage.js';
import { ALIGNED_SQL } from './triageCommon.js';
import { todayLocal, epochToLocalDate } from '../lib/schoolDays.js';
import { sqliteUtcToEpoch } from '../lib/resubmission.js';

const EXCUSED = 1;
const LATE_EXCEPTION = 4;

function splitDue(dueDate) {
  const [date = null, time = null] = String(dueDate || '').split(' ');
  return { date: /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : null, time: time ? time.slice(0, 5) : null };
}

// Epoch seconds of a local date + 'HH:MM' (end of day when there is no time).
function localEpoch(date, time) {
  return Math.floor(new Date(`${date}T${time ? `${time}:00` : '23:59:59'}`).getTime() / 1000);
}

// Mirrors get_submission_status (services/submissionStatus.js itemStatus): with no
// submission signal synced the state is 'unknown', never "not submitted", because
// Prism must not accuse a student on missing data. Only a known-owing state gets
// a "day N" clock.
function submissionState(assignment, g) {
  if (Number(g.exception) === EXCUSED) return 'excused';
  if (assignment.is_test) {
    if (g.test_attempt === 'took') return 'submitted';
    if (g.test_attempt === 'none') return 'not_started';
    if (g.test_attempt === 'not_assigned') return 'not_assigned'; // sits the other copy
    return 'unknown';
  }
  if (assignment.is_lti_submission) {
    if (g.lti_submission_state) return g.lti_submission_state; // submitted | in_progress | not_started
    return g.submission_type ? 'submitted' : 'unknown';
  }
  if (assignment.accepts_submissions === 0) return 'untracked'; // paper / gradebook-only
  if (isSubmitted(assignment, g)) return 'submitted';
  return assignment.accepts_submissions === 1 ? 'not_submitted' : 'unknown';
}

export function buildTimeline({
  assignment, grade, extension = null, referral = null, resubmission = null, cal, today, referralLimitDays = 8,
}) {
  const g = grade || {};
  const due = splitDue(assignment.due_date);
  const ext = extension && due.date
    ? { schoolDays: extension.lessons, until: cal.addSchoolDays(due.date, extension.lessons).date, note: extension.note ?? null }
    : null;
  const deadline = ext?.until ?? due.date;
  const dayOf = (date) => (deadline && date >= deadline ? cal.between(deadline, date).days + 1 : null);

  const state = submissionState(assignment, g);
  const firstAt = Number(g.first_submitted_at) > 0 ? Number(g.first_submitted_at) : null;
  const latestAt = Number(g.latest_revision_at) > 0 ? Number(g.latest_revision_at) : null;
  const schoologyLate = g.exception === LATE_EXCEPTION || (g.late == null ? null : g.late === 1);

  let late = null;
  let day = null;
  let lateMinutes = null;
  if (state === 'submitted') {
    if (firstAt && deadline) {
      const deadlineAt = localEpoch(deadline, due.time);
      late = firstAt > deadlineAt;
      if (late) {
        day = dayOf(epochToLocalDate(firstAt));
        if (day === 1) lateMinutes = Math.ceil((firstAt - deadlineAt) / 60);
      }
    } else if (!ext) {
      late = schoologyLate;
    }
  }

  let overdue = null;
  const owing = ['not_submitted', 'in_progress', 'not_started'].includes(state);
  if (owing && g.score == null && deadline && today > deadline) {
    const d = dayOf(today);
    // Referral is for summative (aligned) work only, so only that goes "over the limit".
    overdue = { day: d, overLimit: Boolean(assignment.aligned) && d > referralLimitDays };
  }

  const req = resubmission?.request || null;
  return {
    due,
    extension: ext,
    deadline,
    submission: { state, firstAt, latestAt, late, day, lateMinutes, schoologyLate },
    overdue,
    resubmission: resubmission?.state
      ? {
          state: resubmission.state,
          askedOn: req?.requestedOn ?? null,
          until: req?.until ?? null,
          arrivedOn: resubmission.arrivedOn ?? null,
          afterDeadline: Boolean(resubmission.arrivedOn && req?.until && resubmission.arrivedOn > req.until),
        }
      : null,
    referral: referral
      ? { on: epochToLocalDate(sqliteUtcToEpoch(referral.created_at)), day: (referral.days_late ?? 0) + 1, note: referral.note ?? null }
      : null,
    limit: referralLimitDays,
  };
}

// Everything buildTimeline needs beyond the grade row, loaded once per course:
// calendar, today, the referral limit, and this course's extensions + referrals
// keyed 'studentId:assignmentId'. Then ctx.timeline(assignment, studentId, grade, resubmission?).
export function timelineContext(db, { courseId, today = todayLocal() }) {
  const cal = loadCalendar(db);
  const { referralLimitDays } = getTriageSettings(db);
  const byPair = (rows) => new Map(rows.map((r) => [`${r.student_id}:${r.assignment_id}`, r]));
  const extensions = byPair(db.prepare('SELECT student_id, assignment_id, lessons, note FROM extensions WHERE course_id = ?').all(Number(courseId)));
  const referrals = byPair(db.prepare(
    "SELECT student_id, assignment_id, days_late, note, created_at FROM referrals WHERE course_id = ? AND action = 'referred'",
  ).all(Number(courseId)));
  // Summative = aligned, exactly as triage decides it (only summative work is referred).
  const aligned = new Set(db.prepare(`SELECT a.id FROM assignments a WHERE a.course_id = ? AND ${ALIGNED_SQL} = 1`).all(Number(courseId)).map((r) => r.id));
  return {
    timeline(assignment, studentId, grade, resubmission = null) {
      const key = `${studentId}:${assignment.id}`;
      return buildTimeline({
        assignment: { ...assignment, aligned: aligned.has(assignment.id) }, grade, resubmission, cal, today, referralLimitDays,
        extension: extensions.get(key) || null,
        referral: referrals.get(key) || null,
      });
    },
  };
}

// The timeline for PrisMCP: the same structure, with submission times as ISO
// strings instead of epoch seconds.
export function agentTimeline(t) {
  if (!t) return null;
  const iso = (secs) => (secs ? new Date(secs * 1000).toISOString() : null);
  const { firstAt, latestAt, ...submission } = t.submission;
  return { ...t, submission: { ...submission, firstSubmittedAt: iso(firstAt), latestSubmittedAt: iso(latestAt) } };
}
