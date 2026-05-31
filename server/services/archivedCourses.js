/**
 * archivedCourses.js
 *
 * Best-effort reader for the teacher's archived (past) course inventory via
 * Schoology's server-rendered page (GET /courses/mycourses/past — Schoology's
 * own name for the source page; "archived" is the app's term, see CONTEXT.md).
 * Browser-session auth (same saved Playwright session as the mastery sync).
 * There is no JSON endpoint, so the page HTML is scraped and parsed
 * (parsePastCourses, named after Schoology's page). Issue #5.
 *
 * Everything is best-effort: no saved session / expired session / launch or
 * navigation failure → returns null, and the caller treats discovery as
 * unavailable. It never throws.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { parsePastCourses } from '../lib/parsePastCourses.js';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';

const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');

/**
 * Fetch the raw archived-courses HTML (Schoology's /mycourses/past page) via the
 * saved browser session. Returns the page HTML, or null when there is no session
 * / it has expired / anything fails.
 */
export async function fetchArchivedCoursesHtml() {
  if (!existsSync(STATE_FILE)) return null;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return null;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: STATE_FILE });
    const page = await context.newPage();
    await page.goto(`${SCHOOLOGY_BASE}/courses/mycourses/past`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    if (!isLoggedInUrl(page.url())) return null; // session expired → redirected to login
    return await page.content();
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Enumerate archived sections. `fetchHtml` is injectable for testing (defaults
 * to the real browser fetch). Returns the parsed section list, or null when the
 * HTML is unavailable (so the caller can report discovery as unavailable).
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
