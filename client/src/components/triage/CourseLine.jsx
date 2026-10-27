import { courseLabel } from '../../lib/triage.js';
import { Tip } from '../HelpDot.jsx';

// A triage row's second line: '[BK 7] AP CSP', one line, ellipsis + the full label in the instant
// popover while it is cut off (#199).
export default function CourseLine({ row }) {
  const label = courseLabel(row);
  return <Tip as="div" className="triage-row__course" named={false} clipped text={label}>{label}</Tip>;
}
