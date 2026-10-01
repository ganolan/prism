import { useCallback, useEffect, useState } from 'react';
import { getTriage, recordReferral } from '../../services/api.js';
import { useDataVersion } from '../../hooks/useDataVersion.jsx';
import { formatDateTime } from '../../lib/formatDate.js';
import LateWorkPanel from './LateWorkPanel.jsx';
import FeedbackOwedPanel from './FeedbackOwedPanel.jsx';
import ReferralHistory from './ReferralHistory.jsx';

// The two triage panels: across all current courses (no courseId — Dashboard)
// or for one course (CoursePage). Owns its fetch; onLoaded hands the payload up
// (the Dashboard uses it for course-card chips and the school-day header).
export default function TriageSection({ courseId = null, onLoaded }) {
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

  useEffect(() => { load(); }, [load, dataVersion]);

  async function handleRecord(row, action, note) {
    try {
      await recordReferral({ studentId: row.studentId, assignmentId: row.assignmentId, action, note });
      setHistoryVersion((v) => v + 1);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!data) return error ? <div className="alert alert-warning">Triage unavailable: {error}</div> : null;
  const showCourse = courseId == null;
  return (
    <div className="triage">
      {error && <div className="alert alert-warning">{error}</div>}
      {!showCourse && data.lastSyncAt && (
        <p className="text-sm text-muted triage__asof">Counts as of the last sync, {formatDateTime(data.lastSyncAt)}</p>
      )}
      <div className="triage-grid">
        <LateWorkPanel
          rows={data.lateWork} settings={data.settings} showCourse={showCourse}
          onRecord={handleRecord} onShowHistory={() => setShowHistory(true)} referralCount={data.referralCount}
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
