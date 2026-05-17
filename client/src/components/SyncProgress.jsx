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

function RemedyBanner({ failure, retryEnabled, onLogin, onRetry }) {
  const isLogin = failure.errorKind === 'login';
  return (
    <div
      data-testid={`remedy-${failure.key}`}
      className={`alert ${isLogin ? 'alert-warning' : 'alert-error'} sync-remedy`}
    >
      {isLogin ? (
        <p>
          <strong>{failure.label}</strong> couldn't sync — the Schoology session expired.
          Log in again, then retry.
        </p>
      ) : (
        <p>
          <strong>{failure.label}</strong> failed: {failure.message}. This is usually
          temporary — retry, or try again later from the Sync menu.
        </p>
      )}
      <div className="sync-remedy-actions">
        {isLogin && (
          <button type="button" className="secondary" onClick={onLogin}>Log in to Schoology</button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => onRetry([failure.courseId])}
          disabled={isLogin && !retryEnabled}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

export default function SyncProgress({ reduced, mode, retryEnabled, onDone, onRetry, onLogin }) {
  const { phases, logLines, failures, progress, summary, fatal } = reduced;
  const running = mode === 'running';

  let heading = 'Syncing…';
  let headingClass = '';
  if (mode === 'done') {
    if (fatal) { heading = 'Sync failed'; headingClass = 'sync-head-error'; }
    else if (failures.length) { heading = 'Sync finished with issues'; headingClass = 'sync-head-warn'; }
    else { heading = 'Sync complete'; headingClass = 'sync-head-ok'; }
  }

  return (
    <div className="sync-progress">
      <div className={`sync-progress-head ${headingClass}`}>
        <h2>{running && <span className="sync-spinner" aria-hidden="true" />}{heading}</h2>
        {running && <p className="text-muted text-sm">Please don't close Prism — this takes a minute.</p>}
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

      {mode === 'done' && failures.filter((f) => f.courseId != null).map((f) => (
        <RemedyBanner
          key={f.key}
          failure={f}
          retryEnabled={retryEnabled}
          onLogin={onLogin}
          onRetry={onRetry}
        />
      ))}

      <div className="sync-foot">
        <span className="text-muted text-sm">
          {summary && mode === 'done' && `Finished in ${(summary.elapsedMs / 1000).toFixed(0)}s`}
        </span>
        <button type="button" className="primary" onClick={onDone} disabled={running}>Done</button>
      </div>
    </div>
  );
}
