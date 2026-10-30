import { getDb } from '../db/index.js';
import { fullSync } from './sync.js';
import { syncMasteryForCourse } from './masterySync.js';
import { refreshRecentQuizzes } from './quizRefresh.js';
import { refreshRecentComments } from './submissionComments.js';
import { getFeatures } from '../middleware/featureGate.js';
import { syncPsAttendance } from './psAttendanceSync.js';
import { syncPsAlerts } from './psAlertsSync.js';
import { captureFeedbackSnapshots } from './feedbackSnapshots.js';
import { settleResubmissions } from './resubmissions.js';
import { recordNightlyDataRead } from './nightlyData.js';

// Classify a mastery sync failure: 'login' means the Schoology browser session
// is missing/expired (recoverable by re-login); 'other' is anything else.
export function classifyMasteryError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('not logged in') || msg.includes('log in') || msg.includes('mastery:login')) {
    return 'login';
  }
  return 'other';
}

// The current courses: not archived, not excluded (template sections), hidden ones only when included.
// What a `kind: 'all'` request reads (syncQueue's coveredCourseIds) and, with `masteryCourseIds: null`,
// the courses whose mastery a run reads.
export function currentCourseIds(db, { includeHidden = false } = {}) {
  return db.prepare(`
    SELECT id FROM courses WHERE COALESCE(archived, 0) = 0 AND COALESCE(excluded, 0) = 0
      AND (COALESCE(hidden, 0) = 0 OR ?) ORDER BY id`).all(includeHidden ? 1 : 0).map((r) => r.id);
}

// The ids whose first read finished (first_sync NULL): not 'pending' or 'failed' (#171).
function withFirstReadDone(db, ids) {
  if (!ids.length) return ids;
  const done = new Set(db.prepare(`SELECT id FROM courses WHERE first_sync IS NULL
    AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)).map((r) => r.id));
  return ids.filter((id) => done.has(id));
}

// Run the unified sync: the Schoology public-API pull, then a mastery pull
// (plain HTTP with the saved session, #141) for each requested course. Every step reports through onEvent.
// Event shapes:
//   { phase:'schoology', status:'running'|'done'|'error', records?, message? }
//   { phase:'mastery', courseId, courseName, status, records?, errorKind?, message? }
//   { type:'log', message }
//   { type:'summary', schoology, blocks, mastery, quizzes, phaseMs, elapsedMs, fatal? }
// Every finished phase event (done or error) carries its own elapsedMs, and the
// summary's phaseMs holds { schoology, blocks, alerts, mastery, comments, quizzes } wall time
// (null = the phase did not run; mastery = the sum over its courses). The same
// times are stored on a sync_metrics row (#143, for the #108 lazy-or-eager
// decision).
// `masteryCourseIds: null` (#171): the current courses once the section phase has run, so a course
// that phase discovered gets its mastery too (a first run on an empty database, a new mid-year section).
export async function runUnifiedSync(
  { masteryCourseIds = [], skipSchoology = false, includeHidden = false, syncBlocks = true, refreshQuizzes = false, courseIds = null },
  onEvent
) {
  const emit = (evt) => onEvent?.(evt);
  const db = getDb();
  const startedAt = Date.now();
  const summary = { schoology: null, blocks: null, alerts: null, mastery: [], comments: null, quizzes: null };
  const phaseMs = { schoology: null, blocks: null, alerts: null, mastery: null, comments: null, quizzes: null };
  // #58: a course list (Sync Course, or the Sync Courses on a student page) scopes every phase; null = everything.
  const scoped = courseIds ? { courseIds } : {};
  const skipMastery = new Set();
  summary.phaseMs = phaseMs;
  let metricsId = null;
  let schoologyResult = null; // fullSync's answer: what was read, for the "Synced" stamps

  const finish = (extra = {}) => {
    const elapsedMs = Date.now() - startedAt;
    recordPhaseTimings(db, { metricsId, startedAt, phaseMs, totalMs: elapsedMs });
    emit({ type: 'summary', ...summary, elapsedMs, ...extra });
    return summary;
  };

  if (!skipSchoology) {
    emit({ phase: 'schoology', status: 'running' });
    const schoologyStartedAt = Date.now();
    try {
      const result = await fullSync(
        (progress) => emit({ type: 'log', message: progress.message }),
        { includeHidden, courseIds }
      );
      // #58: an archived course read through finalize already had its mastery read.
      for (const id of result.archivedRead ?? []) skipMastery.add(id);
      metricsId = result.metricsId ?? null;
      schoologyResult = result;
      phaseMs.schoology = Date.now() - schoologyStartedAt;
      summary.schoology = { records: result.records, elapsedMs: phaseMs.schoology };
      emit({ phase: 'schoology', status: 'done', records: result.records, elapsedMs: phaseMs.schoology });
    } catch (err) {
      phaseMs.schoology = Date.now() - schoologyStartedAt;
      emit({ phase: 'schoology', status: 'error', message: err.message, elapsedMs: phaseMs.schoology });
      return finish({ fatal: true });
    }
  }

  // #106: resolve every active course's PowerSchool block number with the same
  // saved Schoology session, over plain HTTP (#141), whenever the request asks for
  // the PowerSchool pass (`syncBlocks`: every kind 'all' run), so a course synced
  // before its block was published self-heals; the service no-ops (no request)
  // when there are no active courses. Best-effort: a stale PowerSchool session
  // logs an error but never aborts the sync. Wall time is measured for the
  // sync-perf / lazy-refresh evaluation.
  if (syncBlocks) {
    emit({ phase: 'blocks', status: 'running' });
    const blocksStartedAt = Date.now();
    try {
      const r = await syncPsAttendance({
        onProgress: (p) => emit({ type: 'log', message: `[blocks] ${p.message}` }),
        // Whole on purpose, even for a course list (#58 review): the same pass stores the school
        // calendar, which a targeted pass skips.
      });
      const gradeLevelsUpdated = r.gradeLevels?.updated ?? 0;
      // A course whose reason is 'section-info-failed' means PowerSchool didn't
      // answer section_info for it — most commonly because the new school
      // year's term/schedule isn't published there yet (#126). Distinct from
      // 'not-numbered' (PCG/Interim — expected, not an error) and
      // 'no-section-dcid' (template course — also expected), so the UI can
      // explain this specific case instead of a generic "N skipped".
      const notReady = (r.results || []).filter((row) => row.reason === 'section-info-failed').length;
      phaseMs.blocks = Date.now() - blocksStartedAt;
      // stoppedEarly (the time budget stopped the loop) and noCourses (nothing to read): not a full read.
      summary.blocks = {
        updated: r.updated, skipped: r.skipped, notReady, gradeLevelsUpdated,
        stoppedEarly: Boolean(r.stoppedEarly), noCourses: Boolean(r.noCourses), elapsedMs: phaseMs.blocks,
      };
      emit({ phase: 'blocks', status: 'done', records: r.updated, skipped: r.skipped, notReady, gradeLevelsUpdated, elapsedMs: summary.blocks.elapsedMs });
    } catch (err) {
      // classifyMasteryError's string matching is generic to the shared
      // browser-session login error ("Not logged in to Schoology..."), not
      // mastery-specific — reused here so a stale session on the blocks pass
      // gets the same actionable "log in and retry" treatment instead of
      // surfacing as an opaque, unclassified phase failure.
      const errorKind = classifyMasteryError(err);
      phaseMs.blocks = Date.now() - blocksStartedAt;
      summary.blocks = { error: err.message, errorKind, elapsedMs: phaseMs.blocks };
      emit({ phase: 'blocks', status: 'error', errorKind, message: err.message, elapsedMs: phaseMs.blocks });
    }
  }

  // #117: PowerSchool student alerts (accommodation, health), over plain HTTP,
  // in the same PowerSchool pass as the blocks (syncBlocks) and behind powerschool_alerts.
  // Best-effort: a failure is reported in the run and never fails the sync.
  const alertsRun = syncBlocks && getFeatures().powerschool_alerts;
  if (alertsRun) {
    emit({ phase: 'alerts', status: 'running' });
    const alertsStartedAt = Date.now();
    try {
      const r = await syncPsAlerts({ onProgress: (p) => emit({ type: 'log', message: `[alerts] ${p.message}` }), ...scoped });
      phaseMs.alerts = Date.now() - alertsStartedAt;
      summary.alerts = { students: r.students, withAlerts: r.withAlerts, failed: r.failed, attendance: r.attendance, elapsedMs: phaseMs.alerts };
      emit({ phase: 'alerts', status: 'done', records: r.students, failed: r.failed, elapsedMs: summary.alerts.elapsedMs });
    } catch (err) {
      const errorKind = classifyMasteryError(err);
      phaseMs.alerts = Date.now() - alertsStartedAt;
      summary.alerts = { error: err.message, errorKind, elapsedMs: phaseMs.alerts };
      emit({ phase: 'alerts', status: 'error', errorKind, message: err.message, elapsedMs: phaseMs.alerts });
    }
  }

  // #171: the last FULL PowerSchool read (blocks, calendar, alerts), which the dashboard's nightly
  // line shows. A course not ready yet (notReady) is still a full read; a failed phase is not, nor
  // is a blocks pass that stopped early (time budget: some blocks unread, the calendar kept) or had
  // no active course to read. With the alerts feature off there is no alerts phase, so a whole
  // blocks pass is the whole read (blocks and the calendar are always whole). A scoped run
  // (courseIds) reads alerts only for the listed courses, so with alerts on it is not a full read.
  const alertsClean = alertsRun ? Boolean(summary.alerts && !summary.alerts.error) && !courseIds : true;
  const blocksWhole = Boolean(summary.blocks) && !summary.blocks.error && !summary.blocks.stoppedEarly && !summary.blocks.noCourses;
  if (syncBlocks && blocksWhole && alertsClean) {
    try {
      recordNightlyDataRead(db, new Date().toISOString());
    } catch (err) {
      console.error('[sync] could not stamp the PowerSchool read:', err.message);
    }
  }

  const selectCourse = db.prepare('SELECT id, course_name FROM courses WHERE id = ?');
  const insertSyncLog = db.prepare(
    `INSERT INTO sync_log (sync_type, status, started_at) VALUES ('mastery', 'running', ?)`
  );
  const completeSyncLog = db.prepare(
    `UPDATE sync_log SET status = 'completed', records_synced = ?, completed_at = ? WHERE id = ?`
  );
  const failSyncLog = db.prepare(
    `UPDATE sync_log SET status = 'error', error_message = ?, completed_at = ? WHERE id = ?`
  );

  // null: the current courses, less any whose first read failed or did not finish (#171): their
  // sections were not read, so neither is their mastery. A list is used as given.
  const masteryList = masteryCourseIds ?? withFirstReadDone(db, currentCourseIds(db, { includeHidden }));
  for (const courseId of masteryList.filter((id) => !skipMastery.has(Number(id)))) {
    const courseRow = selectCourse.get(courseId);
    const courseName = courseRow?.course_name || `Course ${courseId}`;
    emit({ phase: 'mastery', courseId, courseName, status: 'running' });

    const syncId = insertSyncLog.run(new Date().toISOString()).lastInsertRowid;
    const courseStartedAt = Date.now();
    const courseMs = () => {
      const ms = Date.now() - courseStartedAt;
      phaseMs.mastery = (phaseMs.mastery ?? 0) + ms;
      return ms;
    };

    try {
      const result = await syncMasteryForCourse(courseId, {
        onProgress: (p) => emit({ type: 'log', message: `[${courseName}] ${p.message}` }),
      });
      const records = result.scoresCount || 0;
      completeSyncLog.run(records, new Date().toISOString(), syncId);
      // Rubric levels are part of the visible-feedback fingerprint: re-snapshot the
      // course after its pull (Amendment B fix round 1). Best-effort.
      try {
        captureFeedbackSnapshots(db, { courseId });
        settleResubmissions(db, { courseId });
      } catch (err) {
        console.error('[sync] snapshot/settle after mastery pull failed:', err.message);
      }
      const elapsedMs = courseMs();
      summary.mastery.push({ courseId, courseName, status: 'done', records, elapsedMs });
      emit({ phase: 'mastery', courseId, courseName, status: 'done', records, elapsedMs });
    } catch (err) {
      const errorKind = classifyMasteryError(err);
      failSyncLog.run(err.message, new Date().toISOString(), syncId);
      const elapsedMs = courseMs();
      summary.mastery.push({ courseId, courseName, status: 'error', errorKind, message: err.message, elapsedMs });
      emit({ phase: 'mastery', courseId, courseName, status: 'error', errorKind, message: err.message, elapsedMs });
    }
  }

  // Submission comments (18/10/2026): read recent threads so unread student comments
  // show everywhere, not only on tasks opened in Prism since. Best effort, like quizzes:
  // a failure is reported in the run and never fails the sync.
  if (!skipSchoology && getFeatures().submission_comments) {
    emit({ phase: 'comments', status: 'running' });
    const commentsStartedAt = Date.now();
    try {
      const r = await refreshRecentComments(db, {
        ...scoped,
        onAssignment: (a) => a.queued && emit({ type: 'log', message: `[comments] ${a.title}: ${a.refreshed} read${a.failed ? `, ${a.failed} failed` : ''}` }),
      });
      phaseMs.comments = Date.now() - commentsStartedAt;
      summary.comments = { ...r, elapsedMs: phaseMs.comments };
      emit(r.failed
        ? { phase: 'comments', status: 'error', message: `${r.failed} comment threads not read (${r.refreshed} read)`, elapsedMs: phaseMs.comments }
        : { phase: 'comments', status: 'done', records: r.refreshed, elapsedMs: phaseMs.comments });
    } catch (err) {
      phaseMs.comments = Date.now() - commentsStartedAt;
      summary.comments = { error: err.message, elapsedMs: phaseMs.comments };
      emit({ phase: 'comments', status: 'error', message: err.message, elapsedMs: phaseMs.comments });
    }
  }

  // Spec §12: the nightly run reloads loaded quizzes that students sat in the last 28 days. Best effort: a
  // failure is reported in the run and never fails the sync.
  if (refreshQuizzes && getFeatures().quizzes) {
    emit({ phase: 'quizzes', status: 'running' });
    const quizzesStartedAt = Date.now();
    try {
      const results = await refreshRecentQuizzes(db, {
        onGroup: (r) => emit({ type: 'log', message: `[quizzes] ${r.title}: ${r.status === 'done' ? `${r.attempts} attempts` : r.message}` }),
      });
      const failed = results.filter(r => r.status === 'error');
      phaseMs.quizzes = Date.now() - quizzesStartedAt;
      summary.quizzes = { refreshed: results.length - failed.length, failed: failed.length, elapsedMs: phaseMs.quizzes };
      emit(failed.length
        ? { phase: 'quizzes', status: 'error', message: `${failed.length} of ${results.length} quizzes not refreshed: ${failed[0].message}`, elapsedMs: phaseMs.quizzes }
        : { phase: 'quizzes', status: 'done', records: results.length, elapsedMs: phaseMs.quizzes });
    } catch (err) {
      phaseMs.quizzes = Date.now() - quizzesStartedAt;
      summary.quizzes = { error: err.message, elapsedMs: phaseMs.quizzes };
      emit({ phase: 'quizzes', status: 'error', message: err.message, elapsedMs: phaseMs.quizzes });
    }
  }

  if (schoologyResult) {
    stampCompleteSyncs(db, {
      result: schoologyResult,
      masteryDone: new Set(summary.mastery.filter((m) => m.status === 'done').map((m) => Number(m.courseId))),
      // Comment threads: a phase that failed outright leaves every course incomplete.
      commentsFailed: summary.comments?.error ? 'all' : new Set(summary.comments?.failedCourseIds ?? []),
      at: new Date(startedAt).toISOString(),
    });
  }
  return finish();
}

// "Synced" means everything synced (Graham, 20/10/2026): a course is stamped only when its
// Schoology data and every submission read finished (fullSync's `complete`), its mastery read
// succeeded (or, for a listed archived course, finalize read it), and none of its comment threads
// failed; its tasks read in full are stamped with it. Every course read gets an attempt time,
// so a course that keeps failing waits out the background-sync window too.
export function stampCompleteSyncs(db, { result, masteryDone, commentsFailed, at }) {
  const complete = new Set([
    ...(result.complete?.courseIds ?? []).filter((id) => masteryDone.has(Number(id))),
    ...(result.archivedComplete ?? []),
  ].filter((id) => commentsFailed !== 'all' && !commentsFailed.has(Number(id))));
  const attempted = result.readCourseIds ?? [];
  db.transaction(() => {
    const attemptCourse = db.prepare('UPDATE courses SET sync_attempted_at = ? WHERE id = ?');
    const attemptTasks = db.prepare('UPDATE assignments SET task_sync_attempted_at = ? WHERE course_id = ? AND removed_at IS NULL');
    for (const id of attempted) { attemptCourse.run(at, id); attemptTasks.run(at, id); }
    const stampCourse = db.prepare('UPDATE courses SET course_synced_at = ? WHERE id = ?');
    const stampTask = db.prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?');
    for (const id of complete) {
      stampCourse.run(at, id);
      for (const t of result.complete?.taskIdsByCourse?.[id] ?? []) stampTask.run(at, t);
    }
  })();
}

// #143: store the run's per-phase times. A run whose Schoology phase finished
// already has the sync_metrics row fullSync wrote (metricsId), so the times go
// on it; any other run (Schoology skipped or failed) gets a row of its own.
// Best-effort: a metrics write never fails the sync.
export function recordPhaseTimings(db, { metricsId, startedAt, phaseMs, totalMs }) {
  const values = [phaseMs.schoology, phaseMs.blocks, phaseMs.alerts ?? null, phaseMs.mastery, phaseMs.comments ?? null, phaseMs.quizzes, totalMs];
  try {
    if (metricsId != null) {
      const updated = db.prepare(
        `UPDATE sync_metrics SET schoology_ms = ?, blocks_ms = ?, alerts_ms = ?, mastery_ms = ?, comments_ms = ?, quizzes_ms = ?, total_ms = ? WHERE id = ?`
      ).run(...values, metricsId).changes;
      if (updated) return;
    }
    db.prepare(
      `INSERT INTO sync_metrics (started_at, schoology_ms, blocks_ms, alerts_ms, mastery_ms, comments_ms, quizzes_ms, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(new Date(startedAt).toISOString(), ...values);
  } catch (err) {
    console.error('[sync] could not record phase timings:', err.message);
  }
}
