// A quiz load as a run in the sync queue (#131): loadGroup reads a linked quiz's attempts from
// Schoology, and every bulk Schoology read is a queue run, so it never overlaps a sync. Both the
// PrisMCP tool (load_quiz_results) and the page's Load button go through loadQuizQueued.
//
//   request = { kind: 'quiz', groupId, trigger: 'button', noHold: true }
//
// The queue runs it with runQuizLoad (quizLoadRun.js), whose summary event this reads back.
import { QuizError } from './quizError.js';
import { getGroup } from './quizGroups.js';
import { enqueue, whenDone, queueDeps } from './syncQueue.js';
import { TOOL_WAIT_MS } from '../lib/toolWait.js';

// Load a quiz group's attempts through the queue → the loadGroup summary. Throws a QuizError:
// NOT_FOUND (no such group) and NO_SESSION (checked first, at once, nothing queued), the load's own
// (UNREACHABLE, BUSY, ...), or PENDING once the wait passes waitMs, with `runId` to follow the run
// (loading again joins it).
export async function loadQuizQueued(db, groupId, { waitMs = TOOL_WAIT_MS, deps = {} } = {}) {
  const group = getGroup(db, groupId);
  const sessionStatus = deps.sessionStatus ?? queueDeps.sessionStatus;
  let live = 'unknown';
  try { live = (await sessionStatus({ refresh: true }))?.live ?? 'unknown'; } catch { live = 'unknown'; }
  if (live === 'expired' || live === 'none') {
    throw new QuizError('NO_SESSION', live === 'none'
      ? 'No saved Schoology session: reconnect in Settings'
      : 'Schoology connection expired: reconnect in Settings');
  }

  const { runId } = enqueue({ kind: 'quiz', groupId: group.id, trigger: 'button', noHold: true });
  let timer;
  const done = whenDone(runId);
  const status = await Promise.race([
    done,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
  ]);
  clearTimeout(timer);
  if (status === null) {
    done.cancel(); // stop waiting: loading again follows the run with its own waiter
    throw Object.assign(new QuizError('PENDING', `The quiz is still loading (run ${runId}): ask again to follow it`), { runId });
  }

  const row = db.prepare('SELECT summary_json FROM sync_runs WHERE id = ?').get(runId);
  let summary = null;
  try { summary = JSON.parse(row?.summary_json ?? 'null'); } catch { summary = null; }
  if (summary?.quizError) throw new QuizError(summary.quizError.code, summary.quizError.message);
  if (!summary?.quiz) throw new Error(`The quiz load did not finish (run ${runId}, ${status})`);
  return summary.quiz;
}
