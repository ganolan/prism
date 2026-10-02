import { APPROX_TITLE, meterPct } from '../../lib/triage.js';

const R = 15;
const CIRC = 2 * Math.PI * R;

// A progress ring (40px; `size` 28 in the triage rail) toward a school-day limit, the day number inside (the
// due / test date is day 1; `limit` is the last allowed day). The arc is
// min(1, day/limit) of the circle (a small floor so it always shows); its
// colour and the number's come from the tone (green → amber → red) via CSS.
// `approx` adds ≈. The geometry is drawn in a 40-unit viewBox and scaled to `size`.
export default function UrgencyRing({ day, limit, tone, approx = false, size = 40 }) {
  const arc = (meterPct(day, limit) / 100) * CIRC;
  return (
    <span
      className={`urgency-ring urgency-ring--${tone}${size < 40 ? ' urgency-ring--sm' : ''}`}
      style={{ '--ring-size': `${size}px` }}
      role="img" aria-label={`day ${day}, limit day ${limit}`}
    >
      <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
        <circle className="urgency-ring__track" cx="20" cy="20" r={R} />
        <circle
          className="urgency-ring__arc" cx="20" cy="20" r={R}
          strokeDasharray={`${arc.toFixed(1)} ${CIRC.toFixed(1)}`} transform="rotate(-90 20 20)"
        />
      </svg>
      <span className="urgency-ring__days">
        {day}{approx && <abbr title={APPROX_TITLE}>≈</abbr>}
      </span>
    </span>
  );
}
