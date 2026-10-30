import AnchoredPopover from './AnchoredPopover.jsx';
import AttendanceStrip, { absenceSummary } from '../AttendanceStrip.jsx';
import { studentFullName } from '../../lib/studentNames.js';
import { formatDateTime } from '../../lib/formatDate.js';

const dayText = (iso) => iso.split('-').reverse().join('/'); // a calendar day as DD/MM/YYYY, in any time zone

// One student's attendance in this course (#208): the term's counts and the last 8 lessons, from the marks Prism
// stores each night from PowerSchool (and after each save on the Attendance tab).
export default function AttendancePopover({ student, anchor, onClose }) {
  const a = student.attendance;
  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} title={`${studentFullName(student)}: attendance`}>
      <p className="text-sm">{absenceSummary(a)} since {dayText(a.from)}. The last {a.lessons.length} lessons:</p>
      <AttendanceStrip lessons={a.lessons} />
      <p className="roster-pop__foot">
        From PowerSchool, read {formatDateTime(a.read_at)}. Every code but Present, Tardy and Excused counts as an absence.
      </p>
    </AnchoredPopover>
  );
}
