import { getDb } from '../db/index.js';
import { fullSync } from './sync.js';
import { syncMasteryForCourse } from './masterySync.js';
import { refreshRecentQuizzes } from './quizRefresh.js';
import { getFeatures } from '../middleware/featureGate.js';
import { syncPsAttendance } from './psAttendanceSync.js';
import { syncPsAlerts } from './psAlertsSync.js';
import { captureFeedbackSnapshots } from './feedbackSnapshots.js';
import { settleResubmissions } from './resubmissions.js';

// Classify a mastery sync failure: 'login' means the Schoology browser session
// is missing/expired (recoverable by re-login); 'other' is anything else.
export function classifyMasteryError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('not logged in') || msg.includes('log in') || msg.includes('mastery:login')) {
    return 'login';
  }
  return 'other';
}

// Run the unified sync: the Schoology public-API pull, then a Playwright
// mastery pull for each requested course. Every step reports through onEvent.
// Event shapes:
//   { phase:'schoology', status:'running'|'done'|'error', records?, message? }
//   { phase:'mastery', courseId, courseName, status, records?, errorKind?, message? }
//   { type:'log', message }
//   { type:'summary', schoology, blocks, mastery, quizzes, phaseMs, elapsedMs, fatal? }
// Every finished phase event (done or error) carries its own elapsedMs, and the
// summary's phaseMs holds { schoology, blocks, alerts, mastery, quizzes } wall time
// (null = the phase did not run; mastery = the sum over its courses). The same
// times are stored on a sync_metrics row (#143, for the #108 lazy-or-eager
// decision).
export async function runUnifiedSync(
  { masteryCourseIds = [], skipSchoology = false, includeHidden = false, recentOnly = false, recentDays = 30, syncBlocks = true, refreshQuizzes = false },
  onEvent
) {
  const emit = (evt) => onEvent?.(evt);
  const db = getDb();
  const startedAt = Date.now();
  const summary = { schoology: null, blocks: null, alerts: null, mastery: [], quizzes: null };
  const phaseMs = { schoology: null, blocks: null, alerts: null, mastery: null, quizzes: null };
  summary.phaseMs = phaseMs;
  let metricsId = null;

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
        { includeHidden, recentOnly, recentDays }
      );
      metricsId = result.metricsId ?? null;
      phaseMs.schoology = Date.now() - schoologyStartedAt;
      summary.schoology = { records: result.records, elapsedMs: phaseMs.schoology };
      emit({ phase: 'schoology', status: 'done', records: result.records, elapsedMs: phaseMs.schoology });
    } catch (err) {
      phaseMs.schoology = Date.now() - schoologyStartedAt;
      emit({ phase: 'schoology', status: 'error', message: err.message, elapsedMs: phaseMs.schoology });
      return finish({ fatal: true });
    }
  }

  // #106: resolve every active course's PowerSchool block number from the same
  // shared browser session (opt-out via the sync dialog's `syncBlocks`). Runs
  // every sync so a course synced before its block was published self-heals;
  // the service no-ops (no browser) when there are no active courses. Best-effort:
  // a stale PowerSchool session logs an error but never aborts the sync. Wall
  // time is measured for the sync-perf / lazy-refresh evaluation.
  if (syncBlocks) {
    emit({ phase: 'blocks', status: 'running' });
    const blocksStartedAt = Date.now();
    try {
      const r = await syncPsAttendance({
        onProgress: (p) => emit({ type: 'log', message: `[blocks] ${p.message}` }),
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
      summary.blocks = { updated: r.updated, skipped: r.skipped, notReady, gradeLevelsUpdated, elapsedMs: phaseMs.blocks };
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
  // on the same "Sync from PowerSchool" opt-out and behind powerschool_alerts.
  // Best-effort: a failure is reported in the run and never fails the sync.
  if (syncBlocks && getFeatures().powerschool_alerts) {
    emit({ phase: 'alerts', status: 'running' });
    const alertsStartedAt = Date.now();
    try {
      const r = await syncPsAlerts({ onProgress: (p) => emit({ type: 'log', message: `[alerts] ${p.message}` }) });
      phaseMs.alerts = Date.now() - alertsStartedAt;
      summary.alerts = { students: r.students, withAlerts: r.withAlerts, failed: r.failed, elapsedMs: phaseMs.alerts };
      emit({ phase: 'alerts', status: 'done', records: r.students, failed: r.failed, elapsedMs: summary.alerts.elapsedMs });
    } catch (err) {
      const errorKind = classifyMasteryError(err);
      phaseMs.alerts = Date.now() - alertsStartedAt;
      summary.alerts = { error: err.message, errorKind, elapsedMs: phaseMs.alerts };
      emit({ phase: 'alerts', status: 'error', errorKind, message: err.message, elapsedMs: phaseMs.alerts });
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

  for (const courseId of masteryCourseIds) {
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
        allowInteractiveLogin: false,
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

  return finish();
}

// #143: store the run's per-phase times. A run whose Schoology phase finished
// already has the sync_metrics row fullSync wrote (metricsId), so the times go
// on it; any other run (Schoology skipped or failed) gets a row of its own.
// Best-effort: a metrics write never fails the sync.
export function recordPhaseTimings(db, { metricsId, startedAt, phaseMs, totalMs }) {
  const values = [phaseMs.schoology, phaseMs.blocks, phaseMs.alerts ?? null, phaseMs.mastery, phaseMs.quizzes, totalMs];
  try {
    if (metricsId != null) {
      const updated = db.prepare(
        `UPDATE sync_metrics SET schoology_ms = ?, blocks_ms = ?, alerts_ms = ?, mastery_ms = ?, quizzes_ms = ?, total_ms = ? WHERE id = ?`
      ).run(...values, metricsId).changes;
      if (updated) return;
    }
    db.prepare(
      `INSERT INTO sync_metrics (started_at, schoology_ms, blocks_ms, alerts_ms, mastery_ms, quizzes_ms, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(new Date(startedAt).toISOString(), ...values);
  } catch (err) {
    console.error('[sync] could not record phase timings:', err.message);
  }
}
