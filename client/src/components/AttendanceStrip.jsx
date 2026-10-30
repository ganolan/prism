import { Tip } from './HelpDot.jsx';

// A student's last lessons as a strip of cells, oldest first (#208): each cell the lesson's date and PowerSchool's
// own code (empty for Present), toned by kind: late amber, absent red, excused accent, present plain (the Attendance
// tab's colours). The instant popover names the day and PowerSchool's description, and an office mark says so.
// Used by the Roster tab's absences pop-up and the student page.
// lessons: [{ date: 'YYYY-MM-DD', code, description, kind, office }] (GET /api/courses/:id/students, /api/students/:id).

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayOf = (iso) => WEEKDAY[new Date(`${iso}T00:00:00Z`).getUTCDay()];
const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

export function lessonText(l) {
  const what = l.code ? `${l.description || 'Recorded in PowerSchool'} (${l.code})` : 'Present';
  return `${dayOf(l.date)} ${dm(l.date)}: ${what}${l.office ? ', entered by the office' : ''}`;
}

export default function AttendanceStrip({ lessons }) {
  if (!lessons?.length) return <p className="text-sm text-muted">No lessons recorded yet this term.</p>;
  return (
    <ol className="attendance-strip" aria-label="Last lessons, oldest first">
      {lessons.map((l) => (
        <li key={l.date}>
          <Tip className={`attendance-strip__cell attendance-strip__cell--${l.kind}`} text={lessonText(l)}>
            <b>{l.code}</b>
            <span>{dm(l.date)}</span>
          </Tip>
        </li>
      ))}
    </ol>
  );
}

// "2 absences, 1 late" (and "1 excused" when any), for a heading or a pop-up.
export function absenceSummary(a) {
  const parts = [`${a.absences} ${a.absences === 1 ? 'absence' : 'absences'}`, `${a.lates} late`];
  if (a.excused) parts.push(`${a.excused} excused`);
  return parts.join(', ');
}
