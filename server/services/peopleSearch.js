/**
 * peopleSearch.js
 *
 * School-wide people search — finds users (parents, students, staff) who are
 * NOT in the teacher's own sections. This is the only confirmed way to reach
 * users outside your enrollments: the public OAuth `/search` is 403 and the
 * `/users` multi-get ignores filters. So we drive Schoology's internal
 * `GET /search/user?s={q}&page={n}` (server-rendered HTML) using the same
 * browser session as the mastery sync, and parse each page (see
 * ../lib/parseUserSearch.js for the verified row structure).
 *
 * Pagination: 10 results per page; a page with < 10 rows is the last one.
 * Each result row already carries name/role/school/photo — enough for a
 * result list. Full profile (email, parents) is a per-user follow-up via the
 * public OAuth `getUserProfile(uid)`, fetched lazily on click rather than for
 * every row (rate-limit friendly).
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { parseUserSearchResults, PAGE_SIZE } from '../lib/parseUserSearch.js';

const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';
const SESSION_DIR = join(process.cwd(), '.playwright-session');
const STATE_FILE = join(SESSION_DIR, 'storage-state.json');

// Bound a single search: 5 pages × 10 = up to 50 results. Broad queries
// (e.g. a common surname) have many more; when we hit this cap the result is
// reported `complete: false` so the caller can surface "showing first N".
export const DEFAULT_MAX_PAGES = 5;

// Best-effort: a saved session file exists. Does not prove it is still valid.
export function hasSession() {
  return existsSync(STATE_FILE);
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

async function openPage() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const contextOpts = existsSync(STATE_FILE) ? { storageState: STATE_FILE } : {};
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  return { browser, page };
}

// Fetch one search-results page's raw HTML through the authenticated session.
async function fetchSearchHtml(page, query, pageNum) {
  const qs = pageNum > 0
    ? `s=${encodeURIComponent(query)}&page=${pageNum}`
    : `s=${encodeURIComponent(query)}`;
  return page.evaluate(async ({ base, qs }) => {
    const res = await fetch(`${base}/search/user?${qs}`, {
      credentials: 'include',
      headers: { Accept: 'text/html' },
    });
    return { status: res.status, html: await res.text() };
  }, { base: SCHOOLOGY_BASE, qs });
}

/**
 * Run a school-wide people search. Requires a live Schoology browser session
 * (same one as mastery sync). Throws an error with `.needsLogin = true` if the
 * session has expired.
 *
 * @param {string} query
 * @param {{maxPages?: number}} opts
 * @returns {Promise<{ query, results, pagesFetched, complete }>}
 */
export async function searchPeople(query, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  const q = (query || '').trim();
  if (!q) return { query: '', results: [], pagesFetched: 0, complete: true };

  const { browser, page } = await openPage();
  try {
    await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const url = page.url();
    const loggedIn = url.includes('schoology.hkis.edu.hk') &&
      !/\/login|\/saml|accounts\.google\.com|microsoftonline/.test(url);
    if (!loggedIn) {
      const e = new Error('Schoology browser session expired — run `npm run mastery:login`.');
      e.needsLogin = true;
      throw e;
    }

    const getPage = async (qq, p) => {
      const { status, html } = await fetchSearchHtml(page, qq, p);
      if (status !== 200) throw new Error(`Schoology /search/user returned HTTP ${status}`);
      return parseUserSearchResults(html);
    };

    return await paginatePeopleSearch(getPage, q, { maxPages });
  } finally {
    await browser.close();
  }
}

export { PAGE_SIZE };
