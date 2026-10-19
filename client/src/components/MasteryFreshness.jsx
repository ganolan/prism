import { formatDateTime, localIsoDate } from '../lib/formatDate.js';
import { goToSignIn } from '../lib/signIn.js';

// "14:05 today", else "18/10/2026, 03:02".
export function freshnessTime(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (localIsoDate(d) === localIsoDate(now)) {
    return `${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })} today`;
  }
  return formatDateTime(d);
}

// #52: one line under a page header: when the mastery levels on the page were read from Schoology,
// whether a refresh is running, or why it failed. `state` is useMasteryRefresh's answer; `syncedAt`
// the stamp the page's data came with (shown until the refresh answers).
// The later of the two stamps wins: a page reloaded after Sync Mastery carries a newer one than the
// background refresh answered, and that read also clears the refresh's error.
export default function MasteryFreshness({ state, syncedAt, now }) {
  const refreshAt = state?.syncedAt ?? null;
  const dataNewer = Boolean(syncedAt) && (!refreshAt || Date.parse(syncedAt) > Date.parse(refreshAt));
  const at = dataNewer ? syncedAt : refreshAt ?? syncedAt ?? null;
  const status = dataNewer && state?.status === 'error' ? 'done' : state?.status;
  const when = freshnessTime(at, now);
  // Before the refresh starts there is nothing to say yet about a course never read.
  if ((!status || status === 'idle') && !when) return null;
  let text;
  let tone = '';
  if (status === 'refreshing') {
    text = when ? `Mastery levels as of ${when}. Checking Schoology for changes…` : 'Reading mastery levels from Schoology…';
  } else if (status === 'error') {
    tone = ' mastery-freshness--error';
    text = `Could not refresh mastery levels from Schoology. ${when ? `Showing levels read at ${when}.` : 'No levels read yet.'}`;
  } else if (when) {
    text = `Mastery levels read from Schoology at ${when}.`;
  } else {
    text = 'Mastery levels not yet read from Schoology.';
  }
  return (
    <p className={`mastery-freshness${tone}`} role="status" title={status === 'error' && !state.signIn ? state.error : undefined}>
      {text}
      {status === 'error' && state.signIn && (
        <> <button type="button" className="ghost accent mastery-freshness__action" onClick={goToSignIn}>Log in to Schoology</button></>
      )}
    </p>
  );
}
