// Persistent record of every run in the sync queue (syncQueue.js: queued, held,
// running, finished) and every progress event each one reported. Two jobs:
//   1. Following: the progress dialog and the pages' chips poll
//      getEvents(runId, afterSeq) from the last seq they saw; the run carries on
//      server-side whether or not anyone is following it.
//   2. History: Settings → Recent syncs lists the newest runs and their logs.
// Event shapes are the orchestrator's (see syncOrchestrator.js).

export const KEEP_RUNS = 30;

const FINISHED = ['completed', 'completed_with_errors', 'failed', 'interrupted'];

// Severity of one event, used for the run's error/warning counts and for
// highlighting lines in the log view.
//   error   — `type: 'error'` (route-level failure) or any `status: 'error'`
//             phase (a step that did not sync).
//   warning — a blocks phase that finished with courses PowerSchool hasn't
//             published yet (`notReady > 0`), or a log line that says it hit
//             a problem but carried on ("Warning: …", "… failed …",
//             "could not …", "abandoned"). Matched on words the sync services
//             actually log; a plain "N skipped" tally is NOT a warning (PCG /
//             template courses are skipped by design every sync).
//   null    — everything else.
// "0 failed" is a count, not a failure (the blocks phase's grade-level line).
const WARNING_LOG = /\bwarn(ing)?\b|(?<!\b0 )\bfailed\b|\bcould(?: not|n't)\b|\babandon/i;

export function classifyEvent(evt) {
  if (!evt || typeof evt !== 'object') return null;
  if (evt.type === 'error' || evt.status === 'error') return 'error';
  if (evt.phase && Number(evt.notReady) > 0) return 'warning';
  if (evt.type === 'log' && WARNING_LOG.test(String(evt.message || ''))) return 'warning';
  return null;
}

const nowIso = () => new Date().toISOString();

function parse(json) {
  if (json == null) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function shapeRun(row) {
  if (!row) return null;
  const { options_json, summary_json, ...rest } = row;
  return { ...rest, options: parse(options_json), summary: parse(summary_json) };
}

function shapeEvent(row) {
  const evt = parse(row.event_json) || {};
  return { ...evt, seq: row.seq, at: row.at, level: classifyEvent(evt) };
}

export function startRun(db, options = {}) {
  return Number(db.prepare(
    `INSERT INTO sync_runs (started_at, status, options_json) VALUES (?, 'running', ?)`
  ).run(nowIso(), JSON.stringify(options ?? {})).lastInsertRowid);
}

// Append one event and return its seq (1-based, per run). Counts are bumped
// here so a running run's list row is live.
export function appendEvent(db, runId, evt) {
  const level = classifyEvent(evt);
  const tx = db.transaction(() => {
    const seq = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM sync_run_events WHERE run_id = ?'
    ).get(runId).next;
    db.prepare('INSERT INTO sync_run_events (run_id, seq, at, event_json) VALUES (?, ?, ?, ?)')
      .run(runId, seq, nowIso(), JSON.stringify(evt));
    if (level) {
      const col = level === 'error' ? 'error_count' : 'warning_count';
      db.prepare(`UPDATE sync_runs SET ${col} = COALESCE(${col}, 0) + 1 WHERE id = ?`).run(runId);
    }
    return seq;
  });
  return tx();
}

// Close a run. A 'completed' run that logged any error events is stored as
// 'completed_with_errors' (the orchestrator returned, but something failed).
export function finishRun(db, runId, { status = 'completed', summary = null } = {}) {
  const row = db.prepare('SELECT error_count FROM sync_runs WHERE id = ?').get(runId);
  if (!row) return;
  const final = status === 'completed' && row.error_count > 0 ? 'completed_with_errors' : status;
  db.prepare('UPDATE sync_runs SET status = ?, finished_at = ?, summary_json = ? WHERE id = ?')
    .run(final, nowIso(), summary == null ? null : JSON.stringify(summary), runId);
}

export function listRuns(db, { limit = KEEP_RUNS } = {}) {
  const n = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || KEEP_RUNS));
  return db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?').all(n).map(shapeRun);
}

export function getRun(db, id) {
  const run = shapeRun(db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(id));
  if (!run) return null;
  return { ...run, events: getEvents(db, id) };
}

export function getEvents(db, runId, { afterSeq = 0 } = {}) {
  const after = Number.parseInt(afterSeq, 10) || 0;
  return db.prepare(
    'SELECT seq, at, event_json FROM sync_run_events WHERE run_id = ? AND seq > ? ORDER BY seq'
  ).all(runId, after).map(shapeEvent);
}

export function isFinished(status) {
  return FINISHED.includes(status);
}

// Keep the newest `keep` runs; delete older runs and their events.
export function pruneRuns(db, keep = KEEP_RUNS) {
  db.transaction(() => {
    const cutoff = db.prepare('SELECT id FROM sync_runs ORDER BY id DESC LIMIT 1 OFFSET ?').get(keep - 1);
    if (!cutoff) return;
    // A queued, held or running run is never pruned (the queue still holds it).
    const old = `id < ? AND status NOT IN ('queued', 'held', 'running')`;
    db.prepare(`DELETE FROM sync_run_events WHERE run_id IN (SELECT id FROM sync_runs WHERE ${old})`).run(cutoff.id);
    db.prepare(`DELETE FROM sync_runs WHERE ${old}`).run(cutoff.id);
  })();
}

// Called once at server start: nothing can be running in a fresh process, so a
// run still marked 'running' (or 'queued' / 'held': the queue lives in memory) was cut
// off by a crash, restart or deploy; the next page visit queues it again. Its
// finished_at is when it was last heard from (its last event, or its start if
// it logged nothing), so its duration isn't stretched to the next boot.
export function markInterruptedRuns(db) {
  return db.prepare(`
    UPDATE sync_runs SET status = 'interrupted',
      finished_at = COALESCE(
        finished_at,
        (SELECT MAX(at) FROM sync_run_events WHERE run_id = sync_runs.id),
        started_at
      )
    WHERE status IN ('running', 'queued', 'held')
  `).run().changes;
}
