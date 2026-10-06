import { useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyRing from './UrgencyRing.jsx';
import CourseLine from './CourseLine.jsx';
import ExtendEditor, { ExtensionTag } from './ExtendEditor.jsx';
import { PanelHead, ShowAllToggle, useShowAll, limitRows } from './panelParts.jsx';
import ReferralHistory from './ReferralHistory.jsx';
import { cardLink } from './ResubmissionsPanel.jsx';
import EmailMenu, { MailLink } from './EmailMenu.jsx';

// Late summative work, worst first. Days are numbered from the due date = day 1;
// `limit` (referralLimitDays) is the last allowed day, referral after it. The action
// column stacks Refer (red rows, inline, title "Mark referred") or the days-left label
// above Extend. Extend opens the shared ExtendEditor (by N lessons, school days) full-width
// below the row's text; its Save hands off to the parent's StatusLineModal confirm, which
// publishes the extension line (note included) to the student's Schoology comment. The "Referred / extended (N) ›" link at the bottom toggles
// ReferralHistory open immediately below it, inside this panel (owned by the parent
// TriageSection so a record elsewhere in the rail can still reload it).
// "@ ▾" (EmailMenu) copies still-owing students' addresses; ✉ (MailLink) on each row opens a mailto.
const daysLeft = (day, limit) => (limit - day > 0 ? `${limit - day} left` : 'last day');

export default function LateWorkPanel({
  rows, settings, showCourse, scope, onRecord, onExtend, historyCount,
  historyOpen, onToggleHistory, courseId, historyVersion, onCloseHistory, onHistoryChanged,
}) {
  const [extending, setExtending] = useState(null);
  const [showAll, toggleShowAll] = useShowAll(`late.${scope}`);
  const limit = settings.referralLimitDays;
  const toRefer = rows.filter((r) => r.tone === 'red').length;
  const key = (r) => `${r.studentId}:${r.assignmentId}`;

  return (
    <section className="card triage-panel" id="triage-late" aria-label="Late work">
      <PanelHead title="Late work" badge={toRefer > 0 && <span className="badge badge-red">{toRefer} to refer</span>}>
        <EmailMenu kind="late" rows={rows} showCourse={showCourse} />
        <ShowAllToggle total={rows.length} showAll={showAll} onToggle={toggleShowAll} />
      </PanelHead>
      <p className="triage-panel__sub">school days late · refer at {limit}</p>
      {rows.length === 0 && <p className="text-sm text-muted">No late summative work.</p>}
      {limitRows(rows, showAll).map((r) => {
        const k = key(r);
        const red = r.tone === 'red';
        const open = extending === k;
        return (
          <div key={k} className="triage-row">
            <UrgencyRing day={r.day} limit={limit} tone={r.tone} approx={r.approx} size={28} />
            <div className="triage-row__text">
              <div className="triage-row__line">
                <Link to={cardLink(r)} className="triage-row__name" title={r.studentName}>{r.studentName}</Link>
                <MailLink row={r} kind="late" />
                {r.kind === 'submitted_late' && <span className="badge badge-amber triage-row__tag">submitted {r.submittedDay - 1} school day{r.submittedDay - 1 === 1 ? '' : 's'} late</span>}
                {r.extension && <ExtensionTag extension={r.extension} />}
              </div>
              {showCourse && <CourseLine row={r} />}
              <div className="triage-row__task" title={r.title}>{r.title}</div>
            </div>
            <div className="triage-row__actions">
              {red
                ? <button className="primary btn-sm" title="Mark referred" onClick={() => onRecord(r, 'referred')}>Refer</button>
                : <span className="text-sm text-muted">{daysLeft(r.day, limit)}</span>}
              <button className="secondary btn-sm" onClick={() => setExtending(open ? null : k)}>Extend</button>
            </div>
            {open && (
              <div className="triage-row__more">
                <ExtendEditor
                  courseId={r.courseId} from={r.dueDate}
                  extension={r.extension}
                  onSave={(lessons, note) => { onExtend(r, lessons, note); setExtending(null); }}
                  onCancel={() => setExtending(null)}
                />
              </div>
            )}
          </div>
        );
      })}
      <button className="ghost triage-panel__history" aria-expanded={historyOpen} onClick={onToggleHistory}>
        Referred / extended ({historyCount}) ›
      </button>
      {historyOpen && (
        <ReferralHistory courseId={courseId} version={historyVersion} onClose={onCloseHistory} onChanged={onHistoryChanged} />
      )}
    </section>
  );
}
