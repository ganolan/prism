// Course-card display helpers, shared by the Dashboard and the Sync dialog's
// Past-courses panel. parseGradingPeriod/groupByAcademicYear were extracted
// verbatim from Dashboard.jsx.

export function parseGradingPeriod(gradingPeriod) {
  if (!gradingPeriod) return { academicYear: 'Unknown', semester: 'Unknown' };
  const s = String(gradingPeriod);

  let semester = 'Full Year';
  if (/semester\s*1|\bS1\b/i.test(s)) semester = 'Semester 1';
  else if (/semester\s*2|\bS2\b/i.test(s)) semester = 'Semester 2';
  else if (/summer/i.test(s)) semester = 'Summer';

  return { academicYear: parseAcademicYear(s), semester };
}

// Derive a canonical "YYYY-YY" academic year, preferring the most reliable
// signal: an explicit 4-digit range, then an abbreviated range, then a date
// (month >= 8 ⇒ that's the start year). Tolerant of single-digit months.
function parseAcademicYear(s) {
  let m = s.match(/(20\d{2})\s*-\s*20\d{2}/);
  if (m) { const start = Number(m[1]); return `${start}-${String(start + 1).slice(-2)}`; }
  m = s.match(/\b(\d{2})-\d{2}\b/);
  if (m) { const start = 2000 + Number(m[1]); return `${start}-${String(start + 1).slice(-2)}`; }
  m = s.match(/(\d{1,2})\/\d{1,2}\/(\d{2,4})/);
  if (m) {
    const month = Number(m[1]);
    const raw = Number(m[2]);
    const year = raw < 100 ? 2000 + raw : raw;
    const start = month >= 8 ? year : year - 1;
    return `${start}-${String(start + 1).slice(-2)}`;
  }
  return 'Unknown';
}

export function groupByAcademicYear(courses) {
  const groups = {};
  for (const c of courses) {
    const { academicYear } = parseGradingPeriod(c.grading_period);
    if (!groups[academicYear]) groups[academicYear] = [];
    groups[academicYear].push(c);
  }
  return Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, yearCourses]) => ({ year, courses: yearCourses }));
}

const SEMESTER_ORDER = { 'Semester 1': 0, 'Semester 2': 1, 'Summer': 2, 'Full Year': 3, 'Unknown': 4 };

// Group courses by academic year (descending, "Unknown" last), then by semester
// (Semester 1 → Semester 2 → Summer → Full Year → Unknown). `getPeriod` reads the
// grading-period string from each item — cards use the default (grading_period),
// discovery rows pass (s) => s.gradingPeriod. (#71)
// → [{ year, semesters: [{ semester, courses: [...] }] }]
export function groupByYearAndSemester(courses, getPeriod = (c) => c.grading_period) {
  const years = {};
  for (const c of courses) {
    const { academicYear, semester } = parseGradingPeriod(getPeriod(c));
    if (!years[academicYear]) years[academicYear] = {};
    if (!years[academicYear][semester]) years[academicYear][semester] = [];
    years[academicYear][semester].push(c);
  }
  return Object.keys(years)
    .sort((a, b) => {
      if (a === 'Unknown') return 1;
      if (b === 'Unknown') return -1;
      return b.localeCompare(a);
    })
    .map((year) => ({
      year,
      semesters: Object.keys(years[year])
        .sort((a, b) => (SEMESTER_ORDER[a] ?? 99) - (SEMESTER_ORDER[b] ?? 99))
        .map((semester) => ({ semester, courses: years[year][semester] })),
    }));
}

// "synced 20/05/2026" (UK/AU DD/MM/YYYY) / "never synced". synced_at is an ISO
// string, null, or (defensively) a non-parseable value — all non-dates render
// as "never synced". (App is used in UK/AU date convention; en-GB pins the order.)
export function formatLastSynced(syncedAt) {
  if (!syncedAt) return 'never synced';
  const d = new Date(syncedAt);
  if (Number.isNaN(d.getTime())) return 'never synced';
  return `synced ${d.toLocaleDateString('en-GB')}`;
}
