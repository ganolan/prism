import { useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyMeter from './UrgencyMeter.jsx';
import { APPROX_TITLE, courseLabel } from '../../lib/triage.js';

// Late summative work, worst first. At the referral limit a row offers
// Mark referred / Exempt (optional note); below it, the days left.
export default function LateWorkPanel({ rows, settings, showCourse, onRecord, onShowHistory, referralCount }) {
  const [exempting, setExempting] = useState(null);
  const [note, setNote] = useState('');
  const limit = settings.referralLimitDays;
  const atLimit = rows.filter((r) => r.tone === 'red').length;
  const key = (r) => `${r.studentId}:${r.assignmentId}`;

  return (
    <section className="card triage-panel" aria-label="Late work">
      <h3 className="triage-panel__title">
        Late work {atLimit > 0 && <span className="badge badge-red">{atLimit} at referral limit</span>}
      </h3>
      <p className="triage-panel__sub">Summative work late or submitted after the limit · school days since due · refer at {limit}</p>
      {rows.length === 0 && <p className="text-sm text-muted">No late summative work.</p>}
      {rows.map((r) => (
        <div key={key(r)} className="triage-row triage-row--late">
          <Link to={`/student/${r.studentId}`} className="triage-row__name">{r.studentName}</Link>
          <span className="triage-row__task">
            {showCourse && <span className="triage-row__course">{courseLabel(r)}</span>}
            {r.title}
            {r.kind === 'submitted_late' && <span className="badge badge-amber triage-row__tag">submitted day {r.daysLate}</span>}
          </span>
          <UrgencyMeter days={r.daysLate} limit={limit} tone={r.tone} />
          <span className={`triage-days triage-days--${r.tone}`}>
            {r.daysLate}{r.approx && <abbr title={APPROX_TITLE}>≈</abbr>}
          </span>
          <span className="triage-row__action">
            {r.tone !== 'red' && <span className="text-sm text-muted">{limit - r.daysLate} left</span>}
            {r.tone === 'red' && exempting !== key(r) && (
              <>
                <button className="primary" onClick={() => onRecord(r, 'referred')}>Mark referred</button>
                <button className="ghost" onClick={() => { setExempting(key(r)); setNote(''); }}>Exempt</button>
              </>
            )}
            {r.tone === 'red' && exempting === key(r) && (
              <>
                <input
                  className="triage-note" placeholder="Note (optional)" aria-label="Exemption note"
                  value={note} onChange={(e) => setNote(e.target.value)}
                />
                <button className="secondary" onClick={() => { onRecord(r, 'exempt', note); setExempting(null); }}>Save</button>
                <button className="ghost" onClick={() => setExempting(null)}>Cancel</button>
              </>
            )}
          </span>
        </div>
      ))}
      <button className="ghost triage-panel__history" onClick={onShowHistory}>
        Referred / exempt ({referralCount}) ›
      </button>
    </section>
  );
}
