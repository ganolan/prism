import { Router } from 'express';
import { getDb } from '../db/index.js';
import {
  getTriageSettings, updateTriageSettings, getSyncScheduleSettings, updateSyncScheduleSettings,
} from '../services/settings.js';
import { getSyncScheduler, readLastScheduledRun } from '../services/syncScheduler.js';

const router = Router();

// The schedule's live state: is the scheduler running on this server (prod
// only), when it next fires, and how the last scheduled run went.
function syncScheduleStatus(db) {
  return getSyncScheduler()?.status() ?? { active: false, nextRunAt: null, last: readLastScheduledRun(db) };
}

function body(db) {
  return {
    triage: getTriageSettings(db),
    syncSchedule: getSyncScheduleSettings(db),
    syncScheduleStatus: syncScheduleStatus(db),
  };
}

// GET /api/settings — { triage: {...}, syncSchedule: {...}, syncScheduleStatus: { active, nextRunAt, last } }
router.get('/', (req, res) => {
  res.json(body(getDb()));
});

// PUT /api/settings — body { triage?: {...partial}, syncSchedule?: {...partial} }; values are clamped server-side.
router.put('/', (req, res) => {
  const db = getDb();
  if (req.body?.triage) updateTriageSettings(db, req.body.triage);
  if (req.body?.syncSchedule) {
    updateSyncScheduleSettings(db, req.body.syncSchedule);
    getSyncScheduler()?.reschedule();
  }
  res.json(body(db));
});

export default router;
