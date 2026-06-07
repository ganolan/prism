// One-off spike (#55 sibling): can material-observations/search be batched across
// objective_ids in ONE call, instead of one GET per topic (the ~20-40s/course
// mastery floor)? The sibling alignments/search already batches via objective_ids.
// Tests baseline (per-topic) vs 3 batched variants. Deleted after use.
import 'dotenv/config';
import { chromium } from 'playwright';
import { join } from 'path';
import { existsSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';

const sectionId = process.argv[2] || '7899896098';
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');
if (!existsSync(STATE_FILE)) { console.error('No session'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();

const getJson = (url) => page.evaluate(async (u) => {
  try {
    const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, head: t.slice(0, 120) };
  } catch (e) { return { status: -1, error: String(e) }; }
}, url);

const postJson = (url, body) => page.evaluate(async ({ url, body }) => {
  const csrf = { token: window.Drupal?.settings?.s_common?.csrf_token, key: window.Drupal?.settings?.s_common?.csrf_key };
  try {
    const r = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf.token, 'X-CSRF-Key': csrf.key },
      body: JSON.stringify(body),
    });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, head: t.slice(0, 120) };
  } catch (e) { return { status: -1, error: String(e) }; }
}, { url, body });

// pull the objective id off an observation row, trying common field names
const objOf = (o) => o?.objective_id ?? o?.objective?.id ?? o?.measurement_topic_id ?? o?.objectiveId ?? null;
const rows = (r) => { const d = r?.json?.data ?? r?.json; return Array.isArray(d) ? d : []; };

try {
  // Primary: intercept the page's own requests for building_id=NNN (masterySync's path)
  let buildingId = null;
  page.on('request', (req) => { const m = req.url().match(/building_id=(\d+)/); if (m) buildingId = m[1]; });
  await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`, { waitUntil: 'load', timeout: 30000 });
  if (!isLoggedInUrl(page.url())) throw new Error('SESSION DEAD');
  await page.waitForTimeout(3500); // let the page fire its own mastery API calls
  if (!buildingId) buildingId = await page.evaluate(() => String(window.Drupal?.settings?.s_common?.school_id || window.sSchoolId || '')) || null;
  console.log('section', sectionId, 'building_id', buildingId);
  if (!buildingId) throw new Error('no building_id captured');

  const objs = await getJson(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/aligned-objectives?building_id=${buildingId}&section_id=${sectionId}`);
  const cats = objs.json?.data || objs.json || [];
  const topics = [];
  for (const c of cats) for (const t of (c.child_objectives || c.objectives || c.measurementTopics || c.measurement_topics || c.children || [])) topics.push(t);
  const ids = topics.map(t => String(t.id));
  console.log(`topics: ${ids.length} → ${ids.join(',')}`);
  if (ids.length < 2) { console.log('need ≥2 topics to test batching'); throw new Error('too few topics'); }

  const obsBase = (oid) => `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search?building_id=${buildingId}&section_id=${sectionId}`;

  // ── Baseline: per-topic (the current behaviour) ──
  console.log('\n--- BASELINE per-topic GET (objective_id={one}) ---');
  let baseTotal = 0; const baseByObj = {};
  for (const id of ids) {
    const r = await getJson(`${obsBase()}&objective_id=${id}`);
    const n = rows(r).length; baseTotal += n; baseByObj[id] = n;
    console.log(`  objective_id=${id}: status=${r.status} obs=${n}`);
  }
  console.log(`  BASELINE total observations = ${baseTotal} across ${ids.length} calls`);

  // sample observation shape (to find the objective field)
  const sample = await getJson(`${obsBase()}&objective_id=${ids[0]}`);
  console.log('  observation[0] keys:', rows(sample)[0] ? Object.keys(rows(sample)[0]).join(',') : '(none)');

  const list = ids.join(',');
  const summarize = (label, r) => {
    const rr = rows(r);
    const distinct = new Set(rr.map(objOf).filter(Boolean));
    console.log(`  ${label}: status=${r.status} obs=${rr.length} distinctObjectives=${distinct.size}${r.status !== 200 ? ' head=' + (r.head || r.error) : ''}`);
    return { ok: r.status === 200, count: rr.length, distinct: distinct.size };
  };

  console.log('\n--- BATCHED variants ---');
  const a = summarize('A GET objective_ids={csv}', await getJson(`${obsBase()}&objective_ids=${list}`));
  const b = summarize('B GET objective_id={csv}', await getJson(`${obsBase()}&objective_id=${list}`));
  const c = summarize('C POST {objective_ids:csv}', await postJson(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search`, { building_id: Number(buildingId), section_id: Number(sectionId), objective_ids: list }));

  console.log('\n=== VERDICT ===');
  console.log(`baseline: ${baseTotal} obs / ${ids.length} calls`);
  for (const [name, v] of [['A objective_ids GET', a], ['B objective_id csv GET', b], ['C POST objective_ids', c]]) {
    const wins = v.ok && v.count >= baseTotal * 0.9 && v.distinct >= ids.length - 1;
    console.log(`  ${name}: ${v.ok ? `${v.count} obs spanning ${v.distinct} objectives` : 'FAILED'} → ${wins ? '✅ BATCHES (one call replaces ' + ids.length + ')' : '❌ no'}`);
  }
} catch (e) {
  console.error('PROBE ERROR:', e.message);
} finally {
  await browser.close();
}
