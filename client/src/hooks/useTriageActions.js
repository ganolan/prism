import { createElement, useRef, useState } from 'react';
import {
  recordReferral, recordExtension, setMakeUpIgnored, updateResubmission, getStatusLineUntil,
  undoReferral, undoExtension,
} from '../services/api.js';
import { extensionLine, makeUpLine, extendResubmissionLine, gradeStandsLine } from '../lib/statusLines.js';
import StatusLineModal from '../components/StatusLineModal.jsx';
import { countFromText } from '../components/CountFromChoice.jsx';
import { localIsoDate } from '../lib/formatDate.js';

// The triage rail's actions on a row (Refer, Waive, Extend, Grade stands, Ignore this test), shared by
// the rail (TriageSection) and the Roster tab's Needs attention (#160), so both write the same way.
// Actions that publish a status line to the student's Schoology comment (extensions, make-up
// extensions, resubmission Extend / Grade stands, and Undo of an extension) open one StatusLineModal
// confirm, returned as `modal` for the caller to render; nothing is written until Publish, and
// Cancel writes nothing.
//  - onChanged(): after a write, refresh (the rail re-reads triage and an open history).
//  - onError(message): a write failed, or Schoology left a warning.
//  - onMakeUpIgnored(assignmentId): a whole test was ignored.
//  - onDone(action, row, result): a write went through ('referred', 'waived', 'extended',
//    'resub_extended', 'grade_stands', 'undone'), with what the server returned.
export function useTriageActions({ onChanged, onError, onMakeUpIgnored, onDone } = {}) {
  const [confirm, setConfirm] = useState(null); // StatusLineModal props for the action being confirmed
  const actionSeq = useRef(0); // a fresh key per opened action → the modal always remounts
  const changed = () => onChanged?.();

  // A write, then refresh the lists.
  async function write(fn) {
    try {
      const out = await fn();
      await changed();
      return out;
    } catch (err) {
      onError?.(err.message);
      return undefined;
    }
  }
  const record = (row, action, note) => write(async () => {
    const out = await recordReferral({ studentId: row.studentId, assignmentId: row.assignmentId, action, note });
    onDone?.(action, row, out);
    return out;
  });
  // Refer through ReferPanel (#175, missing work): a refusal throws, so the panel shows it in
  // place; a warning (IE written, Missing not) goes to onError. The lists refresh either way.
  const refer = async (row, schoology) => {
    try {
      const out = await recordReferral({ studentId: row.studentId, assignmentId: row.assignmentId, action: 'referred', schoology });
      if (out?.schoology?.warning) onError?.(out.schoology.warning);
      onDone?.('referred', row, out);
      return out;
    } finally {
      changed();
    }
  };
  const ignore = (row) => write(async () => {
    await setMakeUpIgnored(row.assignmentId, true);
    onMakeUpIgnored?.(row.assignmentId);
  });

  // Open the confirm for one row. `run(line)` does the write; errors stay in the
  // modal (a Schoology change Prism then failed to record still refreshes the lists).
  const publish = (row, action, { run, ...props }) => setConfirm({
    key: (actionSeq.current += 1),
    props: {
      studentName: row.studentName, studentId: row.studentId, assignmentId: row.assignmentId, title: row.title,
      ...props,
      onConfirm: async (line) => {
        let out;
        try {
          out = await run(line);
        } catch (err) {
          if (err.published) changed();
          throw err;
        }
        setConfirm(null);
        onDone?.(action, row, out);
        await changed();
      },
    },
  });
  const lessonsText = (n) => `${n} school day${n === 1 ? '' : 's'}`;
  const untilFor = async (q) => (await getStatusLineUntil(q)).until;

  // Overdue work (extensionLine) and make-up tests (makeUpLine): the note goes into the line.
  // countFrom 'due_date' (the default) adds the days to the original due / test date;
  // 'today' gives them from now (these rows are past their due / test date).
  const extendBy = (row, lessons, note, makeUp, countFrom = 'due_date') => publish(row, 'extended', {
    consequence: `Gives ${row.studentName} ${lessonsText(lessons)} ${makeUp ? 'to sit the test' : 'to hand it in'}, counted from ${countFromText(row.dueDate, countFrom)}.`,
    confirmLabel: 'Publish new due date',
    loadDefaultLine: async () => {
      const until = await untilFor({ kind: makeUp ? 'make_up' : 'extension', studentId: row.studentId, assignmentId: row.assignmentId, lessons, countFrom });
      return makeUp ? makeUpLine({ until, note }) : extensionLine({ until, lessons, note });
    },
    run: (commentLine) => recordExtension({ studentId: row.studentId, assignmentId: row.assignmentId, lessons, countFrom, note, commentLine }),
  });
  const extend = (row, lessons, note, countFrom) => extendBy(row, lessons, note, false, countFrom);
  const extendMakeUp = (row, lessons, note, countFrom) => extendBy(row, lessons, note, true, countFrom);
  const extendResub = (row, lessons) => publish(row, 'resub_extended', {
    consequence: `Gives ${row.studentName} ${lessonsText(lessons)} to resubmit, counted from ${row.requestedOn < localIsoDate() ? 'today' : 'the ask'}.`,
    confirmLabel: 'Publish new due date',
    loadDefaultLine: async () => extendResubmissionLine({
      until: await untilFor({ kind: 'extend_resubmission', studentId: row.studentId, assignmentId: row.assignmentId, resubmissionId: row.id, lessons }),
    }),
    run: (commentLine) => updateResubmission(row.id, { lessons, commentLine }),
  });
  const gradeStands = (row) => publish(row, 'grade_stands', {
    // Prism never re-submits: unsubmitted OneDrive work stays that way.
    consequence: `Ends the resubmission request: missed deadline, grade stands.${row.ltiState === 'in_progress' ? ' Their work stays unsubmitted in Schoology.' : ''}`,
    confirmLabel: 'Publish & close request',
    defaultLine: gradeStandsLine({ until: row.until }),
    run: (commentLine) => updateResubmission(row.id, { gradeStands: true, commentLine }),
  });

  // Undo what one of these actions recorded, as the rail's history does (ReferralHistory):
  //  - kind 'referral': undoReferral; `schoology` (a referral that wrote IE and Missing, after the
  //    caller's ReferPanel confirm) also clears them. Throws, so the caller shows a refusal in place.
  //  - kind 'extension': the remove confirm (StatusLineModal removeMode), which can also take the
  //    line this extension published off the student's comment.
  const undo = async (row, { kind, record: rec }, { schoology = false } = {}) => {
    if (kind === 'extension') {
      publish(row, 'undone', {
        removeMode: true,
        undoSource: { sourceType: 'extension', sourceId: rec.id },
        consequence: 'Deletes this extension from Prism.',
        confirmLabel: 'Undo',
        run: (removeLine) => undoExtension(rec.id, { removeLine }),
      });
      return undefined;
    }
    const out = await undoReferral(rec.id, { schoology });
    if (out?.schoology?.warning) onError?.(out.schoology.warning);
    onDone?.('undone', row, out);
    await changed();
    return out;
  };

  const modal = confirm
    ? createElement(StatusLineModal, { key: confirm.key, ...confirm.props, onCancel: () => setConfirm(null) })
    : null;
  return { record, refer, extend, extendMakeUp, extendResub, gradeStands, ignore, undo, modal };
}
