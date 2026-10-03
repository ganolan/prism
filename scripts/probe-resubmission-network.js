// Probe (#53): where does Schoology keep the per-student "re-submitted" fact?
// Drives pages in a real (headless) browser, captures same-origin responses,
// and reports which ones mention resubmission. READ-ONLY (GET page loads only).
// Usage: [SESSION_FILE=…] node scripts/probe-resubmission-network.js <path> [<path>…]
import 'dotenv/config';
import { chromium } from 'playwright';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';

const STATE_FILE = process.env.SESSION_FILE || join(process.cwd(), '.playwright-session', 'storage-state.json');
const TRACKER = /aptrinsic|nr-data|bam\.nr|doubleclick|googletag|esp-us2|\/rte\/v1\/|hotjar|segment|onetrust|cookielaw|fullstory/;
const OUT = join('/tmp', 'probe-resubmission');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();
let seen = [];
page.on('response', async (resp) => {
  try {
    const url = resp.url();
    if (!url.includes('hkis.edu.hk') || TRACKER.test(url)) return;
    if (/\.(png|jpe?g|gif|svg|css|woff2?|ico|map|js)(\?|$)/.test(url)) return;
    let body = ''; try { body = await resp.text(); } catch {}
    seen.push({ method: resp.request().method(), url, status: resp.status(), len: body.length, body });
  } catch {}
});
await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
if (!isLoggedInUrl(page.url())) { console.error('SESSION DEAD'); process.exit(1); }
let i = 0;
for (const path of process.argv.slice(2)) {
  seen = [];
  console.log(`\n##### ${path}`);
  try { await page.goto(`${SCHOOLOGY_BASE}${path}`, { waitUntil: 'networkidle', timeout: 45000 }); } catch (e) { console.log('  goto:', e.message.split('\n')[0]); }
  await page.waitForTimeout(3000);
  const html = await page.content();
  writeFileSync(join(OUT, `page-${++i}.html`), html);
  console.log(`  final url=${page.url()} html=${html.length} saved page-${i}.html; resubmi in html: ${(html.match(/resubmi/gi) || []).length}`);
  for (const s of seen) {
    const hits = (s.body.match(/resubmi/gi) || []).length;
    console.log(`  ${s.method} ${s.status} ${s.url.replace(SCHOOLOGY_BASE, '')} len=${s.len}${hits ? `  <<< resubmi×${hits}` : ''}`);
    if (hits) writeFileSync(join(OUT, `hit-${i}-${s.url.replace(/[^a-z0-9]+/gi, '_').slice(-80)}.txt`), s.body);
  }
}
await browser.close();
