import { Router } from 'express';
import { getDb } from '../db/index.js';
import { launchSync, currentSync, SyncBusyError } from '../services/syncRunner.js';
import { clampDays } from '../services/recentWindow.js';
import { listRuns, getRun, getEvents, isFinished, KEEP_RUNS } from '../services/syncRuns.js';

const router = Router();

// POST /api/sync — run the unified sync, streaming progress as newline-
// delimited JSON. Body: {
//   masteryCourseIds?: number[],
//   skipSchoology?: boolean,
//   includeHidden?: boolean,    // #56: opt in to syncing hidden courses
//   recentOnly?: boolean,       // #55: skip submissions outside the day window
//   recentDays?: number,        // #55: window size, clamped 1..365 (default 30)
//   syncBlocks?: boolean,       // #106: resolve active courses' PowerSchool block numbers (default true)
// }.
//
// Runs + events (server/services/syncRuns.js): every sync is recorded as a
// sync_runs row, and every progress event it streams is also stored in
// sync_run_events with a per-run `seq` (1, 2, 3…). The stream's FIRST line is
// `{ type: 'run', runId }`; every later line is the orchestrator event plus its
// `seq`. The run is finished in `finally` ('completed', 'completed_with_errors'
// when any error events were logged, or 'failed' — the orchestrator threw or
// reported a fatal summary) and history is pruned to the newest 30 runs. A run
// left 'running' by a crash/restart/deploy is marked 'interrupted' at boot.
//
// Re-attach protocol: if the client disconnects mid-stream the sync continues
// to completion server-side (there is no cancellation). iOS drops the stream
// when the screen locks, so the client keeps `runId` + the last `seq` it saw
// and, on a dropped stream, polls GET /api/sync/runs/:id/events?after=<seq>
// until `finished`. A second POST while a sync runs gets 409 with the running
// `runId` so that client can join it from seq 0; GET /api/sync/current tells a
// client that never saw a runId (or a freshly opened dialog) what is running.
router.post('/sync', async (req, res) => {
  const {
    masteryCourseIds = [],
    skipSchoology = false,
    includeHidden = false,
    recentOnly = false,
    recentDays = 30,
    syncBlocks = true,
  } = req.body || {};
  const options = {
    masteryCourseIds, skipSchoology, includeHidden: !!includeHidden, recentOnly: !!recentOnly,
    recentDays: clampDays(recentDays), syncBlocks: syncBlocks !== false,
  };

  // The stream may be gone (client disconnected) — the sync and the stored
  // event log carry on regardless.
  const send = (obj) => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(JSON.stringify(obj) + '\n'); } catch { /* client gone */ }
  };
  let run;
  try {
    run = launchSync(options, {
      onRun: (runId) => {
        res.set('Content-Type', 'application/x-ndjson');
        res.flushHeaders();
        send({ type: 'run', runId });
      },
      onEvent: send,
    });
  } catch (err) {
    if (err instanceof SyncBusyError) {
      return res.status(409).json({ error: 'Sync already in progress', runId: err.runId });
    }
    console.error('[sync] Could not start a sync run:', err);
    return res.status(500).json({ error: err.message });
  }
  await run.done;
  res.end();
});

// GET /api/sync/status — last sync info (+ the running sync's runId, if any)
router.get('/sync/status', (req, res) => {
  const db = getDb();
  const last = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get();
  const { running, runId } = currentSync();
  res.json({ syncing: running, runId, last: last || null });
});

// GET /api/sync/current — is a sync running right now, and which run is it?
router.get('/sync/current', (req, res) => {
  res.json(currentSync());
});

// GET /api/sync/runs?limit= — newest sync runs (no events), for Settings.
router.get('/sync/runs', (req, res) => {
  res.json(listRuns(getDb(), { limit: req.query.limit ?? KEEP_RUNS }));
});

// GET /api/sync/runs/:id — one run with its full event log.
router.get('/sync/runs/:id', (req, res) => {
  const run = getRun(getDb(), Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Sync run not found' });
  res.json(run);
});

// GET /api/sync/runs/:id/events?after=<seq> — incremental events for a client
// re-attaching to a run. Status is read BEFORE the events, so once `finished`
// is true the returned events are guaranteed to include the run's last one.
router.get('/sync/runs/:id/events', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const run = db.prepare('SELECT status FROM sync_runs WHERE id = ?').get(id);
  if (!run) return res.status(404).json({ error: 'Sync run not found' });
  const events = getEvents(db, id, { afterSeq: req.query.after ?? 0 });
  res.json({ status: run.status, finished: isFinished(run.status), events });
});

// GET /api/sync/metrics — latest sync_metrics row, with failed_assignment_ids
// parsed back to an array. Returns null if no syncs have completed yet.
router.get('/sync/metrics', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, sync_log_id, started_at, duration_ms,
           submission_calls, rate_limit_hits, transient_failures,
           retries_attempted, retries_succeeded, retries_failed,
           concurrency, rate_per_sec, abandoned, sections_skipped, failed_assignment_ids
    FROM sync_metrics
    ORDER BY id DESC
    LIMIT 1
  `).get();
  if (!row) return res.json(null);
  row.failed_assignment_ids = row.failed_assignment_ids ? JSON.parse(row.failed_assignment_ids) : [];
  res.json(row);
});

export default router;
