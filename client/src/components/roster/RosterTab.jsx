import { useEffect, useMemo, useRef, useState } from 'react';
import RosterCard from './RosterCard.jsx';
import RosterFilters from './RosterFilters.jsx';
import AlertPopover from './AlertPopover.jsx';
import CommentsPopover from './CommentsPopover.jsx';
import CopyEmailsPopover from './CopyEmailsPopover.jsx';
import NeedsAttention from './NeedsAttention.jsx';
import TestDay from './TestDay.jsx';
import MasteryView from './MasteryView.jsx';
import RosterSort from './RosterSort.jsx';
import { usePrivateDetails } from '../../lib/privateDetails.js';
import { PrivateHidden } from '../PrivateDetails.jsx';
import { useStickyTab } from '../../hooks/useStickyTab.js';
import { forRoster } from '../../lib/psAlerts.js';
import { useRosterSort, setRosterSort, sortRoster, effectiveSort } from '../../lib/rosterSort.js';
import { unreadCounts, rosterFilterOptions, applyRosterFilters } from '../../lib/rosterVitals.js';
import { getCourseCommentSummaries } from '../../services/api.js';

// The course page's Roster tab (#160; docs/superpowers/specs/2026-10-25-course-roster-redesign-design.md).
// A roster may be projected to a class, so everything private (comment counts, alerts, filters, copying
// emails, and the Needs attention, Test day and Mastery modes) shows only with Private details on (the
// app-wide switch in the sidebar, #197), and with it off is not in the page at all. Turning it off
// closes any pop-up and clears the filters.
//
// Four modes, remembered like the course tabs (`?mode=`; Details keeps the id `roster`, #192 renamed
// its label). With no mode given it opens on Needs attention with Private details on and on Details
// with it off (#210), since Needs attention is private; the switch changed afterwards keeps the mode. With Private details off, Needs attention,
// Test day and Mastery each show the shared PrivateHidden box (Test day keeps its test picker and length).
// Props: course (`linked`: a set of linked sections, where Mastery's override is disabled), students
// (with dropped ones, `dropped_at`), mastery (getMasteryForCourse; masteryFailed when its read failed),
// triage (CoursePage's own getTriage answer, as the rail reads it; triageFailed when that read failed), gradebook (CoursePage's getGradebook: the flag on overdue work, Test day's tests),
// onTriageChanged (after a Needs attention write: CoursePage re-reads triage), onFlagChanged (after one
// that changed a Schoology flag: the gradebook too), onMasteryChanged (after a Mastery override: CoursePage
// re-reads mastery), courseId.

export const ROSTER_MODES = [
  // Needs attention first (#210, 30 Oct 2026). "Roster" would repeat the parent tab (#192).
  { id: 'attention', label: 'Needs attention' },
  { id: 'roster', label: 'Details' }, // "Details and Attendance" until attendance got its own course tab (#39, 29 Oct 2026)
  { id: 'testday', label: 'Test day' },
  { id: 'mastery', label: 'Mastery' },
];

// Roster mode: the cards, and with Private details on the filters and Copy emails. "Sort by" sits
// above the cards (Last name by default, remembered on this device); the dropped cards follow it too.
function RosterMode({ on, courseId, active, dropped, unread, filters, setFilters, labels, card, popup, openPopup, closePopup }) {
  const [showDropped, setShowDropped] = useState(false);
  const [stored] = useRosterSort();
  const sort = effectiveSort(stored, on);

  const options = rosterFilterOptions(active, unread, filters, labels.current);
  for (const o of options.alerts) labels.current[o.key] = o.label;
  const shown = sortRoster(on ? applyRosterFilters(active, filters, unread) : active, sort);
  const droppedSorted = sortRoster(dropped, sort);

  return (
    <div className="roster-mode">
      {on && (
        <RosterFilters options={options} selected={filters} onChange={setFilters} shown={shown.length} total={active.length}
          onCopyEmails={(anchor) => openPopup({ kind: 'emails', anchor })} />
      )}
      {active.length > 0 && <RosterSort sort={sort} onChange={setRosterSort} showPrivate={on} />}
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
          {showDropped && <div className="roster-cards">{droppedSorted.map((s) => card(s, { isDropped: true }))}</div>}
        </div>
      )}
      {on && popup?.kind === 'emails' && (
        <CopyEmailsPopover courseId={courseId} studentIds={shown.map((s) => s.id)} filtered={filters.size > 0} anchor={popup.anchor} onClose={closePopup} />
      )}
    </div>
  );
}

export default function RosterTab({ course = null, students, mastery = null, masteryFailed = false, triage = null, triageFailed = false, gradebook = null, onTriageChanged, onFlagChanged, onMasteryChanged, courseId }) {
  const [on] = usePrivateDetails();
  const [fallback] = useState(() => (on ? 'attention' : 'roster'));
  const [mode, setMode] = useStickyTab('roster-mode', fallback, { param: 'mode' });
  const current = ROSTER_MODES.some((m) => m.id === mode) ? mode : fallback;
  // Filters live for this course and this visit (not remembered), across the modes.
  const [filters, setFilters] = useState(() => new Set());
  const [unread, setUnread] = useState(null); // { [student id]: count }, null until read or when unavailable
  const labels = useRef({}); // alert pill labels seen, for a pill left on after nobody holds it

  const active = useMemo(() => students.filter((s) => !s.dropped_at), [students]);
  const dropped = useMemo(() => students.filter((s) => s.dropped_at), [students]);
  const shownUnread = on ? unread : null;

  // One pop-up at a time (an alert, a student's comments, Copy emails), closed with Private details
  // off or on a change of mode. The anchor toggles its own pop-up; another anchor replaces it.
  const [popup, setPopup] = useState(null); // { kind: 'alert' | 'comments' | 'emails', anchor, student?, alert? }
  useEffect(() => { if (!on) setPopup(null); }, [on]);
  useEffect(() => { setPopup(null); }, [current]);
  const openPopup = (next) => setPopup((cur) => (cur && cur.anchor === next.anchor ? null : next));
  const closePopup = () => setPopup(null);

  // The Roster card, in every mode that lists students; `children` are Needs attention's rows.
  const card = (s, { isDropped = false, children = null } = {}) => (
    <RosterCard key={s.id} student={s} showPrivate={on}
      unread={!isDropped && shownUnread ? shownUnread[s.id] || 0 : null}
      alerts={isDropped ? [] : forRoster(s.ps_alerts)}
      onOpenComments={(anchor) => openPopup({ kind: 'comments', anchor, student: s })}
      onOpenAlert={(alert, anchor) => openPopup({ kind: 'alert', anchor, student: s, alert })}>
      {children}
    </RosterCard>
  );

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
      {/* The Roster tab's child row (#194): .subtab-btn inside the course page's tab panel. */}
      <div className="subtab-row" role="tablist" aria-label="Roster view">
        {ROSTER_MODES.map((m) => (
          <button key={m.id} type="button" role="tab" className={`subtab-btn${current === m.id ? ' active' : ''}`}
            aria-selected={current === m.id} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      {current === 'roster' && (
        <RosterMode on={on} courseId={courseId} active={active} dropped={dropped} unread={shownUnread}
          filters={on ? filters : new Set()} setFilters={setFilters} labels={labels}
          card={card} popup={popup} openPopup={openPopup} closePopup={closePopup} />
      )}
      {current === 'attention' && (on
        ? <NeedsAttention triage={triage} triageFailed={triageFailed} active={active} gradebook={gradebook} archived={Boolean(course?.archived)}
          onChanged={onTriageChanged} onFlagChanged={onFlagChanged} card={card} />
        : <PrivateHidden title="Overdue work, referrals and comments are private." />)}
      {current === 'testday' && (
        <TestDay on={on} students={active} gradebook={gradebook} courseId={courseId} locked={<PrivateHidden title="Extra time for learning plans is private." />} />
      )}
      {current === 'mastery' && (
        <MasteryView on={on} locked={<PrivateHidden title="Levels and grades are private." />} mastery={mastery} failed={masteryFailed} students={active}
          courseId={courseId} linked={Boolean(course?.linked)} archived={Boolean(course?.archived)} onMasteryChanged={onMasteryChanged} />
      )}
      {on && popup?.kind === 'alert' && <AlertPopover student={popup.student} alert={popup.alert} anchor={popup.anchor} onClose={closePopup} />}
      {on && popup?.kind === 'comments' && <CommentsPopover student={popup.student} courseId={courseId} anchor={popup.anchor} onClose={closePopup} />}
    </div>
  );
}
