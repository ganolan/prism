// Semester ends for Triage's Flags panel (#174). Prism stores each course's PowerSchool term
// (courses.term_start / term_end, its section_info calendar's first and last school day). Schoology's
// grading period spans the whole year ("HS 26-27") and grades are reported each semester, so a
// date's semester is the shortest stored term that contains it: a semester course's term inside a
// full-year one. With only a full-year term, that term's end; with none, null.

// Distinct stored terms, archived courses included (last semester's courses are archived by then),
// excluded (template) courses left out.
export function loadTermRanges(db) {
  return db.prepare(`
    SELECT DISTINCT term_start AS start, term_end AS end FROM courses
    WHERE term_start IS NOT NULL AND term_end IS NOT NULL AND excluded = 0
  `).all();
}

// Semesters here run about 120 to 155 days (2026-27: 13/08 to 11/12, 04/01 to 08/06); a shorter term
// (a quarter, a late-start section) never sets a semester end (review, 23 Oct 2026).
const MIN_SEMESTER_DAYS = 100;
const daysIn = (r) => (Date.parse(r.end) - Date.parse(r.start)) / 86400000;

// 'YYYY-MM-DD' → the end of the shortest term containing it (the earliest end among them), or null.
// `within` (the task's own course term, when stored) keeps only terms inside it, so another course's
// odd term cannot set this course's semester end.
export function semesterEndFor(date, ranges, within = null) {
  if (!date) return null;
  let end = null;
  for (const r of ranges) {
    if (daysIn(r) < MIN_SEMESTER_DAYS) continue;
    if (within && (r.start < within.start || r.end > within.end)) continue;
    if (r.start <= date && date <= r.end && (end == null || r.end < end)) end = r.end;
  }
  return end;
}
