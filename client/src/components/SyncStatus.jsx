import { freshnessTime } from '../lib/formatDate.js';
import { goToSignIn } from '../lib/signIn.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const CHIP = {
  queued: 'Waiting to sync…',
  running: 'Syncing…',
  failed: 'Sync failed',
  held: 'Log in to Schoology',
};

// One "Synced …" per page (Graham, 20/10/2026: confidence comes from not having to second guess
// the data): the last time everything in the page's scope synced, amber when a day old or never
// (never amber for an archived course, whose data is frozen). Beside it, the Sync button, and
// while the page's background sync (useBackgroundSync) is queued, running, failed or waiting for
// a sign-in, a chip that opens the progress dialog on that run (`onOpen(runId)`), or the sign-in.
export default function SyncStatus({ label, syncedAt, archived = false, sync = { state: 'idle' }, onSync, onOpen, now = new Date() }) {
  const stale = !archived && (!syncedAt || now.getTime() - Date.parse(syncedAt) >= DAY_MS);
  const chip = CHIP[sync?.state];
  const busy = sync?.state === 'queued' || sync?.state === 'running';
  return (
    <div className={`sync-status${stale ? ' sync-status--stale' : ''}`}>
      <div className="sync-status__row">
        <span className="sync-status__time">{syncedAt ? `Synced ${freshnessTime(syncedAt, now)}` : 'Not synced yet'}</span>
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
        <button type="button" className="primary sync-status__button" onClick={onSync} disabled={sync?.state === 'running'}>
          {label}
        </button>
      </div>
    </div>
  );
}
