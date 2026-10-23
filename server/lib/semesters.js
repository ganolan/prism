// Semester ends for Triage's Flags panel (#174). Prism stores each course's PowerSchool term
// (courses.term_start / term_end, its section_info calendar's first and last school day). Schoology's
// grading period spans the whole year ("HS 26-27") and grades are reported each semester, so a
// date's semester is the shortest stored term that contains it: a semester course's term inside a
// full-year one. With only a full-year term, that term's end; with none, null.

// Distinct stored terms, archived courses included (last semester's courses are archived by then).
export function loadTermRanges(db) {
  return db.prepare(`
    SELECT DISTINCT term_start AS start, term_end AS end FROM courses
    WHERE term_start IS NOT NULL AND term_end IS NOT NULL
  `).all();
}

// 'YYYY-MM-DD' → the end of the shortest term containing it (the earliest end among them), or null.
export function semesterEndFor(date, ranges) {
  if (!date) return null;
  let end = null;
  for (const r of ranges) {
    if (r.start <= date && date <= r.end && (end == null || r.end < end)) end = r.end;
  }
  return end;
}
