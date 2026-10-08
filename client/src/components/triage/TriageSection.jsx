import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getTriage, recordReferral, recordExtension, setMakeUpIgnored,
  updateResubmission, getStatusLineUntil,
} from '../../services/api.js';
import { extensionLine, makeUpLine, extendResubmissionLine, gradeStandsLine } from '../../lib/statusLines.js';
import StatusLineModal from '../StatusLineModal.jsx';
import { useDataVersion } from '../../hooks/useDataVersion.jsx';
import { formatDateTime, localIsoDate } from '../../lib/formatDate.js';
import LateWorkPanel from './LateWorkPanel.jsx';
import FeedbackOwedPanel from './FeedbackOwedPanel.jsx';
import MakeUpPanel from './MakeUpPanel.jsx';
import ResubmissionsPanel from './ResubmissionsPanel.jsx';

// The triage rail: an <aside> of stacked panels — make-up tests first (the most
// urgent: a missed test can be invalidated), then late work, then resubmissions,
// then feedback owed — across all current courses (no courseId — Dashboard) or
// for one course (CoursePage). The page lays it out beside its main column (.triage-layout).
// Owns its fetch; onLoaded hands the payload up (the Dashboard uses it for
// course-card chips and the school-day header, the course page for the Gradebook
// tab's "Triage" count); onMakeUpIgnored(assignmentId) tells the course page a
// quiz was ignored; bumping `version` re-fetches in place (keeps Show formative
// and an open history). `hidden` hides the rail but keeps it mounted (and fetching).
// Actions that publish a status line to the student's Schoology comment (extensions,
// make-up extensions, resubmission Extend / Grade stands) open one StatusLineModal
// confirm here; nothing is written until Publish, and Cancel writes nothing.
export default function TriageSection({ courseId = null, onLoaded, onMakeUpIgnored, version = 0, hidden = false, id }) {
  const dataVersion = useDataVersion();
  const [data, setData] = useState(null);
  const [includeFormative, setIncludeFormative] = useState(undefined); // undefined → the Settings default
  const [showHistory, setShowHistory] = useState(false);
  const [showResubHistory, setShowResubHistory] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0); // reloads an open history after a record
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null); // StatusLineModal props for the action being confirmed
  const actionSeq = useRef(0); // a fresh key per opened action → the modal always remounts

  const load = useCallback(async () => {
    try {
      const t = await getTriage({ courseId, includeFormative });
      if (!t) return;
      setData(t);
      setError(null);
      onLoaded?.(t);
    } catch (err) {
      setError(err.message);
    }
  }, [courseId, includeFormative]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load, dataVersion, version]);

  // A write, then refresh the lists (and an open history).
  async function write(fn) {
    try {
      await fn();
      setHistoryVersion((v) => v + 1);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }
  const handleRecord = (row, action, note) =>
    write(() => recordReferral({ studentId: row.studentId, assignmentId: row.assignmentId, action, note }));
  const handleIgnore = (row) => write(async () => {
    await setMakeUpIgnored(row.assignmentId, true);
    onMakeUpIgnored?.(row.assignmentId);
  });

  // Open the confirm for one row. `run(line)` does the write; errors stay in the
  // modal (a Schoology change Prism then failed to record still refreshes the lists).
  const publish = (row, { run, ...props }) => setConfirm({
    key: (actionSeq.current += 1),
    props: {
      studentName: row.studentName, studentId: row.studentId, assignmentId: row.assignmentId, title: row.title,
      ...props,
      onConfirm: async (line) => {
        try {
          await run(line);
        } catch (err) {
          if (err.published) { setHistoryVersion((v) => v + 1); load(); }
          throw err;
        }
        setConfirm(null);
        setHistoryVersion((v) => v + 1);
        await load();
      },
    },
  });
  const lessonsText = (n) => `${n} school day${n === 1 ? '' : 's'}`;
  const untilFor = async (q) => (await getStatusLineUntil(q)).until;

  // Late work (extensionLine) and make-up tests (makeUpLine) — the note goes into the line.
  const extend = (row, lessons, note, makeUp) => publish(row, {
    // N school days from today (these rows are past their due / test date).
    consequence: makeUp
      ? `Gives ${row.studentName} ${lessonsText(lessons)} from today to sit the test.`
      : `Gives ${row.studentName} ${lessonsText(lessons)} from today to hand it in.`,
    confirmLabel: 'Publish new due date',
    loadDefaultLine: async () => {
      const until = await untilFor({ kind: makeUp ? 'make_up' : 'extension', studentId: row.studentId, assignmentId: row.assignmentId, lessons });
      return makeUp ? makeUpLine({ until, note }) : extensionLine({ until, lessons, note });
    },
    run: (commentLine) => recordExtension({ studentId: row.studentId, assignmentId: row.assignmentId, lessons, note, commentLine }),
  });
  const handleExtend = (row, lessons, note) => extend(row, lessons, note, false);
  const handleExtendMakeUp = (row, lessons, note) => extend(row, lessons, note, true);
  const handleExtendResub = (row, lessons) => publish(row, {
    consequence: `Gives ${row.studentName} ${lessonsText(lessons)} to resubmit, counted from ${row.requestedOn < localIsoDate() ? 'today' : 'the ask'}.`,
    confirmLabel: 'Publish new due date',
    loadDefaultLine: async () => extendResubmissionLine({
      until: await untilFor({ kind: 'extend_resubmission', studentId: row.studentId, assignmentId: row.assignmentId, resubmissionId: row.id, lessons }),
    }),
    run: (commentLine) => updateResubmission(row.id, { lessons, commentLine }),
  });
  const handleGradeStands = (row) => publish(row, {
    // Prism never re-submits: unsubmitted OneDrive work stays that way.
    consequence: `Ends the resubmission request: missed deadline, grade stands.${row.ltiState === 'in_progress' ? ' Their work stays unsubmitted in Schoology.' : ''}`,
    confirmLabel: 'Publish & close request',
    defaultLine: gradeStandsLine({ until: row.until }),
    run: (commentLine) => updateResubmission(row.id, { gradeStands: true, commentLine }),
  });

  if (!data && !error) return null;
  const rail = (children) => (
    <aside className="triage triage-rail" aria-label="Triage" hidden={hidden} id={id}>{children}</aside>
  );
  if (!data) return rail(<div className="alert alert-warning">Triage unavailable: {error}</div>);
  const showCourse = courseId == null;
  const scope = courseId ?? 'all';
  return rail(
    <>
      {error && <div className="alert alert-warning">{error}</div>}
      {!showCourse && data.lastSyncAt && (
        <p className="text-sm text-muted triage__asof">Counts as of the last sync, {formatDateTime(data.lastSyncAt)}</p>
      )}
      <MakeUpPanel
        rows={data.makeUps ?? []} settings={data.settings} showCourse={showCourse} scope={scope}
        unchecked={data.makeUpsUnchecked ?? 0} ignored={data.makeUpsIgnored ?? 0}
        onExtend={handleExtendMakeUp} onIgnore={handleIgnore}
      />
      <LateWorkPanel
        rows={data.lateWork} settings={data.settings} showCourse={showCourse} scope={scope}
        onRecord={handleRecord} onExtend={handleExtend}
        historyCount={data.historyCount}
        historyOpen={showHistory} onToggleHistory={() => setShowHistory((v) => !v)}
        courseId={courseId} historyVersion={historyVersion}
        onCloseHistory={() => setShowHistory(false)} onHistoryChanged={load}
      />
      <ResubmissionsPanel
        rows={data.resubmissions ?? []} settings={data.settings} showCourse={showCourse} scope={scope}
        onGradeStands={handleGradeStands} onExtend={handleExtendResub}
        historyCount={data.resubmissionHistoryCount ?? 0}
        historyOpen={showResubHistory} onToggleHistory={() => setShowResubHistory((v) => !v)}
        courseId={courseId} historyVersion={historyVersion}
        onCloseHistory={() => setShowResubHistory(false)} onHistoryChanged={load}
      />
      <FeedbackOwedPanel
        rows={data.feedbackOwed} settings={data.settings} showCourse={showCourse} scope={scope}
        includeFormative={data.includeFormative} onToggleFormative={setIncludeFormative}
      />
      {confirm && <StatusLineModal key={confirm.key} {...confirm.props} onCancel={() => setConfirm(null)} />}
    </>,
  );
}
