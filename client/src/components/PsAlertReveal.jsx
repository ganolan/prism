import { useState } from 'react';
import PsAlertBadges from './PsAlertBadges.jsx';
import { formatDate } from '../lib/formatDate.js';

// The student page's PowerSchool alerts (#117), hidden until the teacher clicks.
// The page may be on a projector during a parent conference, so before the click
// only "Show alerts (N)" shows: no labels, no categories, no colours. The reveal is
// never remembered: every page load (and every other student) starts hidden.
export default function PsAlertReveal({ alerts, syncedAt = null }) {
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
    </div>
  );
}
