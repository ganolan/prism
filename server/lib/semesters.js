// Semester ends for Triage's Flags panel (#174). Prism stores each course's PowerSchool term
// (courses.term_start / term_end, its section_info calendar's first and last school day). Schoology's
// grading period spans the whole year ("HS 26-27") and grades are reported each semester, so a
// date's semester is the shortest stored term that contains it: a semester course's term inside a
// full-year one. A full-year term with no stored semester term on a side is split at its longest break
// in the school calendar (#180); with no calendar, that term's end; with no term, null.

// Semesters here run about 120 to 155 days (2026-27: 13/08 to 11/12, 04/01 to 08/06); a shorter term
// (a quarter, a late-start section) never sets a semester end (review, 23 Oct 2026).
const MIN_SEMESTER_DAYS = 100;
// A full-year term runs about 300 days (2026-27: 13/08 to 08/06); no semester is this long.
const MIN_YEAR_DAYS = 250;
const daysIn = (r) => (Date.parse(r.end) - Date.parse(r.start)) / 86400000;
const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;

// A full-year term's two semesters from its school days (sorted 'YYYY-MM-DD'): semester 1 ends on
// the last school day before the longest break, semester 2 starts on the first after it. In 2026-27
// that is winter (24 days, 11/12 to 04/01), ahead of spring (14) and Chinese New Year (11), and it
// matches PowerSchool's own semester terms exactly (prod calendar, 24 Oct 2026). Null when the days
// do not span the whole term (a term is its first and last school day) or a half is under 100 days.
export function splitAtLongestBreak(term, days) {
  const inTerm = days.filter((d) => term.start <= d && d <= term.end);
  if (inTerm[0] !== term.start || inTerm[inTerm.length - 1] !== term.end) return null;
  let at = -1;
  let longest = 0;
  for (let i = 1; i < inTerm.length; i++) {
    const gap = Date.parse(inTerm[i]) - Date.parse(inTerm[i - 1]);
    if (gap > longest) { longest = gap; at = i; }
  }
  if (at < 0) return null;
  const halves = [{ start: term.start, end: inTerm[at - 1] }, { start: inTerm[at], end: term.end }];
  return halves.every((h) => daysIn(h) >= MIN_SEMESTER_DAYS) ? halves : null;
}

// Distinct stored terms, archived courses included (last semester's courses are archived by then),
// excluded (template) courses left out, plus each full-year term's calendar halves that no stored
// semester term overlaps.
export function loadTermRanges(db) {
  const stored = db.prepare(`
    SELECT DISTINCT term_start AS start, term_end AS end FROM courses
    WHERE term_start IS NOT NULL AND term_end IS NOT NULL AND excluded = 0
  `).all();
  const semesters = stored.filter((r) => daysIn(r) >= MIN_SEMESTER_DAYS && daysIn(r) < MIN_YEAR_DAYS);
  const schoolDays = db.prepare('SELECT date FROM school_days WHERE in_session = 1 AND date BETWEEN ? AND ? ORDER BY date');
  const derived = [];
  for (const year of stored.filter((r) => daysIn(r) >= MIN_YEAR_DAYS)) {
    const halves = splitAtLongestBreak(year, schoolDays.all(year.start, year.end).map((r) => r.date)) ?? [];
    for (const h of halves) {
      if (semesters.some((s) => overlaps(s, h))) continue;
      if (!derived.some((d) => d.start === h.start && d.end === h.end)) derived.push(h);
    }
  }
  return [...stored, ...derived];
}

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
