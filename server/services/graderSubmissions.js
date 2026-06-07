/**
 * graderSubmissions.js
 *
 * Best-effort reader for per-(student, assignment) submission existence via
 * Schoology's internal gradebook bootstrap
 * (`GET /iapi/grades/grader_header_data/{sectionId}`, browser-session auth —
 * the same Playwright session as the mastery sync). This is the only surface
 * that reports a submission for OneDrive/Google-Drive (`lti_submission`)
 * dropbox assignments: the public OAuth revisions API is blind to post-submit
 * LTI revisions, so it cannot tell "submitted, awaiting grade" from "never
 * opened". See issue #62 and parseGraderHeaderData.js for the verified shape.
 *
 * Everything here is best-effort: if there is no saved session, the session has
 * expired, the fetch fails, or the JSON is unparseable, the fetcher returns
 * `null` and the caller falls back to the public revisions API alone. It never
 * throws into the sync.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { buildSubmissionLookup } from '../lib/parseGraderHeaderData.js';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { fetchAssignmentSubmissionState } from './graderDocuments.js';

const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');

/**
 * Create a submission-lookup fetcher backed by a single headless browser that
 * is reused across all sections in a sync (one browser launch, one page
 * navigation per section — the embedded-frame fragility note in the playbook
 * doesn't apply here since this is a direct same-origin fetch, but a fresh page
 * per request is cheap and avoids any cross-section state).
 *
 * @returns {Promise<null | {
 *   fetch: (sectionId: string) => Promise<object|null>,  // buildSubmissionLookup() result or null
 *   close: () => Promise<void>,
 * }>}
 *   Returns `null` immediately when no saved session exists, so the caller can
 *   skip GHD entirely without launching a browser.
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

  let sessionDead = false;

  return {
    async fetch(sectionId) {
      if (sessionDead) return null;
      const page = await context.newPage();
      try {
        await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!isLoggedInUrl(page.url())) {
          // Session expired — stop trying for the rest of this sync.
          sessionDead = true;
          return null;
        }
        const { status, body } = await page.evaluate(async (url) => {
          const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
          return { status: r.status, body: await r.text() };
        }, `${SCHOOLOGY_BASE}/iapi/grades/grader_header_data/${sectionId}`);
        if (status !== 200) return null;
        let json;
        try { json = JSON.parse(body); } catch { return null; }
        if (json?.response_code && json.response_code !== 200) return null;
        return buildSubmissionLookup(json);
      } catch {
        return null;
      } finally {
        await page.close().catch(() => {});
      }
    },
    async fetchDocuments(assignmentId) {
      if (sessionDead) return null;
      return fetchAssignmentSubmissionState(context, assignmentId);
    },
    async close() {
      if (browser) await browser.close().catch(() => {});
    },
  };
}
