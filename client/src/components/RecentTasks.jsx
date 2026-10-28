import { Link } from 'react-router-dom';
import FlagSymbol from './FlagSymbol.jsx';
import { recentTasks } from '../lib/recentTasks.js';

// The student page's Recent tasks (#185): the last tasks due in the student's current courses, newest
// first, each with its status in the submission timeline's words (lib/recentTasks.js). A Schoology flag
// is its symbol (FlagSymbol), anything else a small round mark in the status's tone. The title opens
// the task on the assessment page at this student. Shown with Private details off too: it is this
// student's own record, as the grade cards under it are (Graham, 27 Oct 2026).

const MARKS = {
  ok: <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z" fill="currentColor" />,
  late: <><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8 5v3l2 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
  quiet: <path d="M4 8h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
};
MARKS.over = MARKS.late;

const localToday = () => new Date().toLocaleDateString('en-CA');
const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

export default function RecentTasks({ student, today = localToday(), limit = 6 }) {
  const tasks = recentTasks(student.grades, student.courses, { today, limit });
  if (!tasks.length) return null;
  return (
    <section className="card recent-tasks" aria-labelledby="recent-tasks-title">
      <div className="recent-tasks__head">
        <h3 id="recent-tasks-title">Recent tasks</h3>
        <span className="text-sm text-muted">The last {limit} tasks due in current courses</span>
      </div>
      <ul className="recent-tasks__list">
        {tasks.map((t) => (
          <li key={t.key} className="recent-task">
            {t.flag != null
              ? <span className="recent-task__mark"><FlagSymbol code={t.flag} size="inline" firstName={student.preferred_name_teacher || student.first_name} /></span>
              : <span className={`recent-task__mark recent-task__dot recent-task__dot--${t.tone}`} aria-hidden="true"><svg viewBox="0 0 16 16">{MARKS[t.tone]}</svg></span>}
            <span className="recent-task__name">
              <Link className="link" to={`/course/${t.courseId}/assessment/${t.schoologyAssignmentId}?student=${student.id}`}>{t.title}</Link>
              <span className="recent-task__sub">{t.courseName}, due {dm(t.due)}</span>
            </span>
            <span className={`recent-task__status recent-task__status--${t.tone}`}>{t.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
