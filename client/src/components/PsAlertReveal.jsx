import { useEffect, useState } from 'react';
import PsAlertBadges from './PsAlertBadges.jsx';
import { formatDate, formatDateTime } from '../lib/formatDate.js';
import { getSupportSummary } from '../services/api.js';

// The Student Support Summary (#163), read from PowerSchool only once the alerts are
// shown, and again on every reveal: nothing is kept on the page. Every row verbatim;
// Prism infers nothing from it (the extra time is in Support Notes, in PowerSchool's words).
function SupportSummary({ studentId }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    getSupportSummary(studentId)
      .then((r) => { if (live) setState({ rows: r.rows || [], readAt: r.readAt }); })
      .catch((err) => { if (live) setState({ error: err.message }); });
    return () => { live = false; };
  }, [studentId]);

  if (state.loading) return <p className="text-sm text-muted">Reading the Student Support Summary from PowerSchool…</p>;
  if (state.error) return <p className="text-sm ps-support-summary__error">Could not read the Support Summary: {state.error}</p>;
  return (
    <section className="ps-support-summary" aria-label="Student Support Summary">
      <h4 className="ps-support-summary__title">
        Student Support Summary
        {state.readAt && <span className="text-sm text-muted">, read from PowerSchool {formatDateTime(state.readAt)}</span>}
      </h4>
      {state.rows.length === 0 ? (
        <p className="text-sm text-muted">PowerSchool&apos;s Support Summary is empty.</p>
      ) : (
        <dl className="ps-support-summary__rows">
          {state.rows.map((r) => (
            <div key={r.category} className="ps-support-summary__row">
              <dt>{r.category}</dt>
              <dd>{r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer" className="link">{r.description || r.url}</a> : r.description}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

// The student page's PowerSchool alerts (#117), hidden until the teacher clicks.
// The page may be on a projector during a parent conference, so before the click
// only "Show alerts (N)" shows: no labels, no categories, no colours. The reveal is
// never remembered: every page load (and every other student) starts hidden.
export default function PsAlertReveal({ alerts, syncedAt = null, studentId = null }) {
  const [shown, setShown] = useState(false);
  if (!alerts?.length) return null;
  if (!shown) {
    return (
      <button type="button" className="ghost ps-alerts-reveal" aria-expanded="false" onClick={() => setShown(true)}>
        Show alerts ({alerts.length})
      </button>
    );
  }
  return (
    <div className="ps-alerts-revealed">
      <PsAlertBadges alerts={alerts} syncedAt={syncedAt} />
      {syncedAt && (
        <span className="text-sm text-muted">from PowerSchool, read {formatDate(syncedAt)}</span>
      )}
      <button type="button" className="ghost ps-alerts-reveal" aria-expanded="true" onClick={() => setShown(false)}>
        Hide alerts
      </button>
      {studentId != null && alerts.some((a) => a.key === 'support_summary') && <SupportSummary studentId={studentId} />}
    </div>
  );
}
