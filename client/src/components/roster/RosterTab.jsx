import { useEffect, useMemo, useRef, useState } from 'react';
import RosterCard from './RosterCard.jsx';
import RosterFilters from './RosterFilters.jsx';
import AlertPopover from './AlertPopover.jsx';
import CommentsPopover from './CommentsPopover.jsx';
import CopyEmailsPopover from './CopyEmailsPopover.jsx';
import { usePrivateDetails } from '../../lib/privateDetails.js';
import { useStickyTab } from '../../hooks/useStickyTab.js';
import { forRoster } from '../../lib/psAlerts.js';
import { unreadCounts, rosterFilterOptions, applyRosterFilters } from '../../lib/rosterVitals.js';
import { getCourseCommentSummaries } from '../../services/api.js';

// The course page's Roster tab (#160; docs/superpowers/specs/2026-10-25-course-roster-redesign-design.md).
// A roster may be projected to a class, so everything private (comment counts, alerts, filters, copying
// emails, and the Needs attention, Test day and Mastery modes) shows only with Private details on, and
// with it off is not in the page at all. Turning it off closes any pop-up and clears the filters.
//
// Four modes, remembered like the course tabs (`?mode=`). Needs attention, Test day and Mastery each
// have a slot below; until they are built, each shows its explanation box.
// Props: course, students (with dropped ones, `dropped_at`), mastery, triage (the rail's getTriage
// answer), onTriageChanged, onMasteryChanged, courseId.

export const ROSTER_MODES = [
  { id: 'roster', label: 'Roster' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'testday', label: 'Test day' },
  { id: 'mastery', label: 'Mastery' },
];

// The pill beside the course name. Amber when on.
export function PrivateDetailsSwitch() {
  const [on, setOn] = usePrivateDetails();
  return (
    <button type="button" className="filter-btn private-details-switch" aria-pressed={on} onClick={() => setOn(!on)}
      title="Shows comment counts, alerts, filters and the private modes on every roster. Remembered on this device.">
      Private details
    </button>
  );
}

// What a private mode shows with Private details off.
export function LockedBox({ title }) {
  return (
    <div className="roster-locked">
      <b>{title}</b>
      <span>Turn on Private details to see it. It stays hidden so the roster is safe to project.</span>
    </div>
  );
}

// Slots for the modes still to be built (#160 Tasks 7, 9 and 10).
function NeedsAttentionMode({ on }) {
  return on ? <p className="text-sm text-muted">Needs attention is on its way.</p> : <LockedBox title="Overdue work, referrals and comments are private." />;
}
function TestDayMode({ on }) {
  return on ? <p className="text-sm text-muted">Test day is on its way.</p> : <LockedBox title="Extra time for learning plans is private." />;
}
function MasteryMode({ on }) {
  return on ? <p className="text-sm text-muted">Mastery is on its way.</p> : <LockedBox title="Levels and grades are private." />;
}

// Roster mode: the cards, and with Private details on the filters and the pop-ups.
function RosterMode({ on, courseId, active, dropped, unread, filters, setFilters, labels }) {
  const [showDropped, setShowDropped] = useState(false);
  const [popup, setPopup] = useState(null); // { kind: 'alert' | 'comments' | 'emails', anchor, student?, alert? }
  useEffect(() => { if (!on) setPopup(null); }, [on]);

  const options = rosterFilterOptions(active, unread, filters, labels.current);
  for (const o of options.alerts) labels.current[o.key] = o.label;
  const shown = on ? applyRosterFilters(active, filters, unread) : active;
  // The anchor toggles its own pop-up; another anchor replaces it.
  const open = (next) => setPopup((cur) => (cur && cur.anchor === next.anchor ? null : next));
  const close = () => setPopup(null);

  const card = (s, isDropped = false) => (
    <RosterCard key={s.id} student={s} showPrivate={on}
      unread={!isDropped && unread ? unread[s.id] || 0 : null}
      alerts={isDropped ? [] : forRoster(s.ps_alerts)}
      onOpenComments={(anchor) => open({ kind: 'comments', anchor, student: s })}
      onOpenAlert={(alert, anchor) => open({ kind: 'alert', anchor, student: s, alert })} />
  );

  return (
    <div className="roster-mode">
      {on && (
        <RosterFilters options={options} selected={filters} onChange={setFilters} shown={shown.length} total={active.length}
          onCopyEmails={(anchor) => open({ kind: 'emails', anchor })} />
      )}
      <div className="roster-cards">
        {shown.map((s) => card(s))}
        {active.length === 0 && <p className="text-sm text-muted">No students are enrolled.</p>}
        {active.length > 0 && shown.length === 0 && <p className="text-sm text-muted">No student matches these filters.</p>}
      </div>
      {/* #128: students who left keep their card, behind a count, never counted or copied. */}
      {dropped.length > 0 && (
        <div className="roster-dropped">
          <button type="button" className="ghost" aria-expanded={showDropped} onClick={() => setShowDropped((v) => !v)}>
            {dropped.length} dropped {showDropped ? '(hide)' : '(show)'}
          </button>
          {showDropped && <div className="roster-cards">{dropped.map((s) => card(s, true))}</div>}
        </div>
      )}
      {on && popup?.kind === 'alert' && <AlertPopover student={popup.student} alert={popup.alert} anchor={popup.anchor} onClose={close} />}
      {on && popup?.kind === 'comments' && <CommentsPopover student={popup.student} courseId={courseId} anchor={popup.anchor} onClose={close} />}
      {on && popup?.kind === 'emails' && (
        <CopyEmailsPopover courseId={courseId} studentIds={shown.map((s) => s.id)} filtered={filters.size > 0} anchor={popup.anchor} onClose={close} />
      )}
    </div>
  );
}

export default function RosterTab({ students, courseId }) {
  const [mode, setMode] = useStickyTab('roster-mode', 'roster', { param: 'mode' });
  const current = ROSTER_MODES.some((m) => m.id === mode) ? mode : 'roster';
  const [on] = usePrivateDetails();
  // Filters live for this course and this visit (not remembered), across the modes.
  const [filters, setFilters] = useState(() => new Set());
  const [unread, setUnread] = useState(null); // { [student id]: count }, null until read or when unavailable
  const labels = useRef({}); // alert pill labels seen, for a pill left on after nobody holds it

  const active = useMemo(() => students.filter((s) => !s.dropped_at), [students]);
  const dropped = useMemo(() => students.filter((s) => s.dropped_at), [students]);

  // Comment counts are read only with Private details on, and dropped with it off.
  useEffect(() => {
    if (!on) { setFilters(new Set()); setUnread(null); return undefined; }
    let live = true;
    Promise.resolve().then(() => getCourseCommentSummaries(courseId))
      .then((r) => { if (live) setUnread(unreadCounts(r?.assignments)); })
      .catch(() => { if (live) setUnread(null); }); // comments off or unreachable: no counts
    return () => { live = false; };
  }, [on, courseId]);

  return (
    <div className="roster-tab">
      <div className="roster-modes" role="group" aria-label="Roster view">
        {ROSTER_MODES.map((m) => (
          <button key={m.id} type="button" className={`tab-btn${current === m.id ? ' active' : ''}`}
            aria-pressed={current === m.id} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      {current === 'roster' && (
        <RosterMode on={on} courseId={courseId} active={active} dropped={dropped} unread={on ? unread : null}
          filters={on ? filters : new Set()} setFilters={setFilters} labels={labels} />
      )}
      {current === 'attention' && <NeedsAttentionMode on={on} />}
      {current === 'testday' && <TestDayMode on={on} />}
      {current === 'mastery' && <MasteryMode on={on} />}
    </div>
  );
}
