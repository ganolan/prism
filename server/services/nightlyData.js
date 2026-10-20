// The last full PowerSchool read (blocks, school calendar, alerts), stamped by the unified sync
// (#171). The dashboard's nightly line says when this data was last read, and the sync help ("?")
// whether the nightly run keeps it fresh, so the teacher need not tick a PowerSchool box.
import { getSyncScheduleSettings } from './settings.js';

export const NIGHTLY_DATA_KEY = 'sync.nightlyDataReadAt';

export function recordNightlyDataRead(db, at) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(NIGHTLY_DATA_KEY, JSON.stringify(at));
}

// readAt: ISO time of the last full read, or null. nightly: the nightly run will read it again,
// which needs the scheduler armed on this server (prod only) and both Settings switches on.
export function nightlyDataStatus(db, { schedulerActive }) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(NIGHTLY_DATA_KEY);
  let readAt = null;
  try { readAt = row ? JSON.parse(row.value) : null; } catch { readAt = null; }
  const s = getSyncScheduleSettings(db);
  return {
    readAt: typeof readAt === 'string' ? readAt : null,
    nightly: Boolean(schedulerActive && s.enabled && s.syncBlocks),
  };
}
