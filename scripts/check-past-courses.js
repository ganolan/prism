// Compares Prism's past courses with the teacher's past sections in Schoology (#178), through a
// running Prism server's GET /api/courses/archived/discover (Schoology's REST section list, every
// school year, linked sections included). Lists each past section Prism does not hold, and why.
// Prints course and section titles and ids, no student data.
//   node scripts/check-past-courses.js [baseUrl]
// baseUrl defaults to http://127.0.0.1:$PORT (3001). Exit 0 when every past section with a
// course code is held; exit 1 when one is not, or Schoology or the server cannot be read.
// A section with no course code is a template, which Prism never imports by design.
import { isMain } from '../server/lib/isMain.js';

const label = (s) => [s.courseTitle, s.sectionTitle].filter(Boolean).join(' ');
const why = (s) => (s.givenUp
  ? 'the import failed twice: import it from the Archived tab'
  : 'not imported yet: the past-course import takes it after the next full sync');

// sections: the discover answer's rows → { ok, lines }.
export function reportPastCourses(sections) {
  const coded = sections.filter((s) => !s.noCourseCode);
  const missing = coded.filter((s) => !s.imported);
  const templates = sections.length - coded.length;
  const lines = [`${sections.length} past sections in Schoology: ${coded.length - missing.length} held by Prism, `
    + `${missing.length} missing, ${templates} template${templates === 1 ? '' : 's'} (no course code, never imported)`];
  for (const s of missing) {
    lines.push(`  missing: ${label(s)} [${s.gradingPeriod ?? 'no grading period'}] section ${s.sectionId}`
      + `${s.linkedSectionIds?.length ? ` (linked: ${s.linkedSectionIds.join(', ')})` : ''}: ${why(s)}`);
  }
  return { ok: missing.length === 0, lines };
}

export async function checkPastCourses(baseUrl, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${baseUrl}/api/courses/archived/discover`);
    if (!res.ok) return { ok: false, lines: [`${baseUrl}: HTTP ${res.status}`] };
    const body = await res.json();
    if (!body.available) return { ok: false, lines: [`${baseUrl}: Schoology could not be read (${body.reason})`] };
    return reportPastCourses(body.sections);
  } catch (err) {
    return { ok: false, lines: [`${baseUrl}: ${err.message}`] };
  }
}

if (isMain(import.meta.url)) {
  const base = process.argv[2] ?? `http://127.0.0.1:${process.env.PORT || 3001}`;
  const { ok, lines } = await checkPastCourses(base.replace(/\/$/, ''));
  for (const line of lines) console.log(line);
  process.exit(ok ? 0 : 1);
}
