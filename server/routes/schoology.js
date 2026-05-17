import { Router } from 'express';
import { getDb } from '../db/index.js';
import { runUnifiedSync } from '../services/syncOrchestrator.js';

const router = Router();

let syncInProgress = false;

// POST /api/sync — run the unified sync, streaming progress as newline-
// delimited JSON. Body: { masteryCourseIds?: number[], skipSchoology?: boolean }.
// Note: if the client disconnects mid-stream the sync continues to completion
// server-side; there is no cancellation on client disconnect.
router.post('/sync', async (req, res) => {
  if (syncInProgress) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }

  syncInProgress = true;
  const { masteryCourseIds = [], skipSchoology = false } = req.body || {};
  res.set('Content-Type', 'application/x-ndjson');
  res.flushHeaders();
  const write = (evt) => res.write(JSON.stringify(evt) + '\n');
  try {
    await runUnifiedSync({ masteryCourseIds, skipSchoology }, write);
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

export default router;
