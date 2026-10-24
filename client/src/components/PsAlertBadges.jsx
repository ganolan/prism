import { formatDate } from '../lib/formatDate.js';

// PowerSchool student alerts (#117) as badges: accommodation / learning support
// (blue), health (amber), other (grey), family (pink; student page only). The
// API sends them only when the powerschool_alerts feature is on, so an absent
// or empty list renders nothing. Callers decide when they show: the student page
// behind PsAlertReveal, the roster's chips (components/roster/RosterCard.jsx, which
// reuses TONE) behind Private details.
// See docs/design-language.md "PowerSchool alerts".
export const TONE = { learning: 'badge-blue', health: 'badge-amber', other: 'badge-gray', family: 'badge-pink' };

export default function PsAlertBadges({ alerts, syncedAt = null }) {
  if (!alerts?.length) return null;
  const source = syncedAt ? `From PowerSchool, read ${formatDate(syncedAt)}` : 'From PowerSchool';
  return (
    <span className="ps-alerts" aria-label="PowerSchool alerts">
      {alerts.map((a) => (
        <span key={a.key} className={`badge ${TONE[a.category] || 'badge-gray'}`} title={`${a.title || a.label}. ${source}`}>
          {a.label}
        </span>
      ))}
    </span>
  );
}
