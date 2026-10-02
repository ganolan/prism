import { useState } from 'react';
import NumberStepper from '../NumberStepper.jsx';
import { formatDate } from '../../lib/formatDate.js';

const DEFAULT_LESSONS = 3;
const MAX_LESSONS = 60;

// The inline "Extend by N lessons" editor that opens inside a triage row's expanded
// area in place of its buttons (late work, make-up tests). Re-extending pre-fills the current extension.
export default function ExtendEditor({ extension, onSave, onCancel }) {
  const [lessons, setLessons] = useState(extension?.lessons ?? DEFAULT_LESSONS);
  const [note, setNote] = useState(extension?.note ?? '');
  return (
    <>
      <NumberStepper value={lessons} min={1} max={MAX_LESSONS} onChange={setLessons} aria-label="Extension (lessons)" />
      <input
        className="triage-note" placeholder="Note (optional)" aria-label="Extension note"
        value={note} onChange={(e) => setNote(e.target.value)}
      />
      <button className="secondary btn-sm" onClick={() => onSave(lessons, note)}>Save</button>
      <button className="ghost" onClick={onCancel}>Cancel</button>
    </>
  );
}

// "ext +N → DD/MM/YYYY" on an extended row (note as the tooltip).
export function ExtensionTag({ extension }) {
  return (
    <span className="badge badge-gray triage-row__tag" title={extension.note || undefined}>
      ext +{extension.lessons} → {formatDate(`${extension.until}T00:00:00`)}
    </span>
  );
}
