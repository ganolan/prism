/**
 * graderSubmissions.js
 *
 * Best-effort reader for lti_submission document state via the grader's
 * per-assignment "submitted" / "in-progress" document endpoints
 * (`/iapi2/assignments/{aid}/{submitted,in-progress}-documents/`, browser-session
 * auth — the same Playwright session as the mastery sync). This is the only
 * surface that distinguishes "submitted" / "in progress" / "not started" for
 * OneDrive/Google-Drive (lti_submission) work: the public OAuth revisions API is
 * blind to post-submit LTI revisions. See issue #62 and parseGraderDocuments.js.
 *
 * Native dropbox does NOT use this — it reads the public bulk revisions endpoint
 * (#55, `getAssignmentSubmissions`), no browser session required. (This module
 * previously also exposed a grader_header_data submission lookup for native
 * dropbox; that became redundant once native moved to the bulk endpoint and was
 * removed along with parseGraderHeaderData.js.)
 *
 * Everything here is best-effort: with no saved session, an expired session, or a
 * failed fetch, the fetcher returns `null` and the caller falls back gracefully.
 * It never throws into the sync.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { fetchAssignmentSubmissionState } from './graderDocuments.js';

const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');

/**
 * Create a document-state fetcher backed by a single headless browser reused
 * across all sections in a sync (one browser launch; a fresh page per request).
 *
 * @returns {Promise<null | {
 *   fetchDocuments: (assignmentId: string) => Promise<Map<string,string>|null>,
 *   close: () => Promise<void>,
 * }>}
 *   Returns `null` immediately when no saved session exists, so the caller can
 *   skip the document pass entirely without launching a browser.
 */
export async function createSubmissionFetcher() {
  if (!existsSync(STATE_FILE)) return null;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return null;
  }

  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ storageState: STATE_FILE });
  } catch {
    if (browser) await browser.close().catch(() => {});
    return null;
  }

  return {
    async fetchDocuments(assignmentId) {
      return fetchAssignmentSubmissionState(context, assignmentId);
    },
    async close() {
      if (browser) await browser.close().catch(() => {});
    },
  };
}
