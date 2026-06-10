/**
 * psAttendanceSync.js
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
import { currentSchoolYearEndYear, gradeLevelToGradYear, pickInSessionDate, extractGradeLevels, userDcidFromLaunchForm } from '../lib/psGradeLevel.js';

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

// Resolve Schoology section → PS sectionDcid + teacher userDcid from the LTI
// launch-form HTML. Uses context.request (carries the Schoology session cookie,
// no app load). The userDcid feeds the section_attendance (grade-level) read.
async function fetchLaunchIds(context, schoologySectionId) {
  const resp = await context.request.get(runUrlFor(schoologySectionId), { maxRedirects: 5 });
  const html = await resp.text();
  return {
    sectionDcid: sectionDcidFromLaunchForm(html),
    userDcid: userDcidFromLaunchForm(html),
  };
}

// GET /ws/attendance/section_attendance for an in-session date, from the live PS
// page (same-origin fetch). includeStudentAlerts=false keeps the PII surface
// minimal (we only need the roster + gradeLevel). Returns parsed JSON or null.
async function fetchSectionAttendance(page, sectionDcid, userDcid, date) {
  const { status, text } = await page.evaluate(async ({ host, dcid, uid, d }) => {
    const url = `https://${host}/ws/attendance/section_attendance`
      + `?sectionDcid=${dcid}&userDcid=${uid}&startDate=${d}&endDate=${d}`
      + `&includeStudentAlerts=false&multiSections=false&sortByFirstName=false`;
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    return { status: res.status, text: await res.text() };
  }, { host: PS_HOST, dcid: sectionDcid, uid: userDcid, d: date });
  if (status !== 200) return null;
  try { return JSON.parse(text); } catch { return null; }
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
 * Apply a Map<dcid → gradeLevel> to the students table: set each matched
 * student's grad_year (join: students.school_uid === '1_' + dcid). Stores the
 * INVARIANT grad_year (computed from the current grade), never the raw grade.
 * Students absent from the map are left untouched (never nulled). Returns the
 * number of student rows updated. `now` may be a Date or an ISO string (the rest
 * of the sync layer threads `now` as a pre-serialised ISO string) — both work.
 */
export function applyGradeLevels(db, gradeByDcid, now = new Date()) {
  const nowDate = typeof now === 'string' ? new Date(now) : now;
  const yearEnd = currentSchoolYearEndYear(nowDate);
  const ts = nowDate.toISOString();
  const update = db.prepare('UPDATE students SET grad_year = ?, updated_at = ? WHERE school_uid = ?');
  let updated = 0;
  const tx = db.transaction((entries) => {
    for (const [dcid, gradeLevel] of entries) {
      const gradYear = gradeLevelToGradYear(gradeLevel, yearEnd);
      if (gradYear == null) continue;
      updated += update.run(gradYear, ts, `1_${dcid}`).changes;
    }
  });
  tx([...gradeByDcid.entries()]);
  return updated;
}

/**
 * Resolve block_number from PowerSchool. PowerSchool-authoritative: a course
 * gets PowerSchool's numbered block ("Block N" → the digit), overwriting any
 * prior value; where PowerSchool resolves no numbered block (PCG → "Pastoral
 * Care", Interim, or a block not assigned yet at the start of the year) the
 * existing value is left untouched.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.onProgress]
 * @param {number[]} [opts.courseIds] — restrict to these course ids (any archive
 *   state). Used by the archived-course import to resolve one course's block.
 *   When omitted, resolves all ACTIVE courses (the regular sync's block pass,
 *   which runs every sync so a course synced before its block was published
 *   self-heals). Archived courses get their block only via courseIds (at import).
 *
 * `block_synced_at` is stamped on every examined course as an informational
 * "last resolved" timestamp (it no longer gates anything). Excluded/template and
 * section-less courses are never touched.
 *
 * Returns { processed, updated, unchanged, skipped, results:[{ courseId,
 * courseName, blockNumber, blockName?, reason, status }] }.
 * reason: 'ok' | 'not-numbered' | 'no-block' | 'ambiguous' | 'no-section-dcid' | 'section-info-failed'
 */
export async function syncPsAttendance({ onProgress, courseIds } = {}) {
  const log = (message) => { console.log(`[psAttendanceSync] ${message}`); onProgress?.({ message }); };
  const db = getDb();

  const where = ['excluded = 0', 'schoology_section_id IS NOT NULL'];
  const params = [];
  if (courseIds && courseIds.length) {
    where.push(`id IN (${courseIds.map(() => '?').join(',')})`);
    params.push(...courseIds);
  } else {
    where.push('archived = 0'); // regular sync: active courses only
  }
  const courses = db.prepare(
    `SELECT id, schoology_section_id, course_name, block_number FROM courses
     WHERE ${where.join(' AND ')} ORDER BY course_name`
  ).all(...params);

  const summary = { processed: 0, updated: 0, unchanged: 0, skipped: 0, gradeLevels: { seen: 0, updated: 0 }, results: [] };
  if (courses.length === 0) {
    log('No courses to sync blocks for.');
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

    const gradeByDcid = new Map(); // dcid → gradeLevel, accumulated across all sections
    const todayIso = new Date().toISOString().slice(0, 10);

    for (const c of courses) {
      summary.processed++;
      const now = new Date().toISOString();

      // Resolve the section's block (or a failure pick) without throwing.
      let pick;
      const { sectionDcid, userDcid } = await fetchLaunchIds(context, c.schoology_section_id);
      if (!sectionDcid) {
        pick = { blockNumber: null, blockName: null, reason: 'no-section-dcid' };
      } else {
        const { status, first } = await fetchSectionInfoFirst(page, sectionDcid);
        pick = first
          ? pickBlockNumber(first)
          : { blockNumber: null, blockName: null, reason: `section-info-failed:${status}` };

        // Grade level: pick an in-session day from the SAME section_info calendar
        // and read the roster's per-student gradeLevel. Best-effort — a failure
        // here never affects block resolution.
        if (first && userDcid) {
          const date = pickInSessionDate(first, todayIso);
          if (date) {
            const sa = await fetchSectionAttendance(page, sectionDcid, userDcid, date);
            for (const { dcid, gradeLevel } of extractGradeLevels(sa || {})) {
              gradeByDcid.set(dcid, gradeLevel);
            }
          }
        }
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

    summary.gradeLevels.seen = gradeByDcid.size;
    summary.gradeLevels.updated = applyGradeLevels(db, gradeByDcid);
    log(`Grade levels: ${summary.gradeLevels.updated} students updated (${gradeByDcid.size} seen).`);
    log(`Done: ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.skipped} skipped (of ${summary.processed}).`);
    return summary;
  } finally {
    await browser.close();
  }
}
