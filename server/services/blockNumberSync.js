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
 *   3. Store the parsed "Block N" digit; never clobber a manual value with a
 *      non-numbered period (PCG → "Pastoral Care", Interim → "Interim").
 *
 * See .claude/powerschool-api-reference.md "Block number".
 */

// Playwright is imported lazily (see masterySync.js for the rationale — a
// top-level import can hang the server boot on Node 25).
import { existsSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/index.js';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { pickBlockNumber, planBlockUpdate, sectionDcidFromLaunchForm } from '../lib/psBlockNumber.js';

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

// Count courses still awaiting their first block examination — the gate the
// regular sync uses to decide whether to launch the browser at all. Exported so
// the orchestrator can skip the whole phase (zero overhead) in steady state.
export function countCoursesNeedingBlockSync(db) {
  return db.prepare(
    `SELECT COUNT(*) AS c FROM courses
     WHERE archived = 0 AND excluded = 0 AND schoology_section_id IS NOT NULL
       AND block_synced_at IS NULL AND (block_number IS NULL OR block_number = '')`
  ).get().c;
}

/**
 * Sync block_number from PowerSchool.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.onProgress]
 * @param {number[]} [opts.courseIds] — restrict to these course ids.
 * @param {boolean}  [opts.force] — re-examine every current course and overwrite
 *   (the manual "Sync blocks" button). Default false = the cheap auto pass:
 *   only courses never examined AND without a block (block_synced_at IS NULL and
 *   block_number empty), filling without clobbering manual values.
 *
 * Either way, every examined course is stamped block_synced_at so non-numbered
 * periods (PCG/Interim) and one-off failures are not re-fetched by the auto pass.
 * Returns { processed, updated, unchanged, skipped, results:[{ courseId,
 * courseName, blockNumber, blockName?, reason, status }] }.
 * reason: 'ok' | 'not-numbered' | 'no-block' | 'ambiguous' | 'no-section-dcid' | 'section-info-failed'
 */
export async function syncBlockNumbers({ onProgress, courseIds, force = false } = {}) {
  const log = (message) => { console.log(`[blockNumberSync] ${message}`); onProgress?.({ message }); };
  const db = getDb();

  const where = ['archived = 0', 'excluded = 0', 'schoology_section_id IS NOT NULL'];
  const params = [];
  if (!force) where.push("block_synced_at IS NULL AND (block_number IS NULL OR block_number = '')");
  if (courseIds && courseIds.length) {
    where.push(`id IN (${courseIds.map(() => '?').join(',')})`);
    params.push(...courseIds);
  }
  const courses = db.prepare(
    `SELECT id, schoology_section_id, course_name, block_number FROM courses
     WHERE ${where.join(' AND ')} ORDER BY course_name`
  ).all(...params);

  const summary = { processed: 0, updated: 0, unchanged: 0, skipped: 0, results: [] };
  if (courses.length === 0) {
    log('No courses need a block sync.');
    return summary;
  }

  if (!existsSync(STATE_FILE)) {
    throw new Error('No Schoology browser session — run `npm run mastery:login` first.');
  }

  const { browser, context, page } = await openPage();
  // Always stamp an examined course; set block_number only when planned.
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

      const { setBlockNumber, stampSyncedAt } = planBlockUpdate(c, pick, { force });

      if (setBlockNumber !== undefined) {
        const changed = String(c.block_number ?? '') !== setBlockNumber;
        setAndStamp.run(setBlockNumber, now, c.id);
        if (changed) {
          summary.updated++;
          summary.results.push({ courseId: c.id, courseName: c.course_name, blockNumber: setBlockNumber, reason: 'ok', status: 'updated' });
          log(`${c.course_name}: Block ${setBlockNumber} (set, was ${c.block_number || 'empty'})`);
        } else {
          summary.unchanged++;
          summary.results.push({ courseId: c.id, courseName: c.course_name, blockNumber: setBlockNumber, reason: 'ok', status: 'unchanged' });
          log(`${c.course_name}: Block ${setBlockNumber} (unchanged)`);
        }
      } else {
        if (stampSyncedAt) stampOnly.run(now, c.id);
        // 'ok' here means a numbered block resolved but we kept a manual value.
        if (reason === 'ok') {
          summary.unchanged++;
          summary.results.push({ courseId: c.id, courseName: c.course_name, blockNumber: pick.blockNumber, reason: 'ok', status: 'unchanged' });
          log(`${c.course_name}: Block ${pick.blockNumber} — kept manual value ${c.block_number}`);
        } else {
          summary.skipped++;
          summary.results.push({ courseId: c.id, courseName: c.course_name, blockNumber: null, blockName: pick.blockName, reason, status: 'skipped' });
          log(`${c.course_name}: no numbered block (${reason}${pick.blockName ? `: "${pick.blockName}"` : ''}) — marked checked`);
        }
      }
    }

    log(`Done: ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.skipped} skipped (of ${summary.processed}).`);
    return summary;
  } finally {
    await browser.close();
  }
}
