// The sync PrisMCP's get_assignment_context forces before it answers (#131, Graham 20/10/2026):
// grading from data the teacher changed in Schoology a minute ago is the failure this prevents.
// It asks the one sync queue for a grading sync of the task (taskSyncRun.js: details, submissions,
// grades, mastery, the comment threads waited for, the files of everyone who uploaded) and waits,
// unless the task's last full sync (`task_synced_at`) is under 5 minutes old.
//
//   gradingSync(db, assignmentRef, { useStoredData, waitMs, now, onProgress, progressMs, deps })
//     → { state: 'fresh' | 'synced' | 'stored', runId?, dataAsOf, summary? }
//
// `assignmentRef` is a local or Schoology assignment id. It never returns stale data silently: a
// lapsed session, a failed run and a wait past `waitMs` each throw a GradingSyncError.
//   NOT_FOUND       no such assignment (nothing queued)
//   SESSION_LAPSED  Schoology is signed out, checked first or lost mid-run (the queue holds that
//                   run): { signInUrl, lastSyncedAt }. The teacher chooses: sign in and call again,
//                   or call again with useStoredData (state 'stored', the database as it is).
//   SYNC_FAILED     the run failed, was interrupted (a deploy) or finished with errors: { runId },
//                   the message says why. Calling again starts a fresh run.
//   SYNC_PENDING    still going after waitMs: { runId }. Calling again follows the same run.
import { resolveAssignmentId } from './idResolvers.js';
import { enqueue, whenDone, queueDeps, TOOL_WAIT_MS } from './syncQueue.js';
import { getEvents } from './syncRuns.js';

export const GRADING_FRESH_MS = 5 * 60 * 1000;
export const GRADING_WAIT_MS = TOOL_WAIT_MS;
export const SIGN_IN_URL = 'https://prism.swordtail-everest.ts.net/settings#schoology-signin';
const PROGRESS_MS = 10_000;

export class GradingSyncError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'GradingSyncError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function lapsed(lastSyncedAt) {
  return new GradingSyncError('SESSION_LAPSED',
    `Prism is signed out of Schoology, so it cannot read the latest data (last full sync of this task: ${lastSyncedAt ?? 'never'}). ` +
    `Ask the teacher: sign in at ${SIGN_IN_URL} and call again, or call again with use_stored_data: true to grade from the data Prism already holds. ` +
    'Do not choose stored data yourself.',
    { signInUrl: SIGN_IN_URL, lastSyncedAt });
}

// Why a run did not finish cleanly: its error events, else its status.
function failure(db, runId, status) {
  const lines = getEvents(db, runId).filter((e) => e.level === 'error').map((e) => e.message || e.title).filter(Boolean);
  const why = lines.length ? lines.join('; ') : `the sync ${status === 'interrupted' ? 'was interrupted (Prism restarted)' : status}`;
  return new GradingSyncError('SYNC_FAILED',
    `The Schoology sync of this task did not finish cleanly (run ${runId}): ${why}. Calling again starts a new sync.`,
    { runId });
}

export async function gradingSync(db, assignmentRef, {
  useStoredData = false, waitMs = GRADING_WAIT_MS, now = Date.now(), onProgress, progressMs = PROGRESS_MS, deps = {},
} = {}) {
  const d = { enqueue, whenDone, sessionStatus: queueDeps.sessionStatus, ...deps };
  const localId = resolveAssignmentId(db, assignmentRef);
  const task = localId && db.prepare('SELECT id, course_id, schoology_assignment_id FROM assignments WHERE id = ?').get(localId);
  if (!task) throw new GradingSyncError('NOT_FOUND', `Unknown assignment ${assignmentRef}`);
  const syncedAt = () => db.prepare('SELECT task_synced_at FROM assignments WHERE id = ?').get(task.id)?.task_synced_at ?? null;

  const before = syncedAt();
  if (before && now - Date.parse(before) < GRADING_FRESH_MS) return { state: 'fresh', dataAsOf: before };
  if (useStoredData) return { state: 'stored', dataAsOf: before };

  let live = 'unknown';
  try { live = (await d.sessionStatus({ refresh: true }))?.live ?? 'unknown'; } catch { live = 'unknown'; }
  if (live === 'expired' || live === 'none') throw lapsed(before);

  const { runId } = d.enqueue({
    kind: 'task', courseId: task.course_id, assignmentId: task.schoology_assignment_id, grading: true, trigger: 'button',
  });
  const started = Date.now();
  let timer; let ticker;
  if (onProgress) ticker = setInterval(() => { try { onProgress({ runId, waitedMs: Date.now() - started }); } catch { /* progress is best effort */ } }, progressMs);
  const status = await Promise.race([
    d.whenDone(runId),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
  ]).finally(() => { clearTimeout(timer); clearInterval(ticker); });

  if (status === null) {
    throw new GradingSyncError('SYNC_PENDING',
      `The Schoology sync is still running (run ${runId}): call get_assignment_context again to follow it.`, { runId });
  }
  if (status === 'held') throw lapsed(syncedAt());
  if (status !== 'completed') throw failure(db, runId, status);

  const row = db.prepare('SELECT summary_json FROM sync_runs WHERE id = ?').get(runId);
  let summary = null;
  try { summary = JSON.parse(row?.summary_json ?? 'null'); } catch { summary = null; }
  return { state: 'synced', runId, dataAsOf: syncedAt(), summary };
}
