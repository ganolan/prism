import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyRing from './UrgencyRing.jsx';
import CourseLine from './CourseLine.jsx';
import { PanelHead, ShowAllToggle, useShowAll, limitRows } from './panelParts.jsx';
import { cardLink } from './ResubmissionsPanel.jsx';
import FlagsMenu from '../FlagsMenu.jsx';
import { FlagDisc } from '../FlagSymbol.jsx';
import { formatDate } from '../../lib/formatDate.js';

// Schoology flags waiting on the teacher (#174, spec 2026-10-23-triage-flags-panel-design.md). On
// this account a flag leaves the task out of the grade, and in Schoology it looks handled: each row
// stays until the work is graded (publishing clears Late, Incomplete and Absent) or a decision is
// made (Missing, Exempt, or clearing the flag). The ring counts school days from the flag date
// (day 1) toward the end of the semester that contains the task's due date; the tone comes from
// that end (amber over its last 10 school days, red over the last 5 and after it). The name opens
// the student's card, where the work is graded; the compact Flags control (the card's own menu,
// symbol only) sets Missing or Exempt, or clears the flag, from the row.
// Hidden on a fresh load with no rows, as Resubmissions is; once it has shown rows in this mount it
// stays, so the row just handled ends on "No flags waiting on you." instead of a vanished panel.
export default function FlagsPanel({ rows, showCourse, scope, onChange }) {
  const [showAll, toggleShowAll] = useShowAll(`flags.${scope}`);
  const hadRowsRef = useRef(false);
  if (rows.length > 0) hadRowsRef.current = true;
  const urgent = rows.filter((r) => r.tone === 'red').length;
  const ends = new Set(rows.map((r) => r.semesterEnd));
  const end = ends.size === 1 ? [...ends][0] : null;
  if (rows.length === 0 && !hadRowsRef.current) return null;

  return (
    <section className="card triage-panel" id="triage-flags" aria-label="Flags">
      <PanelHead title="Flags" badge={urgent > 0 && <span className="badge badge-red">{urgent} urgent</span>}>
        <ShowAllToggle total={rows.length} showAll={showAll} onToggle={toggleShowAll} />
      </PanelHead>
      <p className="triage-panel__sub">school days since flagged{end ? `, semester ends ${formatDate(end)}` : ''}</p>
      {rows.length === 0 && <p className="text-sm text-muted">No flags waiting on you.</p>}
      {limitRows(rows, showAll).map((r) => (
        <FlagRow key={`${r.studentId}:${r.assignmentId}`} r={r} showCourse={showCourse} onChange={onChange} />
      ))}
    </section>
  );
}

// One row; its own host for the flag panel (FlagPanel / ClearFlagPanel) under the row's text.
function FlagRow({ r, showCourse, onChange }) {
  const [host, setHost] = useState(null);
  return (
    <div className="triage-row">
      <UrgencyRing day={r.day} limit={r.limit} tone={r.tone} approx={r.approx} size={28} />
      <div className="triage-row__text">
        <div className="triage-row__line">
          <Link to={cardLink(r)} className="triage-row__name" title={r.studentName}>{r.studentName}</Link>
          {r.kind === 'flag' && <FlagDisc code={r.flag} />}
          {r.submittedAfter && <span className="badge badge-amber triage-row__tag">Submitted after the flag</span>}
        </div>
        {showCourse && <CourseLine row={r} />}
        <div className="triage-row__task" title={r.title}>{r.title}</div>
        <div className="triage-row__advice text-sm text-muted">{r.advice}</div>
      </div>
      <div className="triage-row__actions">
        <FlagsMenu
          compact size="sm" student={{ id: r.studentId, firstName: r.firstName }} assignmentId={r.assignmentId}
          exception={r.exception} score={r.score} aligned={r.aligned} panelHost={host} onChange={onChange}
        />
      </div>
      <div ref={setHost} className="triage-row__more triage-row__flag-panel" />
    </div>
  );
}
