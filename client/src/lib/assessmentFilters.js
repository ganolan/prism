// Pure filter + normalization logic for the assessment summary page. Mirrors the
// server's normalizeSubmissionStatus/gradingState (kept per-side, like the
// proficiency-scale derivation) and reuses gradeLabel for due-date-aware pill
// tones so the filter pills match the gradebook badges exactly.

import { submissionStatus } from './gradeLabel.js';
import { teacherText } from './statusLines.js';
import { isFlag, isExempt } from './flags.js';

// Tone → CSS-var pairs. Mirrors BADGE_TONE_CLASS in CoursePage / SubmissionBadges
// (amber→pink, yellow→amber) so colours stay consistent, plus a resubmit tone.
export const TONE_VARS = {
  green:    { bg: 'var(--badge-green-bg)',    text: 'var(--badge-green-text)' },
  blue:     { bg: 'var(--badge-blue-bg)',     text: 'var(--badge-blue-text)' },
  amber:    { bg: 'var(--badge-pink-bg)',     text: 'var(--badge-pink-text)' },
  yellow:   { bg: 'var(--badge-amber-bg)',    text: 'var(--badge-amber-text)' },
  red:      { bg: 'var(--badge-red-bg)',      text: 'var(--badge-red-text)' },
  neutral:  { bg: 'var(--badge-gray-bg)',     text: 'var(--badge-gray-text)' },
  slate:    { bg: 'var(--flag-absent-bg)',    text: 'var(--flag-absent)' }, // the Absent flag
  resubmit: { bg: 'var(--badge-resubmit-bg)', text: 'var(--badge-resubmit-text)' },
};

// Same rule as the server (assessmentContext.normalizeSubmissionStatus) and triage:
// a real submission signal, never grades.submitted_at (the grade time). Paper /
// gradebook-only work is 'not_tracked'.
export function normalizedSubmissionState(student, assignment) {
  if (assignment.is_lti_submission) {
    const s = student.lti_submission_state || (student.submission_type ? 'submitted' : null);
    return s || 'unknown';
  }
  if (student.submission_type || student.test_attempt === 'took') return 'submitted';
  if (assignment.accepts_submissions === 0 && !assignment.is_test) return 'not_tracked';
  return 'not_started';
}

export function gradingStateOf(student, topics) {
  // Any flag (Exempt, Incomplete, Missing, Absent, Late) counts as handled (server gradingState parity, #40).
  if (isFlag(student.exception)) return 'complete';
  const scores = student.scores || {};
  const scoredCount = topics.filter(t => scores[t.id] != null).length;
  // Prism's own status line (student.status_line) is not teacher feedback (final review M3).
  const hasComment = teacherText(student.grade_comment, student.status_line?.line || null).length > 0;
  // No rubric topics (unaligned, #41): the plain score is the grade.
  if (topics.length === 0) return (student.score != null || hasComment) ? 'complete' : 'ungraded';
  if (scoredCount === 0 && !hasComment) return 'ungraded';
  if (scoredCount === topics.length && hasComment) return 'complete';
  return 'partial';
}

const STATUS_PILLS_LTI = [
  { id: 'submitted', label: 'Submitted' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'not_started', label: 'Not Started' },
];
// Non-LTI (dropbox) work: we can't tell in-progress from not-started, but we DO
// know submitted-or-not — so offer Submitted + Unsubmitted. "Unsubmitted" reuses
// the not_started id (normalizedSubmissionState returns 'not_started' for any
// non-LTI student without a submission), which also gives it the gradebook's
// due-date-aware tone (neutral, red once overdue) for free.
const STATUS_PILLS_NONLTI = [
  { id: 'submitted', label: 'Submitted' },
  { id: 'not_started', label: 'Unsubmitted' },
];

export function filterGroups(assignment) {
  return [
    { key: 'status', pills: assignment.is_lti_submission ? STATUS_PILLS_LTI : STATUS_PILLS_NONLTI },
    { key: 'grading', pills: [
      { id: 'ungraded', label: 'Ungraded' },
      { id: 'partial', label: 'Partially graded' },
      { id: 'graded', label: 'Graded' },
    ] },
    { key: 'visibility', pills: [
      { id: 'visible', label: 'Visible' },
      { id: 'not_visible', label: 'Not visible' },
    ] },
  ];
}

const GRADING_PILL_STATE = { ungraded: 'ungraded', partial: 'partial', graded: 'complete' };

export function studentMatchesPill(student, pillId, { assignment, topics }) {
  switch (pillId) {
    case 'submitted':
    case 'in_progress':
    case 'not_started':
      return normalizedSubmissionState(student, assignment) === pillId;
    case 'ungraded':
    case 'partial':
    case 'graded':
      return gradingStateOf(student, topics) === GRADING_PILL_STATE[pillId];
    case 'visible':
      return student.comment_status === 1;
    case 'not_visible':
      // Only feedback that exists can be hidden: a student with no comment is not "not visible".
      return hasTeacherComment(student) && student.comment_status !== 1;
    default:
      return true;
  }
}

// Reason pills (Needs action + Watch) combine as "any of"; the Refine groups then
// narrow that set (OR within a group, AND across groups).
export function passesFilters(student, activeSet, ctx) {
  const activeReasons = REASON_IDS.filter(id => activeSet.has(id));
  if (activeReasons.length > 0) {
    const mine = new Set(studentReasons(student, ctx).map(r => r.id));
    if (!activeReasons.some(id => mine.has(id))) return false;
  }
  for (const group of filterGroups(ctx.assignment)) {
    const activePills = group.pills.filter(p => activeSet.has(p.id));
    if (activePills.length === 0) continue; // group imposes no constraint
    if (!activePills.some(p => studentMatchesPill(student, p.id, ctx))) return false;
  }
  return true;
}

export function countMatches(students, pillId, ctx) {
  return students.filter(s => studentMatchesPill(s, pillId, ctx)).length;
}

const NONSTATUS_TONE = {
  ungraded: 'neutral', partial: 'yellow', graded: 'green',
  visible: 'blue', not_visible: 'neutral',
  review: 'yellow',
};

// Status pills take the gradebook's due-date-aware tone for a hypothetical
// student in that state; non-status pills use a fixed tone.
export function pillTone(pillId, assignment) {
  if (pillId === 'submitted' || pillId === 'in_progress' || pillId === 'not_started') {
    const base = {
      score: null, exception: 0, late: 0, draft: 0, submitted_at: 0,
      is_lti_submission: !!assignment.is_lti_submission, due_date: assignment.due_date,
    };
    const synthetic = pillId === 'submitted'
      ? { ...base, lti_submission_state: 'submitted', submission_type: 'drop' }
      : { ...base, lti_submission_state: pillId };
    const badges = submissionStatus(synthetic);
    return badges[0]?.tone || (pillId === 'submitted' ? 'green' : pillId === 'in_progress' ? 'blue' : 'neutral');
  }
  return NONSTATUS_TONE[pillId] || 'neutral';
}

const hasTeacherComment = (student) => teacherText(student.grade_comment, student.status_line?.line || null).length > 0;

// ─── Needs action + Watch reasons ───────────────────────────────────────────
// Each reason is a pill in its row and a chip on the student's card. The ones the
// teacher's own grading changes (to grade, partly graded, draft, feedback hidden,
// resubmitted) are worked out here, so they follow each save at once. The
// school-calendar ones come from the server (server/services/cardAttention.js:
// student.attention.reasons), built from triage's Late work, Resubmissions and
// Make-up tests rows.

export const REASONS = {
  to_grade: { group: 'action', label: 'To grade', tone: 'blue' },
  partly_graded: { group: 'action', label: 'Partly graded', tone: 'yellow' },
  draft: { group: 'action', label: 'Draft not published', tone: 'blue' },
  feedback_hidden: { group: 'action', label: 'Feedback hidden', tone: 'neutral' },
  resubmitted: { group: 'action', label: 'Resubmitted', tone: 'resubmit' },
  unread_comment: { group: 'action', label: 'Unread comment', tone: 'yellow' },
  referral: { group: 'action', label: 'Referral to decide', tone: 'red' },
  resubmission_overdue: { group: 'action', label: 'Resubmission overdue', tone: 'red' },
  make_up: { group: 'action', label: 'Make-up test', tone: 'amber' },
  not_started_soon: { group: 'watch', label: 'Not started, due soon', tone: 'yellow' },
  in_progress_late: { group: 'watch', label: 'In progress, past due', tone: 'blue' },
  late: { group: 'watch', label: 'Late', tone: 'yellow' },
  referred_missing: { group: 'watch', label: 'Referred, not submitted', tone: 'red' },
  resubmission_pending: { group: 'watch', label: 'Resubmission pending', tone: 'resubmit' },
};
export const REASON_IDS = Object.keys(REASONS);
export const reasonIdsIn = (group) => REASON_IDS.filter(id => REASONS[id].group === group);

// Triage clock tones (green / amber / red) → pill tones.
const CLOCK_TONE = { green: 'neutral', amber: 'yellow', red: 'red' };
const schoolDays = (n) => `${n} school day${n === 1 ? '' : 's'}`;
const ddmm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');

// The chip text for one reason, with its detail (days, deadline).
export function reasonText(r) {
  switch (r.id) {
    case 'referral':
      return r.kind === 'submitted_late'
        ? `Referral to decide, submitted ${schoolDays(r.daysLate)} late`
        : `Referral to decide, ${schoolDays(r.daysLate)} late`;
    case 'late': return `Late, ${schoolDays(r.daysLate)}`;
    case 'unread_comment': return r.count > 1 ? `${r.count} unread comments` : 'Unread comment';
    case 'referred_missing': return r.referredOn ? `Referred ${ddmm(r.referredOn)}, not submitted` : 'Referred, not submitted';
    case 'in_progress_late': return `In progress, ${schoolDays(r.daysLate)} late`;
    case 'not_started_soon':
      return r.schoolDaysLeft === 0 ? 'Not started, due today' : `Not started, due in ${schoolDays(r.schoolDaysLeft)}`;
    case 'resubmission_pending': return r.until ? `Resubmission due ${ddmm(r.until)}` : 'Resubmission pending';
    case 'resubmission_overdue': return r.until ? `Resubmission overdue, due ${ddmm(r.until)}` : 'Resubmission overdue';
    default: return REASONS[r.id]?.label ?? r.id;
  }
}

export function reasonTone(r) {
  if (r.tone && CLOCK_TONE[r.tone] && (r.id === 'late' || r.id === 'in_progress_late')) return CLOCK_TONE[r.tone];
  return REASONS[r.id]?.tone ?? 'neutral';
}

// ctx: { assignment, topics, hasDraft(student) → boolean, commentSummaryOf(student) → the
// submission-comment summary or null (its `unread` drives Unread comment) }.
// → [{ id, ...detail }] in REASONS order.
export function studentReasons(student, ctx) {
  const out = [];
  const excused = isExempt(student.exception); // Exempt (Absent is a marker, not a decision)
  if (!excused) {
    const grading = gradingStateOf(student, ctx.topics || []);
    const handedIn = student.attention
      ? student.attention.handedIn
      // Paper work has no submission channel: it counts as handed in (as triage's feedback owed does).
      : ['submitted', 'not_tracked'].includes(normalizedSubmissionState(student, ctx.assignment || {}));
    // A Prism draft is the next step whatever Schoology holds, so it replaces to grade / partly graded.
    if (ctx.hasDraft?.(student)) out.push({ id: 'draft' });
    else if (grading === 'ungraded' && handedIn) out.push({ id: 'to_grade' });
    else if (grading === 'partial') out.push({ id: 'partly_graded' });
    if (hasTeacherComment(student) && student.comment_status !== 1) out.push({ id: 'feedback_hidden' });
    if (student.resubmission?.state === 'arrived' || student.resubmitted) out.push({ id: 'resubmitted' });
  }
  const unread = ctx.commentSummaryOf?.(student)?.unread || 0;
  if (unread > 0) out.push({ id: 'unread_comment', count: unread });
  for (const r of student.attention?.reasons || []) if (REASONS[r.id]) out.push(r);
  return out.sort((a, b) => REASON_IDS.indexOf(a.id) - REASON_IDS.indexOf(b.id));
}

export function countReasons(students, ctx) {
  const counts = Object.fromEntries(REASON_IDS.map(id => [id, 0]));
  for (const s of students) for (const r of studentReasons(s, ctx)) counts[r.id] += 1;
  return counts;
}

// Every pill id the page knows (reasons + Refine), for reading ?filter= from a link.
// A group name ('action', 'watch') stands for every reason in that row.
const REFINE_IDS = ['submitted', 'in_progress', 'not_started', 'ungraded', 'partial', 'graded', 'visible', 'not_visible'];
export function parseFilterParam(param) {
  const known = new Set([...REASON_IDS, ...REFINE_IDS]);
  const ids = String(param || '').split(',').map(x => x.trim())
    .flatMap(x => (x === 'action' || x === 'watch' ? reasonIdsIn(x) : [x]));
  return new Set(ids.filter(x => known.has(x)));
}
