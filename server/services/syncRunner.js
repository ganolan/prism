// One unified sync at a time, whoever starts it (the Sync button's POST
// /api/sync or the nightly schedule). Owns the run lifecycle: the sync_runs
// row, every event logged with its seq, and the finish + prune at the end.
import { getDb } from '../db/index.js';
import { runUnifiedSync } from './syncOrchestrator.js';
import { startRun, appendEvent, finishRun, pruneRuns, KEEP_RUNS } from './syncRuns.js';

let currentRunId = null;

export class SyncBusyError extends Error {
  constructor(runId) {
    super('Sync already in progress');
    this.runId = runId;
  }
}

export function currentSync() {
  return { running: currentRunId != null, runId: currentRunId };
}

// Start a sync run. Throws SyncBusyError if one is running (or the error from
// starting the run row). Otherwise calls onRun(runId) synchronously, before the
// first event, then onEvent(evt with seq) for each event. Returns
// { runId, done } where done resolves to the run's final status
// ('completed' | 'completed_with_errors' | 'failed', as finishRun stores it).
export function launchSync(options, { onRun, onEvent } = {}) {
  if (currentRunId != null) throw new SyncBusyError(currentRunId);
  const db = getDb();
  const runId = startRun(db, options);
  currentRunId = runId;
  onRun?.(runId);

  const done = (async () => {
    let summary = null;
    let status = 'completed';
    const write = (evt) => {
      if (evt?.type === 'summary') summary = evt;
      let seq = null;
      try { seq = appendEvent(db, runId, evt); } catch (err) { console.error('[sync] Could not log event:', err.message); }
      onEvent?.(seq == null ? evt : { ...evt, seq });
    };
    try {
      await runUnifiedSync(options, write);
      if (summary?.fatal) status = 'failed';
    } catch (err) {
      console.error('[sync] Error:', err);
      status = 'failed';
      write({ type: 'error', message: err.message });
    } finally {
      try {
        finishRun(db, runId, { status, summary });
        pruneRuns(db, KEEP_RUNS);
      } catch (err) {
        console.error('[sync] Could not finish the sync run:', err.message);
      }
      currentRunId = null;
    }
    return db.prepare('SELECT status FROM sync_runs WHERE id = ?').get(runId)?.status ?? status;
  })();
  return { runId, done };
}
