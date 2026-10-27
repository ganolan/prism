import { useState } from 'react';
import NumberStepper from '../NumberStepper.jsx';
import LessonHint from '../LessonHint.jsx';
import CountFromChoice from '../CountFromChoice.jsx';
import { formatDate } from '../../lib/formatDate.js';
import { Tip } from '../HelpDot.jsx';

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
// `countFrom` (an assignment extension: late work, a make-up) offers, once `from` (the due
// date) has passed, counting from the due date (the default) or from today, and
// onSave(lessons, note, countFrom). Without it (a resubmission) the days count from today
// once the start date has passed.
export default function ExtendEditor({ extension, onSave, onCancel, showNote = true, courseId, from, countFrom: offerCountFrom = false }) {
  // A re-extend starts from the current deadline: its school days after the due date, or
  // the school days still left from today (the default once it has passed).
  const initial = (cf) => {
    const n = cf === 'due_date' ? extension?.schoolDaysAfterDue : extension?.schoolDaysLeft;
    return n > 0 ? n : DEFAULT_LESSONS;
  };
  const [countFrom, setCountFrom] = useState(offerCountFrom ? 'due_date' : null);
  const [lessons, setLessons] = useState(() => initial(countFrom));
  const [note, setNote] = useState(extension?.note ?? '');
  const pick = (v) => { setCountFrom(v); setLessons(initial(v)); };
  return (
    <>
      <NumberStepper value={lessons} min={1} max={MAX_LESSONS} onChange={setLessons} aria-label="Extension (school days)" />
      <span className="text-sm">school days</span>
      {offerCountFrom && <CountFromChoice due={from} value={countFrom} onChange={pick} />}
      <LessonHint courseId={courseId} from={from} countFrom={countFrom} value={lessons} onPick={setLessons} />
      {showNote && (
        <input
          className="triage-note" placeholder="Note (optional)" aria-label="Extension note"
          value={note} onChange={(e) => setNote(e.target.value)}
        />
      )}
      <button className="secondary btn-sm" onClick={() => onSave(lessons, note, countFrom ?? undefined)}>Save</button>
      <button className="ghost" onClick={onCancel}>Cancel</button>
    </>
  );
}

// "ext +N → DD/MM/YYYY" on an extended row; its popover spells out the unit (+ note).
export function ExtensionTag({ extension }) {
  const unit = `Extended to ${formatDate(`${extension.until}T00:00:00`)}`;
  return (
    <Tip className="badge badge-gray triage-row__tag" text={extension.note ? `${unit}: ${extension.note}` : unit}>
      ext → {formatDate(`${extension.until}T00:00:00`)}
    </Tip>
  );
}
