import { useRef, useState } from 'react';
import NumberStepper from './NumberStepper.jsx';
import LessonHint from './LessonHint.jsx';
import StatusLineModal from './StatusLineModal.jsx';
import UnsubmitFailedNote from './UnsubmitFailedNote.jsx';
import { formatDate, localIsoDate } from '../lib/formatDate.js';
import { studentFullName } from '../lib/studentNames.js';
import { askLine, extendResubmissionLine, gradeStandsLine } from '../lib/statusLines.js';
import { requestResubmission, updateResubmission, undoResubmission, getStatusLineUntil } from '../services/api.js';

// The assessment card's resubmission control (triage resubmissions, spec Amendment B).
// No request: "⟳ Ask to resubmit" → school days (default from Settings) + note → Ask,
// with the class's lesson hint ("→ Thu 15/10 · 3 lessons from today", Next lesson).
// Open request: "⟳ Resubmit by DD/MM/YYYY" → Extend / Grade stands (only once the
// deadline has passed) / Undo. Every one of these writes a status line to the
// student's Schoology comment, so each opens the StatusLineModal confirm first —
// nothing is written until Publish. Arrived: no button; the teacher answers by
// regrading or writing a visible comment.
//
// onChange(resubmission, commentChange): resubmission = the card's new state (null
// when none); commentChange (final review I1) = what the action did to the student's
// Schoology comment, so the card can keep its stored comment, status line and editor in
// step — { comment, line, kind } after a publish (line = the new stored line), { comment,
// line: null } after a removal, or null when the comment was not touched. A third
// argument patches other card fields (after an unsubmit: the work is in progress).
//
// Ask on OneDrive work Prism last saw submitted (student.unsubmit_available, Phase 2):
// the confirm also offers to unsubmit it in Schoology. Prism never re-submits, so Undo
// and Grade stands on unsubmitted work say it stays unsubmitted.
const published = (kind, sl) => (sl && sl.comment != null && sl.line ? { comment: sl.comment, line: sl.line, kind } : null);
const removed = (sl) => (sl && sl.comment != null ? { comment: sl.comment, line: null, kind: null } : null);
// The action's record without the publish / unsubmit results the server appends to it.
const recordOf = ({ statusLine: _sl, unsubmit: _u, ...rest } = {}) => rest;
const STAYS_UNSUBMITTED = ' Their work stays unsubmitted in Schoology.';

export default function ResubmitControl({ student, assignmentId, courseId, title, defaultLessons = 3, onChange }) {
  const r = student.resubmission;
  const [panel, setPanel] = useState(false);
  const [lessons, setLessons] = useState(r?.request?.lessons ?? defaultLessons);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(null); // StatusLineModal props for the action being confirmed
  const actionSeq = useRef(0); // a fresh key per opened action → the modal always remounts

  // Fold: reopening the panel always starts from the current request's lessons
  // (or the Settings default) and a blank note — never a stale value left over
  // from a previous open/close of this same card.
  function openPanel() {
    setLessons(r?.request?.lessons ?? defaultLessons);
    setNote('');
    setPanel(true);
  }

  // No assessment-page id yet (assignmentRow still loading) — nothing to ask
  // against, and every action below needs it.
  if (!assignmentId) return null;

  if (r?.state === 'arrived') {
    return <span className="resubmit-control resubmit-control__note">Awaiting your feedback: regrade or comment (visible)</span>;
  }

  const req = r?.state === 'waiting' ? r.request : null;
  const pastDeadline = Boolean(req?.until) && req.until < localIsoDate();
  const ids = { studentId: student.id, assignmentId };
  const done = (fn) => async (arg) => { await fn(arg); setConfirm(null); setPanel(false); };
  const unsubmitted = student.lti_submission_state === 'in_progress';
  const offerUnsubmit = Boolean(student.unsubmit_available);
  const open = (props) => { actionSeq.current += 1; setConfirm({ key: actionSeq.current, props }); };

  const ask = () => open({
    consequence: `Asks ${studentFullName(student) || 'the student'} to resubmit within ${lessons} school day${lessons === 1 ? '' : 's'}.`,
    confirmLabel: 'Publish & ask',
    offerUnsubmit,
    loadDefaultLine: async () => askLine({ until: (await getStatusLineUntil({ kind: 'ask', ...ids, lessons })).until, note }),
    onConfirm: async (commentLine, opts) => {
      const created = await requestResubmission({ ...ids, lessons, note, commentLine, ...(opts ? { unsubmit: opts.unsubmit } : {}) });
      const extra = created?.unsubmit?.ok ? { lti_submission_state: 'in_progress', unsubmit_available: false } : undefined;
      onChange?.({ state: 'waiting', request: recordOf(created) }, published('ask', created?.statusLine), ...(extra ? [extra] : []));
      setPanel(false);
      // A failed unsubmit: the modal stays open to say so (with the Schoology link).
      if (created?.unsubmit && !created.unsubmit.ok) return created;
      setConfirm(null);
      return created;
    },
  });
  const extend = () => open({
    consequence: `Moves the resubmission deadline to ${lessons} school day${lessons === 1 ? '' : 's'} after the ask.`,
    confirmLabel: 'Publish new due date',
    loadDefaultLine: async () => extendResubmissionLine({
      until: (await getStatusLineUntil({ kind: 'extend_resubmission', ...ids, resubmissionId: req.id, lessons })).until,
    }),
    onConfirm: done(async (commentLine) => {
      const updated = await updateResubmission(req.id, { lessons, commentLine });
      onChange?.({ ...r, request: recordOf(updated) }, published('extend_resubmission', updated?.statusLine));
    }),
  });
  const gradeStands = () => open({
    consequence: `Ends the resubmission request: missed deadline, grade stands.${unsubmitted ? STAYS_UNSUBMITTED : ''}`,
    confirmLabel: 'Publish & close request',
    defaultLine: gradeStandsLine({ until: req.until }),
    onConfirm: done(async (commentLine) => {
      const closed = await updateResubmission(req.id, { gradeStands: true, commentLine });
      onChange?.(null, published('grade_stands', closed?.statusLine));
    }),
  });
  const undo = () => open({
    removeMode: true,
    undoSource: { sourceType: 'resubmission', sourceId: req.id },
    // An auto-added (Schoology Unsubmit) request is closed, not deleted, by Undo.
    // A request on unsubmitted work is closed, not deleted (the closed row stops the next
    // sync re-adding it), and the work stays unsubmitted — Prism never re-submits.
    consequence: unsubmitted
      ? `Closes this request in Prism.${STAYS_UNSUBMITTED}`
      : (req.source === 'schoology_unsubmit' ? 'Closes this resubmission request in Prism.' : 'Deletes this resubmission request from Prism.'),
    confirmLabel: 'Undo',
    onConfirm: done(async (removeLine) => {
      const undone = await undoResubmission(req.id, { removeLine });
      onChange?.(null, removed(undone?.statusLine));
    }),
  });

  return (
    <span className="resubmit-control">
      <button
        type="button" className={`resubmit-pill${req ? ' resubmit-pill--active' : ''}`}
        aria-expanded={panel} onClick={() => (panel ? setPanel(false) : openPanel())}
      >
        <span aria-hidden="true">⟳</span>{' '}
        {req ? `Resubmit by ${formatDate(`${req.until}T00:00:00`)}` : 'Ask to resubmit'}
      </button>
      {req?.unsubmitError && <UnsubmitFailedNote url={req.unsubmitUrl} error={req.unsubmitError} uncertain={req.unsubmitUncertain} />}
      {panel && (
        <span className="resubmit-control__panel">
          <NumberStepper value={lessons} min={1} max={60} onChange={setLessons} aria-label="Resubmission deadline (school days)" />
          <span className="text-sm">school days</span>
          <LessonHint courseId={courseId} from={req?.requestedOn || localIsoDate()} value={lessons} onPick={setLessons} />
          {req ? (
            <>
              <button type="button" className="secondary btn-sm" onClick={extend}>Extend</button>
              {pastDeadline && <button type="button" className="primary btn-sm" onClick={gradeStands}>Grade stands</button>}
              <button type="button" className="ghost danger btn-sm" onClick={undo}>Undo</button>
            </>
          ) : (
            <>
              <input className="triage-note" placeholder="Note (optional)" aria-label="Resubmission note" value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="button" className="primary btn-sm" onClick={ask}>Ask</button>
            </>
          )}
        </span>
      )}
      {confirm && (
        <StatusLineModal
          key={confirm.key} studentName={studentFullName(student)} title={title} {...ids} {...confirm.props}
          onCancel={() => setConfirm(null)}
        />
      )}
    </span>
  );
}
