import { Router } from 'express';
import { fullSync } from '../services/sync.js';
import { getDb } from '../db/index.js';

const router = Router();

let syncInProgress = false;

// POST /api/sync — trigger full Schoology sync
router.post('/sync', async (req, res) => {
  if (syncInProgress) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }

  syncInProgress = true;
  try {
    const result = await fullSync((progress) => {
      // Could use SSE for real-time progress in future
      console.log(`[sync] ${progress.message}`);
    });
    res.json(result);
  } catch (err) {
    console.error('[sync] Error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    syncInProgress = false;
  }
});

// GET /api/sync/status — last sync info
router.get('/sync/status', (req, res) => {
  const db = getDb();
  const last = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get();
  res.json({ syncing: syncInProgress, last: last || null });
});

export default router;
