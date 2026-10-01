import { useEffect, useState } from 'react';
import { getReferrals, undoReferral, getExtensions, undoExtension } from '../../services/api.js';
import { formatDate } from '../../lib/formatDate.js';
import { courseLabel } from '../../lib/triage.js';

// createdAt is SQLite UTC 'YYYY-MM-DD HH:MM:SS'.
const createdOn = (r) => formatDate(`${r.createdAt.replace(' ', 'T')}Z`);

// Referrals and deadline extensions, newest first, each undoable. `version`
// bumps when the parent records one, so an open history reloads.
export default function ReferralHistory({ courseId, version = 0, onClose, onChanged }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    try {
      const [referrals, extensions] = await Promise.all([getReferrals({ courseId }), getExtensions({ courseId })]);
      setRows([
        ...(referrals || []).map((r) => ({ ...r, kind: 'referral' })),
        ...(extensions || []).map((r) => ({ ...r, kind: 'extension' })),
      ].sort((x, y) => y.createdAt.localeCompare(x.createdAt)));
    } catch {
      setRows([]);
    }
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
      {rows === null && <p className="text-sm text-muted">Loading…</p>}
      {rows?.length === 0 && <p className="text-sm text-muted">No referrals or extensions recorded yet.</p>}
      {rows?.map((r) => (
        <div key={`${r.kind}:${r.id}`} className="triage-row triage-row--history">
          <span className="triage-row__name">{r.studentName}</span>
          <span className="triage-row__task"><span className="triage-row__course">{courseLabel(r)}</span>{r.title}</span>
          {r.kind === 'referral'
            ? <span className="badge badge-red">Referred · day {r.daysLate}</span>
            : <span className="badge badge-gray">Extended +{r.lessons} → {formatDate(`${r.until}T00:00:00`)}</span>}
          <span className="text-sm text-muted">{createdOn(r)}{r.note ? ` — ${r.note}` : ''}</span>
          <button className="ghost" onClick={() => undo(r)}>Undo</button>
        </div>
      ))}
    </section>
  );
}
