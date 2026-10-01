// Pure helpers for the triage panels (Dashboard + CoursePage).

export const TONE_BADGE = { red: 'badge-red', amber: 'badge-amber', green: 'badge-gray' };

// Tooltip on the ≈ marker of a weekday-fallback count.
export const APPROX_TITLE = 'Approximate: counted as weekdays (no PowerSchool calendar for these dates)';

// Course chip text. Sections of one course share a name, so the block tells
// them apart: '[BK 7] AP COMPUTER SCIENCE PRINCIPLES' (no block → just the name).
export const courseLabel = (row) => (row.blockNumber ? `[BK ${row.blockNumber}] ${row.courseName}` : row.courseName);

// Meter fill %, with a 4% stub so a 0-day row still shows its colour.
export const meterPct = (days, limit) =>
  Math.max(4, Math.min(100, Math.round((days / Math.max(1, limit)) * 100)));

// Per-course counts for the dashboard course-card chips.
export function courseTriageSummary(triage, courseId) {
  const late = (triage?.lateWork || []).filter((r) => r.courseId === courseId);
  const owed = (triage?.feedbackOwed || []).filter((r) => r.courseId === courseId);
  const atLimit = late.filter((r) => r.tone === 'red').length;
  const oldestWait = owed.reduce((m, r) => Math.max(m, r.oldestWaitDays), 0);
  return {
    atLimit,
    late: late.length - atLimit,
    toGrade: owed.reduce((n, r) => n + r.owed, 0),
    oldestWait,
    waitTone: owed.find((r) => r.oldestWaitDays === oldestWait)?.tone ?? 'green',
  };
}

// Schoology assignment id → feedback-owed row (Assessments tab wait column).
export function waitsByAssignment(triage) {
  return Object.fromEntries((triage?.feedbackOwed || []).map((r) => [r.schoologyAssignmentId, r]));
}
