import HelpDot from './HelpDot.jsx';
import { timelineParts, CLOCK_HELP } from '../lib/submissionTimeline.js';

// The full submission picture on one compact, wrapping row (the /assessment/ card,
// the gradebook rubric modal): due + extension, submitted when and how late (or
// the clock day it is missing on), resubmission ask / arrival, referral. One "?"
// explains the day numbers (`help={false}` where one shared "?" already does, e.g. a
// table header). Renders nothing when there is nothing to say.
export default function SubmissionTimeline({ timeline, help = true }) {
  const parts = timelineParts(timeline);
  if (parts.length === 0) return null;
  return (
    <div className="submission-timeline" data-testid="submission-timeline">
      {parts.map((p) => (
        <span key={p.key} className={`submission-timeline__part${p.tone ? ` submission-timeline__part--${p.tone}` : ''}`} title={p.title}>
          {p.text}
        </span>
      ))}
      {help && <HelpDot text={CLOCK_HELP(timeline.limit)} />}
    </div>
  );
}
