import { Link } from 'react-router-dom';
import CourseLine from './CourseLine.jsx';
import { PanelHead, ShowAllToggle, useShowAll, limitRows } from './panelParts.jsx';
import { assessmentLink } from '../../lib/triage.js';
import { formatDate } from '../../lib/formatDate.js';
import { Tip } from '../HelpDot.jsx';

// Unfinished grading: grading work with no clock, per task (server/services/unfinishedGrading.js):
// Prism drafts not yet published, feedback the student cannot see (a comment with Display off, or
// anything graded on an unpublished task, #184), unread student comments. No ring:
// nothing here is late, it is only unfinished. Tasks with a draft come first (oldest
// first). A title opens the task's page with those reasons selected. Hidden when empty.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function unfinishedGradingText(r) {
  return [
    r.drafts > 0 && plural(r.drafts, 'draft not published', 'drafts not published'),
    // Display covers the comment only (#184): on a published task the student sees the grade.
    r.feedbackHidden > 0 && (r.taskUnpublished
      ? `${r.feedbackHidden} with feedback hidden (task not published)`
      : `${r.feedbackHidden} with comment hidden`),
    r.unreadComments > 0 && plural(r.unreadComments, 'unread comment', 'unread comments'),
  ].filter(Boolean).join(', ');
}

const FILTER_OF = { drafts: 'draft', feedbackHidden: 'feedback_hidden', unreadComments: 'unread_comment' };
const filterFor = (r) => Object.entries(FILTER_OF).filter(([k]) => r[k] > 0).map(([, id]) => id);

export default function UnfinishedGradingPanel({ rows, showCourse, scope }) {
  const [showAll, toggleShowAll] = useShowAll(`unfinishedGrading.${scope}`);
  if (rows.length === 0) return null;
  return (
    <section className="card triage-panel" id="triage-unfinished-grading" aria-label="Unfinished grading">
      <PanelHead title="Unfinished grading">
        <ShowAllToggle total={rows.length} showAll={showAll} onToggle={toggleShowAll} />
      </PanelHead>
      <p className="triage-panel__sub">drafts not published, hidden comments or tasks, unread student comments</p>
      {limitRows(rows, showAll).map((r) => (
        <div key={r.assignmentId} className="triage-row triage-row--plain">
          <div className="triage-row__text">
            <div className="triage-row__line">
              <Tip as={Link} className="triage-row__title" to={assessmentLink(r, { filter: filterFor(r) })} named={false} clipped text={r.title}>
                {r.title}
              </Tip>
              {!r.aligned && <span className="badge badge-formative triage-row__tag">F</span>}
            </div>
            <div className="triage-row__sub">
              {unfinishedGradingText(r)}
              {r.oldestDraftOn && <span className="text-muted">, oldest draft {formatDate(r.oldestDraftOn)}</span>}
            </div>
            {showCourse && <CourseLine row={r} />}
          </div>
        </div>
      ))}
    </section>
  );
}
