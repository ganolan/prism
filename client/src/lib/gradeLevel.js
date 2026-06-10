// Derive a student's grade level / graduating-year label from the stored
// (PowerSchool-derived) grad_year. grad_year is the time-INVARIANT value Prism
// persists; the current grade is derived on read so a departed student (whose
// grad_year stops being re-synced) never shows a stale grade. See
// docs/superpowers/specs/2026-06-10-grade-level-sync-design.md.

// A school year is named by its ENDING calendar year and rolls over in August
// (month index >= 7). 2025-26 → 2026.
export function schoolYearEndYear(now = new Date()) {
  return now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
}

// Current grade (1–12) derived from grad_year, or null when out of range
// (e.g. a graduated student whose derived grade exceeds 12).
export function gradYearToLevel(gradYear, now = new Date()) {
  if (!gradYear) return null;
  const grade = 12 - (gradYear - schoolYearEndYear(now));
  return grade >= 1 && grade <= 12 ? grade : null;
}

// Badge parts for a student:
//   active   → { grade: 11, classOf: 2027, label: 'Grade 11 · Class of 2027' }
//   departed → { grade: null, classOf: 2025, label: 'Class of 2025' }
//   unknown  → null  (no grad_year)
export function formatGradeBadge(gradYear, now = new Date()) {
  if (!gradYear) return null;
  const grade = gradYearToLevel(gradYear, now);
  const label = grade ? `Grade ${grade} · Class of ${gradYear}` : `Class of ${gradYear}`;
  return { grade, classOf: gradYear, label };
}
