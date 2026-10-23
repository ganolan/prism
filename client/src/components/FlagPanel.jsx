import { useId, useState } from 'react';
import ActionPanel, { PanelRow } from './ActionPanel.jsx';
import { FLAGS, isExempt } from '../lib/flags.js';
import { flagLine, plainLine, teacherText } from '../lib/statusLines.js';
import { localIsoDate } from '../lib/formatDate.js';
import { HiddenCommentWarning } from './StatusLineModal.jsx';

// What a marker leaves for the teacher to do next (#40 design, "Next steps"). Exempt and Missing
// are final, so they have none.
function nextSteps(code, who) {
  switch (Number(code)) {
    case 6: return 'Grading the work clears Late, and the grade then counts. If the work is too late to count, mark it Missing instead.';
    case 2: return 'Set a date to finish with Extend. Grading the work clears Incomplete.';
    case 5: return `If ${who} will make this up, set a date with Extend. If ${who} will not do this task, mark Exempt instead.`;
    default: return null;
  }
}

// The saved-grade note: what Schoology does to the grade, and the copy Prism keeps. On graded work
// the copy is the grade now (state.gradeText); with no grade but a copy still waiting (a flag
// replacing a flag), the copy Prism already holds.
function savedNote(code, state) {
  const kept = state.graded ? state.gradeText : state.savedGrade?.summary;
  if (!state.graded && !state.savedGrade) return null;
  const copy = kept ? `Prism keeps a copy: ${kept}.` : 'Prism keeps a copy.';
  const effect = Number(code) === 3 ? 'Schoology sets this grade to 0 while the flag is set.' : 'Schoology removes this grade while the flag is set.';
  return `${effect} ${copy} Your comment stays.`;
}

// The panel for setting a flag (#40): "Mark Sam exempt?", an optional reason for the student (the
// status line Prism writes at the top of the comment, previewed), the records Exempt withdraws,
// the saved-grade note and a marker's next steps. Drawn in the host given (the card's action-panel
// row, or a Triage flags row's), or inline without one.
//   state    the fresh read (readFlagState)
//   onConfirm(reason | null)
export default function FlagPanel({ code, firstName = null, state, host = null, busy = false, onCancel, onConfirm }) {
  const [reason, setReason] = useState('');
  const inputId = useId();
  const flag = FLAGS[Number(code)];
  const who = firstName || 'the student';
  const title = `Mark ${who} ${flag.verb}?`;
  const note = plainLine(reason).trim();
  const records = isExempt(code) ? (state.openRecords || []) : [];
  const saved = savedNote(code, state);
  const steps = nextSteps(code, who);
  // A reason publishes a status line, which turns Display on: a hidden teacher comment (text other
  // than Prism's own line) would become visible, so the panel warns as Extend and Resubmit do.
  const hidden = Boolean(note) && Number(state.commentStatus) !== 1 && teacherText(state.comment || '', state.storedLine || null) !== '';

  return (
    <ActionPanel host={host} label={title}>
      <PanelRow><span className="action-panel__title">{title}</span></PanelRow>
      <div className="flag-panel__field">
        <label htmlFor={inputId}>Reason for the student (optional)</label>
        <input id={inputId} className="triage-note flag-panel__input" value={reason} maxLength={300}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) onConfirm(note || null); }} />
        {note && (
          <small className="flag-panel__preview">
            {`Added to the top of ${firstName ? `${firstName}'s` : "the student's"} comment: "${flagLine({ code, on: localIsoDate(), note })}"`}
          </small>
        )}
      </div>
      {hidden && <HiddenCommentWarning />}
      {records.length > 0 && (
        <p className="flag-panel__line">{`Also withdraws: ${records.map((r) => r.label).join(', ')}`}</p>
      )}
      {saved && <p className="flag-panel__saved">{saved}</p>}
      {steps && <p className="flag-panel__line">{steps}</p>}
      <PanelRow>
        <button type="button" className="ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary btn-sm" disabled={busy} onClick={() => onConfirm(note || null)}>{`Mark ${flag.verb}`}</button>
      </PanelRow>
    </ActionPanel>
  );
}
