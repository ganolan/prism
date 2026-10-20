import { freshnessTime } from '../lib/formatDate.js';
import { goToSignIn } from '../lib/signIn.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NIGHTLY_STALE_MS = 26 * 60 * 60 * 1000;

const CHIP = {
  queued: 'Waiting to sync…',
  running: 'Syncing…',
  failed: 'Sync failed',
  held: 'Log in to Schoology',
};

// The dashboard's second line: when blocks, calendar and alerts were last read (the nightly pass, or
// Sync Courses). Amber when never read or over 26 hours ago, so a missed night shows; it names the
// data, not the system (#171). `nightly` is not read here: a missed night is amber whether or not
// the night's refresh is on.
export function nightlyLine(nightlyData, now = new Date()) {
  const name = 'Blocks, calendar and alerts:';
  const readMs = nightlyData?.readAt ? Date.parse(nightlyData.readAt) : NaN;
  if (Number.isNaN(readMs)) return { text: `${name} not read yet. Press Sync Courses to refresh them.`, stale: true };
  const age = now.getTime() - readMs;
  if (age > NIGHTLY_STALE_MS) {
    const days = Math.max(1, Math.floor(age / DAY_MS));
    return { text: `${name} ${days} ${days === 1 ? 'day' : 'days'} old. Press Sync Courses to refresh them.`, stale: true };
  }
  return { text: `${name} ${freshnessTime(nightlyData.readAt, now)}`, stale: false };
}

// One "Synced …" per page (Graham, 20/10/2026: confidence comes from not having to second guess
// the data): the last time everything in the page's scope synced, amber when a day old or never
// (never amber for an archived course, whose data is frozen). Beside it, the Sync button (none when
// `label` is null: the Archived tab shows the time alone, #171), the page's `help` ("?") after the
// time, the dashboard's `nightlyData` line beneath, and
// while the page's background sync (useBackgroundSync) is queued, running, failed or waiting for
// a sign-in, a chip that opens the progress dialog on that run (`onOpen(runId)`), or the sign-in.
export default function SyncStatus({ label, syncedAt, archived = false, sync = { state: 'idle' }, onSync, onOpen, help, nightlyData, now = new Date() }) {
  const stale = !archived && (!syncedAt || now.getTime() - Date.parse(syncedAt) >= DAY_MS);
  const chip = CHIP[sync?.state];
  const nightly = nightlyData ? nightlyLine(nightlyData, now) : null;
  const busy = sync?.state === 'queued' || sync?.state === 'running';
  return (
    <div className={`sync-status${stale ? ' sync-status--stale' : ''}`}>
      <div className="sync-status__row">
        <span className="sync-status__time">{syncedAt ? `Synced ${freshnessTime(syncedAt, now)}` : 'Not synced yet'}</span>
        {help}
        {chip && (
          <button
            type="button"
            className={`sync-status__chip sync-status__chip--${sync.state}`}
            onClick={() => (sync.state === 'held' ? goToSignIn() : onOpen?.(sync.runId))}
          >
            {busy && <span className="sync-spinner" aria-hidden="true" />}
            {chip}
          </button>
        )}
        {/* Usable while the page's sync only waits: a press goes ahead of page syncs. */}
        {label != null && (
          <button type="button" className="primary sync-status__button" onClick={onSync} disabled={sync?.state === 'running'}>
            {label}
          </button>
        )}
      </div>
      {nightly && (
        <div className={`sync-status__nightly${nightly.stale ? ' sync-status__nightly--stale' : ''}`}>{nightly.text}</div>
      )}
    </div>
  );
}
