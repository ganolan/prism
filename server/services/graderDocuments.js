/**
 * graderDocuments.js
 *
 * Browser-session fetch for the grader's per-assignment document lists, which
 * carry the true lti_submission state (submitted / in_progress / not_started).
 * Reuses an existing Playwright BrowserContext (the same session as GHD/mastery)
 * — see graderSubmissions.createSubmissionFetcher. Best-effort: returns null on
 * any failure so the caller falls back cleanly. Never throws into the sync.
 */
import { buildSubmissionResult } from '../lib/parseGraderDocuments.js';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';

/**
 * @param {import('playwright').BrowserContext} context  logged-in context
 * @param {string} assignmentId
 * @returns {Promise<{ states: Map<string,string>, details: Map<string,{submittedAt:number|null, late:0|1}> } | null>}
 *   states = uid → 3-way submission state; details = submittedAt/late for the
 *   submitted students (#125). null on total failure.
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
    // Sequential, NOT Promise.all: two concurrent page.evaluate() calls on the
    // same page race, and the in-progress fetch can silently drop (#62 e2e).
    const submitted = await get('submitted-documents');
    const inProgress = await get('in-progress-documents');
    return buildSubmissionResult(submitted, inProgress);
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}
