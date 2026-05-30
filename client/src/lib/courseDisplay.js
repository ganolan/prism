// Course-card display helpers, shared by the Dashboard and the Sync dialog's
// Past-courses panel. parseGradingPeriod/groupByAcademicYear were extracted
// verbatim from Dashboard.jsx.

export function parseGradingPeriod(gradingPeriod) {
  if (!gradingPeriod) return { academicYear: 'Unknown', semester: 'Unknown' };
  let semester = 'Full Year';
  if (gradingPeriod.includes('Semester 1')) semester = 'Semester 1';
  else if (gradingPeriod.includes('Semester 2')) semester = 'Semester 2';
  const dateMatch = gradingPeriod.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (!dateMatch) return { academicYear: 'Unknown', semester };
  const month = parseInt(dateMatch[1], 10);
  const rawYear = parseInt(dateMatch[3], 10);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const startYear = month >= 8 ? year : year - 1;
  const academicYear = `${startYear}-${String(startYear + 1).slice(-2)}`;
  return { academicYear, semester };
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

// "synced 5/31/2026" / "never synced". synced_at is an ISO string, null, or
// (defensively) a non-parseable value — all non-dates render as "never synced".
export function formatLastSynced(syncedAt) {
  if (!syncedAt) return 'never synced';
  const d = new Date(syncedAt);
  if (Number.isNaN(d.getTime())) return 'never synced';
  return `synced ${d.toLocaleDateString()}`;
}
