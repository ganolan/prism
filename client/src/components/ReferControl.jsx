import { useState } from 'react';
import ActionPanel, { PanelRow } from './ActionPanel.jsx';
import ReferPanel, { canClearInSchoology } from './ReferPanel.jsx';
import { recordReferral, undoReferral, getTriagePair } from '../services/api.js';

// The assessment card's referral actions, mirroring the dashboard's Overdue work row
// (student.late_work, built by the same rules): at the limit, missing work offers
// Refer; work handed in late past the limit offers Refer and Waive (with an optional
// reason, in the card's panel row). Once decided, a "Referred" / "Referral waived" pill
// with Undo.
// Refer on missing work opens ReferPanel (#175): its box, ticked by default, also writes IE on
// every topic and Missing in Schoology. Handed-in work refers at once (Prism only). Undo on a
// referral that wrote them opens the panel again, to clear both.
//
// onChange({ timeline, late_work }): the pair's fresh state after the write.
// onSchoologyChange(): after a write that changed Schoology, so the card refetches the student
// (flag, score, levels). beforeWrite(): settles the card's unsaved draft first (as the Flags menu).
export default function ReferControl({ student, assignmentId, panelHost = null, onChange, onSchoologyChange, beforeWrite }) {
  const [waiving, setWaiving] = useState(false);
  const [confirming, setConfirming] = useState(null); // 'refer' | 'undo': the ReferPanel open
  const [warning, setWarning] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const referral = student.timeline?.referral || null;
  const row = student.late_work || null;
  if (!assignmentId || (!referral && row?.tone !== 'red')) return null;

  const ids = { studentId: student.id, assignmentId };
  // `schoology`: the write may change Schoology, so the card refetches the student after it.
  async function act(fn, schoology = false) {
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      if (schoology) await beforeWrite?.();
      const out = await fn();
      setWaiving(false);
      setConfirming(null);
      setWarning(out?.schoology?.warning || null);
      if (schoology) await onSchoologyChange?.();
      onChange?.(await getTriagePair(student.id, assignmentId));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const panel = confirming && (
    <ReferPanel
      mode={confirming} host={panelHost} busy={busy} error={error}
      onCancel={() => { setConfirming(null); setError(null); }}
      onConfirm={(schoology) => act(() => (confirming === 'refer'
        ? recordReferral({ ...ids, action: 'referred', schoology })
        : undoReferral(referral.id, { schoology })), schoology)}
    />
  );
  const warningText = warning && <span className="text-sm" style={{ color: 'var(--warning)' }}>{warning}</span>;

  if (referral) {
    const waived = referral.action === 'waived';
    return (
      <span className="resubmit-control">
        <span className={`badge ${waived ? 'badge-gray' : 'badge-red'}`} title={referral.note || undefined}>
          {waived ? 'Referral waived' : 'Referred'}
        </span>
        {referral.id && (
          <button type="button" className="ghost btn-sm" disabled={busy} aria-expanded={confirming === 'undo' || undefined}
            onClick={() => (canClearInSchoology(referral.schoology) ? setConfirming(confirming ? null : 'undo') : act(() => undoReferral(referral.id)))}>Undo</button>
        )}
        {error && !confirming && <span className="text-sm" style={{ color: 'var(--danger)' }}>{error}</span>}
        {warningText}
        {panel}
      </span>
    );
  }

  const handedIn = row.kind === 'submitted_late';
  return (
    <span className="resubmit-control">
      <button type="button" className="resubmit-pill refer-pill" title="Refer to the academic office" disabled={busy}
        aria-expanded={handedIn ? undefined : confirming === 'refer'}
        onClick={() => {
          if (handedIn) return act(() => recordReferral({ ...ids, action: 'referred' }));
          setWaiving(false);
          setConfirming(confirming ? null : 'refer');
        }}>Refer</button>
      {handedIn && (
        <button type="button" className="resubmit-pill" title="Don't refer: record why" aria-expanded={waiving}
          onClick={() => { setNote(''); setWaiving(!waiving); }}>Waive</button>
      )}
      {error && !confirming && <span className="text-sm" style={{ color: 'var(--danger)' }}>{error}</span>}
      {warningText}
      {panel}
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
