// Live parity check for #141 (AGENTS.md: a parity probe is the verification of
// choice for API-shape work). Runs the mastery reads both ways on real data and
// diffs the results:
//   "browser" = the pre-#141 transport, kept here verbatim: a headless page on
//               /course/{id}/district_mastery (building_id caught from the page's own
//               requests), each read a fetch inside the page, POST searches with the
//               page's CSRF pair;
//   "http"    = the shipped transport (masterySync.openMasteryReader, plain HTTP).
// Per active course: the building id, the whole course read (readCourseMastery:
// objectives, alignments, observations, material names, rollups), one topic's
// observations (the assignment refresh's GET) and one student's rubric scores
// (getRubricScoresForStudent). Read-only: the POSTs are searches; nothing is written
// to Schoology or to any database.
// Output is masked: ids show their last 3 digits, counts only.
// Usage (repo root): DB_PATH=<abs copy of students.db> node scripts/parity-mastery-reads.js [sectionId ...]
import { existsSync } from 'fs';
import { getDb } from '../server/db/index.js';
import { sessionStateFile } from '../server/lib/sessionPaths.js';
import { openMasteryReader, readCourseMastery, getRubricScoresForStudent } from '../server/services/masterySync.js';

if (!process.env.DB_PATH) { console.error('Set DB_PATH to an absolute path of a copy of students.db'); process.exit(1); }
if (!existsSync(sessionStateFile())) { console.error('No saved session'); process.exit(1); }
const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';
const mask = (id) => `…${String(id).slice(-3)}`;
const db = getDb();
const sections = process.argv.slice(2).length ? process.argv.slice(2)
  : db.prepare('SELECT schoology_section_id AS s FROM courses WHERE archived = 0 AND excluded = 0 ORDER BY id').all().map((r) => r.s);

// ── The pre-#141 browser transport, verbatim from masterySync.js ──
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: sessionStateFile() });
function checkLoggedIn(page) {
  const url = page.url();
  return url.includes('/district_mastery') || url.includes('/course/');
}
async function fetchInternal(page, url) {
  return page.evaluate(async (fetchUrl) => {
    const res = await fetch(fetchUrl, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${fetchUrl}`);
    return res.json();
  }, url);
}
async function postInternal(page, url, body) {
  return page.evaluate(async ({ url, body }) => {
    const csrf = { token: window.Drupal?.settings?.s_common?.csrf_token, key: window.Drupal?.settings?.s_common?.csrf_key };
    if (!csrf.token || !csrf.key) throw new Error('CSRF token/key missing from Drupal.settings.s_common');
    const res = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf.token, 'X-CSRF-Key': csrf.key },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for POST ${url}`);
    return res.json();
  }, { url, body });
}
async function openBrowserReader(sectionId) {
  const page = await context.newPage();
  let buildingId = null;
  page.on('request', (req) => { const m = req.url().match(/building_id=(\d+)/); if (m) buildingId = m[1]; });
  await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`, { waitUntil: 'load', timeout: 30000 });
  if (!checkLoggedIn(page)) throw new Error('browser: not logged in');
  if (!buildingId) {
    await page.waitForFunction(() => window.Drupal?.settings?.s_common?.school_id || window.sSchoolId, { timeout: 10000 }).catch(() => {});
    buildingId = await page.evaluate(() => String(window.Drupal?.settings?.s_common?.school_id || window.sSchoolId || '')) || null;
  }
  return { buildingId, getJson: (url) => fetchInternal(page, url), postJson: (url, body) => postInternal(page, url, body), close: () => page.close() };
}

// Canonical JSON (object keys sorted) so key order never counts as a difference.
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const sortedCanon = (v) => JSON.stringify(JSON.parse(canon(v), (_k, x) => (Array.isArray(x) ? [...x].sort((a, b) => (canon(a) < canon(b) ? -1 : 1)) : x)));
const toPlain = (r) => ({ ...r, allMaterialIds: [...r.allMaterialIds].sort() });
const timed = async (fn) => { const s = Date.now(); try { return [await fn(), Date.now() - s]; } catch (e) { return [{ error: e.message }, Date.now() - s]; } };
const pause = () => new Promise((r) => setTimeout(r, 3000));
const time = { browser: 0, http: 0 };
let mismatches = 0;
let compared = 0;

const compare = (label, b, h) => {
  compared++;
  const exact = canon(b) === canon(h);
  const orderOnly = !exact && sortedCanon(b) === sortedCanon(h);
  if (!exact && !orderOnly) mismatches++;
  return exact ? 'same' : orderOnly ? 'same (array order differs)' : 'DIFFERS';
};

for (const sid of sections) {
  await pause();
  const [bOut, bMs] = await timed(async () => {
    const r = await openBrowserReader(sid);
    try { return { buildingId: r.buildingId, data: toPlain(await readCourseMastery(r, sid)), r }; } finally { /* kept open for the topic read */ }
  });
  await pause();
  const [hOut, hMs] = await timed(async () => {
    const r = await openMasteryReader(sid, { allowInteractiveLogin: false });
    return { buildingId: r.buildingId, data: toPlain(await readCourseMastery(r, sid)), r };
  });
  time.browser += bMs; time.http += hMs;
  if (bOut.error || hOut.error) {
    const same = bOut.error && hOut.error;
    if (!same) mismatches++;
    compared++;
    console.log(`${mask(sid)}: ${same ? 'both failed' : 'DIFFERS'} browser=${bOut.error || 'ok'} http=${hOut.error || 'ok'}`);
    await bOut.r?.close?.();
    continue;
  }
  const d = hOut.data;
  const nObs = Object.values(d.observationsByTopic).reduce((n, l) => n + l.length, 0);
  console.log(`${mask(sid)}: building ${bOut.buildingId === hOut.buildingId ? 'same' : `DIFFERS (${bOut.buildingId} vs ${hOut.buildingId})`}; `
    + `course read ${compare('course', bOut.data, hOut.data)} (${d.categories.length} categories, ${d.allTopics.length} topics, ${d.alignmentRows.length} alignments, `
    + `${nObs} observations, ${Object.keys(d.materialMap).length} materials, ${d.rollupRows.length} rollups); browser ${bMs} ms, http ${hMs} ms`);
  if (bOut.buildingId !== hOut.buildingId) mismatches++;
  if (!bOut.buildingId || !hOut.buildingId) console.log('  (a building id is missing)');

  // One topic's observations (the assignment refresh's per-topic GET) and one student's rubric scores.
  const topic = d.allTopics.find((t) => (d.observationsByTopic[t.id] || []).length);
  if (topic) {
    const url = `${SCHOOLOGY_BASE}/course/${sid}/district_mastery/api/material-observations/search?building_id=${hOut.buildingId}&objective_id=${topic.id}&section_id=${sid}`;
    const [bt, btMs] = await timed(() => bOut.r.getJson(url));
    const [ht, htMs] = await timed(() => hOut.r.getJson(url));
    console.log(`  topic observations: ${compare('topic', bt, ht)} (${(ht.data || []).length} rows); browser ${btMs} ms, http ${htMs} ms (both on an open page/reader)`);
    const obs = d.observationsByTopic[topic.id][0];
    const studentUid = obs.student_uid;
    const assignmentId = obs.gradeable_material?.material_id;
    const rubricUrl = `${SCHOOLOGY_BASE}/course/${sid}/district_mastery/api/observations/search?student_uids=${studentUid}&section_id=${sid}&material_type=ASSIGNMENT&material_id=${assignmentId}`;
    // The old getRubricScoresForStudent: a fresh page on the mastery page, then the fetch.
    const [br, brMs] = await timed(async () => {
      const page = await context.newPage();
      try {
        await page.goto(`${SCHOOLOGY_BASE}/course/${sid}/district_mastery`, { waitUntil: 'domcontentloaded' });
        return (await fetchInternal(page, rubricUrl)).data || [];
      } finally { await page.close(); }
    });
    const [hr, hrMs] = await timed(() => getRubricScoresForStudent({ sectionId: sid, studentUid, assignmentId }));
    console.log(`  one student's rubric scores: ${compare('rubric', br, hr)} (${Array.isArray(hr) ? hr.length : hr.error} rows); browser ${brMs} ms, http ${hrMs} ms`);
  }
  await bOut.r.close();
}

await browser.close();
console.log(`\nCourse reads (open + readCourseMastery), ms: browser ${time.browser}, http ${time.http} (browser launch not counted)`);
console.log(`${sections.length} section(s), ${compared} comparison(s): ${mismatches} mismatch(es)`);
process.exit(mismatches ? 1 : 0);
