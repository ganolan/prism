import { useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyMeter from './UrgencyMeter.jsx';
import ExtendEditor, { ExtensionTag } from './ExtendEditor.jsx';
import { APPROX_TITLE, courseLabel } from '../../lib/triage.js';

// Students who missed a Schoology test or quiz and must sit it (or their * copy)
// ASAP, longest first. A row clears itself once an attempt syncs. Extend records
// when the make-up is booked ("sitting it Thursday"); the clock counts from then.
export default function MakeUpPanel({ rows, settings, showCourse, unchecked = 0, onExtend }) {
  const [extending, setExtending] = useState(null);
  const red = settings.makeUpRedDays;
  const overdue = rows.filter((r) => r.tone === 'red').length;
  const key = (r) => `${r.studentId}:${r.assignmentId}`;

  return (
    <section className="card triage-panel triage-makeups" aria-label="Make-up tests">
      <h3 className="triage-panel__title">
        Make-up tests {overdue > 0 && <span className="badge badge-red">{overdue} overdue</span>}
      </h3>
      <p className="triage-panel__sub">Missed Schoology tests and quizzes · school days since the test · sit by day {red}</p>
      {unchecked > 0 && (
        <p className="alert alert-warning triage-panel__note">
          Couldn&apos;t check {unchecked} test{unchecked === 1 ? '' : 's'} — re-sync.
        </p>
      )}
      {rows.length === 0 && <p className="text-sm text-muted">No missed tests.</p>}
      {rows.map((r) => (
        <div key={key(r)} className="triage-row triage-row--makeup">
          <Link to={`/student/${r.studentId}`} className="triage-row__name">{r.studentName}</Link>
          <span className="triage-row__task">
            {showCourse && <span className="triage-row__course">{courseLabel(r)}</span>}
            {r.title}
            {r.extension && <ExtensionTag extension={r.extension} />}
          </span>
          <UrgencyMeter days={r.daysSince} limit={red} tone={r.tone} />
          <span className={`triage-days triage-days--${r.tone}`}>
            {r.daysSince}{r.approx && <abbr title={APPROX_TITLE}>≈</abbr>}
          </span>
          <span className="triage-row__action">
            {extending !== key(r) && <button className="ghost" onClick={() => setExtending(key(r))}>Extend</button>}
            {extending === key(r) && (
              <ExtendEditor
                extension={r.extension}
                onSave={(lessons, note) => { onExtend(r, lessons, note); setExtending(null); }}
                onCancel={() => setExtending(null)}
              />
            )}
          </span>
        </div>
      ))}
    </section>
  );
}
