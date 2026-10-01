import { useEffect, useState } from 'react';
import { getReferrals, undoReferral } from '../../services/api.js';
import { formatDate } from '../../lib/formatDate.js';
import { courseLabel } from '../../lib/triage.js';

// Referred / exempt records, newest first, each undoable. `version` bumps when
// the parent records a referral, so an open history reloads.
export default function ReferralHistory({ courseId, version = 0, onClose, onChanged }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    try { setRows((await getReferrals({ courseId })) || []); } catch { setRows([]); }
  }
  useEffect(() => { load(); }, [courseId, version]); // eslint-disable-line react-hooks/exhaustive-deps

  async function undo(id) {
    try {
      await undoReferral(id);
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
        <h3 className="triage-panel__title">Referred / exempt</h3>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
      {error && <div className="alert alert-warning">{error}</div>}
      {rows === null && <p className="text-sm text-muted">Loading…</p>}
      {rows?.length === 0 && <p className="text-sm text-muted">No referrals or exemptions recorded yet.</p>}
      {rows?.map((r) => (
        <div key={r.id} className="triage-row triage-row--history">
          <span className="triage-row__name">{r.studentName}</span>
          <span className="triage-row__task"><span className="triage-row__course">{courseLabel(r)}</span>{r.title}</span>
          <span className={`badge ${r.action === 'referred' ? 'badge-red' : 'badge-gray'}`}>
            {r.action === 'referred' ? 'Referred' : 'Exempt'} · day {r.daysLate}
          </span>
          <span className="text-sm text-muted">{formatDate(`${r.createdAt.replace(' ', 'T')}Z`)}{r.note ? ` — ${r.note}` : ''}</span>
          <button className="ghost" onClick={() => undo(r.id)}>Undo</button>
        </div>
      ))}
    </section>
  );
}
