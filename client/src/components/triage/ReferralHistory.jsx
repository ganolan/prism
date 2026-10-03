import { useEffect, useState } from 'react';
import { getReferrals, undoReferral, getExtensions, undoExtension, getResubmissions, undoResubmission } from '../../services/api.js';
import { formatDate } from '../../lib/formatDate.js';
import CourseLine from './CourseLine.jsx';

// SQLite UTC 'YYYY-MM-DD HH:MM:SS'. A re-extended extension dates from its updatedAt.
// Resubmission history rows carry updatedAt/closedAt/createdAt instead (see `recordedAt` below).
const recordedAt = (r) => r.updatedAt || r.closedAt || r.createdAt;
const recordedOn = (r) => formatDate(`${recordedAt(r).replace(' ', 'T')}Z`);

const RESUB_LABEL = { asked: 'Asked', closed: 'Closed', done: 'Resubmitted', reviewed: 'Reviewed' };

// Referrals and deadline extensions (mode 'late', the default), or resubmission
// asks/closes/reviews (mode 'resubmissions'), newest first, each undoable.
// `version` bumps when the parent records one, so an open history reloads.
export default function ReferralHistory({ mode = 'late', courseId, version = 0, onClose, onChanged }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loadErrors, setLoadErrors] = useState([]);
  const resub = mode === 'resubmissions';

  // Each half loads independently: a failed one shows its own error, the other still lists.
  async function load() {
    if (resub) {
      try {
        const list = await getResubmissions({ courseId });
        setLoadErrors([]);
        setRows((list || []).map((r) => ({ ...r, kind: 'resubmission' }))
          .sort((x, y) => recordedAt(y).localeCompare(recordedAt(x))));
      } catch (err) {
        setLoadErrors([`Couldn't load resubmissions: ${err.message}`]);
        setRows([]);
      }
      return;
    }
    const [referrals, extensions] = await Promise.allSettled([getReferrals({ courseId }), getExtensions({ courseId })]);
    const ok = (res, kind) => (res.status === 'fulfilled' ? (res.value || []).map((r) => ({ ...r, kind })) : []);
    setLoadErrors([
      referrals.status === 'rejected' && `Couldn't load referrals: ${referrals.reason?.message}`,
      extensions.status === 'rejected' && `Couldn't load extensions: ${extensions.reason?.message}`,
    ].filter(Boolean));
    setRows([...ok(referrals, 'referral'), ...ok(extensions, 'extension')]
      .sort((x, y) => recordedAt(y).localeCompare(recordedAt(x))));
  }
  useEffect(() => { load(); }, [courseId, version, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  async function undo(r) {
    try {
      await (r.kind === 'extension' ? undoExtension(r.id) : r.kind === 'resubmission' ? undoResubmission(r.id) : undoReferral(r.id));
      setError(null);
    } catch (err) {
      setError(`Undo failed: ${err.message}`);
      return;
    }
    await load();
    onChanged?.();
  }

  return (
    <section className="card triage-history" aria-label={resub ? 'Resubmission history' : 'Referral history'}>
      <div className="triage-panel__head">
        <h3 className="triage-panel__title">{resub ? 'Resubmissions' : 'Referred / extended'}</h3>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
      {error && <div className="alert alert-warning">{error}</div>}
      {loadErrors.map((msg) => <div key={msg} className="alert alert-warning">{msg}</div>)}
      {rows === null && <p className="text-sm text-muted">Loading…</p>}
      {rows?.length === 0 && loadErrors.length === 0 && (
        <p className="text-sm text-muted">{resub ? 'No resubmission records yet.' : 'No referrals or extensions recorded yet.'}</p>
      )}
      {rows?.map((r) => (
        <div key={`${r.kind}:${r.id}`} className="triage-row triage-row--history">
          <div className="triage-row__text">
            <span className="triage-row__name" title={r.studentName}>{r.studentName}</span>
            <CourseLine row={r} />
            <div className="triage-row__task" title={r.title}>{r.title}</div>
          </div>
          <div className="triage-row__actions">
            {r.kind === 'referral' && <span className="badge badge-red">Referred · day {r.day}</span>}
            {r.kind === 'extension' && <span className="badge badge-gray">Extended +{r.lessons} → {formatDate(`${r.until}T00:00:00`)}</span>}
            {r.kind === 'resubmission' && (
              <span className="badge badge-resubmit">{RESUB_LABEL[r.outcome]}{r.outcome === 'asked' && r.until ? ` · by ${formatDate(`${r.until}T00:00:00`)}` : ''}</span>
            )}
            <span className="text-sm text-muted">{recordedOn(r)}{(r.closeNote || r.note) ? ` — ${r.closeNote || r.note}` : ''}</span>
            <button className="ghost" onClick={() => undo(r)}>Undo</button>
          </div>
        </div>
      ))}
    </section>
  );
}
