import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyRing from './UrgencyRing.jsx';
import CourseLine from './CourseLine.jsx';
import ExtendEditor from './ExtendEditor.jsx';
import { PanelHead, ShowAllToggle, useShowAll, limitRows } from './panelParts.jsx';
import ReferralHistory from './ReferralHistory.jsx';
import { formatDate } from '../../lib/formatDate.js';
import UnsubmitFailedNote from '../UnsubmitFailedNote.jsx';
import EmailMenu, { MailLink } from './EmailMenu.jsx';

// Resubmissions: per student × assessment (spec Amendment B). "arrived" = a
// resubmission still awaiting visible feedback (day 1 = its date, regrade by day
// feedbackLimitDays) — no button: the teacher answers by regrading or writing a
// visible comment. "waiting" = asked to resubmit (day 1 = the ask, deadline `until`):
// "N left" + Extend before the deadline; once it has passed (red), Grade stands
// above Extend. Extend and Grade stands publish a status line to the student's
// Schoology comment, so both go through the parent's StatusLineModal confirm.
// Hidden on a fresh load with no rows. Once the panel has shown rows during this
// mount, it stays mounted even after the list empties out (e.g. the last row was
// just closed) — "All caught up." plus the History link, so the record just made
// stays reachable instead of stranding Undo behind a vanished panel.
// Row names open the student's card on the assessment page. A failed LTI unsubmit on the
// ask (Phase 2) shows "Unsubmit failed — unsubmit it in Schoology ›" until a sync sees
// the work in progress.
// "@ ▾" (EmailMenu) copies still-owing students' addresses; ✉ (MailLink) on each row opens a mailto.
export const cardLink = (r) => `/course/${r.courseId}/assessment/${r.schoologyAssignmentId}?student=${r.studentId}`;
const left = (r) => (r.limit - r.day > 0 ? `${r.limit - r.day} left` : 'last day');

export default function ResubmissionsPanel({
  rows, settings, showCourse, scope, onGradeStands, onExtend, historyCount,
  historyOpen, onToggleHistory, courseId, historyVersion, onCloseHistory, onHistoryChanged,
}) {
  const [extending, setExtending] = useState(null); // row key
  const [showAll, toggleShowAll] = useShowAll(`resub.${scope}`);
  const hadRowsRef = useRef(false);
  if (rows.length > 0) hadRowsRef.current = true;
  if (rows.length === 0 && !historyOpen && !hadRowsRef.current) return null;
  const overdue = rows.filter((r) => r.tone === 'red').length;
  const key = (r) => `${r.studentId}:${r.assignmentId}`;

  return (
    <section className="card triage-panel" id="triage-resubmissions" aria-label="Resubmissions">
      <PanelHead title="Resubmissions" badge={overdue > 0 && <span className="badge badge-red">{overdue} overdue</span>}>
        <EmailMenu kind="resubmissions" rows={rows} showCourse={showCourse} />
        <ShowAllToggle total={rows.length} showAll={showAll} onToggle={toggleShowAll} />
      </PanelHead>
      <p className="triage-panel__sub">school days since asked or arrived · regrade overdue at {settings.feedbackLimitDays}</p>
      {rows.length === 0 && <p className="text-sm text-muted">All caught up.</p>}
      {limitRows(rows, showAll).map((r) => {
        const k = key(r);
        const isExtending = extending === k;
        const arrived = r.state === 'arrived';
        return (
          <div key={k} className="triage-row">
            <UrgencyRing day={r.day} limit={r.limit} tone={r.tone} approx={r.approx} size={28} />
            <div className="triage-row__text">
              <div className="triage-row__line">
                <Link to={cardLink(r)} className="triage-row__name" title={r.studentName}>{r.studentName}</Link>
                <MailLink row={r} kind="resubmissions" />
                {arrived
                  ? <span className="badge badge-resubmitted triage-row__tag">↩ arrived · awaiting feedback</span>
                  : <span className="badge badge-resubmit triage-row__tag" title={r.note || undefined}>⟳ by {formatDate(`${r.until}T00:00:00`)}</span>}
                {r.source === 'schoology_unsubmit' && <span className="badge badge-gray triage-row__tag">unsubmitted in Schoology</span>}
                {r.afterDeadline && <span className="badge badge-amber triage-row__tag">after deadline</span>}
              </div>
              {showCourse && <CourseLine row={r} />}
              <div className="triage-row__task" title={r.title}>{r.title}</div>
              {r.unsubmitError && <UnsubmitFailedNote url={r.unsubmitUrl} error={r.unsubmitError} uncertain={r.unsubmitUncertain} className="text-sm" />}
            </div>
            {!arrived && (
              <div className="triage-row__actions">
                {r.tone === 'red'
                  ? <button className="primary btn-sm" title="Missed deadline · grade stands" onClick={() => onGradeStands(r)}>Grade stands</button>
                  : <span className="text-sm text-muted">{left(r)}</span>}
                <button className="secondary btn-sm" onClick={() => setExtending(isExtending ? null : k)}>Extend</button>
              </div>
            )}
            {isExtending && (
              <div className="triage-row__more">
                <ExtendEditor
                  courseId={r.courseId} from={r.requestedOn}
                  extension={{ lessons: r.lessons, note: '' }}
                  onSave={(lessons) => { onExtend(r, lessons); setExtending(null); }}
                  onCancel={() => setExtending(null)}
                  showNote={false}
                />
              </div>
            )}
          </div>
        );
      })}
      <button className="ghost triage-panel__history" aria-expanded={historyOpen} onClick={onToggleHistory}>
        History ({historyCount}) ›
      </button>
      {historyOpen && (
        <ReferralHistory mode="resubmissions" courseId={courseId} version={historyVersion} onClose={onCloseHistory} onChanged={onHistoryChanged} />
      )}
    </section>
  );
}
