import { getDb } from '../db/index.js';
import { fullSync } from './sync.js';
import { syncMasteryForCourse } from './masterySync.js';

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
export async function runUnifiedSync({ masteryCourseIds = [], skipSchoology = false }, onEvent) {
  const emit = (evt) => onEvent?.(evt);
  const db = getDb();
  const startedAt = Date.now();
  const summary = { schoology: null, mastery: [] };

  if (!skipSchoology) {
    emit({ phase: 'schoology', status: 'running' });
    try {
      const result = await fullSync((progress) => emit({ type: 'log', message: progress.message }));
      summary.schoology = { records: result.records };
      emit({ phase: 'schoology', status: 'done', records: result.records });
    } catch (err) {
      emit({ phase: 'schoology', status: 'error', message: err.message });
      emit({ type: 'summary', ...summary, elapsedMs: Date.now() - startedAt, fatal: true });
      return summary;
    }
  }

  for (const courseId of masteryCourseIds) {
    const courseRow = db.prepare('SELECT id, course_name FROM courses WHERE id = ?').get(courseId);
    const courseName = courseRow?.course_name || `Course ${courseId}`;
    emit({ phase: 'mastery', courseId, courseName, status: 'running' });

    const syncId = db.prepare(
      `INSERT INTO sync_log (sync_type, status, started_at) VALUES ('mastery', 'running', ?)`
    ).run(new Date().toISOString()).lastInsertRowid;

    try {
      const result = await syncMasteryForCourse(courseId, {
        allowInteractiveLogin: false,
        onProgress: (p) => emit({ type: 'log', message: `[${courseName}] ${p.message}` }),
      });
      const records = result.scoresCount || 0;
      db.prepare(`UPDATE sync_log SET status = 'completed', records_synced = ?, completed_at = ? WHERE id = ?`)
        .run(records, new Date().toISOString(), syncId);
      summary.mastery.push({ courseId, courseName, status: 'done', records });
      emit({ phase: 'mastery', courseId, courseName, status: 'done', records });
    } catch (err) {
      const errorKind = classifyMasteryError(err);
      db.prepare(`UPDATE sync_log SET status = 'error', error_message = ?, completed_at = ? WHERE id = ?`)
        .run(err.message, new Date().toISOString(), syncId);
      summary.mastery.push({ courseId, courseName, status: 'error', errorKind, message: err.message });
      emit({ phase: 'mastery', courseId, courseName, status: 'error', errorKind, message: err.message });
    }
  }

  emit({ type: 'summary', ...summary, elapsedMs: Date.now() - startedAt });
  return summary;
}
