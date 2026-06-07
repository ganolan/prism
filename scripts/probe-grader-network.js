// Deep spike (#62) v2: find the surface behind the assignment's
// "In Progress / Submitted" tabs. Drive /assignments/{aid}/info (the page that
// renders those tabs), filter out tracker noise, capture the real same-origin
// XHRs, save the HTML, and locate where Maria (never-opened) and Brigid
// (GHD says "drop", teacher says never-opened) appear + with what status.
//
// Usage: node scripts/probe-grader-network.js <sectionId> <assignmentId>
import 'dotenv/config';
import { chromium } from 'playwright';
import { join } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';

const sectionId = process.argv[2] || '7899907720';
const assignmentId = process.argv[3] || '8348763574';
const TARGETS = { '132465441': 'MARIA(never-opened)', '11862763': 'BRIGID(drop?)' };
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');
const TRACKER = /aptrinsic|nr-data|bam\.nr|doubleclick|googletag|esp-us2|\/rte\/v1\/|hotjar|segment|onetrust|cookielaw|fullstory/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(STATE_FILE)) { console.error('No session'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();
const seen = [];
page.on('response', async (resp) => {
  try {
    const url = resp.url();
    if (!url.includes('hkis.edu.hk') || TRACKER.test(url)) return;
    if (/\.(png|jpg|jpeg|gif|svg|css|woff2?|ico|map)(\?|$)/.test(url)) return;
    const ct = (resp.headers()['content-type'] || '').split(';')[0];
    let body = '';
    try { body = await resp.text(); } catch {}
    seen.push({ method: resp.request().method(), url, status: resp.status(), ct, len: body.length, body });
  } catch {}
});

const ctx = (hay, needle, pad = 160) => { const i = hay.indexOf(needle); return i < 0 ? null : hay.slice(Math.max(0, i - pad), i + needle.length + pad).replace(/\s+/g, ' '); };

try {
  await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!isLoggedInUrl(page.url())) throw new Error('SESSION DEAD');

  const url = `${SCHOOLOGY_BASE}/assignments/${assignmentId}/info`;
  console.log('>>> loading', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await sleep(3000);
  console.log('final url:', page.url());

  // 1) All real same-origin responses (no trackers)
  console.log('\n===== SAME-ORIGIN XHR/DOC RESPONSES (trackers removed) =====');
  for (const r of seen) console.log(`  [${r.method} ${r.status} ${r.ct} len=${r.len}] ${r.url.replace(SCHOOLOGY_BASE, '')}`);

  // 2) The assignment-info HTML — where are the submission tabs + targets?
  const docs = seen.filter((r) => r.ct.includes('html') && r.len > 5000);
  const main = docs.sort((a, b) => b.len - a.len)[0];
  if (main) {
    writeFileSync('/tmp/assignment-info.html', main.body);
    console.log(`\n===== assignment-info HTML (len=${main.len}) saved to /tmp/assignment-info.html =====`);
    const h = main.body;
    for (const term of ['submission', 'in_progress', 'In Progress', 'Submitted', 'not-submitted', 'dropbox', 'revision', 'num_submission', 'ungraded']) {
      const c = ctx(h, term, 100);
      if (c) console.log(`  «${term}» → …${c}…`);
    }
    console.log('\n  endpoint-ish literals in HTML:');
    const eps = [...new Set((h.match(/\/(?:iapi2?|sections|assignments?|course|grade[-_a-z]*)\/[A-Za-z0-9_\/{}.?=&-]{3,80}/g) || []))]
      .filter((u) => /submiss|dropbox|grade|ajax|status|revision/i.test(u)).slice(0, 30);
    for (const e of eps) console.log('    ', e);
    console.log('\n  target students in HTML:');
    for (const [uid, name] of Object.entries(TARGETS)) {
      const c = ctx(h, uid, 140);
      console.log(`    ${name}: ${c ? '…' + c + '…' : 'NOT FOUND in page HTML'}`);
    }
  }
} catch (e) {
  console.error('PROBE ERROR:', e.message);
} finally {
  await browser.close();
}
