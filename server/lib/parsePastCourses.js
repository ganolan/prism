import { parse } from 'node-html-parser';

const stripPrefix = (id, prefix) => {
  const s = String(id || '');
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
};

// Schoology's /mycourses/past page renders an <h3> grading-period header before
// each group of courses for that term (verified live 2026-05-31), e.g.
// "Semester 1: 08/14/2025 - 01/11/2026", "2024-2025: …", "22-23 YR · …". A header
// is an <h3> whose text carries a date, a year-range, or a term token.
const TERM_HEADER = /\d{1,2}\/\d{2}\/\d{2,4}|\d{4}-\d{4}|semester|\bS[12]\b|\bYR\b|summer|full.?year/i;
const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();

function parseCourseItem(courseEl, gradingPeriod, seen, out) {
  const courseId = stripPrefix(courseEl.getAttribute('id'), 'course-');
  if (!courseId) return;
  const courseTitle = courseEl.querySelector('.course-title')?.text.trim() || null;
  const rawCode = courseEl.querySelector('.course-code')?.text.trim();
  const courseCode = rawCode ? rawCode : null;
  for (const secEl of courseEl.querySelectorAll('.section-item')) {
    const sectionId = stripPrefix(secEl.getAttribute('id'), 'section-');
    if (!sectionId || seen.has(sectionId)) continue; // dedupe by section
    seen.add(sectionId);
    const sectionTitle =
      secEl.querySelector('.section-title')?.text.trim() ||
      secEl.querySelector('a[href^="/course/"]')?.text.trim() ||
      null;
    out.push({ courseId, courseTitle, courseCode, sectionId, sectionTitle, gradingPeriod });
  }
}

/**
 * Parse Schoology's /courses/mycourses/past HTML into one row per section:
 * { courseId, courseTitle, courseCode (null when the .course-code is empty —
 * the MASTER-style "not taught" signal), sectionId, sectionTitle, gradingPeriod
 * (the text of the most-recent <h3> term header above the course, or null) }.
 * Sections are deduped by sectionId. Pure; never throws on malformed HTML.
 */
export function parsePastCourses(html) {
  const root = parse(html || '');
  const out = [];
  const seen = new Set();
  let currentGradingPeriod = null;
  // Preorder DFS so headers and course-items are visited in document order; each
  // course-item inherits the most-recent term header above it.
  const walk = (node) => {
    if (node.nodeType !== 1) return; // ELEMENT_NODE only (skip text nodes)
    const tag = (node.rawTagName || '').toLowerCase();
    if (tag === 'h3') {
      const t = collapse(node.text);
      if (t && TERM_HEADER.test(t)) currentGradingPeriod = t;
      return; // headers contain no course-items
    }
    if (tag === 'li' && /\bcourse-item\b/.test(node.getAttribute('class') || '')) {
      parseCourseItem(node, currentGradingPeriod, seen, out);
      return; // sections handled; don't double-walk children
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return out;
}
