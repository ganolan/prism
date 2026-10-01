import { useEffect, useState } from 'react';
import { getReferrals, undoReferral, getExtensions, undoExtension } from '../../services/api.js';
import { formatDate } from '../../lib/formatDate.js';
import { courseLabel } from '../../lib/triage.js';

// SQLite UTC 'YYYY-MM-DD HH:MM:SS'. A re-extended extension dates from its updatedAt.
const recordedAt = (r) => r.updatedAt || r.createdAt;
const recordedOn = (r) => formatDate(`${recordedAt(r).replace(' ', 'T')}Z`);

// Referrals and deadline extensions, newest first, each undoable. `version`
// bumps when the parent records one, so an open history reloads.
export default function ReferralHistory({ courseId, version = 0, onClose, onChanged }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loadErrors, setLoadErrors] = useState([]);

  // Each half loads independently: a failed one shows its own error, the other still lists.
  async function load() {
    const [referrals, extensions] = await Promise.allSettled([getReferrals({ courseId }), getExtensions({ courseId })]);
    const ok = (res, kind) => (res.status === 'fulfilled' ? (res.value || []).map((r) => ({ ...r, kind })) : []);
    setLoadErrors([
      referrals.status === 'rejected' && `Couldn't load referrals: ${referrals.reason?.message}`,
      extensions.status === 'rejected' && `Couldn't load extensions: ${extensions.reason?.message}`,
    ].filter(Boolean));
    setRows([...ok(referrals, 'referral'), ...ok(extensions, 'extension')]
      .sort((x, y) => recordedAt(y).localeCompare(recordedAt(x))));
  }
  useEffect(() => { load(); }, [courseId, version]); // eslint-disable-line react-hooks/exhaustive-deps

  async function undo(r) {
    try {
      await (r.kind === 'extension' ? undoExtension(r.id) : undoReferral(r.id));
      setError(null);
    } catch (err) {
      setError(`Undo failed: ${err.message}`);
      return;
    }
    await load();
    onChanged?.();
  }

  return (
    <section className="card triage-history" aria-label="Referral history">
      <div className="triage-panel__head">
        <h3 className="triage-panel__title">Referred / extended</h3>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
      {error && <div className="alert alert-warning">{error}</div>}
      {loadErrors.map((msg) => <div key={msg} className="alert alert-warning">{msg}</div>)}
      {rows === null && <p className="text-sm text-muted">Loading…</p>}
      {rows?.length === 0 && loadErrors.length === 0 && <p className="text-sm text-muted">No referrals or extensions recorded yet.</p>}
      {rows?.map((r) => (
        <div key={`${r.kind}:${r.id}`} className="triage-row triage-row--history">
          <span className="triage-row__name">{r.studentName}</span>
          <span className="triage-row__task"><span className="triage-row__course">{courseLabel(r)}</span>{r.title}</span>
          {r.kind === 'referral'
            ? <span className="badge badge-red">Referred · day {r.daysLate}</span>
            : <span className="badge badge-gray">Extended +{r.lessons} → {formatDate(`${r.until}T00:00:00`)}</span>}
          <span className="text-sm text-muted">{recordedOn(r)}{r.note ? ` — ${r.note}` : ''}</span>
          <button className="ghost" onClick={() => undo(r)}>Undo</button>
        </div>
      ))}
    </section>
  );
}
