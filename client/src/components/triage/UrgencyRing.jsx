import { APPROX_TITLE, meterPct } from '../../lib/triage.js';

const R = 15;
const CIRC = 2 * Math.PI * R;

// A 40px progress ring toward a school-day limit, the day count inside. The arc
// is min(1, days/limit) of the circle (a small nub at 0); its colour and the
// count's come from the tone (green → amber → red) via CSS. `approx` adds ≈.
export default function UrgencyRing({ days, limit, tone, approx = false }) {
  const arc = (meterPct(days, limit) / 100) * CIRC;
  return (
    <span className={`urgency-ring urgency-ring--${tone}`} role="img" aria-label={`${days} of ${limit} school days`}>
      <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
        <circle className="urgency-ring__track" cx="20" cy="20" r={R} />
        <circle
          className="urgency-ring__arc" cx="20" cy="20" r={R}
          strokeDasharray={`${arc.toFixed(1)} ${CIRC.toFixed(1)}`} transform="rotate(-90 20 20)"
        />
      </svg>
      <span className="urgency-ring__days">
        {days}{approx && <abbr title={APPROX_TITLE}>≈</abbr>}
      </span>
    </span>
  );
}
