// Scheduled sync: a nightly unified sync at the Settings time (server-local
// HH:MM), with the Settings options. Runs only where PRISM_SCHEDULED_SYNC=1
// (the prod launchd agent sets it): settings live in the database, and dev
// clones copy prod's database, so the setting alone would also arm every
// laptop.
//
// A 30s tick compares the clock with the next due time instead of one long
// setTimeout: it never fires early (so one 03:00 can't run twice), and a run
// missed while the machine slept fires once on wake. A server that starts after
// today's time waits for tomorrow (no catch-up).
import { getSyncScheduleSettings } from './settings.js';
import { launchSync, SyncBusyError } from './syncRunner.js';
import { clampDays } from './recentWindow.js';

const TICK_MS = 30_000;
const LAST_KEY = 'syncScheduleState.lastRun';

// The first HH:MM strictly after `now` (today, else tomorrow), in server-local time.
export function nextRunAt(now, time) {
  const [h, m] = time.split(':').map(Number);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

// The same options the Sync dialog sends, built from the schedule settings.
// mastery 'all' = the courses the dialog ticks by default (active, not hidden),
// plus hidden ones when hidden courses are included.
export function scheduledSyncOptions(db, s) {
  const masteryCourseIds = s.mastery === 'all'
    ? db.prepare(`
        SELECT id FROM courses
        WHERE COALESCE(archived, 0) = 0 AND COALESCE(excluded, 0) = 0 AND (COALESCE(hidden, 0) = 0 OR ?)
        ORDER BY id
      `).all(s.includeHidden ? 1 : 0).map((r) => r.id)
    : [];
  return {
    masteryCourseIds,
    skipSchoology: false,
    includeHidden: s.includeHidden,
    recentOnly: s.recentOnly,
    recentDays: clampDays(s.recentDays),
    syncBlocks: s.syncBlocks,
    trigger: 'scheduled',
  };
}

export function readLastScheduledRun(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LAST_KEY);
  let last;
  try { last = row ? JSON.parse(row.value) : null; } catch { return null; }
  // A run cut off by a restart stays 'running' here; sync_runs knows it was interrupted.
  if (last?.status === 'running' && last.runId != null) {
    const run = db.prepare('SELECT status FROM sync_runs WHERE id = ?').get(last.runId);
    if (run && run.status !== 'running') return { ...last, status: run.status };
  }
  return last;
}

function writeLastScheduledRun(db, last) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(LAST_KEY, JSON.stringify(last));
}

export function createSyncScheduler({
  db,
  active,
  launch = launchSync,
  now = () => new Date(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = (m) => console.log(m),
}) {
  let nextAt = null;
  let interval = null;
  let firing = null;

  function reschedule() {
    const s = getSyncScheduleSettings(db);
    nextAt = active && s.enabled ? nextRunAt(now(), s.time) : null;
  }

  async function fire() {
    const startedAt = now().toISOString();
    nextAt = null;
    try {
      const options = scheduledSyncOptions(db, getSyncScheduleSettings(db));
      const { runId, done } = launch(options);
      log(`[schedule] Scheduled sync started (run ${runId})`);
      writeLastScheduledRun(db, { at: startedAt, status: 'running', runId });
      const status = await done;
      writeLastScheduledRun(db, { at: startedAt, status, runId });
      log(`[schedule] Scheduled sync ${status} (run ${runId})`);
    } catch (err) {
      if (err instanceof SyncBusyError) {
        writeLastScheduledRun(db, { at: startedAt, status: 'skipped', runId: err.runId, message: 'A sync was already running' });
        log(`[schedule] Scheduled sync skipped: run ${err.runId} was already running`);
      } else {
        writeLastScheduledRun(db, { at: startedAt, status: 'failed', message: err.message });
        log(`[schedule] Scheduled sync could not start: ${err.message}`);
      }
    } finally {
      reschedule();
    }
  }

  function tick() {
    if (firing || !nextAt || now() < nextAt) return null;
    firing = fire().finally(() => { firing = null; });
    return firing;
  }

  return {
    start() {
      reschedule();
      if (!active) return;
      interval = setIntervalFn(tick, TICK_MS);
      interval?.unref?.();
      log(`[schedule] Scheduled sync armed; next run ${nextAt ? nextAt.toString() : 'off (disabled in Settings)'}`);
    },
    stop() {
      if (interval) clearIntervalFn(interval);
      interval = null;
    },
    reschedule,
    tick,
    status() {
      return { active, nextRunAt: nextAt ? nextAt.toISOString() : null, last: readLastScheduledRun(db) };
    },
  };
}

let instance = null;

export function startSyncScheduler(opts) {
  instance?.stop();
  instance = createSyncScheduler(opts);
  instance.start();
  return instance;
}

export function getSyncScheduler() {
  return instance;
}
