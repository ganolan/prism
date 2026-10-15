// Read-only spike (2026-10-12, linked quiz + result design): what do a Schoology
// test's question list, results page and one attempt page expose?
//
// GET only, browser session. Saves each page's raw HTML to OUT_DIR for offline
// inspection (it holds student names and answers: keep it out of the repo) and
// prints only structure. Refuses any URL containing "unsubmit" or "delete": the
// results pages carry GET-href write actions (schoology-api-reference.md, Tests
// and quizzes > Did the student take the test?).
//
// Usage: OUT_DIR=<dir> [PRISM_SESSION_DIR=<dir>] node scripts/probe-assessment-attempt.js <testId> [<copyTestId>]
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';
import { sessionStateFile } from '../server/lib/sessionPaths.js';

const testId = process.argv[2] || '8544307969';
const copyId = process.argv[3] || '8603667595';
const OUT_DIR = process.env.OUT_DIR;
if (!OUT_DIR) { console.error('Set OUT_DIR (outside the repo)'); process.exit(1); }
mkdirSync(OUT_DIR, { recursive: true });
const STATE_FILE = sessionStateFile();
if (!existsSync(STATE_FILE)) { console.error(`No saved session at ${STATE_FILE}`); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();

async function getHtml(path, name) {
  if (/unsubmit|delete/i.test(path)) throw new Error(`Refusing write-action URL: ${path}`);
  const r = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: 'include' });
    return { status: res.status, url: res.url, text: await res.text() };
  }, `${SCHOOLOGY_BASE}${path}`);
  writeFileSync(join(OUT_DIR, `${name}.html`), r.text);
  console.log(`${name}: status=${r.status} len=${r.text.length} final=${r.url.replace(SCHOOLOGY_BASE, '')}`);
  return r.text;
}

try {
  await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!isLoggedInUrl(page.url())) throw new Error('SESSION DEAD: re-run npm run mastery:login');

  await getHtml(`/assignment/${testId}/assessment_questions`, 'questions-std');
  await getHtml(`/assignment/${copyId}/assessment_questions`, 'questions-copy');
  const results = await getHtml(`/assignment/${testId}/assessment_results`, 'results-std');

  // First assignee row that shows an attempt ("1/1"-style submissions cell).
  const rowRe = /<tr[^>]*class="[^"]*student-row-(\d+)[^"]*"[\s\S]*?<\/tr>/g;
  let uid = null;
  for (const m of results.matchAll(rowRe)) {
    const sub = m[0].match(/cell-submissions[^>]*>([\s\S]*?)<\/td>/);
    if (sub && /\d+\s*\/\s*\d+/.test(sub[1].replace(/<[^>]*>/g, ''))) { uid = m[1]; break; }
  }
  console.log('first taker found:', !!uid);
  if (uid) {
    const stats = await getHtml(`/assignment/${testId}/assessment_results/student_stats/${uid}`, 'student-stats');
    const attemptIds = [...stats.matchAll(new RegExp(`student_stats/${uid}/(\\d+)(?=["/?])`, 'g'))]
      .map((m) => m[1]);
    const unique = [...new Set(attemptIds)];
    console.log('attempt ids on stats page:', unique.length);
    if (unique.length) await getHtml(`/assignment/${testId}/assessment_results/student_stats/${uid}/${unique[0]}`, 'attempt');
  }
} finally {
  await browser.close();
}
