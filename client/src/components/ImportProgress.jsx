const STATUS_ICON = { pending: '○', running: '●', done: '✓', error: '✕' };

function CourseRow({ row }) {
  return (
    <div className={`sync-phase sync-phase-${row.status}`}>
      <span className="sync-phase-icon">{STATUS_ICON[row.status] || '○'}</span>
      <span className="sync-phase-label">{row.title}</span>
      <span className="sync-phase-count">
        {row.status === 'done' && row.counts && `${row.counts.students} students · ${row.counts.grades} grades`}
        {row.status === 'running' && 'importing…'}
        {row.status === 'error' && row.error}
      </span>
    </div>
  );
}

// Modal popup mirroring SyncProgress (#71), driven by useImportRunner's model.
// Non-dismissable while running (no backdrop/Escape). No login-remedy banner:
// gradebook import is OAuth-based and mastery is best-effort (mastery-if-session,
// per #70), so a dead session silently skips mastery rather than failing import.
export default function ImportProgress({ model, onRetry, onDone }) {
  const running = model.status === 'running';
  const done = model.status === 'done';
  const failed = model.failures.length;
  const succeeded = model.total - failed;

  let heading = 'Importing archived courses…';
  let headingClass = '';
  if (done) {
    heading = `Import complete · ${succeeded} of ${model.total}`;
    headingClass = failed ? 'sync-head-warn' : 'sync-head-ok';
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content sync-dialog">
        <div className="sync-progress">
          <div className={`sync-progress-head ${headingClass}`}>
            <h2>
              {running && <span className="sync-spinner" aria-hidden="true" />}
              {heading}
              {done && failed > 0 && <span className="badge badge-gray"> · {failed} failed</span>}
            </h2>
            {running && <p className="text-muted text-sm">Please don't close Prism — this can take a few minutes.</p>}
          </div>

          <div className="sync-bar">
            <div className="sync-bar-fill" style={{ width: `${Math.round(model.progress * 100)}%` }} />
          </div>

          <div className="sync-phase-list">
            {model.rows.map((row) => <CourseRow key={row.sectionId} row={row} />)}
          </div>

          {running && model.log.length > 0 && (
            <div className="sync-log">
              {model.log.slice(-40).map((line, i) => (
                <div key={Math.max(0, model.log.length - 40) + i}>{line}</div>
              ))}
            </div>
          )}

          <div className="sync-foot">
            <span className="text-muted text-sm">
              {done && failed > 0 && `${failed} couldn't be imported`}
            </span>
            <div className="sync-foot-actions">
              {done && failed > 0 && (
                <button type="button" className="secondary" onClick={onRetry}>Retry failed ({failed})</button>
              )}
              <button type="button" className="primary" onClick={onDone} disabled={running}>Done</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
