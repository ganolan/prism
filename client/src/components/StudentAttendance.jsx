import { Link } from 'react-router-dom';
import AttendanceStrip, { absenceSummary } from './AttendanceStrip.jsx';
import { formatDateTime } from '../lib/formatDate.js';

// The student page's attendance this term (#208), beside Recent tasks: for each current course Prism has read from
// PowerSchool, the absences and lates, then the last 8 lessons. Private: the page shows it only with Private details on.
// attendance: GET /api/students/:id's `attendance` ([{ course_id, course_name, absences, lates, excused, lessons,
// read_at }]); absent when the feature is off.
export default function StudentAttendance({ attendance }) {
  if (!attendance?.length) return null;
  const readAt = attendance.map((c) => c.read_at).filter(Boolean).sort()[0];
  return (
    <section className="card student-attendance" aria-labelledby="student-attendance-title">
      <div className="recent-tasks__head">
        <h3 id="student-attendance-title">Attendance this term</h3>
        <span className="text-sm text-muted">The last 8 lessons in each course</span>
      </div>
      {attendance.map((c) => (
        <div key={c.course_id} className="student-attendance__course">
          <div className="student-attendance__line">
            <Link className="link" to={`/course/${c.course_id}?tab=attendance`}>{c.course_name}</Link>
            <span className="text-sm">{absenceSummary(c)}</span>
          </div>
          <AttendanceStrip lessons={c.lessons} />
        </div>
      ))}
      {readAt && <p className="text-sm text-muted student-attendance__foot">From PowerSchool, read {formatDateTime(readAt)}. Every code but Present, Tardy and Excused counts as an absence.</p>}
    </section>
  );
}
