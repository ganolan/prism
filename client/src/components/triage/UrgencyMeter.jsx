import { meterPct } from '../../lib/triage.js';

// Horizontal fill toward a school-day limit; colour from the tone
// (green → amber → red). Width is the only inline style (it's data).
export default function UrgencyMeter({ days, limit, tone }) {
  return (
    <span className={`urgency-meter urgency-meter--${tone}`} role="img" aria-label={`${days} of ${limit} school days`}>
      <span className="urgency-meter__fill" style={{ width: `${meterPct(days, limit)}%` }} />
    </span>
  );
}
