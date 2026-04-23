/**
 * Probe POST /course/{sectionId}/district_mastery/api/alignments/search
 * with and without CSRF to confirm header requirements and multi-id support.
 */
import { chromium } from 'playwright';
import { existsSync } from 'fs';
import { join } from 'path';

const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');

const sectionId = process.argv[2] || '7899896088';
const buildingId = 97989879;

async function main() {
  if (!existsSync(STATE_FILE)) { console.error('No session.'); process.exit(1); }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STATE_FILE });
  const page = await context.newPage();
  await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`, { waitUntil: 'load' });

  const csrf = await page.evaluate(() => ({
    token: window.Drupal?.settings?.s_common?.csrf_token,
    key: window.Drupal?.settings?.s_common?.csrf_key,
  }));

  // Fetch aligned objectives to get a real list of topic UUIDs
  const objData = await page.evaluate(async (url) => {
    const r = await fetch(url, { credentials: 'include' });
    return r.json();
  }, `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/aligned-objectives?building_id=${buildingId}&section_id=${sectionId}`);

  const allTopicIds = [];
  for (const cat of (objData.data || [])) {
    for (const t of (cat.child_objectives || [])) allTopicIds.push(t.id);
  }
  console.log('topic ids:', allTopicIds);

  const url = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/alignments/search`;
  const body = {
    building_id: buildingId,
    section_id: Number(sectionId),
    objective_ids: allTopicIds.join(','),    // try multi-id
    include_gradeable_materials_only: true,
  };
  console.log('BODY', JSON.stringify(body));

  for (const attempt of [
    { name: 'no csrf', headers: {} },
    { name: 'with csrf pair', headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf.token, 'X-CSRF-Key': csrf.key } },
  ]) {
    const res = await page.evaluate(async ({ url, body, headers }) => {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, len: text.length, sample: text.slice(0, 400) };
    }, { url, body, headers: attempt.headers });
    console.log(`[${attempt.name}] status=${res.status} len=${res.len}`);
    console.log('   sample:', res.sample);
  }

  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
