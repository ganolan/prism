import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyRing from './UrgencyRing.jsx';
import CourseLine from './CourseLine.jsx';
import ExtendEditor, { ExtensionTag } from './ExtendEditor.jsx';
import { PanelHead, ShowAllToggle, RowToggle, useShowAll, useOpenRows, limitRows, moreId } from './panelParts.jsx';

// Late summative work, worst first. Days are numbered from the due date = day 1;
// `limit` (referralLimitDays) is the last allowed day, referral after it. A row
// past the limit has an inline Refer (= Mark referred); every row expands (▾) to
// Extend by N lessons (school days), with the days left before the limit
// ("last day" on day `limit`) on rows not yet past it.
const daysLeft = (day, limit) => (limit - day > 0 ? `${limit - day} left` : 'last day');

export default function LateWorkPanel({ rows, settings, showCourse, scope, onRecord, onExtend, onShowHistory, historyCount }) {
  const panelId = useId();
  const [extending, setExtending] = useState(null);
  const [showAll, toggleShowAll] = useShowAll(`late.${scope}`);
  const [isOpen, toggleOpen] = useOpenRows();
  const limit = settings.referralLimitDays;
  const toRefer = rows.filter((r) => r.tone === 'red').length;
  const key = (r) => `${r.studentId}:${r.assignmentId}`;

  return (
    <section className="card triage-panel" aria-label="Late work">
      <PanelHead title="Late work" badge={toRefer > 0 && <span className="badge badge-red">{toRefer} to refer</span>}>
        <ShowAllToggle total={rows.length} showAll={showAll} onToggle={toggleShowAll} />
      </PanelHead>
      <p className="triage-panel__sub">due date = day 1 · refer after day {limit}</p>
      {rows.length === 0 && <p className="text-sm text-muted">No late summative work.</p>}
      {limitRows(rows, showAll).map((r) => {
        const k = key(r);
        const red = r.tone === 'red';
        const open = isOpen(k);
        return (
          <div key={k} className={`triage-row${open ? ' is-open' : ''}`}>
            <UrgencyRing day={r.day} limit={limit} tone={r.tone} approx={r.approx} size={28} />
            <div className="triage-row__text">
              <div className="triage-row__line">
                <Link to={`/student/${r.studentId}`} className="triage-row__name" title={r.studentName}>{r.studentName}</Link>
                {r.kind === 'submitted_late' && <span className="badge badge-amber triage-row__tag">submitted day {r.submittedDay}</span>}
                {r.extension && <ExtensionTag extension={r.extension} />}
              </div>
              {showCourse && <CourseLine row={r} />}
              <div className="triage-row__task" title={r.title}>{r.title}</div>
            </div>
            <div className="triage-row__actions">
              {red && <button className="primary btn-sm" aria-label="Mark referred" onClick={() => onRecord(r, 'referred')}>Refer</button>}
              <RowToggle label={`${r.studentName}, ${r.title}`} expanded={open} controls={moreId(panelId, k)} onToggle={() => toggleOpen(k)} />
            </div>
            {open && (
              <div className="triage-row__more" id={moreId(panelId, k)}>
                {extending === k ? (
                  <ExtendEditor
                    extension={r.extension}
                    onSave={(lessons, note) => { onExtend(r, lessons, note); setExtending(null); }}
                    onCancel={() => setExtending(null)}
                  />
                ) : (
                  <>
                    {!red && <span className="text-sm text-muted">{daysLeft(r.day, limit)}</span>}
                    <button className="secondary btn-sm" onClick={() => setExtending(k)}>Extend</button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      <button className="ghost triage-panel__history" onClick={onShowHistory}>
        Referred / extended ({historyCount}) ›
      </button>
    </section>
  );
}
