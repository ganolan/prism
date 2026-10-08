/**
 * schoolYear.js — read a school year and term out of a Schoology grading-period
 * title (`courses.grading_period`), so a student's history can be grouped by
 * year without a schema change.
 *
 * Formats seen in the HKIS archive (2026-10-08, every archived section from
 * 2021-22 to 2026-27):
 *   "2025-2026: 08/14/2025 - 06/17/2026"   full year, four-digit years
 *   "2024-2025: 08/13/24 - 06/15/25"
 *   "Semester 1: 08/14/2025 - 01/11/2026"  semester, dates only
 *   "Semester 2: 1/09/23 - 6/14/23"
 *   "HS 26-27 S1" / "HS 26-27"             2026-27 naming
 *   "21-22 S2" / "21-22 YR" / "22-23 Summer"
 *   "Master Course (non expiring)"         a template, no year
 *
 * HKIS years run August to June, so a bare date in July or later starts a year
 * and one before July ends it. Returns nulls rather than guessing when nothing
 * in the title names a year.
 */

const yy = (n) => String(n % 100).padStart(2, '0');
const label = (start) => `${start}-${yy(start + 1)}`;

function yearFromTitle(t) {
  let m = t.match(/\b(20\d\d)\s*-\s*(20\d\d)\b/);
  if (m && Number(m[2]) === Number(m[1]) + 1) return label(Number(m[1]));
  m = t.match(/(?:^|[^\d/])(\d\d)\s*-\s*(\d\d)(?![\d/])/);
  if (m && Number(m[2]) === (Number(m[1]) + 1) % 100) return label(2000 + Number(m[1]));
  m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return label(Number(m[1]) >= 7 ? year : year - 1);
  }
  return null;
}

function termFromTitle(t) {
  if (/summer/i.test(t)) return 'Summer';
  if (/\bsemester\s*1\b|\bS1\b/i.test(t)) return 'Semester 1';
  if (/\bsemester\s*2\b|\bS2\b/i.test(t)) return 'Semester 2';
  return 'Full year';
}

/**
 * @param {string|null} gradingPeriod  courses.grading_period
 * @returns {{ school_year: string|null, term: string|null }}
 *   school_year like "2025-26"; term "Full year" | "Semester 1" | "Semester 2" | "Summer".
 */
export function schoolYearOf(gradingPeriod) {
  const t = String(gradingPeriod ?? '').trim();
  const school_year = t ? yearFromTitle(t) : null;
  return { school_year, term: school_year ? termFromTitle(t) : null };
}
