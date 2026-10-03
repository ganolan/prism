// A failed LTI unsubmit on an Ask (Phase 2): the ask was recorded, but the student's
// OneDrive work is still submitted in Schoology. Links the Schoology assignment page,
// whose grader has Schoology's own Unsubmit button. Shown on the triage row and the
// card until a sync sees the work in progress.
export default function UnsubmitFailedNote({ url, error = null, className = '' }) {
  return (
    <span className={`unsubmit-failed ${className}`.trim()} title={error || undefined}>
      Unsubmit failed —{' '}
      {url
        ? <a className="link" href={url} target="_blank" rel="noopener noreferrer">unsubmit it in Schoology ›</a>
        : 'unsubmit it in Schoology'}
    </span>
  );
}
