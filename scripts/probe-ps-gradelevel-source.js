/**
 * probe-ps-gradelevel-source.js  (spike #43 — date-free grade-level source)
 *
 * Question: can we read per-student `gradeLevel` from a PowerSchool endpoint
 * that does NOT require an in-session date? The only CONFIRMED source today is
 * `/ws/attendance/section_attendance`, which needs an in-session date. The
 * api-ref flags two date-free candidates whose RESPONSE SHAPE was never probed:
 *   1. POST /teachers/mba_alerts/queries/getStudentsInSection.json  (alerts plugin; "returns the roster")
 *   2. /ws/pt/v1/student/...                                        (PT v1; referenced, never exercised)
 *
 * Method (per .claude/api-exploration-playbook.md): DRIVE the real ACSS
 * attendance grid and CAPTURE its actual XHRs — do not reconstruct. Then inspect
 * each student-roster response for a grade-level-bearing field. Known anchor:
 *   ACSS → Schoology section 7899896098 → PS sectionDcid 49355.
 *
 * Run from the REPO ROOT (needs the repo's node_modules/playwright):
 *   node scripts/probe-ps-gradelevel-source.js
 *
 * Read-only. Never touches /ws/pt/v1/attendance/saveattendance*.
 * PII hygiene: logs SHAPES (keys/types) and the non-identifying gradeLevel value
 * only; student names/emails/ids are masked. Raw capture → /tmp, delete when done.
 */

import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';
const PS_HOST = 'powerschool.hkis.edu.hk';
const APP_ID = '4980125287';
const ACSS_SGY_SECTION = '7899896098';
const ACSS_SECTION_DCID = '49355';

const SESSION_DIR = join(process.cwd(), '.playwright-session');
const STATE_FILE = join(SESSION_DIR, 'storage-state.json');
const TMP_DUMP = '/tmp/ps-gradelevel-capture.json';

const GRADE_KEY_RE = /grade|level|yeargroup|grad/i;
const PII_KEY_RE = /name|email|first|last|dob|birth|lastfirst|sortable/i;

function snip(s, n = 4000) {
  if (typeof s !== 'string') s = JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n} chars)` : s;
}

// Mask a record for safe logging: PII-ish values → '***', grade-ish values kept,
// everything else kept (ids are short numerics; keep for shape, they're not names).
function maskRecord(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (PII_KEY_RE.test(k)) out[k] = '***';
    else if (v && typeof v === 'object') out[k] = Array.isArray(v) ? `[${v.length}]` : '{…}';
    else out[k] = v;
  }
  return out;
}

// Find arrays of student-like objects anywhere in a parsed JSON body.
function findRecordArrays(node, path = '$', acc = []) {
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length && objs.length === node.length) acc.push({ path, arr: node });
    node.forEach((x, i) => findRecordArrays(x, `${path}[${i}]`, acc));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) findRecordArrays(v, `${path}.${k}`, acc);
  }
  return acc;
}

function analyzeBody(label, url, status, postData, bodyText) {
  console.log(`\n──────── ${label} ────────`);
  console.log('URL    :', url);
  console.log('Status :', status);
  if (postData) console.log('POST body (request shape):', snip(postData, 800));
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch {
    console.log('Body   : <non-JSON>', snip(bodyText, 300));
    return { hasGrade: false };
  }
  console.log('Top-level keys:', Array.isArray(parsed) ? `[array len ${parsed.length}]` : Object.keys(parsed).join(', '));

  const arrays = findRecordArrays(parsed);
  let hasGrade = false;
  for (const { path, arr } of arrays) {
    if (!arr.length) { console.log(`  ${path}: empty array`); continue; }
    const keyUnion = new Set();
    arr.forEach((r) => r && typeof r === 'object' && Object.keys(r).forEach((k) => keyUnion.add(k)));
    const keys = [...keyUnion];
    const gradeKeys = keys.filter((k) => GRADE_KEY_RE.test(k));
    console.log(`  ${path}: ${arr.length} records`);
    console.log(`     keys: ${keys.join(', ')}`);
    if (gradeKeys.length) {
      hasGrade = true;
      console.log(`     ★ GRADE-ish keys: ${gradeKeys.join(', ')}`);
      // Show the grade values across the roster (non-PII) to confirm they're 9–12.
      const vals = arr.map((r) => gradeKeys.map((k) => r[k]));
      console.log(`     grade values (first 8): ${JSON.stringify(vals.slice(0, 8))}`);
    }
    console.log(`     sample (masked): ${JSON.stringify(maskRecord(arr[0]))}`);
  }
  if (!arrays.length) console.log('  (no student-like record arrays found)');
  return { hasGrade };
}

async function main() {
  if (!existsSync(STATE_FILE)) {
    console.error(`No session file at ${STATE_FILE}. Run: npm run mastery:login`);
    process.exit(2);
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STATE_FILE });
  const page = await context.newPage();

  // Capture EVERY PowerSchool response (url + status + req/resp bodies).
  const captures = [];
  context.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!url.includes(PS_HOST)) return;
      const ct = resp.headers()['content-type'] || '';
      const req = resp.request();
      const interesting = ct.includes('json') || url.includes('/ws/') || url.includes('/queries/');
      let body = null;
      if (interesting) { try { body = await resp.text(); } catch { body = '<unreadable>'; } }
      captures.push({
        method: req.method(), url, status: resp.status(), ct,
        postData: req.postData() || null,
        body: body || null,
      });
    } catch { /* ignore */ }
  });

  try {
    console.log('── Step 1: LTI launch (ACSS) to establish PowerSchool session ──');
    const runUrl = `${SCHOOLOGY_BASE}/apps/lti/${APP_ID}/run/course/${ACSS_SGY_SECTION}`;
    await page.goto(runUrl, { waitUntil: 'load', timeout: 45000 });
    let afterRun = page.url();
    if (/\/login|\/saml|accounts\.google\.com|login\.microsoftonline\.com/.test(afterRun)) {
      console.error(`Schoology session expired (redirected to ${afterRun}). Run: npm run mastery:login`);
      await browser.close();
      process.exit(3);
    }
    if (!afterRun.includes(PS_HOST)) {
      const hasForm = await page.evaluate(() => !!document.forms[0]);
      if (!hasForm) {
        console.error('Not on PS host and no launch form found. URL:', afterRun);
        await browser.close();
        process.exit(4);
      }
      await Promise.all([
        page.waitForURL((u) => u.toString().includes(PS_HOST), { timeout: 45000 }).catch(() => {}),
        page.evaluate(() => document.forms[0].submit()),
      ]);
      afterRun = page.url();
    }
    console.log('Landed at:', afterRun);

    // Let the Angular grid + plugin XHRs fire (grade_levels, getStudentsInSection, etc.)
    let gridRendered = false;
    try {
      await page.waitForFunction(
        () => /\bBlock\s*\d+\b/i.test(document.body?.innerText || ''),
        { timeout: 25000 }
      );
      gridRendered = true;
    } catch { /* off-session date — grid may not paint; plugin XHRs may still fire */ }
    await page.waitForTimeout(4000);
    console.log('Grid rendered ("Block N" in DOM):', gridRendered);

    // ── Step 2: list every PS XHR we saw, flag the candidates ────────────────
    console.log('\n── Step 2: captured PowerSchool XHRs ──');
    for (const c of captures) {
      console.log(`  [${c.status}] ${c.method} ${c.url.replace(`https://${PS_HOST}`, '')}`);
    }

    const find = (re) => captures.filter((c) => re.test(c.url));
    const gsis = find(/getStudentsInSection/i);
    const ptStudent = find(/\/ws\/pt\/v1\/student/i);
    const sectAtt = find(/\/ws\/attendance\/section_attendance/i);

    // ── Step 3: analyze the date-free candidate(s) for a grade-level field ───
    console.log('\n── Step 3: does a DATE-FREE source carry grade level? ──');
    let dateFreeHasGrade = false;

    if (gsis.length) {
      for (const c of gsis) {
        const r = analyzeBody('getStudentsInSection.json (date-free candidate)', c.url, c.status, c.postData, c.body || '');
        dateFreeHasGrade = dateFreeHasGrade || r.hasGrade;
      }
    } else {
      console.log('\ngetStudentsInSection.json did NOT fire on this load.');
    }

    if (ptStudent.length) {
      for (const c of ptStudent) {
        const r = analyzeBody('/ws/pt/v1/student (date-free candidate)', c.url, c.status, c.postData, c.body || '');
        dateFreeHasGrade = dateFreeHasGrade || r.hasGrade;
      }
    } else {
      console.log('\n/ws/pt/v1/student did NOT fire on this load (would need a separate probe to exercise).');
    }

    // For contrast: confirm the known-good section_attendance carries gradeLevel.
    if (sectAtt.length) {
      console.log('\n── (contrast) section_attendance — the CONFIRMED gradeLevel source ──');
      for (const c of sectAtt) analyzeBody('section_attendance', c.url, c.status, c.postData, c.body || '');
    } else {
      console.log('\n(section_attendance did not fire on this load — likely an off-session default date.)');
    }

    console.log('\n════════ VERDICT ════════');
    console.log(`Date-free source carries grade level: ${dateFreeHasGrade ? 'YES ✅' : 'NO / inconclusive ❌'}`);
    if (!dateFreeHasGrade) {
      console.log('→ Fall back to section_attendance (+ in-session date from section_info calendar).');
      console.log('→ File an issue to finish probing the date-free candidates per the agreed exit.');
    }

    // Raw dump for manual inspection (contains PII → /tmp, delete when done).
    writeFileSync(TMP_DUMP, JSON.stringify(captures, null, 2));
    console.log(`\nRaw capture (PII) → ${TMP_DUMP} (delete when done)`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error('Probe failed:', e); process.exit(1); });
