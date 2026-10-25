import { useState } from 'react';
import ActionPanel, { PanelRow } from './ActionPanel.jsx';

// The confirm for a referral that writes to Schoology (#175), on the assessment card and in
// Triage's Overdue work. One box, ticked by default:
//   mode 'refer' (work still missing): "Also record IE on every topic and mark Missing in
//     Schoology". Missing alone adds no evidence to the topic averages; IE then Missing does.
//   mode 'undo' (a referral that wrote them): "Also clear Missing and the IE levels in Schoology".
// onConfirm(schoology): the parent writes and closes the panel; `error` shows a refusal in place.
const TEXT = {
  refer: {
    title: 'Refer to the academic office?',
    check: 'Also record IE on every topic and mark Missing in Schoology',
    line: 'Missing replaces a Late, Incomplete or Absent flag. Undo can clear both while nothing else changes.',
    confirm: 'Refer',
  },
  undo: {
    title: 'Undo the referral?',
    check: 'Also clear Missing and the IE levels in Schoology',
    line: 'Prism checks that Schoology still holds only what the referral wrote.',
    confirm: 'Undo referral',
  },
};

export default function ReferPanel({ mode = 'refer', host = null, busy = false, error = null, onCancel, onConfirm }) {
  const [schoology, setSchoology] = useState(true);
  const t = TEXT[mode];
  return (
    <ActionPanel host={host} label={t.title}>
      <PanelRow><span className="action-panel__title">{t.title}</span></PanelRow>
      <label className="flag-panel__check">
        <input type="checkbox" checked={schoology} disabled={busy} onChange={(e) => setSchoology(e.target.checked)} />
        <span>{t.check}</span>
      </label>
      {schoology && <p className="flag-panel__line">{t.line}</p>}
      {error && <p className="flag-panel__line" style={{ color: 'var(--danger)' }}>{error}</p>}
      <PanelRow>
        <button type="button" className="ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary danger btn-sm" disabled={busy} onClick={() => onConfirm(schoology)}>
          {busy ? 'Writing…' : t.confirm}
        </button>
      </PanelRow>
    </ActionPanel>
  );
}

// Whether Undo on this referral can offer the Schoology step: it wrote Missing, and Missing has
// not been cleared since (the timeline's referral.schoology, or list_referrals' schoologyMark).
export const canClearInSchoology = (mark) => Boolean(mark?.missing && !mark.cleared);
