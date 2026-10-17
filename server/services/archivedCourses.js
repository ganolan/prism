/**
 * archivedCourses.js
 *
 * Best-effort reader for the teacher's archived (past) course inventory via
 * Schoology's server-rendered page (GET /courses/mycourses/past — Schoology's
 * own name for the source page; "archived" is the app's term, see CONTEXT.md).
 * Session auth (the saved session the mastery sync uses), over plain HTTP with
 * its cookies (schoologyWeb.js, #141): no browser. There is no JSON endpoint, so
 * the page HTML is scraped and parsed (parsePastCourses, named after Schoology's
 * page). Issue #5. Checked against the old browser read with
 * scripts/parity-page-reads.js.
 *
 * Everything is best-effort: no saved session / expired session / a failed
 * request → returns null, and the caller treats discovery as unavailable. It
 * never throws.
 */
import { parsePastCourses } from '../lib/parsePastCourses.js';
import { cookieJar, getPage, WebSessionError } from './schoologyWeb.js';
import { noteSessionLive } from './schoologySession.js';

export const PAST_COURSES_PATH = '/courses/mycourses/past';

/**
 * Fetch the raw archived-courses HTML (Schoology's /mycourses/past page) with
 * the saved session. Returns the page HTML, or null when there is no session /
 * it has expired / anything fails.
 * @param {{ jar?: object|null, fetchImpl?: typeof fetch }} [deps]  test seam
 */
export async function fetchArchivedCoursesHtml({ jar, fetchImpl = fetch } = {}) {
  try {
    const cookies = jar === undefined ? cookieJar() : jar;
    if (!cookies) return null;
    const page = await getPage(cookies, PAST_COURSES_PATH, { fetchImpl });
    noteSessionLive('connected');
    return page.html;
  } catch (err) {
    if (err instanceof WebSessionError && err.code === 'SESSION_EXPIRED') {
      noteSessionLive('expired', 'Schoology sent the archived-courses read to the login page');
    }
    return null;
  }
}

/**
 * Enumerate archived sections. `fetchHtml` is injectable for testing (defaults
 * to the real fetch). Returns the parsed section list, or null when the HTML is
 * unavailable (so the caller can report discovery as unavailable).
 *
 * @param {() => Promise<string|null>} [fetchHtml]
 * @returns {Promise<Array<object>|null>}
 */
export async function getArchivedSections(fetchHtml = fetchArchivedCoursesHtml) {
  const html = await fetchHtml();
  if (!html) return null;
  try {
    return parsePastCourses(html);
  } catch {
    return null;
  }
}
