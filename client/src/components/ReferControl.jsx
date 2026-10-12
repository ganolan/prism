import { useState } from 'react';
import ActionPanel, { PanelRow } from './ActionPanel.jsx';
import { recordReferral, undoReferral, getTriagePair } from '../services/api.js';

// The assessment card's referral actions, mirroring the dashboard's Late work row
// (student.late_work, built by the same rules): at the limit, missing work offers
// Refer; work handed in late past the limit offers Refer and Waive (with an optional
// reason, in the card's panel row). Once decided, a "Referred" / "Referral waived" pill
// with Undo. Referrals publish nothing to Schoology, so no confirm.
//
// onChange({ timeline, late_work }): the pair's fresh state after the write.
export default function ReferControl({ student, assignmentId, panelHost = null, onChange }) {
  const [waiving, setWaiving] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const referral = student.timeline?.referral || null;
  const row = student.late_work || null;
  if (!assignmentId || (!referral && row?.tone !== 'red')) return null;

  const ids = { studentId: student.id, assignmentId };
  async function act(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setWaiving(false);
      onChange?.(await getTriagePair(student.id, assignmentId));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (referral) {
    const waived = referral.action === 'waived';
    return (
      <span className="resubmit-control">
        <span className={`badge ${waived ? 'badge-gray' : 'badge-red'}`} title={referral.note || undefined}>
          {waived ? 'Referral waived' : 'Referred'}
        </span>
        {referral.id && (
          <button type="button" className="ghost btn-sm" disabled={busy} onClick={() => act(() => undoReferral(referral.id))}>Undo</button>
        )}
        {error && <span className="text-sm" style={{ color: 'var(--danger)' }}>{error}</span>}
      </span>
    );
  }

  const handedIn = row.kind === 'submitted_late';
  return (
    <span className="resubmit-control">
      <button type="button" className="resubmit-pill refer-pill" title="Refer to the academic office" disabled={busy}
        onClick={() => act(() => recordReferral({ ...ids, action: 'referred' }))}>Refer</button>
      {handedIn && (
        <button type="button" className="resubmit-pill" title="Don't refer: record why" aria-expanded={waiving}
          onClick={() => { setNote(''); setWaiving(!waiving); }}>Waive</button>
      )}
      {error && <span className="text-sm" style={{ color: 'var(--danger)' }}>{error}</span>}
      {waiving && (
        <ActionPanel host={panelHost} label="Waive the referral">
          <PanelRow>
            <span className="action-panel__title">Waive referral</span>
            <input className="triage-note action-panel__note" placeholder="Reason (optional)" aria-label="Waive note"
              value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="secondary btn-sm" disabled={busy}
              onClick={() => act(() => recordReferral({ ...ids, action: 'waived', note }))}>Waive referral</button>
            <button type="button" className="ghost btn-sm" onClick={() => setWaiving(false)}>Cancel</button>
          </PanelRow>
        </ActionPanel>
      )}
    </span>
  );
}
