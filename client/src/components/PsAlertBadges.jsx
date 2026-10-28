import { formatDate } from '../lib/formatDate.js';
import { Tip } from './HelpDot.jsx';

// PowerSchool student alerts (#117) as badges: accommodation / learning support
// (blue), health (amber), other (grey), family (pink; student page only). The
// API sends them only when the powerschool_alerts feature is on, so an absent
// or empty list renders nothing. Callers decide when they show: the student page's family alerts
// behind Show family alerts (components/StudentAlerts.jsx, #185, whose in-place chips reuse TONE), and
// the roster's chips (components/roster/RosterCard.jsx, also TONE) behind Private details.
// See docs/design-language.md "PowerSchool alerts".
export const TONE = { learning: 'badge-blue', health: 'badge-amber', other: 'badge-gray', family: 'badge-pink' };

export default function PsAlertBadges({ alerts, syncedAt = null }) {
  if (!alerts?.length) return null;
  const source = syncedAt ? `From PowerSchool, read ${formatDate(syncedAt)}` : 'From PowerSchool';
  return (
    <span className="ps-alerts" aria-label="PowerSchool alerts">
      {alerts.map((a) => (
        <Tip key={a.key} className={`badge ${TONE[a.category] || 'badge-gray'}`} text={`${a.title || a.label}. ${source}`}>
          {a.label}
        </Tip>
      ))}
    </span>
  );
}
