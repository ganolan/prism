import { useState } from 'react';
import ActionPanel, { PanelRow } from './ActionPanel.jsx';
import { FLAGS } from '../lib/flags.js';

// Clearing a flag over a grade Prism kept (#40): "Clear Exempt?" with one box, ticked, to put the
// saved grade back as the card's draft (it then goes to Schoology with the usual Publish), and the
// parts the card cannot stage, to re-enter in Schoology (a points-only score, or an overall typed
// in place of the computed one). Without a copy, clearing needs no panel (FlagsMenu clears at once).
//   savedGrade  the waiting copy (readFlagState.savedGrade): restoreSummary, notRestored
//   hasDraft    the card has a draft, which the restore replaces
//   onConfirm(restore)
export default function ClearFlagPanel({ code, savedGrade, hasDraft = false, host = null, busy = false, onCancel, onConfirm }) {
  const [restore, setRestore] = useState(true);
  const name = FLAGS[Number(code)].name;
  const title = `Clear ${name}?`;
  const staged = savedGrade?.restoreSummary || null;
  const toReenter = savedGrade?.notRestored || [];

  return (
    <ActionPanel host={host} label={title}>
      <PanelRow><span className="action-panel__title">{title}</span></PanelRow>
      {staged && (
        <label className="flag-panel__check">
          <input type="checkbox" checked={restore} onChange={(e) => setRestore(e.target.checked)} />
          <span>{`Restore the saved grade as a draft: ${staged}${hasDraft ? ' (replaces your current draft)' : ''}`}</span>
        </label>
      )}
      {toReenter.length > 0 && <p className="flag-panel__line">{`Re-enter in Schoology: ${toReenter.join(', ')}`}</p>}
      <PanelRow>
        <button type="button" className="ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary btn-sm" disabled={busy} onClick={() => onConfirm(staged ? restore : true)}>{`Clear ${name}`}</button>
      </PanelRow>
    </ActionPanel>
  );
}
