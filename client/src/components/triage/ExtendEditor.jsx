import { useState } from 'react';
import NumberStepper from '../NumberStepper.jsx';
import LessonHint from '../LessonHint.jsx';
import { formatDate } from '../../lib/formatDate.js';

const DEFAULT_LESSONS = 3;
const MAX_LESSONS = 60;

// The inline "Extend by N school days" editor that opens inside a triage row's expanded
// area in place of its buttons (late work, make-up tests, resubmissions). Re-extending
// pre-fills the current extension. With `courseId` + `from` (the date the count starts
// at: due date, test date, or the day the resubmission was asked) it shows where the
// count lands in the class's lessons, with "Next lesson" picks.
// `showNote` hides the note field for callers whose write doesn't persist one
// (resubmissions: a note typed here would be silently dropped — the teacher edits
// the status line in the confirm instead).
export default function ExtendEditor({ extension, onSave, onCancel, showNote = true, courseId, from }) {
  const [lessons, setLessons] = useState(extension?.lessons ?? DEFAULT_LESSONS);
  const [note, setNote] = useState(extension?.note ?? '');
  return (
    <>
      <NumberStepper value={lessons} min={1} max={MAX_LESSONS} onChange={setLessons} aria-label="Extension (school days)" />
      <span className="text-sm">school days</span>
      <LessonHint courseId={courseId} from={from} value={lessons} onPick={setLessons} />
      {showNote && (
        <input
          className="triage-note" placeholder="Note (optional)" aria-label="Extension note"
          value={note} onChange={(e) => setNote(e.target.value)}
        />
      )}
      <button className="secondary btn-sm" onClick={() => onSave(lessons, note)}>Save</button>
      <button className="ghost" onClick={onCancel}>Cancel</button>
    </>
  );
}

// "ext +N → DD/MM/YYYY" on an extended row; the tooltip spells out the unit (+ note).
export function ExtensionTag({ extension }) {
  const unit = `Extended by ${extension.lessons} school day${extension.lessons === 1 ? '' : 's'}`;
  return (
    <span className="badge badge-gray triage-row__tag" title={extension.note ? `${unit}: ${extension.note}` : unit}>
      ext +{extension.lessons} → {formatDate(`${extension.until}T00:00:00`)}
    </span>
  );
}
