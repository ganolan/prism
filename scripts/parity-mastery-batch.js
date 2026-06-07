// scripts/parity-mastery-batch.js
// Live parity (#104): per-topic GET material-observations/search vs the batched
// POST must yield the identical set of (student_uid, material_id, objective_id,
// points) observations. Usage: node scripts/parity-mastery-batch.js [sectionId]
import 'dotenv/config';
import { chromium } from 'playwright';
import { join } from 'path';
import { existsSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';
import { groupObservationsByTopic, normalizeObservation } from '../server/lib/masteryObservations.js';

const sectionId = process.argv[2] || '7899896098'; // ACSS
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');
if (!existsSync(STATE_FILE)) { console.error('No session — run npm run mastery:login'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();

const getJson = (u) => page.evaluate(async (url) => { const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { return null; } }, u);
const postJson = (url, body) => page.evaluate(async ({ url, body }) => { const c = { token: window.Drupal?.settings?.s_common?.csrf_token, key: window.Drupal?.settings?.s_common?.csrf_key }; const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': c.token, 'X-CSRF-Key': c.key }, body: JSON.stringify(body) }); const t = await r.text(); try { return JSON.parse(t); } catch { return null; } }, { url, body });
// Compare on the NORMALIZED shape (what the sync actually persists): GET and POST
// differ in material-id nesting and points representation (number vs string vs
// null-vs-undefined for "no score"). normalizeObservation collapses both to the
// same canonical form, so any remaining diff is a real data difference.
const key = (raw, oid) => {
  const o = normalizeObservation(raw);
  const pts = o.points == null ? 'none' : o.points;
  return `${o.student_uid}|${o.gradeable_material?.material_id}|${oid}|${pts}`;
};

try {
  let buildingId = null;
  page.on('request', (req) => { const m = req.url().match(/building_id=(\d+)/); if (m) buildingId = m[1]; });
  await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`, { waitUntil: 'load', timeout: 30000 });
  if (!isLoggedInUrl(page.url())) throw new Error('SESSION DEAD — run npm run mastery:login');
  await page.waitForTimeout(3500);
  if (!buildingId) throw new Error('no building_id captured');

  const objs = await getJson(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/aligned-objectives?building_id=${buildingId}&section_id=${sectionId}`);
  const cats = objs?.data || objs || [];
  const topicIds = [];
  for (const c of cats) for (const t of (c.child_objectives || c.objectives || c.measurementTopics || c.measurement_topics || c.children || [])) topicIds.push(String(t.id));

  // OLD: per-topic GET
  const oldSet = new Set();
  for (const id of topicIds) {
    const r = await getJson(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search?building_id=${buildingId}&objective_id=${id}&section_id=${sectionId}`);
    for (const o of (r?.data || [])) oldSet.add(key(o, id));
  }

  // NEW: batched POST → regroup
  const resp = await postJson(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search`, { building_id: Number(buildingId), section_id: Number(sectionId), objective_ids: topicIds.join(',') });
  const grouped = groupObservationsByTopic(resp?.data || [], topicIds);
  const newSet = new Set();
  for (const id of topicIds) for (const o of (grouped[id] || [])) newSet.add(key(o, id));

  const onlyOld = [...oldSet].filter(k => !newSet.has(k));
  const onlyNew = [...newSet].filter(k => !oldSet.has(k));
  console.log(`\n=== PARITY #104 (section ${sectionId}) ===`);
  console.log(`topics: ${topicIds.length} | per-topic observations: ${oldSet.size} | batched: ${newSet.size}`);
  console.log(`only-in-per-topic: ${onlyOld.length} | only-in-batched: ${onlyNew.length}`);
  if (onlyOld.length) console.log('  e.g. missing from batch:', onlyOld.slice(0, 3));
  if (onlyNew.length) console.log('  e.g. extra in batch:', onlyNew.slice(0, 3));
  const ok = onlyOld.length === 0 && onlyNew.length === 0;
  console.log(ok ? '✅ PARITY OK' : '❌ PARITY FAILED');
  await browser.close();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('PROBE ERROR:', e.message);
  await browser.close();
  process.exit(1);
}
