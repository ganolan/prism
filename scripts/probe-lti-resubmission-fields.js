// Probe (#53): which grader-document fields mark an LTI resubmission? Dumps the
// distinct values of every field across submitted/in-progress entries for the
// assignments Schoology's reminders count as re-submitted. READ-ONLY; uids masked.
// Usage: [SESSION_FILE=…] node scripts/probe-lti-resubmission-fields.js <aid> [<aid>…]
import 'dotenv/config';
import { chromium } from 'playwright';
import { join } from 'path';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';

const STATE_FILE = process.env.SESSION_FILE || join(process.cwd(), '.playwright-session', 'storage-state.json');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();
await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
if (!isLoggedInUrl(page.url())) { console.error('SESSION DEAD'); process.exit(1); }
const get = (p) => page.evaluate(async (u) => {
  const r = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include' });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, head: t.slice(0, 300) };
}, `${SCHOOLOGY_BASE}${p}`);
const SKIP = new Set(['firstName', 'middleName', 'lastName', 'avatarUrl']);
let n = 0; const mask = new Map(); const m = (u) => { if (!mask.has(u)) mask.set(u, 'S' + String(++n).padStart(2, '0')); return mask.get(u); };
for (const aid of process.argv.slice(2)) {
  for (const list of ['submitted-documents', 'in-progress-documents']) {
    const r = await get(`/iapi2/assignments/${aid}/${list}/`);
    const rows = r.json?.data || [];
    console.log(`\n=== ${aid} ${list} status=${r.status} n=${rows.length} topKeys=${Object.keys(r.json || {}).join(',')}`);
    if (rows[0]) console.log('  keys:', Object.keys(rows[0]).join(','));
    const distinct = {};
    for (const row of rows) for (const [k, v] of Object.entries(row)) {
      if (SKIP.has(k) || k === 'id' || k === 'enrollmentId' || k === 'submissionDate') continue;
      const s = JSON.stringify(v); (distinct[k] ||= new Map()).set(s, (distinct[k].get(s) || 0) + 1);
    }
    for (const [k, mp] of Object.entries(distinct)) console.log(`  ${k}: ${[...mp].map(([v, c]) => `${v.slice(0, 80)}×${c}`).join('  ')}`);
    // any nested objects/arrays → print shape for the first row that has them
    for (const row of rows) for (const [k, v] of Object.entries(row)) {
      if (v && typeof v === 'object') { console.log(`  nested ${k} (${m(String(row.id))}):`, JSON.stringify(v).slice(0, 400)); }
    }
  }
}
await browser.close();
