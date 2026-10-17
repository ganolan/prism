/**
 * graderSubmissions.js
 *
 * Best-effort reader for lti_submission document state via the grader's
 * per-assignment "submitted" / "in-progress" document endpoints
 * (`/iapi2/assignments/{aid}/{submitted,in-progress}-documents/`, session auth).
 * This is the only surface that distinguishes "submitted" / "in progress" /
 * "not started" for OneDrive/Google-Drive (lti_submission) work: the public OAuth
 * revisions API is blind to post-submit LTI revisions. See issue #62 and
 * parseGraderDocuments.js.
 *
 * Native dropbox does NOT use this — it reads the public bulk revisions endpoint
 * (#55, `getAssignmentSubmissions`). (This module previously also exposed a
 * grader_header_data submission lookup for native dropbox; that became redundant
 * once native moved to the bulk endpoint and was removed along with
 * parseGraderHeaderData.js.)
 *
 * It also reads Schoology test attempts per section (grader_grade_data, make-up
 * tests — see graderTestAttempts.js).
 *
 * Both reads go over plain HTTP with the saved session's cookies (schoologyWeb.js,
 * #141): no browser launch, no /home page load per request. Checked against the
 * old headless-browser path with scripts/parity-grader-reads.js.
 *
 * Everything here is best-effort: with no saved session, an expired session, or a
 * failed fetch, the fetcher returns `null` and the caller falls back gracefully.
 * It never throws into the sync.
 */
import { fetchAssignmentSubmissionState } from './graderDocuments.js';
import { fetchSectionTestAttempts } from './graderTestAttempts.js';
import { cookieJar } from './schoologyWeb.js';
import { noteSessionLive } from './schoologySession.js';

/**
 * Create a fetcher sharing one cookie jar across all sections in a sync. Once
 * Schoology sends a read to sign-in, later reads return null at once (the
 * session will not come back mid-sync) and the session card says "expired".
 *
 * @param {{ jar?: object|null, fetchImpl?: typeof fetch }} [deps]  test seam
 * @returns {Promise<null | {
 *   fetchDocuments: (assignmentId: string) => Promise<{ states: Map<string,string>, details: Map<string,{submittedAt:number|null, late:0|1}> }|null>,
 *   fetchTestAttempts: (sectionId: string, uids: string[], gradeItemIds: string[]) => Promise<Map<string, Map<string,{took:boolean, notAssigned:boolean}>>|null>,
 *   close: () => Promise<void>,
 * }>}
 *   Returns `null` immediately when no saved session exists, so the caller can
 *   skip the document pass entirely.
 */
export async function createSubmissionFetcher({ jar, fetchImpl = fetch } = {}) {
  let cookies;
  try { cookies = jar === undefined ? cookieJar() : jar; } catch { cookies = null; }
  if (!cookies) return null;

  let expired = false;
  const web = {
    jar: cookies,
    fetchImpl,
    onSessionExpired() {
      if (!expired) noteSessionLive('expired', 'Schoology sent a sync read to the login page');
      expired = true;
    },
  };

  return {
    async fetchDocuments(assignmentId) {
      return expired ? null : fetchAssignmentSubmissionState(web, assignmentId);
    },
    async fetchTestAttempts(sectionId, uids, gradeItemIds) {
      return expired ? null : fetchSectionTestAttempts(web, sectionId, uids, gradeItemIds);
    },
    async close() { /* nothing to release: no browser */ },
  };
}
