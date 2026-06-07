// One-off spike (#62): can Prism read Not-Started / In-Progress / Submitted for
// lti_submission (OneDrive/GDrive) work — the states a teacher sees as tabs in
// the Schoology grader UI?
//
// Cross-tabulates THREE surfaces per student for one assignment:
//   1. internal grader_header_data  (browser session)  — the `submission` key
//   2. internal grader_grade_data   (browser session)  — UNCHARACTERIZED sibling
//   3. public  /submissions/{aid}/{uid} (OAuth)         — revision[] / draft=1
//
// PII hygiene: uids are masked to S01,S02… ; we print KEY SHAPES + state enums,
// never names/content.
//
// Usage: node scripts/probe-lti-submission-states.js <sectionId> <assignmentId>
import 'dotenv/config';
import { chromium } from 'playwright';
import { join } from 'path';
import { existsSync } from 'fs';
import { apiGet } from '../server/services/schoology.js';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';

const sectionId = process.argv[2] || '7899907720';
const assignmentId = process.argv[3] || '8348763571';
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(STATE_FILE)) { console.error('No saved session — run npm run mastery:login'); process.exit(1); }

// stable uid -> S## mask
const mask = (() => { const m = new Map(); return (uid) => { if (!m.has(uid)) m.set(uid, 'S' + String(m.size + 1).padStart(2, '0')); return m.get(uid); }; })();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();

async function getJson(url) {
  await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!isLoggedInUrl(page.url())) throw new Error('SESSION DEAD — re-run mastery:login');
  return page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, len: text.length, json, head: text.slice(0, 200) };
  }, url);
}

try {
  console.log(`\n=== TARGET: section ${sectionId}, assignment ${assignmentId} ===\n`);

  // --- Surface 1: grader_header_data ---------------------------------------
  const ghd = await getJson(`${SCHOOLOGY_BASE}/iapi/grades/grader_header_data/${sectionId}`);
  console.log(`[1] grader_header_data  status=${ghd.status} len=${ghd.len}`);
  const gb = ghd.json?.body ?? ghd.json ?? {};
  const item = gb.grade_item_data?.[assignmentId];
  console.log('    grade_item_data[assignment] keys:', item ? Object.keys(item).join(',') : '(missing)');
  if (item) console.log('    grade_item flags:', JSON.stringify({ is_lti_assignment: item.is_lti_assignment, option_dropbox: item.option_dropbox, has_assessment: item.has_assessment, status: item.status }));

  // every distinct key seen across ALL cells in the section (spot rare markers)
  const keyTally = {};
  const cellStates = []; // for our target assignment
  const grades = gb.grades || {};
  for (const uid of Object.keys(grades)) {
    const byItem = grades[uid] || {};
    for (const aid of Object.keys(byItem)) {
      const c = byItem[aid] || {};
      for (const k of Object.keys(c)) keyTally[k] = (keyTally[k] || 0) + 1;
      if (aid === assignmentId) {
        cellStates.push({ s: mask(uid), keys: Object.keys(c), submission: c.submission ?? null, grade: c.grade ?? null, exception: c.exception ?? null, not_assigned: c.not_assigned ?? null, raw: c });
      }
    }
  }
  console.log('    ALL-CELL key frequency (section-wide):', JSON.stringify(keyTally));
  console.log(`    target-assignment cells (n=${cellStates.length}); full raw shape per student:`);
  for (const c of cellStates) console.log(`      ${c.s}: ${JSON.stringify(c.raw)}`);

  // --- Surface 2: grader_grade_data (uncharacterized) ----------------------
  const ggd = await getJson(`${SCHOOLOGY_BASE}/iapi/grades/grader_grade_data/${sectionId}`);
  console.log(`\n[2] grader_grade_data  status=${ggd.status} len=${ggd.len}`);
  if (ggd.json) {
    const body2 = ggd.json?.body ?? ggd.json;
    console.log('    top-level keys:', Object.keys(body2).join(','));
    // hunt for the assignment id / a per-cell submission-status structure
    const probe = JSON.stringify(body2);
    console.log('    mentions assignmentId?', probe.includes(assignmentId));
    for (const k of Object.keys(body2)) {
      const v = body2[k];
      if (v && typeof v === 'object') {
        const sample = Array.isArray(v) ? v[0] : v[Object.keys(v)[0]];
        console.log(`    ${k}: ${Array.isArray(v) ? 'array['+v.length+']' : 'obj['+Object.keys(v).length+']'} sampleKeys=${sample && typeof sample==='object' ? Object.keys(sample).slice(0,12).join(',') : typeof sample}`);
      }
    }
  } else {
    console.log('    not JSON. head:', ggd.head);
  }

  // --- Surface 3: public revisions per student -----------------------------
  console.log(`\n[3] public /submissions/${assignmentId}/{uid} per student (draft = In Progress?):`);
  for (const c of cellStates) {
    // recover real uid from mask map
    let realUid = null; for (const uid of Object.keys(grades)) if (mask(uid) === c.s) { realUid = uid; break; }
    try {
      const d = await apiGet(`/sections/${sectionId}/submissions/${assignmentId}/${realUid}`);
      const revs = d?.revision || [];
      const drafts = revs.filter((r) => Number(r.draft) === 1).length;
      const nondraft = revs.filter((r) => Number(r.draft) !== 1).length;
      console.log(`      ${c.s}: ghd_submission=${c.submission ?? '—'} graded=${c.grade!=null} | revisions=${revs.length} draft=${drafts} nondraft=${nondraft}`);
    } catch (e) {
      console.log(`      ${c.s}: ghd_submission=${c.submission ?? '—'} | public_err=${e.message}`);
    }
    await sleep(250); // rate-limit courtesy
  }

  console.log('\n=== done ===');
} catch (e) {
  console.error('PROBE ERROR:', e.message);
} finally {
  await browser.close();
}
