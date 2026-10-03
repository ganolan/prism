import { useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyRing from './UrgencyRing.jsx';
import CourseLine from './CourseLine.jsx';
import ExtendEditor from './ExtendEditor.jsx';
import { PanelHead, ShowAllToggle, useShowAll, limitRows } from './panelParts.jsx';
import ReferralHistory from './ReferralHistory.jsx';
import { formatDate } from '../../lib/formatDate.js';

// Resubmissions: per student × assessment. "arrived" = a resubmission newer than
// the last feedback (day 1 = its date, regrade by day feedbackLimitDays); "waiting"
// = asked to resubmit (day 1 = the ask, deadline `until`). Arrived rows: Reviewed
// (grade stands). Waiting rows: Close (grade stands, optional note) + Extend.
// Hidden when empty. Row names open the student's card on the assessment page.
export const cardLink = (r) => `/course/${r.courseId}/assessment/${r.schoologyAssignmentId}?student=${r.studentId}`;
const left = (r) => (r.limit - r.day > 0 ? `${r.limit - r.day} left` : 'last day');

export default function ResubmissionsPanel({
  rows, settings, showCourse, scope, onReview, onClose, onExtend, historyCount,
  historyOpen, onToggleHistory, courseId, historyVersion, onCloseHistory, onHistoryChanged,
}) {
  const [open, setOpen] = useState(null); // { key, mode: 'extend' | 'close' }
  const [closeNote, setCloseNote] = useState('');
  const [showAll, toggleShowAll] = useShowAll(`resub.${scope}`);
  if (rows.length === 0 && !historyOpen) return null;
  const overdue = rows.filter((r) => r.tone === 'red').length;
  const key = (r) => `${r.studentId}:${r.assignmentId}`;

  return (
    <section className="card triage-panel" aria-label="Resubmissions">
      <PanelHead title="Resubmissions" badge={overdue > 0 && <span className="badge badge-red">{overdue} overdue</span>}>
        <ShowAllToggle total={rows.length} showAll={showAll} onToggle={toggleShowAll} />
      </PanelHead>
      <p className="triage-panel__sub">asked = day 1 · regrade by day {settings.feedbackLimitDays}</p>
      {limitRows(rows, showAll).map((r) => {
        const k = key(r);
        const mode = open?.key === k ? open.mode : null;
        return (
          <div key={k} className="triage-row">
            <UrgencyRing day={r.day} limit={r.limit} tone={r.tone} approx={r.approx} size={28} />
            <div className="triage-row__text">
              <div className="triage-row__line">
                <Link to={cardLink(r)} className="triage-row__name" title={r.studentName}>{r.studentName}</Link>
                {r.state === 'arrived'
                  ? <span className="badge badge-resubmitted triage-row__tag">↩ arrived</span>
                  : <span className="badge badge-resubmit triage-row__tag" title={r.note || undefined}>⟳ by {formatDate(`${r.until}T00:00:00`)}</span>}
                {r.source === 'schoology_unsubmit' && <span className="badge badge-gray triage-row__tag">unsubmitted in Schoology</span>}
                {r.afterDeadline && <span className="badge badge-amber triage-row__tag">after deadline</span>}
              </div>
              {showCourse && <CourseLine row={r} />}
              <div className="triage-row__task" title={r.title}>{r.title}</div>
            </div>
            <div className="triage-row__actions">
              {r.state === 'arrived' ? (
                <button className="primary btn-sm" onClick={() => onReview(r)}>Reviewed</button>
              ) : (
                <>
                  {r.tone === 'red'
                    ? <button className="primary btn-sm" onClick={() => { setCloseNote(''); setOpen({ key: k, mode: 'close' }); }}>Close</button>
                    : <span className="text-sm text-muted">{left(r)}</span>}
                  <button className="secondary btn-sm" onClick={() => setOpen(mode === 'extend' ? null : { key: k, mode: 'extend' })}>Extend</button>
                  {r.tone !== 'red' && (
                    <button className="ghost btn-sm" onClick={() => { setCloseNote(''); setOpen({ key: k, mode: 'close' }); }}>Close</button>
                  )}
                </>
              )}
            </div>
            {mode === 'extend' && (
              <div className="triage-row__more">
                <ExtendEditor
                  extension={{ lessons: r.lessons, note: '' }}
                  onSave={(lessons) => { onExtend(r, lessons); setOpen(null); }}
                  onCancel={() => setOpen(null)}
                />
              </div>
            )}
            {mode === 'close' && (
              <div className="triage-row__more">
                <input className="triage-note" placeholder="Note (optional)" aria-label="Close note" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
                <button className="secondary btn-sm" aria-label="Confirm close" onClick={() => { onClose(r, closeNote); setOpen(null); }}>Close request</button>
                <button className="ghost" onClick={() => setOpen(null)}>Cancel</button>
              </div>
            )}
          </div>
        );
      })}
      <button className="ghost triage-panel__history" aria-expanded={historyOpen} onClick={onToggleHistory}>
        Closed / reviewed ({historyCount}) ›
      </button>
      {historyOpen && (
        <ReferralHistory mode="resubmissions" courseId={courseId} version={historyVersion} onClose={onCloseHistory} onChanged={onHistoryChanged} />
      )}
    </section>
  );
}
