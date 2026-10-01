/**
 * graderTestAttempts.js
 *
 * Browser-session read of who has an attempt on each Schoology test in a section
 * (make-up tests): the gradebook's own lazy column loader,
 * `GET /iapi/grades/grader_grade_data/{sectionId}/all?uids=…&grade_item_nids=…`.
 * One GET per section; parsed by parseTestAttempts. Reuses the sync's shared
 * Playwright BrowserContext (graderSubmissions.createSubmissionFetcher).
 * Read-only: never fetch the results pages' `/unsubmit` or `/delete` links.
 * Best-effort: returns null on any failure (no session, timeout, bad payload) so
 * the caller records the tests as unknown. Never throws into the sync.
 */
import { parseTestAttempts } from '../lib/parseTestAttempts.js';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';

// page.evaluate has no timeout of its own; abort a stalled fetch in the page.
const FETCH_TIMEOUT_MS = 30000;

/**
 * @param {import('playwright').BrowserContext} context  logged-in context
 * @param {string} sectionId
 * @param {string[]} uids          Schoology user ids (the section's students)
 * @param {string[]} gradeItemIds  public assignment ids of the tests
 * @returns {Promise<Map<string, Map<string, {took: boolean, notAssigned: boolean}>> | null>}
 */
export async function fetchSectionTestAttempts(context, sectionId, uids, gradeItemIds) {
  if (!uids.length || !gradeItemIds.length) return null;
  const page = await context.newPage();
  try {
    await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!isLoggedInUrl(page.url())) return null;
    const url = `${SCHOOLOGY_BASE}/iapi/grades/grader_grade_data/${encodeURIComponent(sectionId)}/all`
      + `?uids=${uids.join(',')}&grade_item_nids=${gradeItemIds.join(',')}`;
    const payload = await page.evaluate(async ({ u, timeoutMs }) => {
      const r = await fetch(u, {
        headers: { Accept: 'application/json' },
        credentials: 'include',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status !== 200) return null;
      try { return JSON.parse(await r.text()); } catch { return null; }
    }, { u: url, timeoutMs: FETCH_TIMEOUT_MS });
    return parseTestAttempts(payload);
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}
