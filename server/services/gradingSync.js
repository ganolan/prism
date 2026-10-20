// The sync PrisMCP's get_assignment_context forces before it answers (#131, Graham 20/10/2026):
// grading from data the teacher changed in Schoology a minute ago is the failure this prevents.
// It asks the one sync queue for a grading sync of the task (taskSyncRun.js: details, submissions,
// grades, mastery, the comment threads waited for, the files of everyone who uploaded) and waits,
// unless the task's last grading sync (`grading_synced_at`) is under 5 minutes old.
//
//   gradingSync(db, assignmentRef, { useStoredData, waitMs, now, onProgress, progressMs, deps })
//     → { state: 'fresh' | 'synced' | 'stored', runId?, dataAsOf, summary?, task }
//
// `task` is the assignment row it resolved (id, course_id, schoology_assignment_id,
// is_lti_submission, grading_synced_at as it was before any sync), for the caller to reuse.
//
// `assignmentRef` is a local or Schoology assignment id. It never returns stale data silently: a
// lapsed session, a failed run and a wait past `waitMs` each throw a GradingSyncError.
//   NOT_FOUND       no such assignment (nothing queued), or the run found the task deleted in Schoology
//   SESSION_LAPSED  Schoology is signed out, checked first or lost mid-run (the queue holds that
//                   run): { signInUrl, lastSyncedAt }. The teacher chooses: sign in and call again,
//                   or call again with useStoredData (state 'stored', the database as it is).
//   SYNC_FAILED     the run failed or finished with errors: { runId }, the message says why. The
//                   teacher chooses: call again (a fresh run), or call again with useStoredData
//                   (the database as it is, with the stale_data warning). A deploy restart does not
//                   answer this: the call that was waiting loses its connection (the server keeps
//                   no MCP session), and the next call starts a fresh run.
//   SYNC_PENDING    still going after waitMs: { runId }. Calling again follows the same run.
import { resolveAssignmentId } from './idResolvers.js';
import { enqueue, whenDone, resumeHeld, queueDeps } from './syncQueue.js';
import { TOOL_WAIT_MS } from '../lib/toolWait.js';
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
    `The Schoology sync of this task did not finish cleanly (run ${runId}): ${why}. ` +
    'Tell the teacher what failed. They may retry (calling again starts a new sync), or, if it keeps failing, choose to call again with use_stored_data: true, ' +
    'which returns the data Prism already holds with a stale_data warning. Do not choose stored data yourself.',
    { runId });
}

export async function gradingSync(db, assignmentRef, {
  useStoredData = false, waitMs = GRADING_WAIT_MS, now = Date.now(), onProgress, progressMs = PROGRESS_MS, deps = {},
} = {}) {
  const d = { enqueue, whenDone, resumeHeld, sessionStatus: queueDeps.sessionStatus, ...deps };
  const localId = resolveAssignmentId(db, assignmentRef);
  const task = localId && db.prepare(
    'SELECT id, course_id, schoology_assignment_id, is_lti_submission, grading_synced_at FROM assignments WHERE id = ?',
  ).get(localId);
  if (!task) throw new GradingSyncError('NOT_FOUND', `Unknown assignment ${assignmentRef}`);
  // dataAsOf, and what the teacher is told: when the task's data was last read (any full task read).
  const syncedAt = () => db.prepare('SELECT task_synced_at FROM assignments WHERE id = ?').get(task.id)?.task_synced_at ?? null;
  // The 5 minute skip counts only a grading sync: a plain task run does not wait for the comment
  // threads or read the files.
  const gradedAt = task.grading_synced_at;

  const before = syncedAt();
  if (gradedAt && now - Date.parse(gradedAt) < GRADING_FRESH_MS) return { state: 'fresh', dataAsOf: before, task };
  if (useStoredData) return { state: 'stored', dataAsOf: before, task };

  let live = 'unknown';
  try { live = (await d.sessionStatus({ refresh: true }))?.live ?? 'unknown'; } catch { live = 'unknown'; }
  if (live === 'expired' || live === 'none') throw lapsed(before);

  // The check just made goes on the request, so the queue does not make another (#170).
  const { runId, state } = d.enqueue({
    kind: 'task', courseId: task.course_id, assignmentId: task.schoology_assignment_id, grading: true, trigger: 'button',
    sessionCheckedAt: Date.now(), sessionLive: live,
  });
  // A held run: nothing else resumes it, and waiting on it would not end. A sign-in that has since
  // happened ('connected') runs every held run again, as runOne does when a session check passes.
  // Schoology not reached ('unknown') runs this one again: it fails visibly (SYNC_FAILED) or, if
  // the sign-in really lapsed, is held again (SESSION_LAPSED), never SYNC_PENDING forever (#170).
  if (state === 'held') d.resumeHeld(live === 'connected' ? undefined : { runId });
  const started = Date.now();
  let timer; let ticker;
  if (onProgress) ticker = setInterval(() => { try { onProgress({ runId, waitedMs: Date.now() - started }); } catch { /* progress is best effort */ } }, progressMs);
  const done = d.whenDone(runId);
  const status = await Promise.race([
    done,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
  ]).finally(() => { clearTimeout(timer); clearInterval(ticker); });

  if (status === null) {
    done.cancel?.(); // stop waiting: the next call follows the run with its own waiter
    throw new GradingSyncError('SYNC_PENDING',
      `The Schoology sync is still running (run ${runId}): call get_assignment_context again to follow it.`, { runId });
  }
  if (status === 'held') throw lapsed(syncedAt());
  if (status !== 'completed') throw failure(db, runId, status);

  const row = db.prepare('SELECT summary_json FROM sync_runs WHERE id = ?').get(runId);
  let summary = null;
  try { summary = JSON.parse(row?.summary_json ?? 'null'); } catch { summary = null; }
  // A task deleted in Schoology: the run completes (and says so), but there is nothing to grade.
  if (summary?.removed) throw new GradingSyncError('NOT_FOUND', `This task was deleted in Schoology (run ${runId}), so there is nothing to read.`, { runId });
  return { state: 'synced', runId, dataAsOf: syncedAt(), summary, task };
}
