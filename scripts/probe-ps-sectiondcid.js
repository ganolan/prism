/**
 * probe-ps-sectiondcid.js  (spike #106 — sync linchpin)
 *
 * For wiring block_number into sync we must resolve schoology_section_id →
 * PowerSchool sectionDcid dynamically (not the hardcoded doc map). The mapping
 * lives in the LTI launch form's hidden input custom_sectiondcid.
 *
 * This verifies that an authenticated context.request GET of the run URL returns
 * the form HTML (NOT a JS-executed redirect to PS), so we can regex the dcid
 * cheaply — one HTTP GET per section, no full Angular app load.
 *
 * Run from REPO ROOT:  node scripts/probe-ps-sectiondcid.js
 * Read-only.
 */
import { existsSync } from 'fs';
import { join } from 'path';

const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';
const APP_ID = '4980125287';
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');

// A couple of known schoology sections to cross-check against the doc map.
const CHECK = [
  { sgy: '7899896098', expectDcid: '49355', name: 'ACSS' },
  { sgy: '7899907727', expectDcid: '49390', name: 'AIML' },
  { sgy: '280110114', expectDcid: null, name: 'MASTER (template — expect null)' },
];

async function main() {
  if (!existsSync(STATE_FILE)) { console.error('No session. Run: npm run mastery:login'); process.exit(2); }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STATE_FILE });

  try {
    for (const c of CHECK) {
      const runUrl = `${SCHOOLOGY_BASE}/apps/lti/${APP_ID}/run/course/${c.sgy}`;
      const resp = await context.request.get(runUrl, { maxRedirects: 5 });
      const status = resp.status();
      const ct = resp.headers()['content-type'] || '';
      let body = '';
      try { body = await resp.text(); } catch { /* */ }
      const secMatch = body.match(/name="custom_sectiondcid"\s+value="([^"]*)"/i);
      const userMatch = body.match(/name="custom_userdcid"\s+value="([^"]*)"/i);
      const finalUrl = resp.url();
      console.log(`${c.name} (sgy ${c.sgy})`);
      console.log(`  status=${status} ct=${ct.split(';')[0]} finalUrl=${finalUrl.includes('powerschool') ? '→PS' : finalUrl.replace(SCHOOLOGY_BASE, '')}`);
      console.log(`  custom_sectiondcid=${secMatch ? secMatch[1] : '(not found)'}  custom_userdcid=${userMatch ? userMatch[1] : '(not found)'}  expect=${c.expectDcid}`);
      if (!secMatch && !finalUrl.includes('powerschool')) {
        console.log('  bodyHead:', body.replace(/\s+/g, ' ').slice(0, 400));
      }
    }
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
