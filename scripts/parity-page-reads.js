// Live parity check for #141 (AGENTS.md: a parity probe is the verification of
// choice for API-shape work). Runs two server-rendered page reads both ways on
// real data and diffs the parsed results:
//   - archived-course discovery: GET /courses/mycourses/past → parsePastCourses
//   - people search:             GET /search/user?s={q}&page={n} → parseUserSearchResults
// "browser" = the pre-#141 headless-browser code (kept here verbatim: page.goto +
// page.content() for the past page; /home then in-page fetches for the search).
// "http" = the shipped path (archivedCourses.fetchArchivedCoursesHtml,
// peopleSearch.searchPeople: plain HTTP with the saved cookies).
// Read-only GETs. Output is masked: counts and match only, no names or ids.
// Usage (repo root): node scripts/parity-page-reads.js [query ...]   (default queries: chan wong lee)
import { existsSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';
import { sessionStateFile } from '../server/lib/sessionPaths.js';
import { parsePastCourses } from '../server/lib/parsePastCourses.js';
import { parseUserSearchResults } from '../server/lib/parseUserSearch.js';
import { fetchArchivedCoursesHtml } from '../server/services/archivedCourses.js';
import { searchPeople, paginatePeopleSearch, DEFAULT_MAX_PAGES } from '../server/services/peopleSearch.js';

if (!existsSync(sessionStateFile())) { console.error('No saved session'); process.exit(1); }
const queries = process.argv.slice(2).length ? process.argv.slice(2) : ['chan', 'wong', 'lee'];
// With DB_PATH (a copy of students.db), add full student names: narrow searches
// that finish on one page (complete=true), so their row sets must match exactly.
if (process.env.DB_PATH) {
  const { getDb } = await import('../server/db/index.js');
  const names = getDb().prepare(`SELECT first_name || ' ' || last_name AS n FROM students ORDER BY random() LIMIT ${Number(process.env.NAMES) || 4}`).all();
  queries.push(...names.map((r) => r.n));
}
const { chromium } = await import('playwright');

// ── The pre-#141 browser code, verbatim from archivedCourses.js / peopleSearch.js ──
async function browserArchivedHtml() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: sessionStateFile() });
    const page = await context.newPage();
    await page.goto(`${SCHOOLOGY_BASE}/courses/mycourses/past`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!isLoggedInUrl(page.url())) return null;
    return await page.content();
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function browserSearch(query, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  const q = (query || '').trim();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: sessionStateFile() });
  const page = await context.newPage();
  try {
    await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!isLoggedInUrl(page.url())) throw new Error('session expired');
    const getPage = async (qq, p) => {
      const qs = p > 0 ? `s=${encodeURIComponent(qq)}&page=${p}` : `s=${encodeURIComponent(qq)}`;
      const { status, html } = await page.evaluate(async ({ base, qs }) => {
        const res = await fetch(`${base}/search/user?${qs}`, { credentials: 'include', headers: { Accept: 'text/html' } });
        return { status: res.status, html: await res.text() };
      }, { base: SCHOOLOGY_BASE, qs });
      if (status !== 200) throw new Error(`Schoology /search/user returned HTTP ${status}`);
      return parseUserSearchResults(html);
    };
    return await paginatePeopleSearch(getPage, q, { maxPages });
  } finally {
    await browser.close();
  }
}

const timed = async (fn) => { const s = Date.now(); const r = await fn(); return [r, Date.now() - s]; };
const pause = () => new Promise((r) => setTimeout(r, 2000));
let mismatches = 0;

// Archived courses
{
  const [bHtml, bMs] = await timed(browserArchivedHtml);
  await pause();
  const [hHtml, hMs] = await timed(() => fetchArchivedCoursesHtml());
  const b = bHtml ? parsePastCourses(bHtml) : null;
  const h = hHtml ? parsePastCourses(hHtml) : null;
  const same = JSON.stringify(b) === JSON.stringify(h);
  if (!same) mismatches++;
  const periods = (l) => (l ? new Set(l.map((s) => s.gradingPeriod)).size : null);
  console.log(`archived: ${same ? 'same' : 'DIFFERS'} sections browser=${b?.length ?? null} http=${h?.length ?? null}, `
    + `terms browser=${periods(b)} http=${periods(h)}, no-code browser=${b?.filter((s) => !s.courseCode).length ?? null} http=${h?.filter((s) => !s.courseCode).length ?? null}`);
  console.log(`  time: browser ${bMs} ms (launch + page), http ${hMs} ms`);
  if (!same && b && h) {
    const key = (s) => JSON.stringify(s);
    const hs = new Set(h.map(key)); const bs = new Set(b.map(key));
    console.log(`  rows only in browser: ${b.filter((s) => !hs.has(key(s))).length}, only in http: ${h.filter((s) => !bs.has(key(s))).length}`);
  }
}

// People search
for (const q of queries) {
  await pause();
  const [b, bMs] = await timed(() => browserSearch(q).catch((e) => ({ error: e.message })));
  await pause();
  const [h, hMs] = await timed(() => searchPeople(q).catch((e) => ({ error: e.message })));
  // Schoology's ordering of a search is not stable between two reads of the same
  // query (seen 2026-10-17: two plain-HTTP reads differed too), so the pages of a
  // multi-page search can shift and a user can fall between pages or show on two.
  // The test is therefore: a one-page search returns exactly the same rows; in
  // any search every user both reads returned parses to the same fields.
  const byId = (r) => [...r.results].sort((x, y) => (x.userId < y.userId ? -1 : 1));
  const exact = JSON.stringify(b) === JSON.stringify(h);
  let ok = exact; let label = exact ? 'same' : 'DIFFERS';
  if (!exact && !b.error && !h.error) {
    const fieldsSame = b.results.every((x) => { const y = h.results.find((z) => z.userId === x.userId); return !y || JSON.stringify(x) === JSON.stringify(y); });
    const setSame = JSON.stringify(byId(b)) === JSON.stringify(byId(h));
    ok = fieldsSame && (setSame || (b.pagesFetched > 1 && h.pagesFetched > 1));
    if (ok) label = setSame ? 'same rows, order differs' : 'multi-page: every common user parses the same, the page sets shifted';
  }
  if (!ok) mismatches++;
  const sum = (r) => (r.error ? `error ${r.error}` : `${r.results.length} results, ${r.pagesFetched} pages, complete=${r.complete}`);
  console.log(`search "${q.slice(0, 1)}…" (${q.length} chars): ${label}; browser: ${sum(b)}; http: ${sum(h)}`);
  console.log(`  time: browser ${bMs} ms, http ${hMs} ms`);
  if (!exact && !b.error && !h.error) {
    // Where do they differ: which users, their order, or a row's fields?
    const ids = (r) => r.results.map((x) => x.userId);
    const hIds = new Set(ids(h)); const bIds = new Set(ids(b));
    const fields = new Map();
    for (const x of b.results) {
      const y = h.results.find((z) => z.userId === x.userId);
      if (!y) continue;
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) fields.set(k, (fields.get(k) || 0) + 1);
      }
    }
    const common = ids(b).filter((id) => hIds.has(id));
    const sameOrder = JSON.stringify(common) === JSON.stringify(ids(h).filter((id) => bIds.has(id)));
    console.log(`  users only in browser ${ids(b).filter((id) => !hIds.has(id)).length}, only in http ${ids(h).filter((id) => !bIds.has(id)).length}, `
      + `common ${common.length} in the same order: ${sameOrder}; fields differing on common users: ${JSON.stringify(Object.fromEntries(fields))}`);
    // Is the search itself stable? A second HTTP read of the same query.
    await pause();
    const h2 = await searchPeople(q).catch((e) => ({ error: e.message }));
    console.log(`  a second http read is ${JSON.stringify(h2) === JSON.stringify(h) ? 'identical to' : 'DIFFERENT from'} the first`);
  }
}

console.log(`\n${1 + queries.length} read(s): ${mismatches} mismatch(es)`);
process.exit(mismatches ? 1 : 0);
