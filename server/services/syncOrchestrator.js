import { getDb } from '../db/index.js';
import { fullSync } from './sync.js';
import { syncMasteryForCourse } from './masterySync.js';
import { syncBlockNumbers, countCoursesNeedingBlockSync } from './blockNumberSync.js';

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
//   { type:'summary', schoology, mastery, elapsedMs, fatal? }
export async function runUnifiedSync(
  { masteryCourseIds = [], skipSchoology = false, includeHidden = false, recentOnly = false, recentDays = 30 },
  onEvent
) {
  const emit = (evt) => onEvent?.(evt);
  const db = getDb();
  const startedAt = Date.now();
  const summary = { schoology: null, blocks: null, mastery: [] };

  if (!skipSchoology) {
    emit({ phase: 'schoology', status: 'running' });
    try {
      const result = await fullSync(
        (progress) => emit({ type: 'log', message: progress.message }),
        { includeHidden, recentOnly, recentDays }
      );
      summary.schoology = { records: result.records };
      emit({ phase: 'schoology', status: 'done', records: result.records });
    } catch (err) {
      emit({ phase: 'schoology', status: 'error', message: err.message });
      emit({ type: 'summary', ...summary, elapsedMs: Date.now() - startedAt, fatal: true });
      return summary;
    }
  }

  // #106: fill any course missing its PowerSchool block number, from the same
  // shared browser session. Gated on a cheap count so steady-state syncs launch
  // no browser (each course is examined once, then marked block_synced_at); the
  // manual "Sync blocks" button is the force-refresh path. Best-effort: a stale
  // PowerSchool session logs an error but never aborts the sync.
  if (countCoursesNeedingBlockSync(db) > 0) {
    emit({ phase: 'blocks', status: 'running' });
    try {
      const r = await syncBlockNumbers({
        onProgress: (p) => emit({ type: 'log', message: `[blocks] ${p.message}` }),
      });
      summary.blocks = { updated: r.updated, skipped: r.skipped };
      emit({ phase: 'blocks', status: 'done', records: r.updated });
    } catch (err) {
      summary.blocks = { error: err.message };
      emit({ phase: 'blocks', status: 'error', message: err.message });
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

    try {
      const result = await syncMasteryForCourse(courseId, {
        allowInteractiveLogin: false,
        onProgress: (p) => emit({ type: 'log', message: `[${courseName}] ${p.message}` }),
      });
      const records = result.scoresCount || 0;
      completeSyncLog.run(records, new Date().toISOString(), syncId);
      summary.mastery.push({ courseId, courseName, status: 'done', records });
      emit({ phase: 'mastery', courseId, courseName, status: 'done', records });
    } catch (err) {
      const errorKind = classifyMasteryError(err);
      failSyncLog.run(err.message, new Date().toISOString(), syncId);
      summary.mastery.push({ courseId, courseName, status: 'error', errorKind, message: err.message });
      emit({ phase: 'mastery', courseId, courseName, status: 'error', errorKind, message: err.message });
    }
  }

  emit({ type: 'summary', ...summary, elapsedMs: Date.now() - startedAt });
  return summary;
}
