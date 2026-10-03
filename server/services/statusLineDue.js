// The due date a status line embeds ({Ddd DD/MM}), worked out with the SAME
// calendar logic the corresponding record step uses — reusing the services' own
// assert* validators, so it refuses exactly what the action would refuse
// (ALREADY_OPEN, NOT_AT_DEADLINE, BAD_LESSONS, ...). No Schoology read.
// Shared by PrisMCP (preview_status_line renders the line server-side) and the
// web confirm modal (GET /api/triage/status-line/until; the client renders the
// line itself with client/src/lib/statusLines.js).
import { assertCanExtend, TriageError } from './triage.js';
import { assertCanRequest, assertCanExtendRequest, assertCanGradeStand } from './resubmissions.js';
import { loadCalendar } from './schoolCalendar.js';
import { todayLocal, epochToLocalDate } from '../lib/schoolDays.js';
import { sqliteUtcToEpoch } from '../lib/resubmission.js';

export const DUE_KINDS = ['ask', 'extend_resubmission', 'grade_stands', 'extension', 'make_up'];

// → { until: 'YYYY-MM-DD', lessons }
export function statusLineUntil(db, { kind, studentId, assignmentId, lessons, resubmissionId } = {}, today = todayLocal()) {
  if (!DUE_KINDS.includes(kind)) throw new TriageError('BAD_VALUE', `kind must be one of ${DUE_KINDS.join(', ')}`);
  const cal = loadCalendar(db);
  if (kind === 'ask') {
    const { lessons: n } = assertCanRequest(db, { studentId, assignmentId, lessons: lessons ?? null });
    return { until: cal.addSchoolDays(today, n).date, lessons: n };
  }
  if (kind === 'extend_resubmission' || kind === 'grade_stands') {
    if (resubmissionId == null || resubmissionId === '') throw new TriageError('BAD_VALUE', `resubmission id is required for kind ${kind}`);
    if (kind === 'grade_stands') {
      const { request, until } = assertCanGradeStand(db, resubmissionId, today);
      return { until, lessons: request.lessons };
    }
    const { request, lessons: n } = assertCanExtendRequest(db, resubmissionId, lessons);
    const requestedOn = epochToLocalDate(sqliteUtcToEpoch(request.requested_at));
    return { until: cal.addSchoolDays(requestedOn, n).date, lessons: n };
  }
  // extension / make_up: from the assignment's own due date.
  const { assignment, lessons: n } = assertCanExtend(db, { studentId, assignmentId, lessons });
  return { until: cal.addSchoolDays(assignment.due_date.slice(0, 10), n).date, lessons: n };
}
