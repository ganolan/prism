// One student's feedback on one assignment, read-only (#135). The gradebook
// submission modal and each assignment on the student page render this, so the
// two always share one layout, in this order:
//   1. badges row: submission status + flags, then the outbound links passed in
//      `links` (the OneDrive "Open" link, "Attempt", the comments chip, and any
//      later link component: it is a plain slot, so new ones drop straight in),
//      then the small Flags menu when `flagsMenu` is given (#40), whose panel opens
//      in its own row under the badges;
//   2. the submission timeline;
//   3. the rubric: full descriptors (RubricDescriptorGrid, read-only) when a
//      rubric is attached and mapped, otherwise the compact grid; an unaligned
//      task with a rubric attached shows its feedback rows (the student's row
//      levels) and then "Overall:" its scale level; any other task with no
//      topics (points only, "50 / 100") shows its score here instead;
//   4. the teacher's comment.
import { useState } from 'react';
import SubmissionBadges from './SubmissionBadges.jsx';
import FlagsMenu from './FlagsMenu.jsx';
import SubmissionTimeline from './SubmissionTimeline.jsx';
import CompactRubric from './CompactRubric.jsx';
import RubricDescriptorGrid from './RubricDescriptorGrid.jsx';
import { feedbackDescriptorRows, feedbackRowView } from '../lib/rubricDescriptorRows.js';
import FlagSymbol from './FlagSymbol.jsx';
import { FLAGS, isFinalFlag, isMarker, flagEffect } from '../lib/flags.js';
import { LEVELS, LEVEL_COLORS, CELL_TEXT, masteryCodeForLevel } from '../lib/masteryLevels.js';

// The rubric is hidden while Exempt is set (#40; /assessment/ locks Exempt and Missing): Schoology
// removes Exempt's grade (flagEffect). A marker (Late, Incomplete, Absent) keeps the rubric: the
// teacher grades straight through it, and a line above it says grading clears the flag. Missing
// keeps the rubric too, as a display transform (missingView): IE on every topic or row when
// Schoology holds no levels for the task, the real levels when it does.
const lockName = (exception) => (isFinalFlag(exception) && Number(exception) !== 3 ? FLAGS[Number(exception)].name : null);

const MISSING_NO_LEVELS = 'Shown as IE because the work is marked Missing. Schoology holds no topic levels for this task yet.';
const MISSING_LEVELS = 'Marked Missing. These levels still count in the topic averages.';

// Graham, 21 Oct 2026: work marked Missing shows IE on every topic or row, to inform talks with the
// student. Missing writes no levels and keeps those that exist (probed 21 and 22 Oct), so when none
// exist every level is shown as IE, and when some do they show as they are. Display only: nothing
// here is written, and the per-topic summaries keep Schoology's numbers. `grades` is the levels as
// Schoology holds them (topic id to level or null); returns the levels to draw, or null when the
// flag is not Missing.
export function missingView(exception, grades) {
  if (Number(exception) !== 3) return null;
  const hasLevels = Object.values(grades).some(Boolean);
  return {
    hasLevels,
    grades: hasLevels ? grades : Object.fromEntries(Object.keys(grades).map((id) => [id, 'IE'])),
    line: hasLevels ? MISSING_LEVELS : MISSING_NO_LEVELS,
  };
}

const HEADER = Object.fromEntries(LEVELS.map((l) => [l, LEVEL_COLORS[l].headerFill]));
const BORDER = Object.fromEntries(LEVELS.map((l) => [l, LEVEL_COLORS[l].finalBorder]));
const DRAFT = Object.fromEntries(LEVELS.map((l) => [l, LEVEL_COLORS[l].draftFill]));

// A gradeLabel() result for an unaligned task: a level chip in the level's colour
// for General Academic levels, the raw text otherwise, red when it matches no level.
// A flag (Exempt/Incomplete/Missing/Absent/Late) shows its symbol in the score's place.
// savedLevel: the grade Prism saved when the flag was set (null when none).
export function ScoreLabel({ label, savedLevel = null, firstName = null, reasonLine = null }) {
  if (label.kind === 'exception') return <FlagSymbol code={label.exception} size="inline" showName firstName={firstName} savedLevel={savedLevel} reasonLine={reasonLine} />;
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
  status = [], flags = [], resubmitted = false,
  lateTitle = 'Late', // how late, for the late clock on the status badge (lateText)
  links = null,
  timeline = null, timelineHelp = true, due = null,
  topics = [], attachment = null, palette = {}, exception = 0,
  score = null,
  savedLevel = null, // the grade Prism saved before a flag removed it (shown in the flag's popover)
  reasonLine = null, // the flag's status line Prism wrote (shown in the flag's popover)
  firstName = null, // the student's first name, for the flag's popover
  comment = '',
  // The Flags menu's props (FlagsMenu: student, assignmentId, exception, score, aligned, onChange),
  // or null for none (an archived course, or a surface that cannot write).
  flagsMenu = null,
}) {
  const [panelHost, setPanelHost] = useState(null);
  const hasBadges = status.length > 0 || flags.length > 0 || resubmitted || !!links || !!flagsMenu;
  // A marker on a task with a rubric: its symbol (an aligned task shows no score label to carry it)
  // and the line the assessment card shows too.
  const markerNote = isMarker(exception) && (topics.length > 0 || feedbackRowView(attachment) != null) ? (
    <div className="assignment-feedback__marker text-sm">
      {topics.length > 0 && <FlagSymbol code={Number(exception)} size="inline" showName firstName={firstName} aligned savedLevel={savedLevel} reasonLine={reasonLine} />}
      <span>Grading this work clears {FLAGS[Number(exception)].name}.</span>
    </div>
  ) : null;
  const lock = topics.length > 0 ? lockName(exception) : null;
  const rows = lock ? null : feedbackDescriptorRows(topics, attachment);
  // Feedback rows: an unaligned score-scale task with a rubric attached in Prism.
  const rowView = topics.length === 0 ? feedbackRowView(attachment) : null;
  // Work marked Missing: IE (or the real levels) on every topic or row, and the line saying which.
  const hasRubric = topics.length > 0 ? !lock : !!rowView;
  const missing = hasRubric ? missingView(exception, topics.length > 0
    ? Object.fromEntries(topics.map((t) => [t.topic_id, t.grade]))
    : rowView.gradeByTopic) : null;
  const gradeByTopic = missing && topics.length > 0 ? missing.grades : Object.fromEntries(topics.map((t) => [t.topic_id, t.grade]));
  const rowGrades = missing && rowView ? missing.grades : rowView?.gradeByTopic;
  // The Missing symbol in each cell shown as IE (not beside real levels).
  const iePlaceholder = missing && !missing.hasLevels
    ? <FlagSymbol code={3} size="inline" firstName={firstName} aligned={false} /> : null;
  const missingNote = missing ? (
    <div className="assignment-feedback__marker text-sm">
      <FlagSymbol code={3} size="inline" showName firstName={firstName} aligned={missing.hasLevels} savedLevel={savedLevel} reasonLine={reasonLine} />
      <span>{missing.line}</span>
    </div>
  ) : null;

  let rubric = null;
  if (rowView) {
    rubric = (
      <>
        <div className="assignment-feedback__rubric assignment-feedback__rubric--descriptors">
          <RubricDescriptorGrid
            rows={rowView.rows}
            levels={LEVELS}
            cellState={(topicId, l) => ({ final: rowGrades[topicId] === l })}
            palette={palette}
            levelHeaderColors={HEADER}
            levelBorderColors={BORDER}
            levelDraftColors={DRAFT}
            firstColumnLabel="Criteria"
            awardedMark={iePlaceholder}
          />
        </div>
        {score && (
          <div className="assignment-feedback__score">
            <span className="assignment-feedback__label">Overall:</span>
            <ScoreLabel label={score} savedLevel={savedLevel} firstName={firstName} reasonLine={reasonLine} />
          </div>
        )}
      </>
    );
  } else if (lock) {
    rubric = (
      <div className="assignment-feedback__notice text-sm">
        <FlagSymbol code={Number(exception)} size="inline" firstName={firstName} aligned savedLevel={savedLevel} reasonLine={reasonLine} />{' '}
        <strong>{lock}</strong>
        {`, rubric hidden because ${flagEffect(exception)}`}
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
          awardedMark={iePlaceholder}
        />
      </div>
    );
  } else if (topics.length > 0) {
    rubric = (
      <div className="assignment-feedback__rubric">
        <CompactRubric topics={topics.map((t) => ({ ...t, grade: gradeByTopic[t.topic_id] }))} currentMark={iePlaceholder} />
      </div>
    );
  } else if (score) {
    rubric = (
      <div className="assignment-feedback__score">
        <span className="assignment-feedback__label">Score:</span>
        <ScoreLabel label={score} savedLevel={savedLevel} firstName={firstName} reasonLine={reasonLine} />
      </div>
    );
  }

  return (
    <div className="assignment-feedback">
      {hasBadges && (
        <div className="assignment-feedback__badges">
          {/* With the Flags pill here, it carries the flag (in its color): no second flag badge. */}
          <SubmissionBadges status={flagsMenu ? status.filter((b) => b.kind !== 'exception') : status} flags={flags} resubmitted={resubmitted} lateTitle={lateTitle} />
          {links}
          {flagsMenu && <FlagsMenu {...flagsMenu} size="sm" panelHost={panelHost} />}
        </div>
      )}
      {flagsMenu && <div ref={setPanelHost} className="assignment-feedback__panel" />}
      {timeline
        ? <SubmissionTimeline timeline={timeline} help={timelineHelp} />
        : due && <span className="text-xs text-muted">Due: {due}</span>}
      {markerNote}
      {missingNote}
      {rubric}
      {comment && (
        <div className="assignment-feedback__comment text-sm">
          <span className="assignment-feedback__label">Comment:</span>{comment}
        </div>
      )}
    </div>
  );
}
