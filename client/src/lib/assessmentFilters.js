// Pure filter + normalization logic for the assessment summary page. Mirrors the
// server's normalizeSubmissionStatus/gradingState (kept per-side, like the
// proficiency-scale derivation) and reuses gradeLabel for due-date-aware pill
// tones so the filter pills match the gradebook badges exactly.

import { submissionStatus } from './gradeLabel.js';

// Tone → CSS-var pairs. Mirrors BADGE_TONE_CLASS in CoursePage / SubmissionBadges
// (amber→pink, yellow→amber) so colours stay consistent, plus a resubmit tone.
export const TONE_VARS = {
  green:    { bg: 'var(--badge-green-bg)',    text: 'var(--badge-green-text)' },
  blue:     { bg: 'var(--badge-blue-bg)',     text: 'var(--badge-blue-text)' },
  amber:    { bg: 'var(--badge-pink-bg)',     text: 'var(--badge-pink-text)' },
  yellow:   { bg: 'var(--badge-amber-bg)',    text: 'var(--badge-amber-text)' },
  red:      { bg: 'var(--badge-red-bg)',      text: 'var(--badge-red-text)' },
  neutral:  { bg: 'var(--badge-gray-bg)',     text: 'var(--badge-gray-text)' },
  resubmit: { bg: 'var(--badge-resubmit-bg)', text: 'var(--badge-resubmit-text)' },
};

export function normalizedSubmissionState(student, assignment) {
  if (assignment.is_lti_submission) {
    const s = student.lti_submission_state || (student.submission_type ? 'submitted' : null);
    return s || 'unknown';
  }
  return (student.submission_type || Number(student.submitted_at) > 0) ? 'submitted' : 'not_started';
}

export function gradingStateOf(student, topics) {
  if (student.exception) return 'complete';
  const scores = student.scores || {};
  const scoredCount = topics.filter(t => scores[t.id] != null).length;
  const hasComment = (student.grade_comment || '').trim().length > 0;
  if (scoredCount === 0 && !hasComment) return 'ungraded';
  if (topics.length === 0) return 'complete'; // no rubric topics to score; a comment-bearing row is handled (matches server gradingState)
  if (scoredCount === topics.length && hasComment) return 'complete';
  return 'partial';
}

const STATUS_PILLS_LTI = [
  { id: 'submitted', label: 'Submitted' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'not_started', label: 'Not Started' },
];
const STATUS_PILLS_NONLTI = [{ id: 'submitted', label: 'Submitted' }];

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
    { key: 'flag', pills: [{ id: 'review', label: 'Flag for review' }] },
    { key: 'resubmit', pills: [{ id: 'resubmit', label: 'Ask to resubmit' }] },
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
      return student.comment_status !== 1;
    case 'review':
      return student.review_flag != null;
    case 'resubmit':
      return student.resubmit_flag != null;
    default:
      return true;
  }
}

export function passesFilters(student, activeSet, ctx) {
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
  review: 'yellow', resubmit: 'resubmit',
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
