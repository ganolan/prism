import { useEffect, useState } from 'react';
import { getSyncRuns, getSyncRun } from '../services/api.js';
import { formatDateTime, formatTime } from '../lib/formatDate.js';
import { runStatus, formatDuration, describeOptions, describeRunEvent } from '../lib/syncRunLog.js';

const LIMIT = 30;
// How often an expanded log of a still-running sync re-fetches itself.
const REFRESH_MS = 3000;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function counts(run) {
  const parts = [];
  if (run.error_count) parts.push(plural(run.error_count, 'error'));
  if (run.warning_count) parts.push(plural(run.warning_count, 'warning'));
  return parts.join(' · ');
}

// `reloadKey` changes on the card's Refresh. A running sync's log re-fetches
// every `refreshMs` while open; when it finishes, `onFinished` lets the card
// reload the list so the row's badge/duration/counts catch up.
function RunLog({ runId, reloadKey, refreshMs, onFinished }) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let wasRunning = false;
    function load() {
      getSyncRun(runId)
        .then((r) => {
          if (cancelled) return;
          setRun(r);
          setError(null);
          if (r.status === 'running') {
            wasRunning = true;
            timer = setTimeout(load, refreshMs);
          } else if (wasRunning) {
            onFinished?.();
          }
        })
        .catch((err) => { if (!cancelled) setError(err.message); });
    }
    load();
    return () => { cancelled = true; clearTimeout(timer); };
    // onFinished is the card's stable reload; re-running on its identity would refetch needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, reloadKey, refreshMs]);

  if (error) return <p className="text-sm error-msg">Could not load this sync's log: {error}</p>;
  if (!run) return <p className="text-sm text-muted">Loading log…</p>;
  const lines = run.events.map((evt) => ({ evt, line: describeRunEvent(evt) })).filter((x) => x.line);
  if (!lines.length) return <p className="text-sm text-muted">This sync logged nothing.</p>;

  return (
    <div className="sync-run-log" role="log" aria-label={`Sync log for ${formatDateTime(run.started_at)}`}>
      {lines.map(({ evt, line }) => (
        <div key={evt.seq} className={`sync-run-line${line.level ? ` sync-run-line-${line.level}` : ''}`}>
          <span className="sync-run-line-time">{formatTime(evt.at)}</span>
          <span className="sync-run-line-icon" aria-hidden="true">{line.icon}</span>
          <span className="sync-run-line-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

// Settings → Recent syncs: the last 30 sync runs, each expandable to the full
// event log it reported (kept server-side, so a sync whose dialog lost its
// connection still has a complete record).
export default function RecentSyncs({ refreshMs = REFRESH_MS }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  function loadList() {
    setError(null);
    getSyncRuns(LIMIT).then(setRuns).catch((err) => setError(err.message));
  }
  useEffect(loadList, []);

  function refresh() {
    loadList();
    setReloadKey((k) => k + 1); // re-fetches an expanded log too
  }

  return (
    <section className="card settings-section">
      <div className="sync-runs-head">
        <h3>Recent syncs</h3>
        <button type="button" className="ghost accent" onClick={refresh}>Refresh</button>
      </div>
      {error && <p className="text-sm error-msg">Could not load recent syncs: {error}</p>}
      {!error && !runs && <p className="text-sm text-muted">Loading…</p>}
      {runs?.length === 0 && <p className="text-sm text-muted">No syncs recorded yet.</p>}
      {runs?.length > 0 && (
        <ul className="sync-runs">
          {runs.map((run) => {
            const status = runStatus(run);
            const open = openId === run.id;
            const what = describeOptions(run.options);
            const tally = counts(run);
            const logId = `sync-run-log-${run.id}`;
            return (
              <li key={run.id} className="sync-run">
                <button
                  type="button"
                  className="ghost sync-run-row"
                  aria-expanded={open}
                  aria-controls={logId}
                  onClick={() => setOpenId(open ? null : run.id)}
                >
                  <span className="sync-run-when">{formatDateTime(run.started_at)}</span>
                  <span className={`badge ${status.badge}`}>{status.label}</span>
                  <span className="sync-run-meta text-muted">
                    {formatDuration(run.started_at, run.finished_at) && <span>{formatDuration(run.started_at, run.finished_at)}</span>}
                    {what && <span>{what}</span>}
                    {tally && <span className={run.error_count ? 'sync-run-errors' : 'sync-run-warnings'}>{tally}</span>}
                  </span>
                </button>
                {open && (
                  <div id={logId}>
                    <RunLog runId={run.id} reloadKey={reloadKey} refreshMs={refreshMs} onFinished={loadList} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
