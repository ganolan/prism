// Read-only probe: the web surface behind a submission's comment thread.
// Loads the dropbox view page for one student (native dropbox) and records:
//   - every same-origin XHR/fetch the page makes (method, path, status, content type)
//   - the comment form's action, method and input NAMES (never values)
//   - the DOM container of the comment list and how many comments it shows
//   - endpoint-like literals near "comment" in inline scripts
// Nothing is posted. No comment text or student name is printed.
//
// Usage: node scripts/probe-submission-comments-web.js <assignmentId> <uid>
import 'dotenv/config';
import { chromium } from 'playwright';
import { join } from 'path';
import { existsSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';

const [aid, uid] = process.argv.slice(2);
if (!aid || !uid) { console.error('usage: <assignmentId> <uid>'); process.exit(2); }
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');
if (!existsSync(STATE_FILE)) { console.error('No session'); process.exit(1); }
const TRACKER = /aptrinsic|nr-data|bam\.nr|doubleclick|googletag|esp-us2|\/rte\/v1\/|hotjar|segment|onetrust|cookielaw|fullstory/;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();
const seen = [];
page.on('request', (req) => {
  const url = req.url();
  if (!url.includes('hkis.edu.hk') || TRACKER.test(url)) return;
  if (!['xhr', 'fetch'].includes(req.resourceType())) return;
  seen.push({ method: req.method(), url, req });
});

try {
  await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!isLoggedInUrl(page.url())) throw new Error('SESSION DEAD');
  const url = `${SCHOOLOGY_BASE}/assignment/${aid}/dropbox/view/${uid}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);
  console.log('final url ok:', page.url().replace(/\d{6,}/g, '#'));

  console.log('\n-- XHR/fetch --');
  for (const s of seen) {
    const resp = await s.req.response();
    console.log(` ${s.method} ${new URL(s.url).pathname.replace(/\d{6,}/g, '#')} ${resp?.status()} ${(resp?.headers()['content-type'] || '').split(';')[0]}`);
  }

  const info = await page.evaluate(() => {
    const forms = [...document.querySelectorAll('form')].filter((f) => /comment/i.test(f.id + f.action + f.className));
    const formInfo = forms.map((f) => ({
      id: f.id, action: f.getAttribute('action'), method: f.method, enctype: f.enctype,
      inputs: [...f.querySelectorAll('input,textarea,select,button')].map((i) => `${i.tagName.toLowerCase()}[${i.type || ''}] name=${i.name || ''} id=${i.id || ''}`),
    }));
    const lists = [...document.querySelectorAll('[class*=comment],[id*=comment]')]
      .filter((e) => !e.closest('form'))
      .slice(0, 25)
      .map((e) => `${e.tagName.toLowerCase()}#${e.id}.${String(e.className).replace(/\s+/g, '.')} children=${e.children.length}`);
    const scripts = [...document.scripts].map((s) => s.textContent || '').join('\n');
    const lits = [...new Set((scripts.match(/["'](\/[a-z0-9_\-/{}]*comment[a-z0-9_\-/{}]*)["']/gi) || []))].slice(0, 40);
    const s = window.Drupal?.settings?.s_common;
    return { formInfo, lists, lits, csrf: { token: !!s?.csrf_token, key: !!s?.csrf_key } };
  });
  console.log('\n-- comment forms --');
  console.log(JSON.stringify(info.formInfo, null, 1).replace(/\d{6,}/g, '#'));
  console.log('\n-- comment-ish elements --');
  info.lists.forEach((l) => console.log(' ', l.replace(/\d{6,}/g, '#')));
  console.log('\n-- script literals with "comment" --');
  info.lits.forEach((l) => console.log(' ', l));
  console.log('\ncsrf present:', JSON.stringify(info.csrf));
} finally {
  await browser.close();
}
