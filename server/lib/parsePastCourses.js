/**
 * parsePastCourses.js
 *
 * Pure parser for Schoology's past-courses page (GET /courses/mycourses/past,
 * browser-session auth — there is no JSON endpoint). Verified structure
 * (.claude/schoology-api-reference.md → "Three high-priority surfaces" #2):
 *   li.course-item#course-{courseId}
 *     .course-title, .course-code
 *     div.section-item#section-{sectionId}  (+ a[href="/course/{sectionId}"])
 *
 * Output is section-grained: one row per section-item (so a 2-section course
 * yields 2 rows sharing course fields). An empty .course-code → courseCode null
 * (the MASTER-style "not taught" signal). sectionTitle is best-effort.
 */
import { parse } from 'node-html-parser';

const stripPrefix = (id, prefix) => {
  const s = String(id || '');
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
};

export function parsePastCourses(html) {
  const root = parse(html || '');
  const out = [];
  for (const courseEl of root.querySelectorAll('li.course-item')) {
    const courseId = stripPrefix(courseEl.getAttribute('id'), 'course-');
    if (!courseId) continue;
    const courseTitle = courseEl.querySelector('.course-title')?.text.trim() || null;
    const rawCode = courseEl.querySelector('.course-code')?.text.trim();
    const courseCode = rawCode ? rawCode : null;
    for (const secEl of courseEl.querySelectorAll('.section-item')) {
      const sectionId = stripPrefix(secEl.getAttribute('id'), 'section-');
      if (!sectionId) continue;
      const sectionTitle =
        secEl.querySelector('.section-title')?.text.trim() ||
        secEl.querySelector('a[href^="/course/"]')?.text.trim() ||
        null;
      out.push({ courseId, courseTitle, courseCode, sectionId, sectionTitle });
    }
  }
  return out;
}
