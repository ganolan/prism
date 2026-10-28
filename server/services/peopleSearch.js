/**
 * peopleSearch.js
 *
 * School-wide people search — finds users (parents, students, staff) who are
 * NOT in the teacher's own sections. This is the only confirmed way to reach
 * users outside your enrollments: the public OAuth `/search` is 403 and the
 * `/users` multi-get ignores filters. So we drive Schoology's internal
 * `GET /search/user?s={q}&page={n}` (server-rendered HTML) with the same
 * saved session as the mastery sync, over plain HTTP with its cookies
 * (schoologyWeb.js, #141; no browser), and parse each page (see
 * ../lib/parseUserSearch.js for the verified row structure). Checked against
 * the old browser read with scripts/parity-page-reads.js.
 *
 * Pagination: 10 results per page; a page with < 10 rows is the last one.
 * Each result row already carries name/school/photo (no role) — enough for a
 * result list. Full profile (email, parents) is a per-user follow-up via the
 * public OAuth `getUserProfile(uid)`, fetched lazily on click rather than for
 * every row (rate-limit friendly).
 */
import { existsSync } from 'fs';
import { parseUserSearchResults, PAGE_SIZE } from '../lib/parseUserSearch.js';
import { sessionStateFile } from '../lib/sessionPaths.js';
import { cookieJar, getResource, WebSessionError } from './schoologyWeb.js';
import { noteSessionLive } from './schoologySession.js';

// Bound a single search: 5 pages × 10 = up to 50 results. Broad queries
// (e.g. a common surname) have many more; when we hit this cap the result is
// reported `complete: false` so the caller can surface "showing first N".
export const DEFAULT_MAX_PAGES = 5;

// Best-effort: a saved session file exists. Does not prove it is still valid.
export function hasSession() {
  return existsSync(sessionStateFile());
}

/**
 * Pure pagination orchestrator (no I/O — unit-tested). Pulls pages via the
 * injected `getPage(query, page) => Promise<Array>` until a short page (< PAGE_SIZE)
 * or `maxPages` is reached. Dedupes by `userId`, preserving first-seen order.
 *
 * @returns {{ query, results, pagesFetched, complete }}
 *   `complete` is false only when stopped by the maxPages cap.
 */
export async function paginatePeopleSearch(getPage, query, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  const seen = new Set();
  const results = [];
  let page = 0;
  let complete = false;
  while (page < maxPages) {
    const pageResults = await getPage(query, page);
    page++;
    for (const r of pageResults) {
      if (r && r.userId && !seen.has(r.userId)) {
        seen.add(r.userId);
        results.push(r);
      }
    }
    if (pageResults.length < PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  return { query, results, pagesFetched: page, complete };
}

// The path of one search-results page (page 0 carries no page parameter).
export function searchPath(query, pageNum) {
  const qs = pageNum > 0
    ? `s=${encodeURIComponent(query)}&page=${pageNum}`
    : `s=${encodeURIComponent(query)}`;
  return `/search/user?${qs}`;
}

const needsLogin = () => {
  const e = new Error('Schoology browser session expired: run `npm run mastery:login`.');
  e.needsLogin = true;
  return e;
};

/**
 * Run a school-wide people search. Requires a live saved Schoology session
 * (same one as mastery sync). Throws an error with `.needsLogin = true` if there
 * is no saved session or it has expired.
 *
 * @param {string} query
 * @param {{maxPages?: number, jar?: object|null, fetchImpl?: typeof fetch}} opts  jar / fetchImpl: test seam
 * @returns {Promise<{ query, results, pagesFetched, complete }>}
 */
export async function searchPeople(query, { maxPages = DEFAULT_MAX_PAGES, jar, fetchImpl = fetch } = {}) {
  const q = (query || '').trim();
  if (!q) return { query: '', results: [], pagesFetched: 0, complete: true };

  const cookies = jar === undefined ? cookieJar() : jar;
  if (!cookies) throw needsLogin();

  const getPage = async (qq, p) => {
    let r;
    try {
      r = await getResource(cookies, searchPath(qq, p), { fetchImpl, accept: 'text/html' });
    } catch (err) {
      if (err instanceof WebSessionError && err.code === 'SESSION_EXPIRED') {
        noteSessionLive('expired', 'Schoology sent a people search to the login page');
        throw needsLogin();
      }
      throw err;
    }
    if (r.status !== 200) throw new Error(`Schoology /search/user returned HTTP ${r.status}`);
    return parseUserSearchResults(r.text);
  };

  return paginatePeopleSearch(getPage, q, { maxPages });
}

export { PAGE_SIZE };
