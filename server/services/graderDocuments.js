/**
 * graderDocuments.js
 *
 * Browser-session fetch for the grader's per-assignment document lists, which
 * carry the true lti_submission state (submitted / in_progress / not_started).
 * Reuses an existing Playwright BrowserContext (the same session as GHD/mastery)
 * — see graderSubmissions.createSubmissionFetcher. Best-effort: returns null on
 * any failure so the caller falls back cleanly. Never throws into the sync.
 */
import { buildSubmissionStateMap } from '../lib/parseGraderDocuments.js';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';

/**
 * @param {import('playwright').BrowserContext} context  logged-in context
 * @param {string} assignmentId
 * @returns {Promise<Map<string,string>|null>} uid → state, or null
 */
export async function fetchAssignmentSubmissionState(context, assignmentId) {
  const page = await context.newPage();
  try {
    await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!isLoggedInUrl(page.url())) return null;
    const get = (path) => page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include' });
      if (r.status !== 200) return null;
      try { return JSON.parse(await r.text()); } catch { return null; }
    }, `${SCHOOLOGY_BASE}/iapi2/assignments/${assignmentId}/${path}/`);
    const [submitted, inProgress] = await Promise.all([get('submitted-documents'), get('in-progress-documents')]);
    if (submitted == null && inProgress == null) return null;
    return buildSubmissionStateMap(submitted, inProgress);
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}
