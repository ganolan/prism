// Live parity check for #141 (AGENTS.md: a parity probe is the verification of
// choice for API-shape work). Runs the sync's two session reads both ways on real
// data and diffs the parsed results:
//   - lti document state: /iapi2/assignments/{aid}/{submitted,in-progress}-documents/
//   - test attempts:      /iapi/grades/grader_grade_data/{sectionId}/all?uids=…&grade_item_nids=…
// "browser" = the pre-#141 headless-browser path (kept here verbatim: open a page,
// load /home, fetch inside the page). "http" = the shipped path
// (graderSubmissions.createSubmissionFetcher, plain HTTP with the saved cookies).
// Each item is read both ways back to back (order alternates), so a student
// acting between the two reads is the only expected source of a difference.
// Read-only GETs. Output is masked: ids show their last 3 digits, no names.
// Usage (repo root): DB_PATH=<abs copy of students.db> node scripts/parity-grader-reads.js
//   ARCHIVED=1 also reads archived courses' LTI assignments; LIMIT=n caps the LTI list.
import { existsSync } from 'fs';
import { getDb } from '../server/db/index.js';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';
import { sessionStateFile } from '../server/lib/sessionPaths.js';
import { buildSubmissionResult } from '../server/lib/parseGraderDocuments.js';
import { parseTestAttempts } from '../server/lib/parseTestAttempts.js';
import { createSubmissionFetcher } from '../server/services/graderSubmissions.js';

if (!process.env.DB_PATH) { console.error('Set DB_PATH to an absolute path of a copy of students.db'); process.exit(1); }
if (!existsSync(sessionStateFile())) { console.error('No saved session'); process.exit(1); }
const db = getDb();
const mask = (id) => `…${String(id).slice(-3)}`;

// ── The pre-#141 browser path, from graderDocuments.js / graderTestAttempts.js ──
// Verbatim except that each in-page read also reports why it gave nothing
// (`seen`: the HTTP status, or the error a failed page.evaluate threw), so a
// browser-side failure can be told from a data difference.
async function browserDocuments(context, assignmentId, seen = []) {
  const page = await context.newPage();
  try {
    await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!isLoggedInUrl(page.url())) return null;
    const get = async (path) => {
      try {
        const out = await page.evaluate(async (u) => {
          const r = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include' });
          if (r.status !== 200) return { status: r.status, json: null };
          try { return { status: 200, json: JSON.parse(await r.text()) }; } catch { return { status: 200, json: null }; }
        }, `${SCHOOLOGY_BASE}/iapi2/assignments/${assignmentId}/${path}/`);
        seen.push(`${path.split('-')[0]}:${out.status}${out.json ? '' : ' (no JSON)'}`);
        return out.json;
      } catch (err) {
        seen.push(`${path.split('-')[0]}:threw ${String(err.message).split('\n')[0].slice(0, 80)}`);
        throw err;
      }
    };
    const submitted = await get('submitted-documents');
    const inProgress = await get('in-progress-documents');
    return buildSubmissionResult(submitted, inProgress);
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function browserTestAttempts(context, sectionId, uids, gradeItemIds) {
  if (!uids.length || !gradeItemIds.length) return null;
  let page;
  try {
    page = await context.newPage();
    await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!isLoggedInUrl(page.url())) return null;
    const url = `${SCHOOLOGY_BASE}/iapi/grades/grader_grade_data/${encodeURIComponent(sectionId)}/all`
      + `?uids=${uids.join(',')}&grade_item_nids=${gradeItemIds.join(',')}`;
    const payload = await page.evaluate(async ({ u, timeoutMs }) => {
      const r = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include', signal: AbortSignal.timeout(timeoutMs) });
      if (r.status !== 200) return null;
      try { return JSON.parse(await r.text()); } catch { return null; }
    }, { u: url, timeoutMs: 30000 });
    return parseTestAttempts(payload);
  } catch {
    return null;
  } finally {
    await page?.close().catch(() => {});
  }
}

// ── Canonical forms for the diff ──
const sortEntries = (m) => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const canonDocs = (r) => (r ? JSON.stringify({ states: sortEntries(r.states), details: sortEntries(r.details) }) : 'null');
const canonTests = (r) => (r ? JSON.stringify(sortEntries(r).map(([uid, byItem]) => [uid, sortEntries(byItem)])) : 'null');

// ── Items ──
const courseFilter = process.env.ARCHIVED ? '' : 'AND c.archived = 0';
const lti = db.prepare(`SELECT a.schoology_assignment_id AS aid FROM assignments a JOIN courses c ON c.id = a.course_id
  WHERE a.is_lti_submission = 1 AND a.removed_at IS NULL AND c.excluded = 0 ${courseFilter} ORDER BY c.archived, a.id`).all()
  .slice(0, Number(process.env.LIMIT) || undefined);
const testSections = db.prepare(`SELECT c.id, c.schoology_section_id AS sid FROM courses c
  WHERE c.archived = 0 AND c.excluded = 0 AND EXISTS (SELECT 1 FROM assignments a WHERE a.course_id = c.id AND a.is_test = 1 AND a.removed_at IS NULL)`).all()
  .map((c) => ({
    sid: c.sid,
    uids: db.prepare(`SELECT s.schoology_uid FROM enrolments e JOIN students s ON s.id = e.student_id WHERE e.course_id = ? AND e.dropped_at IS NULL AND s.schoology_uid IS NOT NULL`).all(c.id).map((r) => String(r.schoology_uid)),
    tests: db.prepare(`SELECT schoology_assignment_id FROM assignments WHERE course_id = ? AND is_test = 1 AND removed_at IS NULL`).all(c.id).map((r) => String(r.schoology_assignment_id)),
  }));
console.log(`Items: ${lti.length} LTI assignment(s), ${testSections.length} section(s) with tests`);

// ── Run ──
const { chromium } = await import('playwright');
let t = Date.now();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: sessionStateFile() });
const launchMs = Date.now() - t;
t = Date.now();
// Count the 429s the HTTP path meets (getResource waits them out and asks again).
const seen429 = [];
const http = await createSubmissionFetcher({
  fetchImpl: async (...a) => {
    const r = await fetch(...a);
    if (r.status === 429) seen429.push(r.headers.get('retry-after'));
    return r;
  },
});
const httpSetupMs = Date.now() - t;

const time = { browser: { docs: 0, tests: 0 }, http: { docs: 0, tests: 0 } };
const timed = async (bucket, key, fn) => { const s = Date.now(); const r = await fn(); time[bucket][key] += Date.now() - s; return r; };
let mismatches = 0; let nulls = 0; let i = 0;
// The browser path's /home load fires the page's own XHRs, enough to draw 429s
// from Schoology's web surface; a pause between items keeps both paths under it.
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 3000);
const pause = () => new Promise((r) => setTimeout(r, PAUSE_MS));

// A browser read where a list gave nothing is a browser failure, not a data
// difference: it is read again (the sync retries a failed read once too) and only
// a difference between two complete reads counts as a mismatch.
let browserFailures = 0;
const complete = (seen) => seen.length === 2 && seen.every((s) => /:200$/.test(s));
for (const { aid } of lti) {
  let seen = [];
  const run = { browser: () => browserDocuments(context, aid, (seen = [])), http: () => http.fetchDocuments(aid) };
  if (i) await pause();
  const order = i++ % 2 ? ['http', 'browser'] : ['browser', 'http'];
  const got = {};
  for (const k of order) got[k] = await timed(k, 'docs', run[k]);
  const failed = [];
  for (let retry = 0; retry < 3 && !complete(seen); retry++) {
    failed.push(seen.join(', ') || 'no read');
    browserFailures++;
    got.browser = await timed('browser', 'docs', run.browser);
  }
  const same = canonDocs(got.browser) === canonDocs(got.http);
  if (!same) mismatches++;
  if (!got.browser || !got.http) nulls++;
  const counts = (r) => (r ? [...r.states.values()].reduce((o, s) => ({ ...o, [s]: (o[s] || 0) + 1 }), {}) : null);
  console.log(`docs ${mask(aid)}: ${same ? 'same' : 'DIFFERS'} browser=${JSON.stringify(counts(got.browser))} http=${JSON.stringify(counts(got.http))}`
    + (failed.length ? `  [browser read failed first: ${failed.join(' | ')}]` : ''));
}

for (const s of testSections) {
  const run = { browser: () => browserTestAttempts(context, s.sid, s.uids, s.tests), http: () => http.fetchTestAttempts(s.sid, s.uids, s.tests) };
  if (i) await pause();
  const order = i++ % 2 ? ['http', 'browser'] : ['browser', 'http'];
  const got = {};
  for (const k of order) got[k] = await timed(k, 'tests', run[k]);
  const same = canonTests(got.browser) === canonTests(got.http);
  if (!same) mismatches++;
  if (!got.browser || !got.http) nulls++;
  const took = (r) => (r ? [...r.values()].reduce((n, m) => n + [...m.values()].filter((c) => c.took).length, 0) : null);
  console.log(`tests ${mask(s.sid)} (${s.uids.length} students × ${s.tests.length} tests): ${same ? 'same' : 'DIFFERS'} took browser=${took(got.browser)} http=${took(got.http)}`);
}

await browser.close();
await http.close();
const n = lti.length + testSections.length;
console.log('\nTiming (ms):');
console.log(`  browser: launch ${launchMs} + docs ${time.browser.docs} + tests ${time.browser.tests} = ${launchMs + time.browser.docs + time.browser.tests}`);
console.log(`  http:    setup ${httpSetupMs} + docs ${time.http.docs} + tests ${time.http.tests} = ${httpSetupMs + time.http.docs + time.http.tests}`);
console.log(`  per LTI assignment: browser ${Math.round(time.browser.docs / (lti.length || 1))}, http ${Math.round(time.http.docs / (lti.length || 1))}`);
console.log(`  per test section:   browser ${Math.round(time.browser.tests / (testSections.length || 1))}, http ${Math.round(time.http.tests / (testSections.length || 1))}`);
console.log(`  (browser docs time includes the ${browserFailures} re-read(s) of failed browser reads; pauses between items are not counted)`);
console.log(`  HTTP path met ${seen429.length} 429(s)${seen429.length ? `, Retry-After: ${JSON.stringify(seen429)}` : ''}`);
console.log(`\n${n} item(s): ${mismatches} mismatch(es), ${nulls} with a null read; ${browserFailures} failed browser read(s) re-read`);
process.exit(mismatches ? 1 : 0);
