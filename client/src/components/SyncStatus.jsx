import { freshnessTime } from './MasteryFreshness.jsx';
import { goToSignIn } from '../lib/signIn.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// The check line: the pages' own background reads (useMasteryRefresh states: mastery #52,
// submissions and scores #108). Refreshing while any is; else a failure if any failed; else the
// latest time any of them read.
function checkLine(checks, now) {
  if (!checks.length) return null;
  if (checks.some((c) => c?.status === 'refreshing')) return { text: 'Checking Schoology for new work…' };
  const failed = checks.filter((c) => c?.status === 'error');
  if (failed.length) {
    return {
      text: 'Could not check Schoology for new work.', error: true,
      title: failed.map((c) => c.error).filter(Boolean).join('; '), signIn: failed.some((c) => c.signIn),
    };
  }
  const times = checks.map((c) => c?.syncedAt).filter(Boolean).sort();
  const latest = times[times.length - 1];
  return latest ? { text: `Checked for new work at ${freshnessTime(latest, now)}.` } : null;
}

// #58: a prominent "Synced …" (the last full sync of the course or task: nightly, Sync Courses, or
// this button), amber when a day old or never; the button beside it; and one small line for the
// pages' own background reads.
export default function SyncStatus({ label, syncedAt, syncing = false, onSync, checks = [], now = new Date() }) {
  const stale = !syncedAt || now.getTime() - Date.parse(syncedAt) >= DAY_MS;
  const check = checkLine(checks, now);
  return (
    <div className={`sync-status${stale ? ' sync-status--stale' : ''}`}>
      <div className="sync-status__row">
        <span className="sync-status__time">{syncedAt ? `Synced ${freshnessTime(syncedAt, now)}` : 'Not synced yet'}</span>
        <button type="button" className="primary sync-status__button" onClick={onSync} disabled={syncing}>
          {syncing ? 'Syncing…' : label}
        </button>
      </div>
      {check && (
        <p className={`sync-status__check${check.error ? ' sync-status__check--error' : ''}`} role="status" title={check.title || undefined}>
          {check.text}
          {check.signIn && (
            <> <button type="button" className="ghost accent sync-status__signin" onClick={goToSignIn}>Log in to Schoology</button></>
          )}
        </p>
      )}
    </div>
  );
}
