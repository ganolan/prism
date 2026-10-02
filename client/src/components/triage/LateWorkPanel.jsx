import { useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyRing from './UrgencyRing.jsx';
import CourseLine from './CourseLine.jsx';
import ExtendEditor, { ExtensionTag } from './ExtendEditor.jsx';

// Late summative work, worst first. Days are numbered from the due date = day 1;
// `limit` (referralLimitDays) is the last allowed day, referral after it. Every
// row can be extended by N lessons (school days); past the limit a row also
// offers Mark referred; before it, the days left ("last day" on day `limit`).
const daysLeft = (day, limit) => (limit - day > 0 ? `${limit - day} left` : 'last day');

export default function LateWorkPanel({ rows, settings, showCourse, onRecord, onExtend, onShowHistory, historyCount }) {
  const [extending, setExtending] = useState(null);
  const limit = settings.referralLimitDays;
  const atLimit = rows.filter((r) => r.tone === 'red').length;
  const key = (r) => `${r.studentId}:${r.assignmentId}`;

  return (
    <section className="card triage-panel" aria-label="Late work">
      <h3 className="triage-panel__title">
        Late work {atLimit > 0 && <span className="badge badge-red">{atLimit} at referral limit</span>}
      </h3>
      <p className="triage-panel__sub">Summative work late or submitted after the limit · due date = day 1 · refer after day {limit}</p>
      {rows.length === 0 && <p className="text-sm text-muted">No late summative work.</p>}
      {rows.map((r) => (
        <div key={key(r)} className="triage-row">
          <UrgencyRing day={r.day} limit={limit} tone={r.tone} approx={r.approx} />
          <div className="triage-row__text">
            <Link to={`/student/${r.studentId}`} className="triage-row__name">{r.studentName}</Link>
            {showCourse && <CourseLine row={r} />}
            <div className="triage-row__task">
              {r.title}
              {r.kind === 'submitted_late' && <span className="badge badge-amber triage-row__tag">submitted day {r.submittedDay}</span>}
              {r.extension && <ExtensionTag extension={r.extension} />}
            </div>
          </div>
          {extending !== key(r) && (
            <div className="triage-row__actions">
              {r.tone !== 'red' && <span className="text-sm text-muted">{daysLeft(r.day, limit)}</span>}
              {r.tone === 'red' && <button className="primary btn-sm" onClick={() => onRecord(r, 'referred')}>Mark referred</button>}
              <button className="secondary btn-sm" onClick={() => setExtending(key(r))}>Extend</button>
            </div>
          )}
          {extending === key(r) && (
            <div className="triage-row__editor">
              <ExtendEditor
                extension={r.extension}
                onSave={(lessons, note) => { onExtend(r, lessons, note); setExtending(null); }}
                onCancel={() => setExtending(null)}
              />
            </div>
          )}
        </div>
      ))}
      <button className="ghost triage-panel__history" onClick={onShowHistory}>
        Referred / extended ({historyCount}) ›
      </button>
    </section>
  );
}
