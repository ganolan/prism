/**
 * blockNumberSync.js
 *
 * Populate courses.block_number from PowerSchool (issue #106). The block a
 * teacher sees on the attendance page (e.g. ACSS = "Block 3") is the PowerSchool
 * period name, reachable via the same shared-SSO browser session as the mastery
 * sync. It does NOT come from Schoology (whose section_title is the period/cycle
 * expression, e.g. "2(A-B)") and is NOT derivable from periodNumber.
 *
 * Flow (verified 2026-06-08, scripts/probe-ps-block-number.js):
 *   1. Establish the PowerSchool session once via the attendance LTI launch.
 *   2. Per course: resolve Schoology section → PS sectionDcid from the LTI
 *      launch-form HTML (Schoology fetch), then GET /ws/attendance/section_info
 *      (PowerSchool fetch) and read bellScheduleItems[].period.name.
 *   3. Store the parsed "Block N" digit (PowerSchool-authoritative, overwrites);
 *      where no numbered block resolves (PCG → "Pastoral Care", Interim, or a
 *      block not yet assigned at year start) leave the value untouched.
 *
 * This runs for all active courses on every regular sync (opt-out checkbox in
 * the sync dialog), so a course synced before its block was published self-heals
 * on the next sync. Archived courses are never touched. The cost of re-resolving
 * every sync is tracked in the sync-perf measurement issue (lazy/on-demand TBD).
 *
 * See .claude/powerschool-api-reference.md "Block number".
 */

// Playwright is imported lazily (see masterySync.js for the rationale — a
// top-level import can hang the server boot on Node 25).
import { existsSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/index.js';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { pickBlockNumber, sectionDcidFromLaunchForm } from '../lib/psBlockNumber.js';

const PS_HOST = 'powerschool.hkis.edu.hk';
const ATTENDANCE_APP_ID = '4980125287';
const SESSION_DIR = join(process.cwd(), '.playwright-session');
const STATE_FILE = join(SESSION_DIR, 'storage-state.json');

const runUrlFor = (schoologySectionId) =>
  `${SCHOOLOGY_BASE}/apps/lti/${ATTENDANCE_APP_ID}/run/course/${schoologySectionId}`;

async function openPage() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(existsSync(STATE_FILE) ? { storageState: STATE_FILE } : {});
  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Navigate the attendance LTI launch to establish the PowerSchool session. With
 * a live session the run URL redirects straight to the PS app; otherwise it
 * returns the auto-submit form (which does not fire under goto — submit it).
 * Throws a login-recoverable error if the Schoology session has expired.
 */
async function establishPsSession(page, schoologySectionId) {
  await page.goto(runUrlFor(schoologySectionId), { waitUntil: 'load', timeout: 45000 });

  if (!page.url().includes(PS_HOST)) {
    if (!isLoggedInUrl(page.url())) {
      throw new Error('Not logged in to Schoology — run `npm run mastery:login` and retry.');
    }
    const hasForm = await page.evaluate(() => !!document.forms[0]);
    if (!hasForm) {
      throw new Error('Could not reach the PowerSchool attendance app (no launch form). Session may be stale — run `npm run mastery:login`.');
    }
    await Promise.all([
      page.waitForURL((u) => u.toString().includes(PS_HOST), { timeout: 45000 }).catch(() => {}),
      page.evaluate(() => document.forms[0].submit()),
    ]);
  }
  if (!page.url().includes(PS_HOST)) {
    throw new Error('PowerSchool attendance app did not load — run `npm run mastery:login` and retry.');
  }
}

// Resolve Schoology section → PS sectionDcid from the LTI launch-form HTML.
// Uses context.request (carries the Schoology session cookie, no app load).
async function fetchSectionDcid(context, schoologySectionId) {
  const resp = await context.request.get(runUrlFor(schoologySectionId), { maxRedirects: 5 });
  const html = await resp.text();
  return sectionDcidFromLaunchForm(html);
}

// GET /ws/attendance/section_info for a sectionDcid, from the live PS page
// (same-origin fetch). Returns the first section object, or null. The bell-
// schedule config is independent of the queried date range (verified 2026-06-08:
// returned in full even for an off-day weekend), so "today" — what the
// attendance app itself queries — keeps this robust across school years.
async function fetchSectionInfoFirst(page, sectionDcid) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const { status, text } = await page.evaluate(async ({ host, dcid, date }) => {
    const url = `https://${host}/ws/attendance/section_info?sectionDcid=${dcid}&multiSections=false&startDate=${date}&endDate=${date}`;
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    return { status: res.status, text: await res.text() };
  }, { host: PS_HOST, dcid: sectionDcid, date: today });
  if (status !== 200) return { status, first: null };
  try {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return { status, first: arr[0] || null };
  } catch {
    return { status, first: null };
  }
}

/**
 * Resolve block_number from PowerSchool for ALL active courses (archived = 0,
 * excluded = 0, with a Schoology section). PowerSchool-authoritative: a course
 * gets PowerSchool's numbered block ("Block N" → the digit), overwriting any
 * prior value; where PowerSchool resolves no numbered block (PCG → "Pastoral
 * Care", Interim, or a block not assigned yet at the start of the year) the
 * existing value is left untouched. Because it runs every sync, a course synced
 * before its block was published self-heals on the next sync — no manual step.
 *
 * `block_synced_at` is stamped on every examined course as an informational
 * "last resolved" timestamp (it no longer gates anything). Archived courses are
 * never touched.
 *
 * Returns { processed, updated, unchanged, skipped, results:[{ courseId,
 * courseName, blockNumber, blockName?, reason, status }] }.
 * reason: 'ok' | 'not-numbered' | 'no-block' | 'ambiguous' | 'no-section-dcid' | 'section-info-failed'
 */
export async function syncBlockNumbers({ onProgress } = {}) {
  const log = (message) => { console.log(`[blockNumberSync] ${message}`); onProgress?.({ message }); };
  const db = getDb();

  const courses = db.prepare(
    `SELECT id, schoology_section_id, course_name, block_number FROM courses
     WHERE archived = 0 AND excluded = 0 AND schoology_section_id IS NOT NULL
     ORDER BY course_name`
  ).all();

  const summary = { processed: 0, updated: 0, unchanged: 0, skipped: 0, results: [] };
  if (courses.length === 0) {
    log('No active courses to sync blocks for.');
    return summary; // returns before launching a browser
  }

  if (!existsSync(STATE_FILE)) {
    throw new Error('No Schoology browser session — run `npm run mastery:login` first.');
  }

  const { browser, context, page } = await openPage();
  const stampOnly = db.prepare('UPDATE courses SET block_synced_at = ? WHERE id = ?');
  const setAndStamp = db.prepare('UPDATE courses SET block_number = ?, block_synced_at = ? WHERE id = ?');

  try {
    log(`Establishing PowerSchool session (via ${courses[0].course_name})...`);
    await establishPsSession(page, courses[0].schoology_section_id);
    log('PowerSchool session ready.');

    for (const c of courses) {
      summary.processed++;
      const now = new Date().toISOString();

      // Resolve the section's block (or a failure pick) without throwing.
      let pick;
      const sectionDcid = await fetchSectionDcid(context, c.schoology_section_id);
      if (!sectionDcid) {
        pick = { blockNumber: null, blockName: null, reason: 'no-section-dcid' };
      } else {
        const { status, first } = await fetchSectionInfoFirst(page, sectionDcid);
        pick = first
          ? pickBlockNumber(first)
          : { blockNumber: null, blockName: null, reason: `section-info-failed:${status}` };
      }
      const reason = pick.reason.startsWith('section-info-failed') ? 'section-info-failed' : pick.reason;

      if (reason === 'ok') {
        // PowerSchool-authoritative: overwrite with the resolved numbered block.
        const changed = String(c.block_number ?? '') !== pick.blockNumber;
        setAndStamp.run(pick.blockNumber, now, c.id);
        if (changed) {
          summary.updated++;
          summary.results.push({ courseId: c.id, courseName: c.course_name, blockNumber: pick.blockNumber, reason: 'ok', status: 'updated' });
          log(`${c.course_name}: Block ${pick.blockNumber} (set, was ${c.block_number || 'empty'})`);
        } else {
          summary.unchanged++;
          summary.results.push({ courseId: c.id, courseName: c.course_name, blockNumber: pick.blockNumber, reason: 'ok', status: 'unchanged' });
          log(`${c.course_name}: Block ${pick.blockNumber} (unchanged)`);
        }
      } else {
        // No numbered block (PCG/Interim, not-assigned-yet, or a fetch failure):
        // leave the existing value, just record that we looked.
        stampOnly.run(now, c.id);
        summary.skipped++;
        summary.results.push({ courseId: c.id, courseName: c.course_name, blockNumber: null, blockName: pick.blockName, reason, status: 'skipped' });
        log(`${c.course_name}: no numbered block (${reason}${pick.blockName ? `: "${pick.blockName}"` : ''}) — left unchanged`);
      }
    }

    log(`Done: ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.skipped} skipped (of ${summary.processed}).`);
    return summary;
  } finally {
    await browser.close();
  }
}
