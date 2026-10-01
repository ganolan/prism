import { Link } from 'react-router-dom';
import UrgencyMeter from './UrgencyMeter.jsx';

const APPROX_TITLE = 'Approximate: counted as weekdays (no PowerSchool calendar for these dates)';

// Assessments with ungraded submissions, longest wait first.
export default function FeedbackOwedPanel({ rows, settings, showCourse, includeFormative, onToggleFormative }) {
  const limit = settings.feedbackLimitDays;
  const overdue = rows.filter((r) => r.tone === 'red').length;
  return (
    <section className="card triage-panel" aria-label="Feedback owed">
      <div className="triage-panel__head">
        <h3 className="triage-panel__title">
          Feedback owed {overdue > 0 && <span className="badge badge-red">{overdue} overdue</span>}
        </h3>
        <label className="text-sm text-muted triage-panel__toggle">
          <input type="checkbox" checked={includeFormative} onChange={(e) => onToggleFormative(e.target.checked)} aria-label="Show formative" />
          Show formative
        </label>
      </div>
      <p className="triage-panel__sub">
        Ungraded {includeFormative ? '' : 'summative '}work · school days the oldest submission has waited · aim ≤ {limit}
      </p>
      {rows.length === 0 && <p className="text-sm text-muted">Nothing waiting for feedback.</p>}
      {rows.map((r) => (
        <div key={r.assignmentId} className="triage-row triage-row--feedback">
          <Link className="triage-row__task" to={`/course/${r.courseId}/assessment/${r.schoologyAssignmentId}`}>
            {showCourse && <span className="triage-row__course">{r.courseName}</span>}
            <strong>{r.title}</strong>
            {!r.aligned && <span className="badge badge-formative triage-row__tag">F</span>}
          </Link>
          <span className="text-sm text-muted">{r.owed} of {r.submittedTotal} ungraded</span>
          <UrgencyMeter days={r.oldestWaitDays} limit={limit} tone={r.tone} />
          <span className={`triage-days triage-days--${r.tone}`}>
            {r.oldestWaitDays}{r.approx && <abbr title={APPROX_TITLE}>≈</abbr>}
          </span>
        </div>
      ))}
    </section>
  );
}
