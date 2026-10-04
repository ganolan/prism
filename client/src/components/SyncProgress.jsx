const STATUS_ICON = { running: '●', done: '✓', error: '✕' };

function PhaseRow({ phase }) {
  const status = phase.status || 'pending';
  return (
    <div className={`sync-phase sync-phase-${status}`}>
      <span className="sync-phase-icon">{STATUS_ICON[status] || '○'}</span>
      <span className="sync-phase-label">{phase.label}</span>
      <span className="sync-phase-count">
        {phase.status === 'done' && phase.records != null && `${phase.records} records`}
        {phase.status === 'running' && 'syncing…'}
        {phase.status === 'error' && 'not synced'}
      </span>
    </div>
  );
}

// Informational (not an error/warning) — 'section-info-failed' courses just
// haven't had their PowerSchool schedule published yet, most commonly right
// after the new-school-year rollover. Nothing to retry; it self-heals on a
// later sync once PowerSchool has the term set up.
function BlocksPendingBanner({ count }) {
  const singular = count === 1;
  return (
    <div className="alert alert-info sync-remedy">
      <p>
        {count} course{singular ? '' : 's'} {singular ? "doesn't" : "don't"} have a PowerSchool
        block number yet: PowerSchool hasn't published {singular ? 'its' : 'their'} schedule for
        the new school year. This resolves automatically on a later sync.
      </p>
    </div>
  );
}

// onRetry is a bound, zero-arg callback — the caller decides what "retry"
// means for this failure (re-run one mastery course vs. re-run the whole
// blocks pass), so this banner stays agnostic to which phase it's for.
function RemedyBanner({ failure, retryEnabled, onLogin, onRetry }) {
  const isLogin = failure.errorKind === 'login';
  return (
    <div
      data-testid={`remedy-${failure.key}`}
      className={`alert ${isLogin ? 'alert-warning' : 'alert-error'} sync-remedy`}
    >
      {isLogin ? (
        <p>
          <strong>{failure.label}</strong> couldn't sync: the Schoology session expired.
          Log in again, then retry.
        </p>
      ) : (
        <p>
          <strong>{failure.label}</strong> failed: {failure.message}. This is usually
          temporary: retry, or try again later from the Sync menu.
        </p>
      )}
      <div className="sync-remedy-actions">
        {isLogin && (
          <button type="button" className="secondary" onClick={onLogin}>Log in to Schoology</button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={onRetry}
          disabled={isLogin && !retryEnabled}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

// `notice` is a muted status line under the heading (e.g. "Connection lost —
// still syncing on the server…") — informational, never styled as an error.
// mode 'stalled' = the dialog lost touch with Prism while following a run:
// neutral (amber), with Try again (`onTryAgain`) and Close. `onClose`, when
// given, lets the teacher close the dialog while the sync runs.
export default function SyncProgress({ reduced, mode, notice, retryEnabled, onDone, onClose, onTryAgain, onRetry, onRetryBlocks, onLogin }) {
  const { phases, logLines, failures, progress, summary, fatal } = reduced;
  const running = mode === 'running';
  const blocksPhase = phases.find((p) => p.kind === 'blocks');
  const blocksFailure = failures.find((f) => f.kind === 'blocks');

  let heading = 'Syncing…';
  let headingClass = '';
  if (mode === 'stalled') { heading = "Can't reach Prism"; headingClass = 'sync-head-warn'; }
  if (mode === 'done') {
    if (fatal) { heading = 'Sync failed'; headingClass = 'sync-head-error'; }
    else if (failures.length) { heading = 'Sync finished with issues'; headingClass = 'sync-head-warn'; }
    else { heading = 'Sync complete'; headingClass = 'sync-head-ok'; }
  }

  return (
    <div className="sync-progress">
      <div className={`sync-progress-head ${headingClass}`}>
        <h2>{running && <span className="sync-spinner" aria-hidden="true" />}{heading}</h2>
        {running && (
          <p className="text-muted text-sm">
            This takes a few minutes. You can close this or lock your screen. The sync keeps running on the server.
          </p>
        )}
        {running && notice && <p className="text-muted text-sm sync-notice" role="status">{notice}</p>}
      </div>

      <div className="sync-bar">
        <div className="sync-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>

      <div className="sync-phase-list">
        {phases.map((p) => <PhaseRow key={p.key} phase={p} />)}
      </div>

      {logLines.length > 0 && (
        <div className="sync-log">
          {logLines.slice(-40).map((line, i) => (
            <div key={Math.max(0, logLines.length - 40) + i}>{line}</div>
          ))}
        </div>
      )}

      {mode === 'stalled' && (
        <div className="alert alert-warning sync-remedy" role="status">
          Couldn't reach Prism: the sync may still be running. Check Settings → Recent syncs.
        </div>
      )}

      {mode === 'done' && blocksPhase?.notReady > 0 && (
        <BlocksPendingBanner count={blocksPhase.notReady} />
      )}

      {mode === 'done' && blocksFailure && (
        <RemedyBanner
          failure={blocksFailure}
          retryEnabled={retryEnabled}
          onLogin={onLogin}
          onRetry={onRetryBlocks}
        />
      )}

      {mode === 'done' && failures.filter((f) => f.courseId != null).map((f) => (
        <RemedyBanner
          key={f.key}
          failure={f}
          retryEnabled={retryEnabled}
          onLogin={onLogin}
          onRetry={() => onRetry([f.courseId])}
        />
      ))}

      <div className="sync-foot">
        <span className="text-muted text-sm">
          {summary && mode === 'done' && `Finished in ${(summary.elapsedMs / 1000).toFixed(0)}s`}
        </span>
        {mode === 'stalled' ? (
          <span className="sync-foot-actions">
            <button type="button" className="secondary" onClick={onTryAgain}>Try again</button>
            <button type="button" className="primary" onClick={onClose ?? onDone}>Close</button>
          </span>
        ) : running && onClose ? (
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        ) : (
          <button type="button" className="primary" onClick={onDone} disabled={running}>Done</button>
        )}
      </div>
    </div>
  );
}
