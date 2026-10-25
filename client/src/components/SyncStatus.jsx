import { freshnessTime } from '../lib/formatDate.js';
import { goToSignIn } from '../lib/signIn.js';
import { Tip } from './HelpDot.jsx';

const DAY_MS = 24 * 60 * 60 * 1000;
const NIGHTLY_STALE_MS = 26 * 60 * 60 * 1000;

const CHIP = {
  queued: 'Waiting to sync…',
  running: 'Syncing…',
  failed: 'Last sync failed',
  held: 'Log in to Schoology',
};

const REFRESH_HINT = 'Press Sync Courses to refresh them.';

// The dashboard's second row: when blocks, calendar and alerts were last read (the nightly pass, or
// Sync Courses). Amber when never read or over 26 hours ago, so a missed night shows; it names the
// data, not the system (#171). `nightly` is not read here: a missed night is amber whether or not
// the night's refresh is on. An amber time carries `hint`, the popover on it.
export function nightlyLine(nightlyData, now = new Date()) {
  const label = 'Blocks, calendar and alerts';
  const readMs = nightlyData?.readAt ? Date.parse(nightlyData.readAt) : NaN;
  if (Number.isNaN(readMs)) return { label, time: 'not read yet', stale: true, hint: REFRESH_HINT };
  const age = now.getTime() - readMs;
  if (age > NIGHTLY_STALE_MS) {
    const days = Math.max(1, Math.floor(age / DAY_MS));
    return { label, time: `${days} ${days === 1 ? 'day' : 'days'} old`, stale: true, hint: REFRESH_HINT };
  }
  return { label, time: freshnessTime(nightlyData.readAt, now), stale: false };
}

// One row: a status dot (green when current, amber when old, gray for a past course's frozen data),
// what was read, and when, so the rows' times line up (#198, Graham's option 3 with dots).
function Row({ label, time, stale, archived, hint, children }) {
  const mod = stale ? ' sync-status__row--stale' : archived ? ' sync-status__row--archived' : '';
  return (
    <div className={`sync-status__row${mod}`}>
      <span className="sync-status__dot" aria-hidden="true" />
      <span className="sync-status__label">{label}</span>
      {hint ? <Tip className="sync-status__time" text={`${time}. ${hint}`} pop={hint}>{time}</Tip> : <span className="sync-status__time">{time}</span>}
      <span className="sync-status__help">{children}</span>
    </div>
  );
}

// One "Last successful sync" per page (Graham, 20/10/2026: confidence comes from not having to second
// guess the data): the last time everything in the page's scope synced, amber when a day old or never
// (never amber for an archived course, whose data is frozen), with the page's `help` ("?") after it.
// Under it, the dashboard's `nightlyData` row. On the right, the Sync button (none when `label` is
// null: the Archived tab shows the time alone, #171) and, under it while the page's background sync
// (useBackgroundSync) is queued, running, failed or waiting for a sign-in, a chip that opens the
// progress dialog on that run (`onOpen(runId)`), or the sign-in. One type size throughout (#198).
export default function SyncStatus({ label, syncedAt, archived = false, sync = { state: 'idle' }, onSync, onOpen, help, nightlyData, now = new Date() }) {
  const stale = !archived && (!syncedAt || now.getTime() - Date.parse(syncedAt) >= DAY_MS);
  const chip = CHIP[sync?.state];
  const nightly = nightlyData ? nightlyLine(nightlyData, now) : null;
  const busy = sync?.state === 'queued' || sync?.state === 'running';
  return (
    <div className="sync-status">
      <Row label="Last successful sync" time={syncedAt ? freshnessTime(syncedAt, now) : 'none yet'} stale={stale} archived={archived}>{help}</Row>
      {nightly && <Row {...nightly} />}
      <div className="sync-status__actions">
        {/* Usable while the page's sync only waits: a press goes ahead of page syncs. */}
        {label != null && (
          <button type="button" className="primary sync-status__button" onClick={onSync} disabled={sync?.state === 'running'}>
            {label}
          </button>
        )}
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
      </div>
    </div>
  );
}
