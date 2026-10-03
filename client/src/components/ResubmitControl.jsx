import { useState } from 'react';
import NumberStepper from './NumberStepper.jsx';
import { formatDate } from '../lib/formatDate.js';
import { requestResubmission, updateResubmission, reviewResubmission, undoResubmission } from '../services/api.js';

// The assessment card's resubmission control (triage resubmissions, 2026-10-03).
// No request: "⟳ Ask to resubmit" → lessons (default from Settings) + note → Ask.
// Open request: "⟳ Resubmit by DD/MM/YYYY" → Extend / Close / Undo.
// Arrived: "Reviewed" (grade stands). Prism-only — nothing is written to Schoology.
export default function ResubmitControl({ student, assignmentId, defaultLessons = 3, onChange }) {
  const r = student.resubmission;
  const [panel, setPanel] = useState(false);
  const [lessons, setLessons] = useState(r?.request?.lessons ?? defaultLessons);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Fold: reopening the panel always starts from the current request's lessons
  // (or the Settings default) and a blank note — never a stale value left over
  // from a previous open/close of this same card.
  function openPanel() {
    setLessons(r?.request?.lessons ?? defaultLessons);
    setNote('');
    setPanel(true);
  }

  async function run(fn) {
    setBusy(true); setError(null);
    try { await fn(); setPanel(false); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const ask = () => run(async () => {
    const req = await requestResubmission({ studentId: student.id, assignmentId, lessons, note });
    onChange?.({ state: 'waiting', request: req });
  });
  const extend = () => run(async () => {
    const req = await updateResubmission(r.request.id, { lessons });
    onChange?.({ ...r, request: req });
  });
  const close = () => run(async () => { await updateResubmission(r.request.id, { close: true, note }); onChange?.(null); });
  const undo = () => run(async () => { await undoResubmission(r.request.id); onChange?.(null); });
  const reviewed = () => run(async () => { await reviewResubmission({ studentId: student.id, assignmentId }); onChange?.(null, { reviewed: true }); });

  // No assessment-page id yet (assignmentRow still loading) — nothing to ask
  // against, and every action below needs it.
  if (!assignmentId) return null;

  if (r?.state === 'arrived') {
    return (
      <span className="resubmit-control">
        <button type="button" className="secondary btn-sm" disabled={busy} onClick={reviewed}>Reviewed</button>
        {error && <span className="text-sm badge badge-red">{error}</span>}
      </span>
    );
  }
  const open = r?.state === 'waiting' && r.request;
  return (
    <span className="resubmit-control">
      <button
        type="button" className={`resubmit-pill${open ? ' resubmit-pill--active' : ''}`}
        aria-expanded={panel} disabled={busy} onClick={() => (panel ? setPanel(false) : openPanel())}
      >
        <span aria-hidden="true">⟳</span>{' '}
        {open ? `Resubmit by ${formatDate(`${r.request.until}T00:00:00`)}` : 'Ask to resubmit'}
      </button>
      {panel && (
        <span className="resubmit-control__panel">
          <NumberStepper value={lessons} min={1} max={60} onChange={setLessons} aria-label="Resubmission deadline (lessons)" />
          <input className="triage-note" placeholder="Note (optional)" aria-label="Resubmission note" value={note} onChange={(e) => setNote(e.target.value)} />
          {open ? (
            <>
              <button type="button" className="secondary btn-sm" disabled={busy} onClick={extend}>Extend</button>
              <button type="button" className="secondary btn-sm" disabled={busy} onClick={close}>Close request</button>
              <button type="button" className="ghost danger btn-sm" disabled={busy} onClick={undo}>Undo</button>
            </>
          ) : (
            <button type="button" className="primary btn-sm" disabled={busy} onClick={ask}>Ask</button>
          )}
        </span>
      )}
      {error && <span className="text-sm badge badge-red">{error}</span>}
    </span>
  );
}
