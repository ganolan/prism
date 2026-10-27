// Lesson hints for school-day deadlines. Every triage clock counts school days
// (an extension or resubmission deadline is the N-th school day after its start
// date); a teacher thinks in lessons ("give them until next lesson"). This
// returns, for one class and a start date, the school day each N lands on and
// the class's own meeting dates (class_meetings, from PowerSchool), so the
// client can show "→ Thu 08/10 · 2 lessons from today" and offer "Next lesson"
// as a school-day count. Nothing here changes what is stored or counted.
import { loadCalendar, loadClassMeetings } from './schoolCalendar.js';
import { todayLocal } from '../lib/schoolDays.js';
import { MAX_EXTENSION_LESSONS } from './triageCommon.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// → { from, today, days: [{ n, date, approx, overdue? }] for n = 1..MAX, meetings: [dates > today] }
//   meetings is [] when PowerSchool hasn't given this class a timetable. overdue (a day on or
//   before today) is how many school days late work due then is today, as triage counts it.
export function lessonPlan(db, { courseId, from, countFrom = null, today = todayLocal() }) {
  // Deadlines count from the later of their start date and today (deadlineFrom), except an
  // extension counted from the due date (countFrom 'due_date'), which can land in the past.
  const valid = ISO.test(String(from || ''));
  const start = valid && (from > today || countFrom === 'due_date') ? from : today;
  const cal = loadCalendar(db);
  const days = [];
  for (let n = 1; n <= MAX_EXTENSION_LESSONS; n++) {
    const { date, approx } = cal.addSchoolDays(start, n);
    days.push(date <= today ? { n, date, approx, overdue: cal.between(date, today).days } : { n, date, approx });
  }
  const last = days[days.length - 1].date;
  const meetings = loadClassMeetings(db, Number(courseId)).filter((d) => d > today && d <= last);
  return { from: start, today, days, meetings };
}
