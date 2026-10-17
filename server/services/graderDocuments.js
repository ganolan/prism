/**
 * graderDocuments.js
 *
 * Reads the grader's per-assignment document lists, which carry the true
 * lti_submission state (submitted / in_progress / not_started):
 * `GET /iapi2/assignments/{aid}/submitted-documents/` and `/in-progress-documents/`.
 * Plain HTTP with the saved session's cookies (schoologyWeb.js, #141), no browser:
 * the browser path ran the same two GETs as an in-page fetch after loading /home.
 * `web` is the sync's shared { jar, fetchImpl, onSessionExpired? }
 * (graderSubmissions.createSubmissionFetcher).
 * Best-effort: returns null on any failure so the caller falls back cleanly.
 * Never throws into the sync.
 */
import { buildSubmissionResult } from '../lib/parseGraderDocuments.js';
import { getJson, WebSessionError } from './schoologyWeb.js';

/**
 * @param {{ jar, fetchImpl?: typeof fetch, onSessionExpired?: () => void }} web
 * @param {string} assignmentId
 * @returns {Promise<{ states: Map<string,string>, details: Map<string,{submittedAt:number|null, late:0|1}> } | null>}
 *   states = uid → 3-way submission state; details = submittedAt/late for the
 *   submitted students (#125). null on total failure.
 */
export async function fetchAssignmentSubmissionState(web, assignmentId) {
  const io = { fetchImpl: web.fetchImpl };
  // A list that is not a 200 JSON answer counts as missing, as before (a test's
  // lists are 403: dropbox / LTI only).
  const get = async (list) => {
    const r = await getJson(web.jar, `/iapi2/assignments/${encodeURIComponent(assignmentId)}/${list}/`, io);
    return r.status === 200 ? r.json : null;
  };
  try {
    // Plain HTTP, so the two reads can run together (the browser path had to run
    // them one after the other: two page.evaluate() calls on one page raced, #62).
    const [submitted, inProgress] = await Promise.all([get('submitted-documents'), get('in-progress-documents')]);
    return buildSubmissionResult(submitted, inProgress);
  } catch (err) {
    if (err instanceof WebSessionError && err.code === 'SESSION_EXPIRED') web.onSessionExpired?.();
    return null;
  }
}
