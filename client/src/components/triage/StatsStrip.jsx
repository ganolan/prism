import { Link } from 'react-router-dom';
import { useSchoologyConnection } from '../SchoologyConnectionStatus.jsx';
import { formatDateTime } from '../../lib/formatDate.js';

// Dashboard "At a glance" strip (#137): one status line (school day, last sync,
// Schoology connection), then the overdue tiles from the triage payload's counts —
// "is anything on fire?" Only non-zero tiles render; all four at 0 shows one quiet
// "Nothing overdue" line instead of a grid of zeroes. A tile scrolls to its triage
// panel and focuses the panel heading; a panel that isn't rendered (an empty
// Resubmissions panel hides itself) makes it a no-op.
export const TILES = [
  { key: 'atReferralLimit', label: 'At referral limit', panel: 'triage-late' },
  { key: 'makeUpsOverdue', label: 'Make-ups overdue', panel: 'triage-makeups' },
  { key: 'resubmissionsOverdue', label: 'Resubmissions overdue', panel: 'triage-resubmissions' },
  { key: 'feedbackOverdue', label: 'Feedback overdue', panel: 'triage-feedback' },
];

const SCHOOLOGY_TEXT = { connected: 'connected', expired: 'expired', unknown: 'unknown', none: 'not set up' };

export function jumpTo(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  panel.querySelector('h3')?.focus({ preventScroll: true });
}

export default function StatsStrip({ triage, syncStatus }) {
  const { status } = useSchoologyConnection();
  const today = triage?.calendar?.today;
  const last = syncStatus?.last;
  const live = status?.live;

  const parts = [];
  if (today?.schoolDayNumber) {
    const cycle = today.cycleLetter ? ` · Day ${today.cycleLetter}` : '';
    parts.push(<span key="day">{`School day ${today.schoolDayNumber} of ${triage.calendar.totalSchoolDays}${cycle}`}</span>);
  }
  if (last) {
    parts.push(<span key="sync">{`Last sync ${formatDateTime(last.completed_at || last.started_at)}, ${last.status}`}</span>);
  }
  if (SCHOOLOGY_TEXT[live]) {
    const text = `Schoology: ${SCHOOLOGY_TEXT[live]}`;
    parts.push(live === 'expired'
      ? <Link key="schoology" to="/settings#schoology">{text}</Link>
      : <span key="schoology">{text}</span>);
  }
  const counts = triage?.counts;
  if (parts.length === 0 && !counts) return null;

  // #137: the strip answers "is anything on fire?" — only overdue (non-zero)
  // tiles are worth showing; an all-clear day gets one quiet line instead of
  // a grid of zeroes.
  const liveTiles = counts ? TILES.filter((t) => (counts[t.key] ?? 0) > 0) : [];
  const allClear = !!counts && liveTiles.length === 0;

  return (
    <section className="stats-strip" aria-label="At a glance">
      {parts.length > 0 && (
        <p className="text-sm text-muted stats-strip__status">
          {parts.flatMap((p, i) => (i ? [<span key={`sep${i}`} aria-hidden="true"> · </span>, p] : [p]))}
        </p>
      )}
      {allClear && <p className="text-sm text-muted stats-strip__clear">Nothing overdue</p>}
      {liveTiles.length > 0 && (
        <div className="stats-strip__tiles">
          {liveTiles.map((t) => {
            const n = counts[t.key];
            return (
              <button key={t.key} type="button" className="stat-tile stat-tile--red" onClick={() => jumpTo(t.panel)}>
                <span className="stat-tile__num">{n}</span>
                <span className="stat-tile__label">{t.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
