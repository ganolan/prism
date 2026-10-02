import { Link } from 'react-router-dom';
import UrgencyRing from './UrgencyRing.jsx';
import CourseLine from './CourseLine.jsx';

// Assessments with ungraded submissions, longest wait first. The ring shows the
// school-day number of the oldest wait; day 1 = the start of the wait (the due
// date, or a late student's submission date). Overdue after day `limit`.
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
        Ungraded {includeFormative ? '' : 'summative '}work · day 1 = due date (or a late submission) · overdue after day {limit}
      </p>
      {rows.length === 0 && <p className="text-sm text-muted">Nothing waiting for feedback.</p>}
      {rows.map((r) => (
        <div key={r.assignmentId} className="triage-row">
          <UrgencyRing day={r.day} limit={limit} tone={r.tone} approx={r.approx} />
          <div className="triage-row__text">
            <Link className="triage-row__title" to={`/course/${r.courseId}/assessment/${r.schoologyAssignmentId}`}>
              {r.title}
              {!r.aligned && <span className="badge badge-formative triage-row__tag">F</span>}
            </Link>
            {showCourse && <CourseLine row={r} />}
          </div>
          <div className="triage-row__actions">
            <span className="text-sm text-muted">{r.owed} of {r.submittedTotal} ungraded</span>
          </div>
        </div>
      ))}
    </section>
  );
}
