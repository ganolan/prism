import { useRef, useState } from 'react';
import NumberStepper from './NumberStepper.jsx';
import LessonHint from './LessonHint.jsx';
import StatusLineModal from './StatusLineModal.jsx';
import { formatDate, localIsoDate } from '../lib/formatDate.js';
import { studentFullName } from '../lib/studentNames.js';
import { extensionLine, makeUpLine } from '../lib/statusLines.js';
import { recordExtension, undoExtension, getStatusLineUntil } from '../services/api.js';

const DEFAULT_DAYS = 3;
const days = (n) => `${n} school day${n === 1 ? '' : 's'}`;

// The assessment card's deadline extension for one student, before or after the due
// date (late work, or a missed test's make-up). N school days count from the due date,
// or from today once it has passed; the lesson hint shows where that lands in this
// class's lessons. Like the resubmission control, every write publishes a status line
// to the student's Schoology comment through the StatusLineModal confirm first.
//
// onChange(timeline, commentChange): the pair's fresh submission timeline (from the
// server) and what the action did to the student's comment ({ comment, line, kind } |
// { comment, line: null } | null), so the card keeps its comment editor in step.
export default function ExtendControl({ student, assignment, courseId, onChange }) {
  const ext = student.timeline?.extension || null;
  const makeUp = assignment.is_test === 1;
  const initial = () => (ext?.schoolDaysLeft > 0 ? ext.schoolDaysLeft : DEFAULT_DAYS);
  const [panel, setPanel] = useState(false);
  const [n, setN] = useState(initial);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(null);
  const seq = useRef(0);

  if (!assignment?.id || !assignment.due_date) return null;
  const ids = { studentId: student.id, assignmentId: assignment.id };
  const name = studentFullName(student) || 'the student';
  const open = (props) => { seq.current += 1; setConfirm({ key: seq.current, props }); };
  const done = (fn) => async (arg) => { await fn(arg); setConfirm(null); setPanel(false); };
  const lineOf = (sl, kind) => (sl && sl.comment != null && sl.line ? { comment: sl.comment, line: sl.line, kind } : null);
  const kind = makeUp ? 'make_up' : 'extension';

  function openPanel() {
    setN(initial());
    setNote(ext?.note || '');
    setPanel(true);
  }
  const save = () => open({
    consequence: `Gives ${name} ${days(n)} ${makeUp ? 'to sit the test' : 'more'}, counted from ${assignment.due_date.slice(0, 10) < localIsoDate() ? 'today' : 'the due date'}.`,
    confirmLabel: 'Publish new due date',
    loadDefaultLine: async () => {
      const { until } = await getStatusLineUntil({ kind, ...ids, lessons: n });
      return makeUp ? makeUpLine({ until, note }) : extensionLine({ until, lessons: n, note });
    },
    onConfirm: done(async (commentLine) => {
      const x = await recordExtension({ ...ids, lessons: n, note, commentLine });
      onChange?.(x?.timeline ?? null, lineOf(x?.statusLine, kind));
    }),
  });
  const undo = () => open({
    removeMode: true,
    undoSource: { sourceType: 'extension', sourceId: ext.id },
    consequence: 'Removes this extension from Prism: the original due date applies again.',
    confirmLabel: 'Undo',
    onConfirm: done(async (removeLine) => {
      const u = await undoExtension(ext.id, { removeLine });
      const sl = u?.statusLine;
      onChange?.(u?.timeline ?? null, sl && sl.comment != null ? { comment: sl.comment, line: null, kind: null } : null);
    }),
  });

  return (
    <span className="resubmit-control">
      <button
        type="button" className={`resubmit-pill${ext ? ' resubmit-pill--active' : ''}`}
        aria-expanded={panel} onClick={() => (panel ? setPanel(false) : openPanel())}
      >
        {ext ? `Extended to ${formatDate(`${ext.until}T00:00:00`)}` : 'Extend'}
      </button>
      {panel && (
        <span className="resubmit-control__panel">
          <NumberStepper value={n} min={1} max={60} onChange={setN} aria-label="Extension (school days)" />
          <span className="text-sm">school days</span>
          <LessonHint courseId={courseId} from={assignment.due_date.slice(0, 10)} value={n} onPick={setN} />
          <input className="triage-note" placeholder="Note (optional)" aria-label="Extension note" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="primary btn-sm" onClick={save}>Save</button>
          {ext?.id && <button type="button" className="ghost danger btn-sm" onClick={undo}>Undo</button>}
        </span>
      )}
      {confirm && (
        <StatusLineModal
          key={confirm.key} studentName={studentFullName(student)} title={assignment.title} {...ids} {...confirm.props}
          onCancel={() => setConfirm(null)}
        />
      )}
    </span>
  );
}
