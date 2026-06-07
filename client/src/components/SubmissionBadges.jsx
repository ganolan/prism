// Shared submission-state + flag badges. Renders a flat run of <span> badges
// (a Fragment, no wrapper element) so callers can drop it straight into their
// own flex row. Used by the /student/ course table (StudentPage) and the
// gradebook rubric modal (CoursePage). Returns null when there is nothing to
// show, so a conditionally-rendered band collapses cleanly.
//
// Props:
//   status         — array from submissionStatus(): [{ kind, label, tone }]
//   flags          — array of flag objects; renders review_needed,
//                    resubmit_requested, and any other flag_type generically
//   resubmitted    — boolean → "↩ Resubmitted" badge
//   assignmentTitle — optional; the generic-flag branch suppresses a reason
//                    that merely repeats the assignment title

const TONE_CLASS = { red: 'badge-red', blue: 'badge-blue', amber: 'badge-pink', green: 'badge-green', yellow: 'badge-amber', neutral: 'badge-gray' };

function formatFlagReason(flag) {
  return flag?.flag_reason || '';
}

export default function SubmissionBadges({ status = [], flags = [], resubmitted = false, assignmentTitle }) {
  if (status.length === 0 && flags.length === 0 && !resubmitted) return null;
  return (
    <>
      {status.map(b => (
        <span key={b.kind} className={`badge ${TONE_CLASS[b.tone]}`} style={{ fontSize: '0.65rem' }}>{b.label}</span>
      ))}
      {flags.map(flag => {
        const flagReason = formatFlagReason(flag);
        // Review flags use the same amber badge + "⚑ Review: …" format as the
        // assessment page.
        if (flag.flag_type === 'review_needed') {
          return (
            <span key={flag.id} className="badge badge-amber" style={{ fontSize: '0.68rem' }}>
              ⚑ Review: {flagReason}
            </span>
          );
        }
        if (flag.flag_type === 'resubmit_requested') {
          return (
            <span key={flag.id} className="badge badge-resubmit" style={{ fontSize: '0.68rem' }}>
              ⟳ Re-submit requested
            </span>
          );
        }
        const showReason = flagReason && flagReason !== assignmentTitle;
        return (
          <span key={flag.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
            <span className={`badge ${flag.resolved ? 'badge-green' : 'badge-red'}`} style={{ textTransform: 'capitalize' }}>
              {flag.flag_type.replaceAll('_', ' ')}
            </span>
            {showReason && <span className="text-xs text-muted">{flagReason}</span>}
          </span>
        );
      })}
      {resubmitted && (
        <span className="badge badge-resubmitted" style={{ fontSize: '0.68rem' }}
              title="The student has submitted new work since this was last graded">
          ↩ Resubmitted
        </span>
      )}
    </>
  );
}
