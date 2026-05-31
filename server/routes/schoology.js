import { Router } from 'express';
import { getDb } from '../db/index.js';
import { runUnifiedSync } from '../services/syncOrchestrator.js';

const router = Router();

let syncInProgress = false;

// POST /api/sync — run the unified sync, streaming progress as newline-
// delimited JSON. Body: {
//   masteryCourseIds?: number[],
//   skipSchoology?: boolean,
//   includeHidden?: boolean,    // #56: opt in to syncing hidden courses
// }.
// Note: if the client disconnects mid-stream the sync continues to completion
// server-side; there is no cancellation on client disconnect.
router.post('/sync', async (req, res) => {
  if (syncInProgress) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }

  syncInProgress = true;
  const {
    masteryCourseIds = [],
    skipSchoology = false,
    includeHidden = false,
  } = req.body || {};
  res.set('Content-Type', 'application/x-ndjson');
  res.flushHeaders();
  const write = (evt) => res.write(JSON.stringify(evt) + '\n');
  try {
    await runUnifiedSync({ masteryCourseIds, skipSchoology, includeHidden }, write);
  } catch (err) {
    console.error('[sync] Error:', err);
    write({ type: 'error', message: err.message });
  } finally {
    syncInProgress = false;
    res.end();
  }
});

// GET /api/sync/status — last sync info
router.get('/sync/status', (req, res) => {
  const db = getDb();
  const last = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get();
  res.json({ syncing: syncInProgress, last: last || null });
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
