import { Link } from 'react-router-dom';
import UrgencyRing from './UrgencyRing.jsx';
import CourseLine from './CourseLine.jsx';
import { PanelHead, ShowAllToggle, useShowAll, limitRows } from './panelParts.jsx';

// Assessments with ungraded submissions, longest wait first. The ring shows the
// school-day number of the oldest wait; day 1 = the start of the wait (the due
// date, or a late student's submission date). Overdue after day `limit`. The
// count sits right-aligned as "X/Y" (title: "X of Y ungraded"); no row actions.
// Ids are fixed (triage-feedback) for the Dashboard stats tiles.
export default function FeedbackOwedPanel({ rows, settings, showCourse, scope, includeFormative, onToggleFormative }) {
  const [showAll, toggleShowAll] = useShowAll(`feedback.${scope}`);
  const limit = settings.feedbackLimitDays;
  const overdue = rows.filter((r) => r.tone === 'red').length;
  return (
    <section className="card triage-panel" id="triage-feedback" aria-label="Feedback owed">
      <PanelHead title="Feedback owed" badge={overdue > 0 && <span className="badge badge-red">{overdue} overdue</span>}>
        <ShowAllToggle total={rows.length} showAll={showAll} onToggle={toggleShowAll} />
        <label className="text-sm text-muted triage-panel__toggle">
          <input type="checkbox" checked={includeFormative} onChange={(e) => onToggleFormative(e.target.checked)} aria-label="Show formative" />
          Formative
        </label>
      </PanelHead>
      <p className="triage-panel__sub">school days waiting · overdue at {limit}</p>
      {rows.length === 0 && <p className="text-sm text-muted">Nothing waiting for feedback.</p>}
      {limitRows(rows, showAll).map((r) => (
        <div key={r.assignmentId} className="triage-row">
          <UrgencyRing day={r.day} limit={limit} tone={r.tone} approx={r.approx} size={28} />
          <div className="triage-row__text">
            <div className="triage-row__line">
              <Link className="triage-row__title" to={`/course/${r.courseId}/assessment/${r.schoologyAssignmentId}`} title={r.title}>
                {r.title}
              </Link>
              {!r.aligned && <span className="badge badge-formative triage-row__tag">F</span>}
            </div>
            {showCourse && <CourseLine row={r} />}
          </div>
          <div className="triage-row__actions">
            <span className="triage-row__count" title={`${r.owed} of ${r.submittedTotal} ungraded`}>{r.owed}/{r.submittedTotal}</span>
          </div>
        </div>
      ))}
    </section>
  );
}
