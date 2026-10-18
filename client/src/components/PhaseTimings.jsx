import { formatPhaseTime } from '../lib/syncEvents.js';

// #143 / #165: one line per sync phase with its wall time, label left and time
// right. Takes the phases from reduceSyncEvents (mastery is one line per
// course) and lists only those with a recorded time; renders nothing when no
// phase has one (a run logged before #143). Used by the sync dialog's foot and
// by Settings → Recent syncs.
export default function PhaseTimings({ phases }) {
  const timed = (phases || []).filter((p) => p.elapsedMs != null);
  if (!timed.length) return null;
  return (
    <ul className="sync-timings" aria-label="Time per phase">
      {timed.map((p) => (
        <li key={p.key}>
          <span className="sync-timing-label">{p.label}</span>
          <span className="sync-timing-value">{formatPhaseTime(p.elapsedMs)}</span>
        </li>
      ))}
    </ul>
  );
}
