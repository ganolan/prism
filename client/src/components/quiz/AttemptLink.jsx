// The student's attempt on a Schoology test, beside the submission-status pill
// (the #120 "Open" pattern): one outbound link, short label, detail on hover.
// Used on the assessment page cards, the gradebook modal and the student page.
import SchoologyLink from '../SchoologyLink.jsx';
import { formatDateTime } from '../../lib/formatDate.js';

export default function AttemptLink({ link, name }) {
  if (!link?.url) return null;
  const when = link.completedAt ? `: completed ${formatDateTime(link.completedAt.replace(' ', 'T'))}` : '';
  return (
    <SchoologyLink
      url={link.url}
      label="Attempt"
      ariaLabel={`Attempt: open ${name}'s test attempt in Schoology`}
      title={`Open ${name}'s test attempt in Schoology${when}`}
      style={{ fontSize: '0.78rem', fontWeight: 600 }}
    />
  );
}
