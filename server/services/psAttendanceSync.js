/**
 * psAttendanceSync.js
 *
 * Populate courses.block_number from PowerSchool (issue #106). The block a
 * teacher sees on the attendance page (e.g. ACSS = "Block 3") is the PowerSchool
 * period name, read from PowerSchool's attendance app with the saved Schoology
 * session. It does NOT come from Schoology (whose section_title is the period/cycle
 * expression, e.g. "2(A-B)") and is NOT derivable from periodNumber.
 *
 * Plain HTTP, no browser (#141; verified 2026-10-18, scripts/parity-ps-blocks.js):
 *   1. Per course: GET the attendance LTI run URL on Schoology with the saved
 *      session (server/services/powerschoolWeb.js) → the launch form, whose
 *      custom_sectiondcid is the PS sectionDcid (empty = a template course).
 *   2. The first course with a sectionDcid starts the PowerSchool session: its
 *      launch form is posted to PowerSchool, which sets the session cookies.
 *   3. GET /ws/attendance/section_info (Accept: application/json) and read
 *      bellScheduleItems[].period.name; the same answer gives the school
 *      calendar and the class's lesson dates.
 *   4. Store the parsed "Block N" digit (PowerSchool-authoritative, overwrites);
 *      where no numbered block resolves (PCG → "Pastoral Care", Interim, or a
 *      block not yet assigned at year start) leave the value untouched.
 *   5. Grade level (#43, #164): after the loop, on the SAME PowerSchool session,
 *      read each section's student list (psGradeLevelRead.js, with the
 *      section_info already in hand) and store grad_year.
 * A read sent to sign-in (PowerSchool's session ended) relaunches once and asks
 * again; an error status (e.g. a prior-year section) is that section's answer.
 *
 * This runs for all active courses on every regular sync (opt-out checkbox in
 * the sync dialog), so a course synced before its block was published self-heals
 * on the next sync. Archived courses are never touched. The cost of re-resolving
 * every sync is tracked in the sync-perf measurement issue (lazy/on-demand TBD).
 *
 * Timeouts (#126, fixed 2026-08-07): a brand-new school year's not-yet-scheduled
 * sections can cause PowerSchool's section_info/section_attendance to stall
 * instead of erroring. Every request carries PS_FETCH_TIMEOUT_MS
 * (AbortSignal.timeout), and LOOP_TIME_BUDGET_MS bounds the per-course loop as a
 * safety net if every section stalls.
 *
 * See .claude/powerschool-api-reference.md "Block number".
 */
import { getDb } from '../db/index.js';
import { pickBlockNumber, loopTimeBudgetExceeded } from '../lib/psBlockNumber.js';
import { currentSchoolYearEndYear, gradeLevelToGradYear } from '../lib/psGradeLevel.js';
import { readGradeLevels } from './psGradeLevelRead.js';
import { extractCalendarDays, mergeCalendarDays, extractMeetingDates } from '../lib/psCalendar.js';
import { storeSchoolDays, storeClassMeetings } from './schoolCalendar.js';
import { cookieJar } from './schoologyWeb.js';
import { PowerSchoolWeb } from './powerschoolWeb.js';

// Per-request timeout for every Schoology and PowerSchool read here. A stalling
// PowerSchool response (observed: a brand-new school year whose term/bell-schedule
// isn't published yet) fails fast instead of hanging the sync.
const PS_FETCH_TIMEOUT_MS = 20000;

// Wall-clock safety net for the whole per-course loop. Not a normal operating
// constraint (a healthy sync finishes well under this) — only guards the
// pathological case where every remaining course times out, so the sync still
// terminates instead of paying PS_FETCH_TIMEOUT_MS per course indefinitely.
const LOOP_TIME_BUDGET_MS = 3 * 60 * 1000;

const LOGIN_MESSAGE = 'Not logged in to Schoology: run `npm run mastery:login` and retry.';
const NO_APP_MESSAGE = 'PowerSchool attendance app did not load: run `npm run mastery:login` and retry.';

// The PowerSchool reads, over one plain-HTTP session (powerschoolWeb.js). The
// session starts lazily, on the first section that has a sectionDcid, by posting
// the launch form just read for it. A read that finds the session gone relaunches
// once and asks again. Launch failures throw (the whole pass stops, as the
// browser's did); read failures are the caller's per-section answer.
function attendanceReader({ jar, fetchImpl }) {
  const ps = new PowerSchoolWeb({ sgyJar: jar, fetchImpl, timeoutMs: PS_FETCH_TIMEOUT_MS });
  const unposted = new Map(); // schoologySectionId → a launch form read but not posted yet
  // `fatal`: no session can be had, so the whole pass stops.
  const fatal = (message) => Object.assign(new Error(message), { fatal: true });
  const asLaunchError = (err) => (err?.code === 'SESSION_EXPIRED' ? fatal(LOGIN_MESSAGE)
    : err?.code === 'PS_LAUNCH' ? fatal(`${NO_APP_MESSAGE} (${err.message})`)
      : err?.code === 'PS_SECURITY' ? fatal(err.message) : err);
  const launch = async (sectionId) => {
    const form = unposted.get(sectionId) ?? null;
    unposted.clear();
    await ps.launch(sectionId, { form }).catch((err) => { throw asLaunchError(err); });
  };
  const ws = async (sectionId, path, params) => {
    if (!ps.launched) await launch(sectionId);
    const get = () => ps.read(path, params, { method: 'GET', accept: 'application/json' }).catch((err) => { throw asLaunchError(err); });
    try {
      return await get();
    } catch (err) {
      if (!err?.sessionEnded) throw err;
      await launch(sectionId); // the form is not reused: a fresh one is read
      return get();
    }
  };
  return {
    // → { sectionDcid, userDcid }. Throws LOGIN_MESSAGE when Schoology sends the
    // saved session to sign-in (after one renewal through Microsoft).
    async ids(sectionId) {
      const { sectionDcid, userDcid, form } = await ps.launchIds(sectionId).catch((err) => { throw asLaunchError(err); });
      if (sectionDcid && form && !ps.launched) unposted.set(sectionId, form);
      return { sectionDcid, userDcid };
    },
    // section_info for a sectionDcid → { status, first }. Never throws for a read
    // failure: an error status is `status`; a timeout or network failure is
    // "error:<name>" (e.g. "error:TimeoutError"), so the caller's
    // `section-info-failed:${status}` bucket covers it. The bell-schedule config is
    // independent of the queried date range (verified 2026-06-08: returned in full
    // even for an off-day weekend), so "today" (what the attendance app itself
    // queries) keeps this robust across school years.
    async sectionInfo(sectionId, sectionDcid) {
      const today = new Date().toISOString().slice(0, 10);
      let parsed;
      try {
        parsed = await ws(sectionId, '/ws/attendance/section_info', { sectionDcid, multiSections: 'false', startDate: today, endDate: today });
      } catch (err) {
        if (err?.fatal) throw err;
        if (err?.code === 'PS_SESSION') return { status: err.status, first: null };
        return { status: `error:${err?.name || 'unknown'}`, first: null };
      }
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return { status: 200, first: arr[0] || null };
    },
    // The PowerSchool session itself, for the grade-level pass after the loop
    // (psGradeLevelRead.readGradeLevels), so it needs no second launch.
    ps,
  };
}

/**
 * Apply a Map<dcid → gradeLevel> to the students table: set each matched
 * student's grad_year (join: students.school_uid === '1_' + dcid). Stores the
 * INVARIANT grad_year (computed from the current grade), never the raw grade.
 * Students absent from the map are left untouched (never nulled). Returns the
 * number of student rows updated. `now` may be a Date or an ISO string (the rest
 * of the sync layer threads `now` as a pre-serialised ISO string) — both work.
 *
 * Assumes the synced gradeLevel is as-of the CURRENT school year: true for the
 * section student list (#164, today's grade) and for the section_attendance
 * fallback whenever its in-session date range (pickInSessionRange) falls in it.
 * In the rare off-season case where the fallback's only in-session day is in a
 * *future* year past an August boundary, grad_year could be off by one; it
 * self-heals on the next in-session sync, so we don't reconcile the query date
 * against `now` here.
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
 * @param {object}   [opts.db] — defaults to getDb().
 * @param {object}   [opts.deps] — { jar, fetchImpl } for tests and the parity
 *   script: the Schoology cookie jar (null = no saved session) and fetch.
 *
 * `block_synced_at` is stamped on every examined course as an informational
 * "last resolved" timestamp (it no longer gates anything). Excluded/template and
 * section-less courses are never touched.
 *
 * Throws (login-recoverable message) when there is no saved Schoology session,
 * Schoology sends it to sign-in, or PowerSchool will not start a session.
 *
 * Returns { processed, updated, unchanged, skipped, schoolDays, gradeLevels:
 * { seen, updated }, results:[{ courseId, courseName, blockNumber, blockName?,
 * reason, status }], noCourses, stoppedEarly }. noCourses = there was no course
 * to read (nothing was read); stoppedEarly = the time budget stopped the loop
 * (some courses were not read, and the calendar was kept). schoolDays = school-calendar rows stored (0 when the
 * calendar was not replaced: a targeted sync, a loop that stopped early, or
 * none returned); gradeLevels = students whose PowerSchool grade level was
 * seen / changed.
 * reason: 'ok' | 'not-numbered' | 'no-block' | 'ambiguous' | 'no-section-dcid' | 'section-info-failed'
 */
export async function syncPsAttendance({ onProgress, courseIds, db = getDb(), deps = {} } = {}) {
  const log = (message) => { console.log(`[psAttendanceSync] ${message}`); onProgress?.({ message }); };

  // A targeted sync (archived-course import, or any courseIds-restricted
  // re-sync) only visits a subset of sections, so its merged calendar would be
  // a partial — or wrong-year — view of the school year. The stored
  // school_days calendar is only ever replaced by the regular, all-active-
  // courses sync (see the schoolDays block after the loop below).
  const isTargetedSync = Boolean(courseIds && courseIds.length);
  const where = ['excluded = 0', 'schoology_section_id IS NOT NULL'];
  const params = [];
  if (isTargetedSync) {
    where.push(`id IN (${courseIds.map(() => '?').join(',')})`);
    params.push(...courseIds);
  } else {
    where.push('archived = 0'); // regular sync: active courses only
  }
  const courses = db.prepare(
    `SELECT id, schoology_section_id, course_name, block_number FROM courses
     WHERE ${where.join(' AND ')} ORDER BY course_name`
  ).all(...params);

  const summary = { processed: 0, updated: 0, unchanged: 0, skipped: 0, schoolDays: 0, gradeLevels: { seen: 0, updated: 0 }, results: [], noCourses: false, stoppedEarly: false };
  if (courses.length === 0) {
    log('No courses to sync blocks for.');
    summary.noCourses = true;
    return summary; // returns before any request
  }

  const jar = 'jar' in deps ? deps.jar : cookieJar();
  if (!jar) {
    throw new Error('No Schoology browser session: run `npm run mastery:login` first.');
  }
  const reader = attendanceReader({ jar, fetchImpl: deps.fetchImpl ?? fetch });
  const stampOnly = db.prepare('UPDATE courses SET block_synced_at = ? WHERE id = ?');
  const setAndStamp = db.prepare('UPDATE courses SET block_number = ?, block_synced_at = ? WHERE id = ?');

  const gradeSections = []; // sections for the grade-level pass after the loop
  const calendarByDate = new Map(); // date → merged school day (triage calendar)
  const todayIso = new Date().toISOString().slice(0, 10);
  const loopStartedAt = Date.now();
  const loopBudgetMs = deps.loopBudgetMs ?? LOOP_TIME_BUDGET_MS; // tests stop the loop with 0
  let loopCompleted = true; // false if the time-budget break below fires — then calendarByDate is partial
  let started = false;

  for (const c of courses) {
    // Safety net (see LOOP_TIME_BUDGET_MS): if PowerSchool is stalling on
    // every section, stop instead of paying PS_FETCH_TIMEOUT_MS per
    // remaining course — they're picked up on the next sync.
    if (loopTimeBudgetExceeded(loopStartedAt, loopBudgetMs)) {
      log(`Time budget (${loopBudgetMs / 1000}s) exceeded: stopping with ${courses.length - summary.processed} course(s) left for the next sync.`);
      loopCompleted = false;
      summary.stoppedEarly = true;
      break;
    }
    summary.processed++;
    const now = new Date().toISOString();

    // Resolve the section's block (or a failure pick) without throwing, except
    // when the Schoology or PowerSchool session cannot be had at all.
    let pick;
    let ids;
    try {
      ids = await reader.ids(c.schoology_section_id);
    } catch (err) {
      if (err.fatal) throw err;
      ids = { failed: err };
    }
    if (ids.failed) {
      log(`${c.course_name}: launch form not read (${ids.failed.message})`);
      pick = { blockNumber: null, blockName: null, reason: 'section-info-failed:launch-form' };
    } else if (!ids.sectionDcid) {
      pick = { blockNumber: null, blockName: null, reason: 'no-section-dcid' };
    } else {
      const { sectionDcid, userDcid } = ids;
      if (!started) { log(`Starting the PowerSchool session (via ${c.course_name})...`); started = true; }
      const { status, first } = await reader.sectionInfo(c.schoology_section_id, sectionDcid);
      if (first && !isTargetedSync) mergeCalendarDays(calendarByDate, extractCalendarDays(first));
      if (first) {
        const meetings = storeClassMeetings(db, c.id, extractMeetingDates(first), now);
        if (meetings) log(`${c.course_name}: ${meetings} lesson dates`);
      }
      pick = first
        ? pickBlockNumber(first)
        : { blockNumber: null, blockName: null, reason: `section-info-failed:${status}` };

      // Grade level is read after the loop (#164); keep what it needs, including
      // the section_info already in hand.
      gradeSections.push({ name: c.course_name, schoologySectionId: c.schoology_section_id, sectionDcid, userDcid, sectionInfo: first || undefined });
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
      log(`${c.course_name}: no numbered block (${pick.reason}${pick.blockName ? `: "${pick.blockName}"` : ''}), left unchanged`);
    }
  }

  // Only a complete, regular (all-active-courses) sync replaces the stored
  // calendar: a targeted sync (isTargetedSync) only ever sees a subset of
  // sections, and a loop that stopped early (!loopCompleted) only saw a
  // prefix of them — either way calendarByDate is a partial, not the whole
  // school year, so storing it would overwrite a good calendar with one.
  if (isTargetedSync) {
    log('School calendar: skipped (targeted sync).');
  } else if (!loopCompleted) {
    log('School calendar: kept the stored calendar (sync stopped early).');
  } else {
    summary.schoolDays = storeSchoolDays(db, [...calendarByDate.values()]);
    log(summary.schoolDays
      ? `School calendar: ${summary.schoolDays} days stored.`
      : 'School calendar: none returned, kept the stored calendar.');
  }
  // Grade level (#164): each section's student list (students_integration, no
  // date), with section_attendance over a date range as the fallback, on the
  // block loop's PowerSchool session (a session that ended is started again
  // there). Best-effort: a failed section keeps its students' stored grad_year,
  // and no failure here touches the block results above, except a "Security
  // Violation Logged" page, which stops the pass (PS_SECURITY is thrown).
  if (gradeSections.length) {
    const gradeStartedAt = Date.now();
    const { gradeByDcid, sources } = await readGradeLevels({ ps: reader.ps, sections: gradeSections, today: todayIso, log });
    const elapsedMs = Date.now() - gradeStartedAt;
    summary.gradeLevels = { seen: gradeByDcid.size, updated: applyGradeLevels(db, gradeByDcid), sources, elapsedMs };
    log(`Grade levels: ${summary.gradeLevels.updated} students updated (${gradeByDcid.size} seen; sections: ${sources.students_integration} from the student list, ${sources.section_attendance} from section_attendance, ${sources.failed} failed; ${elapsedMs} ms).`);
  }
  log(`Done: ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.skipped} skipped (of ${summary.processed}).`);
  return summary;
}
