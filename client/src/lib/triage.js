// Pure helpers for the triage panels (Dashboard + CoursePage).

export const TONE_BADGE = { red: 'badge-red', amber: 'badge-amber', green: 'badge-gray' };

// Tooltip on the ≈ marker of a weekday-fallback count.
export const APPROX_TITLE = 'Approximate: counted as weekdays (no PowerSchool calendar for these dates)';

// Course chip text. Sections of one course share a name, so the block tells
// them apart: '[BK 7] AP COMPUTER SCIENCE PRINCIPLES' (no block → just the name).
export const courseLabel = (row) => (row.blockNumber ? `[BK ${row.blockNumber}] ${row.courseName}` : row.courseName);

// Urgency-ring arc % = min(1, day/limit), with a 4% floor so a short arc still shows its colour.
export const meterPct = (day, limit) =>
  Math.max(4, Math.min(100, Math.round((day / Math.max(1, limit)) * 100)));

const TONE_RANK = { green: 0, amber: 1, red: 2 };
const worstTone = (rows) => rows.reduce((t, r) => (TONE_RANK[r.tone] > TONE_RANK[t] ? r.tone : t), 'green');

// Per-course counts for the dashboard course-card chips.
export function courseTriageSummary(triage, courseId) {
  const late = (triage?.lateWork || []).filter((r) => r.courseId === courseId);
  const owed = (triage?.feedbackOwed || []).filter((r) => r.courseId === courseId);
  const makeUps = (triage?.makeUps || []).filter((r) => r.courseId === courseId);
  const resubs = (triage?.resubmissions || []).filter((r) => r.courseId === courseId);
  const atLimit = late.filter((r) => r.tone === 'red').length;
  // Day number (due date = day 1) of the longest feedback wait.
  const oldestDay = owed.reduce((m, r) => Math.max(m, r.day), 0);
  return {
    atLimit,
    late: late.length - atLimit,
    toGrade: owed.reduce((n, r) => n + r.owed, 0),
    oldestDay,
    waitTone: owed.find((r) => r.day === oldestDay)?.tone ?? 'green',
    makeUps: makeUps.length,
    makeUpTone: worstTone(makeUps),
    resubmissions: resubs.length,
    resubmissionTone: worstTone(resubs),
  };
}

// Schoology assignment id → feedback-owed row (Assessments tab wait column).
export function waitsByAssignment(triage) {
  return Object.fromEntries((triage?.feedbackOwed || []).map((r) => [r.schoologyAssignmentId, r]));
}

// Red rows across all four lists — the count on the course page's "Triage ▸" button.
export function redCount(triage) {
  return ['makeUps', 'lateWork', 'resubmissions', 'feedbackOwed']
    .reduce((n, list) => n + (triage?.[list] || []).filter((r) => r.tone === 'red').length, 0);
}
