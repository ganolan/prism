import LateClock from './LateClock.jsx';
// Shared submission-state + flag badges. Renders a flat run of <span> badges
// (a Fragment, no wrapper element) so callers can drop it straight into their
// own flex row. Used by the /student/ course table (StudentPage) and the
// gradebook rubric modal (CoursePage). Returns null when there is nothing to
// show, so a conditionally-rendered band collapses cleanly.
//
// Props:
//   status         — array from submissionStatus(): [{ kind, label, tone }]
//   flags          — array of flag objects; renders resubmit_requested (the only flag
//                    left: Flag for review was removed, #40)
//   resubmitted    — boolean → "↩ Resubmitted" badge

const TONE_CLASS = { red: 'badge-red', blue: 'badge-blue', amber: 'badge-amber', green: 'badge-green', slate: 'badge-slate', yellow: 'badge-amber', neutral: 'badge-gray' };

// lateTitle: how late, for the late clock's hover (lateText(timeline)); the clock rides a badge
// whose submission was late. The Late flag is an exception badge and has no clock.
export default function SubmissionBadges({ status = [], flags = [], resubmitted = false, lateTitle = 'Late' }) {
  if (status.length === 0 && flags.length === 0 && !resubmitted) return null;
  return (
    <>
      {status.map(b => (
        <span key={b.kind} className="status-pill-wrap">
          <span className={`badge ${TONE_CLASS[b.tone]}`} style={{ fontSize: '0.65rem' }}>{b.label}</span>
          {b.late && <LateClock title={lateTitle} />}
        </span>
      ))}
      {flags.filter(flag => flag.flag_type === 'resubmit_requested').map(flag => (
        <span key={flag.id} className="badge badge-resubmit" style={{ fontSize: '0.68rem' }}>
          ⟳ Re-submit requested
        </span>
      ))}
      {resubmitted && (
        <span className="badge badge-resubmitted" style={{ fontSize: '0.68rem' }}
              title="The student has submitted new work since this was last graded">
          ↩ Resubmitted
        </span>
      )}
    </>
  );
}
