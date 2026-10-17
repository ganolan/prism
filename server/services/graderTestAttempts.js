/**
 * graderTestAttempts.js
 *
 * Reads who has an attempt on each Schoology test in a section (make-up tests):
 * the gradebook's own lazy column loader,
 * `GET /iapi/grades/grader_grade_data/{sectionId}/all?uids=…&grade_item_nids=…`.
 * One GET per section; parsed by parseTestAttempts. Plain HTTP with the saved
 * session's cookies (schoologyWeb.js, #141), no browser; `web` is the sync's
 * shared { jar, fetchImpl, onSessionExpired? } (graderSubmissions.createSubmissionFetcher).
 * Read-only: never fetch the results pages' `/unsubmit` or `/delete` links.
 * Best-effort: returns null on any failure (no session, timeout, bad payload) so
 * the caller records the tests as unknown. Never throws into the sync.
 */
import { parseTestAttempts } from '../lib/parseTestAttempts.js';
import { getJson, WebSessionError } from './schoologyWeb.js';

const FETCH_TIMEOUT_MS = 30000;

/**
 * @param {{ jar, fetchImpl?: typeof fetch, onSessionExpired?: () => void }} web
 * @param {string} sectionId
 * @param {string[]} uids          Schoology user ids (the section's students)
 * @param {string[]} gradeItemIds  public assignment ids of the tests
 * @returns {Promise<Map<string, Map<string, {took: boolean, notAssigned: boolean}>> | null>}
 */
export async function fetchSectionTestAttempts(web, sectionId, uids, gradeItemIds) {
  if (!uids.length || !gradeItemIds.length) return null;
  const path = `/iapi/grades/grader_grade_data/${encodeURIComponent(sectionId)}/all`
    + `?uids=${uids.join(',')}&grade_item_nids=${gradeItemIds.join(',')}`;
  try {
    const r = await getJson(web.jar, path, { fetchImpl: web.fetchImpl, timeoutMs: FETCH_TIMEOUT_MS });
    return r.status === 200 ? parseTestAttempts(r.json) : null;
  } catch (err) {
    if (err instanceof WebSessionError && err.code === 'SESSION_EXPIRED') web.onSessionExpired?.();
    return null;
  }
}
