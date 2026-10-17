/**
 * ltiSubmissionApps.js
 *
 * Over plain HTTP with the saved session's cookies (schoologyWeb.js, no
 * browser), read-only GETs (#142):
 *   - which app backs an lti_submission task (Google Drive / OneDrive), from the
 *     assignment page's props (GET /assignment/{aid});
 *   - the grader's submitted list (GET /iapi2/assignments/{aid}/submitted-documents/),
 *     so a Google Drive "Open" link shows only for students who submitted.
 * Best-effort: every failure resolves to a status, never a throw. The app of an
 * assignment doesn't change, so it is cached for hours; the submitted list for
 * minutes, like the OneDrive listing. Failures are not cached.
 * Shapes: .claude/schoology-api-reference.md ("Which app backs an lti_submission task").
 */
import { cookieJar, getPage, WebSessionError } from './schoologyWeb.js';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { parseLtiSubmissionApp } from '../lib/ltiSubmissionApp.js';
import { noteSessionLive } from './schoologySession.js';

export const APP_TTL_MS = 12 * 60 * 60 * 1000;
export const SUBMITTED_TTL_MS = 5 * 60 * 1000;

// Swappable in tests.
export const ltiAppDeps = {
  cookieJar: () => cookieJar(),
  fetch: (...a) => fetch(...a),
};

const appCache = new Map();       // aid → { at, result }
const submittedCache = new Map(); // aid → { at, result }

/** Test hook. */
export function clearLtiAppCache() {
  appCache.clear();
  submittedCache.clear();
}

function cached(cache, key, ttl, refresh, load) {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.result);
  return load().then((result) => {
    if (result.status === 'ok') cache.set(key, { at: Date.now(), result });
    return result;
  });
}

/**
 * @returns {Promise<{status:'ok', appId, launchUrl, targetHost, provider} |
 *   {status:'no_app'|'no_session'|'session_expired'|'error'}>}
 */
export function getLtiSubmissionApp({ assignmentId, refresh = false }) {
  const aid = String(assignmentId);
  return cached(appCache, aid, APP_TTL_MS, refresh, async () => {
    const jar = ltiAppDeps.cookieJar();
    if (!jar) return { status: 'no_session' };
    try {
      const { html } = await getPage(jar, `/assignment/${encodeURIComponent(aid)}`, { fetchImpl: ltiAppDeps.fetch });
      noteSessionLive('connected');
      const app = parseLtiSubmissionApp(html);
      return app ? { status: 'ok', ...app } : { status: 'no_app' };
    } catch (err) {
      return sessionFailure(err, 'The assignment page');
    }
  });
}

/**
 * The grader's submitted-documents entries ({ id = schoology uid, submissionDate, … }).
 * @returns {Promise<{status:'ok', entries: object[]} | {status:'no_session'|'session_expired'|'error'}>}
 */
export function getSubmittedDocuments({ assignmentId, refresh = false }) {
  const aid = String(assignmentId);
  return cached(submittedCache, aid, SUBMITTED_TTL_MS, refresh, async () => {
    const jar = ltiAppDeps.cookieJar();
    if (!jar) return { status: 'no_session' };
    try {
      const res = await ltiAppDeps.fetch(`${SCHOOLOGY_BASE}/iapi2/assignments/${encodeURIComponent(aid)}/submitted-documents/`, {
        headers: { cookie: jar.header(), Accept: 'application/json' },
        redirect: 'manual',
      });
      jar.take(res);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location && !isLoggedInUrl(new URL(location, SCHOOLOGY_BASE).href)) {
        throw new WebSessionError('SESSION_EXPIRED', 'The saved Schoology session has expired');
      }
      if (res.status !== 200) return { status: 'error' };
      const json = await res.json().catch(() => null);
      if (!Array.isArray(json?.data)) return { status: 'error' };
      return { status: 'ok', entries: json.data };
    } catch (err) {
      return sessionFailure(err, 'The grader submitted list');
    }
  });
}

function sessionFailure(err, what) {
  if (err instanceof WebSessionError && err.code === 'SESSION_EXPIRED') {
    noteSessionLive('expired', `${what} was sent to the login page`);
    return { status: 'session_expired' };
  }
  console.error(`[lti submission app] ${what}:`, err.message);
  return { status: 'error' };
}
