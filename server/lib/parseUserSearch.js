/**
 * parseUserSearch.js
 *
 * Pure parser for Schoology's internal user-search results page
 * (`GET /search/user?s={q}&page={n}` on the school domain). The page is
 * server-rendered HTML — the results are present without running JS — so we
 * parse the raw HTML here (in Node) rather than in the browser, which keeps
 * this logic unit-testable against a fixture.
 *
 * Verified result-row structure (see schoology-api-reference.md, "Three
 * high-priority surfaces" #1):
 *
 *   li.search-summary > div.item.user-list-item
 *     a[href="/user/{id}"] > … img.imagecache-profile_sm[src]   ← photo
 *     div.item-title  > a[href="/user/{id}"]                     ← name + id
 *     div.item-info   > span.item-type                           ← entity-type label
 *                     > span.item-school > a[href="/{schoolId}"] ← school
 *
 * Note: `.item-type` is the generic entity type — observed as "Person" for
 * every /search/user row — NOT the user's role. The actual role (Parent /
 * Student / Staff) lives on the profile read (`GET /v1/users/{uid}.role_id`),
 * fetched lazily per user, not in the search row.
 *     div.network-button-links > a.action-message[href="/messages/new/{id}"]
 */
import { parse } from 'node-html-parser';

// Verified empirically (2026-05-30): /search/user returns 10 results per page,
// not the 20 an earlier doc claimed. The scraper uses this to detect the last
// page (a page with fewer than PAGE_SIZE rows is the final one).
export const PAGE_SIZE = 10;

const firstDigits = (s) => {
  const m = (s || '').match(/(\d+)/);
  return m ? m[1] : null;
};

const text = (el) => (el ? el.text.replace(/\s+/g, ' ').trim() : null);

/**
 * Parse a /search/user results page into structured rows.
 * @param {string} html — raw HTML of the search results page
 * @returns {Array<{userId, name, role, school, schoolId, photoUrl, messageUserId}>}
 */
export function parseUserSearchResults(html) {
  if (!html) return [];
  const root = parse(html);
  const rows = root.querySelectorAll('li.search-summary');
  const out = [];

  for (const row of rows) {
    const titleLink = row.querySelector('.item-title a') ||
      row.querySelectorAll('a').find(a => /\/user\/\d+/.test(a.getAttribute('href') || ''));
    const userId = titleLink ? firstDigits((titleLink.getAttribute('href') || '').match(/\/user\/(\d+)/)?.[0]) : null;
    if (!userId) continue; // not a user result row

    const schoolLink = row.querySelector('.item-school a');
    const img = row.querySelector('.profile-picture img');
    const msgLink = row.querySelector('.network-button-links a.action-message');
    const msgHref = msgLink ? msgLink.getAttribute('href') || '' : '';

    out.push({
      userId,
      name: text(titleLink),
      type: text(row.querySelector('.item-type')),
      school: text(schoolLink),
      schoolId: schoolLink ? firstDigits(schoolLink.getAttribute('href')) : null,
      photoUrl: img ? (img.getAttribute('src') || null) : null,
      messageUserId: msgHref.match(/\/messages\/new\/(\d+)/)?.[1] ?? null,
    });
  }

  return out;
}
