/**
 * probe-ps-block-number.js  (spike #106)
 *
 * Goal: find which PowerSchool field renders the displayed "Block N" at the top
 * of the attendance-code column (teacher-confirmed ACSS = Block 3), so
 * courses.block_number can be populated from PowerSchool during sync.
 *
 * Method (per .claude/api-exploration-playbook.md): DRIVE the real attendance
 * grid for ACSS on an in-session date and CAPTURE its actual XHRs + rendered
 * DOM — do not reconstruct the request. Confirmed datum to validate against:
 *   ACSS → Schoology section 7899896098 → PS sectionDcid 49355 → Block 3.
 *
 * Run from the REPO ROOT (needs the repo's node_modules/playwright):
 *   node scripts/probe-ps-block-number.js
 *
 * Read-only. Never touches /ws/pt/v1/attendance/saveattendance*.
 * PII hygiene: section-level shapes are logged; student names are masked; raw
 * captures go to /tmp and should be deleted when done.
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
const TMP_DUMP = '/tmp/ps-block-capture.json';

function snip(s, n = 1200) {
  if (typeof s !== 'string') s = JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n} chars)` : s;
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

  // ── Capture EVERY PowerSchool response (url + status + body snippet) ───────
  const captures = [];
  context.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!url.includes(PS_HOST)) return;
      const ct = resp.headers()['content-type'] || '';
      const req = resp.request();
      // Only capture data-ish responses (json/text); skip html bundles/assets.
      const interesting =
        ct.includes('json') ||
        url.includes('/ws/') ||
        url.includes('/integrations/attendance') && ct.includes('json');
      let body = null;
      if (interesting) {
        try { body = await resp.text(); } catch { body = '<unreadable>'; }
      }
      captures.push({
        method: req.method(),
        url,
        status: resp.status(),
        ct,
        postData: req.postData() || null,
        body: body ? snip(body, 4000) : null,
      });
    } catch { /* ignore */ }
  });

  try {
    // ── Step 1: LTI launch for ACSS to establish the PS session ─────────────
    console.log('── Step 1: LTI launch (ACSS) ──');
    const runUrl = `${SCHOOLOGY_BASE}/apps/lti/${APP_ID}/run/course/${ACSS_SGY_SECTION}`;
    await page.goto(runUrl, { waitUntil: 'load', timeout: 45000 });

    let afterRun = page.url();
    if (/\/login|\/saml|accounts\.google\.com|login\.microsoftonline\.com/.test(afterRun)) {
      console.error(`Schoology session expired (redirected to ${afterRun}). Run: npm run mastery:login`);
      await browser.close();
      process.exit(3);
    }

    // The run URL may either (a) already be on the PS app (session live, auto
    // redirect through ltigw), or (b) still show the auto-submit form.
    if (!afterRun.includes(PS_HOST)) {
      const formInfo = await page.evaluate(() => {
        const f = document.forms[0];
        if (!f) return { hasForm: false };
        const inputs = {};
        for (const el of f.elements) {
          if (el.name && /dcid|user|section/i.test(el.name)) inputs[el.name] = el.value;
        }
        return { hasForm: true, action: f.action, inputs };
      });
      console.log('Launch form:', JSON.stringify(formInfo, null, 2));
      if (!formInfo.hasForm) {
        console.error('Not on PS host and no launch form found — unexpected. URL:', afterRun);
        await browser.close();
        process.exit(4);
      }
      await Promise.all([
        page.waitForURL((u) => u.toString().includes(PS_HOST), { timeout: 45000 }).catch(() => {}),
        page.evaluate(() => document.forms[0].submit()),
      ]);
      afterRun = page.url();
    } else {
      console.log('Run URL landed directly on PS app (session live).');
    }
    console.log('Landed at:', afterRun);

    // Wait for the Angular attendance grid to actually render. The grid only
    // populates for an in-session date; the app defaults to "today".
    let gridRendered = false;
    try {
      await page.waitForFunction(
        () => /\bBlock\s*\d+\b/i.test(document.body?.innerText || ''),
        { timeout: 25000 }
      );
      gridRendered = true;
    } catch {
      // fall through — capture whatever loaded
    }
    await page.waitForTimeout(3000);
    console.log('Grid rendered (found "Block N" in DOM):', gridRendered);

    // Helpers ----------------------------------------------------------------
    const toArr = (o) => (Array.isArray(o) ? o : Object.values(o || {}));

    // Fetch section_info for a sectionDcid in the live PS session.
    async function fetchSectionInfo(dcid, startDate, endDate) {
      return page.evaluate(async ({ host, dcid, startDate, endDate }) => {
        const url = `https://${host}/ws/attendance/section_info?sectionDcid=${dcid}&multiSections=false&startDate=${startDate}&endDate=${endDate}`;
        const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
        const text = await res.text();
        return { status: res.status, text };
      }, { host: PS_HOST, dcid, startDate, endDate });
    }

    // Deterministically resolve the section's block(s) from section_info[0].
    // The displayed "Block N" = bellScheduleItems[].period.name, filtered to the
    // periodId(s) the section actually meets in (periodIdToPsmPeriodIdMap keys).
    function resolveBlock(si) {
      if (!si) return null;
      const periodIds = new Set(Object.keys(si.periodIdToPsmPeriodIdMap || {}).map(Number));
      const byName = new Map();
      for (const it of toArr(si.bellScheduleItems)) {
        if (periodIds.size && !periodIds.has(it.periodId)) continue;
        const p = it.period || {};
        if (p.name) byName.set(p.name.trim(), {
          abbreviation: (p.abbreviation || '').trim(),
          periodNumber: p.periodNumber,
          periodId: p.id,
        });
      }
      return {
        courseName: si.courseName,
        expression: si.expression,
        periodIds: [...periodIds],
        blocks: [...byName.entries()].map(([name, v]) => ({ name, ...v })),
        meetings: toArr(si.sectionMeetings).map((m) => ({
          periodNumber: m.periodNumber, cycleDayLetter: m.cycleDayLetter, meeting: m.meeting,
        })),
      };
    }

    function parseFirst(text) {
      const v = JSON.parse(text);
      const arr = Array.isArray(v) ? v : [v];
      return arr[0] || {};
    }

    // ── Step 2: ACSS section_info — resolve block, assert "Block 3" ──────────
    console.log('\n── Step 2: ACSS block resolution (sectionDcid 49355) ──');
    const acssRaw = await fetchSectionInfo(ACSS_SECTION_DCID, '2026-06-01', '2026-06-13');
    console.log('section_info status:', acssRaw.status);
    let acssFirst = {};
    let acssResolution = null;
    let inSessionDates = [];
    try {
      acssFirst = parseFirst(acssRaw.text);
      console.log('section_info[0] keys:', Object.keys(acssFirst).join(', '));
      acssResolution = resolveBlock(acssFirst);
      console.log('Resolved:', JSON.stringify(acssResolution, null, 2));
      const cal = acssFirst.calenderDays || acssFirst.calendarDays || {};
      inSessionDates = Object.entries(cal)
        .filter(([, d]) => d && d.inSession)
        .map(([date, d]) => ({ date, letter: d.cycleDay?.letter }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const blockNames = (acssResolution.blocks || []).map((b) => b.name);
      const PASS = blockNames.length === 1 && blockNames[0] === 'Block 3';
      console.log(`\n  ASSERT ACSS === "Block 3": ${PASS ? 'PASS ✅' : 'FAIL ❌ (' + JSON.stringify(blockNames) + ')'}`);
    } catch (e) {
      console.log('ACSS parse error:', e.message, '\nSnippet:', snip(acssRaw.text, 600));
    }

    // ── Step 2b: off-day range — is bellScheduleItems date-independent? ──────
    console.log('\n── Step 2b: ACSS section_info on an OFF-day range (2026-06-27..28, weekend) ──');
    const offRaw = await fetchSectionInfo(ACSS_SECTION_DCID, '2026-06-27', '2026-06-28');
    let offResolution = null;
    try {
      const offFirst = parseFirst(offRaw.text);
      const cal = offFirst.calenderDays || offFirst.calendarDays || {};
      const offInSession = Object.entries(cal).filter(([, d]) => d && d.inSession).length;
      offResolution = resolveBlock(offFirst);
      console.log(`status ${offRaw.status}; in-session days in range: ${offInSession}; bellScheduleItems present: ${toArr(offFirst.bellScheduleItems).length}`);
      console.log('  Resolved on off-day range:', JSON.stringify(offResolution.blocks));
    } catch (e) {
      console.log('off-day parse error:', e.message, '\nSnippet:', snip(offRaw.text, 400));
    }

    // ── Step 3: search the rendered grid DOM for "Block N" ──────────────────
    console.log('\n── Step 3: DOM search for "Block N" (the displayed value) ──');
    const domHits = await page.evaluate(() => {
      const out = [];
      const re = /\bBlock\s*\d+\b/i;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.nodeValue && n.nodeValue.trim();
        if (t && re.test(t)) {
          const el = n.parentElement;
          out.push({ text: t, tag: el?.tagName, cls: el?.className });
        }
      }
      return out.slice(0, 20);
    });
    console.log('DOM "Block N" hits:', JSON.stringify(domHits));

    // ── Step 4: the app's OWN captured calls (cross-check) ──────────────────
    console.log('\n── Step 4: app self-capture cross-check ──');
    const wsCalls = captures.filter((c) => c.url.includes('/ws/'));
    for (const c of wsCalls) {
      const u = c.url.replace(`https://${PS_HOST}`, '').replace(/_=\d+&?/g, '');
      console.log(`  [${c.status}] ${c.method} ${u}`);
    }
    const insertions = wsCalls.find((c) => c.url.includes('/pagecustomizations/insertions') && c.postData);
    if (insertions) {
      try {
        const p = JSON.parse(insertions.postData).parameters?.[0] || {};
        console.log('  insertions params (att_period / Period_ID):', JSON.stringify({ att_period: p.att_period, Period_ID: p.Period_ID, sectionid: p.sectionid }));
      } catch { /* ignore */ }
    }
    const appSectAtt = wsCalls.find((c) => c.url.includes('section_attendance'));
    if (appSectAtt) {
      const m = appSectAtt.url.match(/userDcid=(\d+)/);
      console.log('  app section_attendance userDcid =', m ? m[1] : '(none)');
    }

    // ── Step 5: generalize across ALL documented sections (one session) ─────
    console.log('\n── Step 5: block resolution across all sections ──');
    const SECTIONS = [
      { sgy: '7899896098', dcid: '49355', name: 'Advanced Computer Science Studio' },
      { sgy: '7899907727', dcid: '49390', name: 'AI & Machine Learning' },
      { sgy: '7899896088', dcid: '49354', name: 'AP Computer Science Principles' },
      { sgy: '7899907701', dcid: '49386', name: 'Mobile App Development' },
      { sgy: '7899916157', dcid: '50210', name: 'PCG' },
      { sgy: '7899907720', dcid: '49388', name: 'Robotics' },
      { sgy: '7899866071', dcid: '49027', name: 'Teaching Assistant (Sem)' },
      { sgy: '8141827061', dcid: '51067', name: 'Interim A' },
      { sgy: '8141827060', dcid: '51066', name: 'Interim B' },
    ];
    const allSections = [];
    for (const s of SECTIONS) {
      const raw = await fetchSectionInfo(s.dcid, '2026-02-02', '2026-02-13');
      let resolved = null;
      try { resolved = resolveBlock(parseFirst(raw.text)); } catch { /* parse fail */ }
      const blocks = resolved?.blocks?.map((b) => `${b.name} (${b.abbreviation}, periodNumber=${b.periodNumber})`) || [];
      console.log(`  [${raw.status}] ${s.name} (dcid ${s.dcid}, sgy ${s.sgy}): ${blocks.join(' | ') || '(none)'}  expr=${resolved?.expression ?? '?'}`);
      allSections.push({ ...s, status: raw.status, resolved });
      await page.waitForTimeout(250); // be polite
    }

    // ── Persist raw capture to /tmp for offline inspection ──────────────────
    writeFileSync(TMP_DUMP, JSON.stringify({
      acssResolution, offResolution, allSections, domHits, inSessionDates,
      bellScheduleItemsRaw: toArr(acssFirst.bellScheduleItems),
      wsCalls: wsCalls.map((c) => ({ method: c.method, url: c.url, status: c.status, postData: c.postData, body: c.body })),
    }, null, 2));
    console.log(`\nTotal PS responses captured: ${captures.length}. Raw capture → ${TMP_DUMP}`);

  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
