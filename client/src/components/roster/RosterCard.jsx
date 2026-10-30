import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TONE } from '../PsAlertBadges.jsx';
import { gradeText } from '../PersonSub.jsx';
import { preferredFirstName, studentFullName } from '../../lib/studentNames.js';
import { formatDate } from '../../lib/formatDate.js';
import { alertChipLabel } from '../../lib/rosterVitals.js';
import { Tip } from '../HelpDot.jsx';
import { BirthdayMark } from '../Birthday.jsx';

// One student on the Roster tab (#160). Left: the photo, then the name line: the one name the student
// goes by, then a small cake on a student's birthday (public, never the date or age: #191, Graham 28 Oct 2026).
// The card shows no gender or age tag: those are on the student page only (Graham, 27 Oct 2026;
// components/StudentTags.jsx), and the roster keeps its Gender filter and sort.
// Under it one line: grade, student number (the email's local part) and an Email copy button. Right, only with
// Private details on: the unread comments count, the absences this term (#208) and the alert chips, in fixed-width
// slots so they line up down the page. With Private details off those slots are not drawn at all.
//
// Tapping the card opens the student page; a button or link inside it does its own job only. Hover text
// is the instant popover (Tip), never a native title.
// `children` (Needs attention's rows) sit under the card's top line, and a tap among them stays.
//  - unread: the student's unread comment count, or null when Prism has none to show (slot left empty).
//  - alerts: the student's roster alerts (forRoster).
//  - attendance: the student's attendance this term ({ absences, lessons, ... }), or null (slot left empty).

const CopyIcon = () => (
  <svg className="filter-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="5" y="5" width="9" height="9" rx="2" />
    <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
  </svg>
);

// Also the student page header's Email button (#185).
export function CopyEmail({ email }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard here: the address is in the button's popover.
    }
  }
  return (
    <Tip as="button" type="button" className="roster-copy" aria-label={`Copy email ${email}`} text={`Copy ${email}`} onClick={copy}>
      <CopyIcon />{copied ? 'Copied' : 'Email'}
    </Tip>
  );
}

export function Photo({ student }) {
  if (student.picture_url) return <img className="roster-card__photo" src={student.picture_url} alt="" />;
  return (
    <span className="roster-card__photo roster-card__photo--initials" aria-hidden="true">
      {preferredFirstName(student)?.[0]}{student.last_name?.[0]}
    </span>
  );
}

function Comments({ count, onOpen }) {
  if (count == null) return null;
  const word = count === 1 ? 'comment' : 'comments';
  if (count === 0) {
    return <Tip className="roster-stat roster-stat--zero" text="No unread student comments on submissions"><b>0</b> <span>{word}</span></Tip>;
  }
  return (
    <Tip as="button" type="button" className="roster-stat" aria-haspopup="dialog" named={false}
      text="Unread student comments on submissions. Tap to read them."
      onClick={(e) => { e.stopPropagation(); onOpen(e.currentTarget); }}>
      <b>{count}</b> <span>{word}</span>
    </Tip>
  );
}

// Absences this term (#208): tap for the last lessons. Shown once Prism has read the course's attendance.
function Absences({ attendance, onOpen }) {
  if (!attendance) return null;
  const n = attendance.absences;
  const word = n === 1 ? 'absence' : 'absences';
  if (!attendance.lessons.length) {
    return <Tip className="roster-stat roster-stat--zero" text="No lessons recorded yet this term"><b>0</b> <span>{word}</span></Tip>;
  }
  return (
    <Tip as="button" type="button" className={`roster-stat${n ? '' : ' roster-stat--zero'}`} aria-haspopup="dialog" named={false}
      text="Absences this term, from PowerSchool. Tap for the last lessons."
      onClick={(e) => { e.stopPropagation(); onOpen(e.currentTarget); }}>
      <b>{n}</b> <span>{word}</span>
    </Tip>
  );
}

export default function RosterCard({ student, showPrivate, unread = null, alerts = [], attendance = null, onOpenComments, onOpenAlert, onOpenAttendance, children }) {
  const navigate = useNavigate();
  const number = student.email ? student.email.split('@')[0] : null;
  const grade = gradeText(student.grad_year);
  const open = (e) => {
    // Needs attention's rows hold editors and panels: a tap there never leaves the page.
    if (e.target.closest('a, button, input, select, textarea, label, .birthday-mark, .roster-card__items')) return;
    navigate(`/student/${student.id}`);
  };
  return (
    <div className={`roster-card${showPrivate ? ' roster-card--private' : ''}${student.dropped_at ? ' roster-card--dropped' : ''}`} onClick={open}>
      <span className="roster-card__avatar"><Photo student={student} /></span>
      <span className="roster-card__id">
        <span className="roster-card__nameline">
          <Link className="roster-card__name" to={`/student/${student.id}`}>{studentFullName(student)}</Link>
          <BirthdayMark student={student} />
        </span>
        <span className="roster-card__meta">
          {grade && <span>{grade}</span>}
          {number && <span className="roster-card__number">{number}</span>}
          {student.email && <span><CopyEmail email={student.email} /></span>}
          {student.dropped_at && <span>dropped {formatDate(student.dropped_at)}</span>}
        </span>
      </span>
      {showPrivate && (
        <span className="roster-card__comments"><Comments count={unread} onOpen={onOpenComments} /></span>
      )}
      {showPrivate && (
        <span className="roster-card__absences"><Absences attendance={attendance} onOpen={onOpenAttendance} /></span>
      )}
      {showPrivate && (
        <span className="roster-card__alerts">
          {alerts.map((a) => (
            <Tip as="button" key={a.key} type="button" className={`badge ${TONE[a.category] || 'badge-gray'} roster-alert-chip`}
              aria-haspopup="dialog" aria-label={a.title || a.label} text={`${a.title || a.label}. Tap to read it from PowerSchool.`}
              onClick={(e) => { e.stopPropagation(); onOpenAlert(a, e.currentTarget); }}>
              {alertChipLabel(a)}
            </Tip>
          ))}
        </span>
      )}
      {children && <div className="roster-card__items">{children}</div>}
    </div>
  );
}
