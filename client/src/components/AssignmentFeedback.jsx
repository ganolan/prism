// One student's feedback on one assignment, read-only (#135). The gradebook
// submission modal and each assignment on the student page render this, so the
// two always share one layout, in this order:
//   1. badges row: submission status + flags, then the outbound links passed in
//      `links` (the OneDrive "Open" link, "Attempt", the comments chip, and any
//      later link component: it is a plain slot, so new ones drop straight in);
//   2. the submission timeline;
//   3. the rubric: full descriptors (RubricDescriptorGrid, read-only) when a
//      rubric is attached and mapped, otherwise the compact grid; an unaligned
//      task with a rubric attached shows its feedback rows (the student's row
//      levels) and then "Overall:" its scale level; any other task with no
//      topics (points only, "50 / 100") shows its score here instead;
//   4. the teacher's comment.
import SubmissionBadges from './SubmissionBadges.jsx';
import SubmissionTimeline from './SubmissionTimeline.jsx';
import CompactRubric from './CompactRubric.jsx';
import RubricDescriptorGrid from './RubricDescriptorGrid.jsx';
import { feedbackDescriptorRows, feedbackRowView } from '../lib/rubricDescriptorRows.js';
import { LEVELS, LEVEL_COLORS, CELL_TEXT, masteryCodeForLevel } from '../lib/masteryLevels.js';

// Schoology deletes rubric scores while one of these exceptions is set (the
// gradebook and /assessment/ lock the same three).
const RUBRIC_LOCKING_EXCEPTIONS = { 1: 'Excused', 2: 'Incomplete', 3: 'Missing' };

const HEADER = Object.fromEntries(LEVELS.map((l) => [l, LEVEL_COLORS[l].headerFill]));
const BORDER = Object.fromEntries(LEVELS.map((l) => [l, LEVEL_COLORS[l].finalBorder]));
const DRAFT = Object.fromEntries(LEVELS.map((l) => [l, LEVEL_COLORS[l].draftFill]));

// A gradeLabel() result for an unaligned task: a level chip in the level's colour
// for General Academic levels, the raw text otherwise, red when it matches no level.
export function ScoreLabel({ label }) {
  const code = label.kind === 'scale' ? masteryCodeForLevel(label.text) : null;
  const c = code ? LEVEL_COLORS[code] : null;
  const style = label.kind === 'mismatch' ? { color: 'var(--danger)' }
    : label.kind === 'pending' ? { color: 'var(--text-muted)' }
    : c ? { background: c.headerFill, color: CELL_TEXT, border: `1px solid ${c.finalBorder}`, padding: '0.1rem 0.4rem', borderRadius: 4, fontWeight: 500, display: 'inline-block' }
    : null;
  return (
    <span className="text-sm" style={style}
      title={label.kind === 'mismatch' ? 'Score does not match any defined level on this grading scale: check Schoology' : undefined}>
      {label.text}
    </span>
  );
}

export default function AssignmentFeedback({
  status = [], flags = [], resubmitted = false, assignmentTitle,
  links = null,
  timeline = null, timelineHelp = true, due = null,
  topics = [], attachment = null, palette = {}, exception = 0,
  score = null,
  comment = '',
}) {
  const hasBadges = status.length > 0 || flags.length > 0 || resubmitted || !!links;
  const lock = topics.length > 0 ? RUBRIC_LOCKING_EXCEPTIONS[exception] : null;
  const rows = lock ? null : feedbackDescriptorRows(topics, attachment);
  const gradeByTopic = Object.fromEntries(topics.map((t) => [t.topic_id, t.grade]));
  // Feedback rows: an unaligned score-scale task with a rubric attached in Prism.
  const rowView = topics.length === 0 ? feedbackRowView(attachment) : null;

  let rubric = null;
  if (rowView) {
    rubric = (
      <>
        <div className="assignment-feedback__rubric assignment-feedback__rubric--descriptors">
          <RubricDescriptorGrid
            rows={rowView.rows}
            levels={LEVELS}
            cellState={(topicId, l) => ({ final: rowView.gradeByTopic[topicId] === l })}
            palette={palette}
            levelHeaderColors={HEADER}
            levelBorderColors={BORDER}
            levelDraftColors={DRAFT}
            firstColumnLabel="Criteria"
          />
        </div>
        {score && (
          <div className="assignment-feedback__score">
            <span className="assignment-feedback__label">Overall:</span>
            <ScoreLabel label={score} />
          </div>
        )}
      </>
    );
  } else if (lock) {
    rubric = (
      <div className="assignment-feedback__notice text-sm">
        <strong>{lock}</strong>
        {', rubric hidden because Schoology deletes scores when an exception is set.'}
      </div>
    );
  } else if (rows) {
    rubric = (
      <div className="assignment-feedback__rubric assignment-feedback__rubric--descriptors">
        <RubricDescriptorGrid
          rows={rows}
          levels={LEVELS}
          cellState={(topicId, l) => ({ final: gradeByTopic[topicId] === l })}
          palette={palette}
          levelHeaderColors={HEADER}
          levelBorderColors={BORDER}
          levelDraftColors={DRAFT}
        />
      </div>
    );
  } else if (topics.length > 0) {
    rubric = <div className="assignment-feedback__rubric"><CompactRubric topics={topics} /></div>;
  } else if (score) {
    rubric = (
      <div className="assignment-feedback__score">
        <span className="assignment-feedback__label">Score:</span>
        <ScoreLabel label={score} />
      </div>
    );
  }

  return (
    <div className="assignment-feedback">
      {hasBadges && (
        <div className="assignment-feedback__badges">
          <SubmissionBadges status={status} flags={flags} resubmitted={resubmitted} assignmentTitle={assignmentTitle} />
          {links}
        </div>
      )}
      {timeline
        ? <SubmissionTimeline timeline={timeline} help={timelineHelp} />
        : due && <span className="text-xs text-muted">Due: {due}</span>}
      {rubric}
      {comment && (
        <div className="assignment-feedback__comment text-sm">
          <span className="assignment-feedback__label">Comment:</span>{comment}
        </div>
      )}
    </div>
  );
}
