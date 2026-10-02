import { courseLabel } from '../../lib/triage.js';

// A triage row's second line: '[BK 7] AP CSP', one line, ellipsis + the full label as a tooltip.
export default function CourseLine({ row }) {
  const label = courseLabel(row);
  return <div className="triage-row__course" title={label}>{label}</div>;
}
