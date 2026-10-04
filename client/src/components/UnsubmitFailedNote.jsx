// A failed LTI unsubmit on an Ask (Phase 2): the ask was recorded, but the student's
// OneDrive work is (known: "Unsubmit failed") or may be (uncertain — the request went out
// but Schoology never confirmed it: "Unsubmit not confirmed") still submitted. Links the
// Schoology assignment page, whose grader has Schoology's own Unsubmit button. Shown on
// the triage row and the card until a sync sees the work in progress.
export default function UnsubmitFailedNote({ url, error = null, uncertain = false, className = '' }) {
  return (
    <span className={`unsubmit-failed ${className}`.trim()} title={error || undefined}>
      {uncertain ? 'Unsubmit not confirmed' : 'Unsubmit failed'}:{' '}
      {url
        ? <a className="link" href={url} target="_blank" rel="noopener noreferrer">unsubmit it in Schoology ›</a>
        : 'unsubmit it in Schoology'}
    </span>
  );
}
