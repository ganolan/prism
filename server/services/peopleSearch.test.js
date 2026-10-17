import { describe, it, expect } from 'vitest';
import { paginatePeopleSearch, searchPeople } from './peopleSearch.js';
import { fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';
import { PAGE_SIZE } from '../lib/parseUserSearch.js';

// Build `n` fake result rows starting at id `offset`.
const mk = (n, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ userId: String(offset + i), name: `User ${offset + i}` }));

// Returns a getPage(query, page) fn backed by a list of per-page result arrays.
const pager = (pages) => async (_query, page) => pages[page] || [];

describe('paginatePeopleSearch', () => {
  it('stops at the first short page and reports complete', async () => {
    const getPage = pager([mk(PAGE_SIZE, 0), mk(4, PAGE_SIZE)]);
    const r = await paginatePeopleSearch(getPage, 'liu');
    expect(r.results).toHaveLength(PAGE_SIZE + 4);
    expect(r.pagesFetched).toBe(2);
    expect(r.complete).toBe(true);
  });

  it('treats an empty first page as a complete, empty result', async () => {
    const r = await paginatePeopleSearch(pager([[]]), 'zzz');
    expect(r.results).toEqual([]);
    expect(r.pagesFetched).toBe(1);
    expect(r.complete).toBe(true);
  });

  it('caps at maxPages and reports incomplete when every page is full', async () => {
    const getPage = pager([mk(PAGE_SIZE, 0), mk(PAGE_SIZE, PAGE_SIZE), mk(PAGE_SIZE, PAGE_SIZE * 2)]);
    const r = await paginatePeopleSearch(getPage, 'chan', { maxPages: 2 });
    expect(r.pagesFetched).toBe(2);
    expect(r.results).toHaveLength(PAGE_SIZE * 2);
    expect(r.complete).toBe(false);
  });

  it('dedupes users that repeat across or within pages', async () => {
    // page 0 is full (so it continues) but contains a duplicate id; page 1 repeats one more.
    const page0 = [...mk(PAGE_SIZE - 1, 0), { userId: '0', name: 'User 0 again' }]; // 10 rows, id 0 twice
    const page1 = [{ userId: '0', name: 'dup' }, { userId: '100', name: 'New' }];   // short → stop
    const r = await paginatePeopleSearch(pager([page0, page1]), 'dup');
    const ids = r.results.map(x => x.userId);
    expect(new Set(ids).size).toBe(ids.length);          // no duplicates
    expect(ids).toContain('100');
    expect(ids.filter(id => id === '0')).toHaveLength(1); // id 0 kept exactly once
  });
});

// Synthetic /search/user rows in the verified row structure (no real PII).
const row = (id) => `<li class="search-summary"><div class="item user-list-item">
  <div class="item-title"><a href="/user/${id}">Person ${id}</a></div>
  <div class="item-info"><span class="item-type">Person</span></div></div></li>`;
const resultsPage = (ids) => `<html><body><ul class="search-summaries">${ids.map(row).join('')}</ul></body></html>`;

describe('searchPeople (plain HTTP, #141)', () => {
  const ids = (from, n) => Array.from({ length: n }, (_, i) => String(from + i));

  it('GETs /search/user page by page with the session cookie, page 0 without a page parameter', async () => {
    const pages = [ids(100, PAGE_SIZE), ids(200, 3)];
    const web = fakeSchoologyWeb({ routes: { '/search/user': (e) => ({ text: resultsPage(pages[Number(e.query.get('page') || 0)] || []) }) } });
    const r = await searchPeople('  liu ', { jar: web.jar, fetchImpl: web.fetchImpl });
    expect(r).toMatchObject({ query: 'liu', pagesFetched: 2, complete: true });
    expect(r.results.map((x) => x.userId)).toEqual([...pages[0], ...pages[1]]);
    expect(web.requests.map((q) => [q.query.get('s'), q.query.get('page')])).toEqual([['liu', null], ['liu', '1']]);
    expect(web.requests[0].headers).toMatchObject({ cookie: 'SESS=old', Accept: 'text/html' });
  });

  it('needsLogin with no saved session, or when Schoology sends the search to sign-in', async () => {
    await expect(searchPeople('liu', { jar: null })).rejects.toMatchObject({ needsLogin: true });
    const web = fakeSchoologyWeb({ routes: { '/search/user': { login: true } } });
    await expect(searchPeople('liu', { jar: web.jar, fetchImpl: web.fetchImpl })).rejects.toMatchObject({ needsLogin: true });
  });

  it('a non-200 page is an error naming the status; an empty query sends nothing', async () => {
    const web = fakeSchoologyWeb({ routes: { '/search/user': { status: 500, text: 'oops' } } });
    await expect(searchPeople('liu', { jar: web.jar, fetchImpl: web.fetchImpl })).rejects.toThrow(/HTTP 500/);
    expect(await searchPeople('  ', { jar: web.jar, fetchImpl: web.fetchImpl })).toMatchObject({ results: [], pagesFetched: 0 });
    expect(web.requests).toHaveLength(1);
  });
});
