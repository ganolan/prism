// Probe (#53): load an LTI assignment's page, save every JS chunk + same-origin
// XHR it pulls in, so the bundle can be literal-grepped for the per-student
// submission-history route. READ-ONLY (page load only, no clicks).
// Usage: [SESSION_FILE=…] node scripts/probe-lti-grader-chunks.js <assignmentId>
import 'dotenv/config';
import { chromium } from 'playwright';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';

const aid = process.argv[2];
const STATE_FILE = process.env.SESSION_FILE || join(process.cwd(), '.playwright-session', 'storage-state.json');
const OUT = '/tmp/probe-resubmission/chunks';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE, viewport: { width: 1400, height: 1000 } });
const page = await context.newPage();
const log = [];
page.on('response', async (resp) => {
  const url = resp.url();
  try {
    if (/\.js(\?|$)/.test(url)) { writeFileSync(join(OUT, url.split('/').pop().split('?')[0]), await resp.text()); return; }
    if (url.includes('hkis.edu.hk') && /iapi|ajax|submission|document/i.test(url)) {
      const body = await resp.text().catch(() => '');
      log.push(`${resp.request().method()} ${resp.status()} ${url.replace(SCHOOLOGY_BASE, '')} len=${body.length}`);
    }
  } catch {}
});
await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded' });
if (!isLoggedInUrl(page.url())) { console.error('SESSION DEAD'); process.exit(1); }
await page.goto(`${SCHOOLOGY_BASE}/assignments/${aid}/info`, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => console.log('goto', e.message));
await page.waitForTimeout(5000);
await page.screenshot({ path: join(OUT, 'page.png'), fullPage: false });
console.log(log.join('\n'));
await browser.close();
