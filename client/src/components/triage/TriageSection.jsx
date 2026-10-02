import { useCallback, useEffect, useState } from 'react';
import { getTriage, recordReferral, recordExtension, setMakeUpIgnored } from '../../services/api.js';
import { useDataVersion } from '../../hooks/useDataVersion.jsx';
import { formatDateTime } from '../../lib/formatDate.js';
import LateWorkPanel from './LateWorkPanel.jsx';
import FeedbackOwedPanel from './FeedbackOwedPanel.jsx';
import MakeUpPanel from './MakeUpPanel.jsx';
import ReferralHistory from './ReferralHistory.jsx';

// The triage panels — make-up tests full-width on top (the most urgent: a missed
// test can be invalidated), then late work + feedback owed side by side — across
// all current courses (no courseId — Dashboard) or for one course (CoursePage). Owns its fetch; onLoaded hands the payload up
// (the Dashboard uses it for course-card chips and the school-day header);
// onMakeUpIgnored(assignmentId) tells the course page a quiz was ignored; bumping
// `version` re-fetches in place (keeps Show formative and an open history).
export default function TriageSection({ courseId = null, onLoaded, onMakeUpIgnored, version = 0 }) {
  const dataVersion = useDataVersion();
  const [data, setData] = useState(null);
  const [includeFormative, setIncludeFormative] = useState(undefined); // undefined → the Settings default
  const [showHistory, setShowHistory] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0); // reloads an open history after a record
  const [error, setError] = useState(null);

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
  const handleExtend = (row, lessons, note) =>
    write(() => recordExtension({ studentId: row.studentId, assignmentId: row.assignmentId, lessons, note }));
  const handleIgnore = (row) => write(async () => {
    await setMakeUpIgnored(row.assignmentId, true);
    onMakeUpIgnored?.(row.assignmentId);
  });

  if (!data) return error ? <div className="alert alert-warning">Triage unavailable: {error}</div> : null;
  const showCourse = courseId == null;
  return (
    <div className="triage">
      {error && <div className="alert alert-warning">{error}</div>}
      {!showCourse && data.lastSyncAt && (
        <p className="text-sm text-muted triage__asof">Counts as of the last sync, {formatDateTime(data.lastSyncAt)}</p>
      )}
      <MakeUpPanel
        rows={data.makeUps ?? []} settings={data.settings} showCourse={showCourse}
        unchecked={data.makeUpsUnchecked ?? 0} ignored={data.makeUpsIgnored ?? 0}
        onExtend={handleExtend} onIgnore={handleIgnore}
      />
      <div className="triage-grid">
        <LateWorkPanel
          rows={data.lateWork} settings={data.settings} showCourse={showCourse}
          onRecord={handleRecord} onExtend={handleExtend}
          onShowHistory={() => setShowHistory(true)} historyCount={data.historyCount}
        />
        <FeedbackOwedPanel
          rows={data.feedbackOwed} settings={data.settings} showCourse={showCourse}
          includeFormative={data.includeFormative} onToggleFormative={setIncludeFormative}
        />
      </div>
      {showHistory && <ReferralHistory courseId={courseId} version={historyVersion} onClose={() => setShowHistory(false)} onChanged={load} />}
    </div>
  );
}
