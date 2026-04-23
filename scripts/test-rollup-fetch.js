/**
 * Probe POST /course/{sectionId}/district_mastery/api/outcomes/objectives
 * using the existing saved Playwright session. Logs csrf-token candidates
 * from the DOM then retries the POST with them.
 */
import { chromium } from 'playwright';
import { existsSync } from 'fs';
import { join } from 'path';

const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');

const sectionId = process.argv[2] || '7899896088';
const buildingId = 97989879;
const objectiveIds = [
  '5a952c1f-b628-4701-9eda-d05c31fb0de7',
  'eb0d8a8d-7d63-4b0e-97d4-020d3e376864',
  'c3a3c687-4593-4614-a6db-20dc94f2d3e8',
];
const studentUids = ['23814283'];

async function main() {
  if (!existsSync(STATE_FILE)) { console.error('No session. Run npm run mastery:login'); process.exit(1); }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STATE_FILE });
  const page = await context.newPage();
  await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`, { waitUntil: 'load' });

  // Dump csrf-token candidates
  const tokens = await page.evaluate(() => {
    const out = {};
    try { out.meta_csrf = document.querySelector('meta[name="csrf-token"]')?.content; } catch {}
    try { out.drupal_csrf = window.Drupal?.settings?.s_common?.csrf_token || window.Drupal?.settings?.s_common?.csrfToken || null; } catch {}
    try { out.drupal_csrf_key = window.Drupal?.settings?.s_common?.csrf_key || null; } catch {}
    try { out.drupal_logout = window.Drupal?.settings?.s_common?.logout_token || null; } catch {}
    try {
      const keys = Object.keys(window.Drupal?.settings || {});
      out.drupal_setting_keys = keys;
      out.s_common_keys = Object.keys(window.Drupal?.settings?.s_common || {});
    } catch {}
    try { out.cookies = document.cookie; } catch {}
    try { out.sCSRF = window.sCSRF || window.sCsrfToken || null; } catch {}
    return out;
  });
  console.log('TOKEN SNIFF', JSON.stringify(tokens, null, 2));

  const url = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/outcomes/objectives`;
  const body = {
    building_id: buildingId,
    section_id: Number(sectionId),
    student_uids: studentUids.join(','),
    ids: objectiveIds.join(','),
  };

  // Try several header variants
  const attempts = [
    { name: 'no extra headers', extra: {} },
    { name: 'X-Requested-With', extra: { 'X-Requested-With': 'XMLHttpRequest' } },
    { name: 'X-CSRF-Token from meta', extra: tokens.meta_csrf ? { 'X-CSRF-Token': tokens.meta_csrf } : null },
    { name: 'X-CSRF-Token from Drupal', extra: tokens.drupal_csrf ? { 'X-CSRF-Token': tokens.drupal_csrf } : null },
    { name: 'X-Requested-With + meta token', extra: tokens.meta_csrf ? { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': tokens.meta_csrf } : null },
    { name: 'X-CSRF-Token from Drupal s_common (X-CSRF-Token)', extra: tokens.drupal_csrf ? { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': tokens.drupal_csrf } : null },
    { name: 'X-Csrf-Token (lowercase variant)', extra: tokens.drupal_csrf ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Csrf-Token': tokens.drupal_csrf } : null },
    { name: 'X-CSRF-Token + X-CSRF-Key', extra: tokens.drupal_csrf ? { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': tokens.drupal_csrf, 'X-CSRF-Key': tokens.drupal_csrf_key } : null },
  ].filter(a => a.extra !== null);

  for (const attempt of attempts) {
    const result = await page.evaluate(async ({ url, body, extra }) => {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...extra },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, snippet: text.slice(0, 300) };
    }, { url, body, extra: attempt.extra });
    console.log(`ATTEMPT [${attempt.name}] → ${result.status}  ${result.snippet}`);
  }

  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
