import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TONE } from '../PsAlertBadges.jsx';
import { gradeText } from '../PersonSub.jsx';
import { preferredFirstName, studentFullName } from '../../lib/studentNames.js';
import { formatDate } from '../../lib/formatDate.js';
import { alertChipLabel } from '../../lib/rosterVitals.js';
import StudentTags from './StudentTags.jsx';

// One student on the Roster tab (#160). Left: the photo, then the name line: the one name the student
// goes by, and (Private details only) a small group of tags right after it, today the gender code
// (F, M, NB or ?, full label on hover; see StudentTags), kept on the same line so the card gains none.
// Under it one line: grade, student number (the email's local part) and an Email copy button. Right, only with
// Private details on: the unread comments count and the alert chips, in fixed-width slots so they line
// up down the page. With Private details off those slots are not drawn at all.
//
// Tapping the card opens the student page; a button or link inside it does its own job only.
// `children` (Needs attention's rows) sit under the card's top line, and a tap among them stays.
//  - unread: the student's unread comment count, or null when Prism has none to show (slot left empty).
//  - alerts: the student's roster alerts (forRoster).

const CopyIcon = () => (
  <svg className="filter-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="5" y="5" width="9" height="9" rx="2" />
    <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
  </svg>
);

function CopyEmail({ email }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard here: the address is in the button's title.
    }
  }
  return (
    <button type="button" className="roster-copy" aria-label={`Copy email ${email}`} title={`Copy ${email}`} onClick={copy}>
      <CopyIcon />{copied ? 'Copied' : 'Email'}
    </button>
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
    return <span className="roster-stat roster-stat--zero" title="Unread student comments on submissions"><b>0</b> <span>{word}</span></span>;
  }
  return (
    <button type="button" className="roster-stat" aria-haspopup="dialog" title="Unread student comments on submissions. Tap to read them."
      onClick={(e) => { e.stopPropagation(); onOpen(e.currentTarget); }}>
      <b>{count}</b> <span>{word}</span>
    </button>
  );
}

export default function RosterCard({ student, showPrivate, unread = null, alerts = [], onOpenComments, onOpenAlert, children }) {
  const navigate = useNavigate();
  const number = student.email ? student.email.split('@')[0] : null;
  const grade = gradeText(student.grad_year);
  const open = (e) => {
    // Needs attention's rows hold editors and panels: a tap there never leaves the page.
    if (e.target.closest('a, button, input, select, textarea, label, .roster-tag, .roster-card__items')) return;
    navigate(`/student/${student.id}`);
  };
  return (
    <div className={`roster-card${showPrivate ? ' roster-card--private' : ''}${student.dropped_at ? ' roster-card--dropped' : ''}`} onClick={open}>
      <span className="roster-card__avatar"><Photo student={student} /></span>
      <span className="roster-card__id">
        <span className="roster-card__nameline">
          <Link className="roster-card__name" to={`/student/${student.id}`}>{studentFullName(student)}</Link>
          {showPrivate && <StudentTags student={student} />}{/* not in the DOM with Private details off */}
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
        <span className="roster-card__alerts">
          {alerts.map((a) => (
            <button key={a.key} type="button" className={`badge ${TONE[a.category] || 'badge-gray'} roster-alert-chip`}
              aria-haspopup="dialog" aria-label={a.title || a.label} title={`${a.title || a.label}. Tap to read it from PowerSchool.`}
              onClick={(e) => { e.stopPropagation(); onOpenAlert(a, e.currentTarget); }}>
              {alertChipLabel(a)}
            </button>
          ))}
        </span>
      )}
      {children && <div className="roster-card__items">{children}</div>}
    </div>
  );
}
