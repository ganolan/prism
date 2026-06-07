// Spike: is there a BULK student-profile source (email, preferred name, grad_year,
// parents) to replace the per-student getUserProfile walk? The course members page
// renders all of it at once. Check (1) the known member_enrollments endpoint's
// fields, and (2) what /course/{sid}/members actually loads. PII: keys+presence only.
import 'dotenv/config';
import { chromium } from 'playwright';
import { join } from 'path';
import { existsSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';

const sectionId = process.argv[2] || '7899896098';
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');
const TRACKER = /aptrinsic|nr-data|bam\.nr|doubleclick|googletag|esp-us2|\/rte\/v1\/|hotjar|segment|onetrust/;
if (!existsSync(STATE_FILE)) { console.error('No session'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const want = ['primary_email', 'email', 'name_first_preferred', 'use_preferred_first_name', 'grad_year', 'parents', 'guardian', 'school_uid'];
const presence = (o) => want.filter((k) => o && o[k] != null && o[k] !== '').join(',') || '(none of the wanted fields)';

const seen = [];
page.on('response', async (resp) => {
  try {
    const url = resp.url();
    if (!url.includes('hkis.edu.hk') || TRACKER.test(url)) return;
    if (/\.(png|jpg|jpeg|gif|svg|css|woff2?|ico|map)(\?|$)/.test(url)) return;
    const ct = (resp.headers()['content-type'] || '').split(';')[0];
    let len = 0; try { len = (await resp.text()).length; } catch {}
    seen.push({ method: resp.request().method(), url: url.replace(SCHOOLOGY_BASE, ''), status: resp.status(), ct, len });
  } catch {}
});

const getJson = (path) => page.evaluate(async (u) => {
  const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, head: t.slice(0, 140) };
}, `${SCHOOLOGY_BASE}${path}`);

try {
  await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!isLoggedInUrl(page.url())) throw new Error('SESSION DEAD');

  // (1) known roster endpoint — what fields per member?
  console.log('=== /iapi/enrollment/member_enrollments/course/' + sectionId + ' ===');
  const me = await getJson(`/iapi/enrollment/member_enrollments/course/${sectionId}`);
  console.log('  status', me.status);
  const body = me.json?.body ?? me.json ?? {};
  let members = Array.isArray(body) ? body : (body.members || body.enrollments || Object.values(body).find(Array.isArray) || []);
  if (members.length) {
    console.log('  members:', members.length, '| member[0] keys:', Object.keys(members[0]).slice(0, 30).join(','));
    console.log('  wanted-field presence on member[0]:', presence(members[0]));
  } else { console.log('  head:', me.head); }

  // (2) drive the members page, capture what it loads
  console.log('\n=== driving /course/' + sectionId + '/members — captured same-origin XHRs ===');
  const before = seen.length;
  await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/members`, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => console.log('  nav warn', e.message));
  await sleep(3000);
  const fresh = seen.slice(before).filter((r) => /\/iapi|\/api\/|enrollment|members|user|parent|guardian/i.test(r.url) || r.ct.includes('json'));
  for (const r of fresh) console.log(`  [${r.method} ${r.status} ${r.ct} len=${r.len}] ${r.url.slice(0, 110)}`);
  if (!fresh.length) console.log('  (no obvious data XHR — page may be server-rendered HTML)');
} catch (e) {
  console.error('PROBE ERROR:', e.message);
} finally {
  await browser.close();
}
