// Lesson hints next to a school-day deadline (Extend, Ask to resubmit). Deadlines
// are counted in school days; these say where a count lands in the class's own
// lessons. `plan` is GET /api/triage/lesson-plan: { from, today, days: [{ n, date }],
// meetings: [lesson dates after today] }.
import { lineDate } from './statusLines.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// n school days → { date, text } e.g. "→ Thu 15/10 · 3 lessons from today", or null.
export function lessonHint(plan, n) {
  const day = plan?.days?.[n - 1];
  if (!day?.date) return null;
  const to = `→ ${lineDate(day.date)}`;
  if (day.date <= plan.today) return { date: day.date, text: `${to} · already passed` };
  if (!plan.meetings?.length) return { date: day.date, text: to };
  const lessons = plan.meetings.filter((m) => m <= day.date).length;
  return { date: day.date, text: lessons ? `${to} · ${plural(lessons, 'lesson')} from today` : `${to} · no lessons before then` };
}

// The school-day count that lands on the k-th lesson after today (and after the
// start date, when that is later). null when the plan doesn't reach it.
export function schoolDaysForLesson(plan, k) {
  const lesson = (plan?.meetings || []).filter((m) => m > plan.from)[k - 1];
  if (!lesson) return null;
  const day = plan.days.find((d) => d.date === lesson);
  return day ? day.n : null;
}
