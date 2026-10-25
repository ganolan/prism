// The /assessment/ page's "Needs action" and "Watch" reasons that depend on the
// school calendar, per student, for one assignment. Built from triage's own rows
// (getTriage), so a card never disagrees with the dashboard: Overdue work (referral
// clock), Resubmissions (deadline) and Make-up tests. Plus two OneDrive/Google
// Drive watch reasons triage has no panel for: work never opened with the due
// date close, and work opened but not submitted after the due date.
//
// Reasons that change while the teacher grades (to grade, partly graded, Prism
// draft, feedback hidden, resubmitted, flagged) are worked out on the page
// (client/src/lib/assessmentFilters.js), so they follow each save immediately.
//
// → Map(studentId → { handedIn, reasons: [{ id, ...detail }] }). Reason ids:
//   action: 'referral', 'resubmission_overdue', 'make_up'
//   watch:  'late', 'in_progress_late', 'not_started_soon', 'resubmission_pending',
//           'referred_missing' (referred, and the work has still not come in)

import { todayLocal, epochToLocalDate } from '../lib/schoolDays.js';
import { sqliteUtcToEpoch } from '../lib/resubmission.js';
import { loadCalendar } from './schoolCalendar.js';
import { getTriageSettings } from './settings.js';
import { getTriage, isSubmitted, extensionUntil, assignmentFacts, studentState } from './triage.js';
import { isExempt } from '../lib/flags.js';

// triage: the course's getTriage result (includeFormative true, for today) when the caller already
// has one, so a page of cards reads triage once.
export function attentionByStudent(db, { assignment, students, today = todayLocal(), triage: given = null }) {
  const out = new Map(students.map((s) => [s.id, { handedIn: false, reasons: [] }]));
  if (!assignment?.id) return out;

  const grades = new Map(db.prepare(`
    SELECT student_id, lti_submission_state, submission_type, test_attempt, exception
    FROM grades WHERE assignment_id = ?
  `).all(assignment.id).map((g) => [g.student_id, g]));
  const due = assignment.due_date ? assignment.due_date.slice(0, 10) : null;
  const pastDue = Boolean(due && due < today);
  // No submission channel (paper / in class): everyone handed it in on the due date,
  // as triage's Feedback owed counts it; a Schoology test whose attempts were read is
  // the exception (only takers handed it in).
  const handedInAtDue = assignment.accepts_submissions === 0 && pastDue
    && !(assignment.is_test === 1 && assignment.test_fetch_status === 'ok');
  for (const s of students) {
    const g = grades.get(s.id) || {};
    out.get(s.id).handedIn = isSubmitted(assignment, g) || handedInAtDue;
  }

  const course = db.prepare('SELECT archived, excluded FROM courses WHERE id = ?').get(assignment.course_id);
  if (!course || course.archived || course.excluded || !assignment.published) return out;

  const add = (studentId, reason) => out.get(studentId)?.reasons.push(reason);
  const mine = (r) => r.assignmentId === assignment.id;
  const triage = given ?? getTriage(db, { courseId: assignment.course_id, includeFormative: true, today });

  // Overdue work (summative work that takes submissions; referred / waived pairs are gone).
  const lateRow = new Map();
  for (const r of triage.lateWork.filter(mine)) {
    lateRow.set(r.studentId, r);
    if (r.tone === 'red') add(r.studentId, { id: 'referral', kind: r.kind, daysLate: r.daysLate, tone: 'red' });
  }
  for (const r of triage.resubmissions.filter(mine)) {
    if (r.state !== 'waiting') continue; // 'arrived' is the page's own Resubmitted reason
    add(r.studentId, r.tone === 'red'
      ? { id: 'resubmission_overdue', until: r.until, tone: 'red' }
      : { id: 'resubmission_pending', until: r.until, tone: r.tone });
  }
  for (const r of triage.makeUps.filter(mine)) {
    add(r.studentId, { id: 'make_up', daysSince: r.daysSince, tone: r.tone });
  }

  // Watch: late, before the referral limit. OneDrive / Google Drive work tells
  // opened-but-not-submitted apart, for formative work too.
  const { warnLeadDays } = getTriageSettings(db);
  const cal = loadCalendar(db);
  const extensions = new Map(db.prepare('SELECT student_id, lessons, until FROM extensions WHERE assignment_id = ?')
    .all(assignment.id).map((e) => [e.student_id, e]));
  const openAsks = new Set(db.prepare(`
    SELECT student_id FROM resubmissions WHERE assignment_id = ? AND kind = 'request' AND status = 'open'
  `).all(assignment.id).map((r) => r.student_id));
  const lti = Number(assignment.is_lti_submission) === 1;

  // Referred students whose work has still not come in (a referral takes the pair off
  // Overdue work for good; waived pairs had already handed it in).
  const referred = new Map(db.prepare(`SELECT student_id, created_at FROM referrals WHERE assignment_id = ? AND action = 'referred'`)
    .all(assignment.id).map((r) => [r.student_id, r.created_at]));
  const facts = referred.size ? assignmentFacts(db, assignment) : null;

  for (const s of students) {
    const g = grades.get(s.id) || {};
    if (isExempt(g.exception)) continue; // Exempt
    if (referred.has(s.id)) {
      const st = studentState(assignment, facts, s);
      if (!st.submitted && !st.scored) {
        add(s.id, { id: 'referred_missing', referredOn: epochToLocalDate(sqliteUtcToEpoch(referred.get(s.id))), tone: 'red' });
      }
      continue;
    }
    const late = lateRow.get(s.id);
    if (late?.tone === 'red') continue; // already a referral to decide
    const state = lti ? g.lti_submission_state : null;
    if (state === 'in_progress' && !openAsks.has(s.id)) {
      const effDue = due && extensionUntil(cal, due, extensions.get(s.id)).date;
      if (effDue && effDue < today) {
        const { days } = cal.between(effDue, today);
        add(s.id, { id: 'in_progress_late', daysLate: late?.daysLate ?? days, tone: late?.tone ?? 'green' });
        continue;
      }
    }
    if (late?.kind === 'outstanding') {
      add(s.id, { id: 'late', daysLate: late.daysLate, tone: late.tone });
      continue;
    }
    if (state === 'not_started' && due) {
      const effDue = extensionUntil(cal, due, extensions.get(s.id)).date;
      if (effDue && effDue >= today) {
        const { days } = cal.between(today, effDue);
        if (days <= warnLeadDays) add(s.id, { id: 'not_started_soon', schoolDaysLeft: days, tone: 'amber' });
      }
    }
  }
  return out;
}
