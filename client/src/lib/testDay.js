// Test day on the Roster tab (#160): the course's next tests, a learning plan's extra minutes, and the
// one line of plan text a card shows. Clock times (#187) come from the lesson on the test's date, with
// its start and end time from PowerSchool's bell schedule (GET /api/courses/:id/class-times); without
// one, everything is in minutes.
import { localIsoDate } from './formatDate.js';

export const TEST_WINDOW_DAYS = 14;

// 'YYYY-MM-DD' plus n calendar days, without a time zone (UTC arithmetic on the bare date).
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// The course's Schoology tests (is_test 1, published, not removed) due from today to 14 days ahead,
// nearest first. `today` is a Date or 'YYYY-MM-DD'; a due date's own day is compared (Schoology sends
// 'YYYY-MM-DD HH:MM:SS' in school time).
export function upcomingTests(assignments, today = new Date()) {
  const from = typeof today === 'string' ? today.slice(0, 10) : localIsoDate(today);
  const to = addDays(from, TEST_WINDOW_DAYS);
  return (assignments || [])
    .filter((a) => a.is_test === 1 && a.published !== 0 && !a.removed_at && a.due_date)
    .filter((a) => { const day = String(a.due_date).slice(0, 10); return day >= from && day <= to; })
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
    .map((a) => ({ schoologyAssignmentId: a.schoology_assignment_id, title: a.title, dueDate: a.due_date }));
}

// The extra minutes a plan's percentage gives a test of `length` minutes, to the nearest minute.
export const extraMinutes = (length, percent) => Math.round((length * percent) / 100);

// "time" as a word (not "timetable" or "sometimes"), or a percentage.
const MENTIONS_TIME = /\btime\b|%/i;

// The one line a card shows from the plan's rows ({ description }): the first that mentions time or a
// percentage, else the first non-empty one; null when no row has text.
export function planLine(rows) {
  const texts = (rows || []).map((r) => (r?.description || '').trim()).filter(Boolean);
  return texts.find((t) => MENTIONS_TIME.test(t)) ?? texts[0] ?? null;
}

// 'HH:MM' plus n minutes → 'HH:MM' (the same day; a test never runs past midnight).
export function addMinutes(hhmm, n) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const t = h * 60 + m + n;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

// 'HH:MM' → "10:55 AM", the 12-hour time the sync status uses (freshnessTime).
export function clockText(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// The class's lesson on a test's due date ({ date, start, end } from class-times), when Prism has its
// start time; else null (no lesson that day, or no time read).
export function lessonOn(meetings, dueDate) {
  const day = String(dueDate || '').slice(0, 10);
  return (meetings || []).find((m) => m.date === day && m.start) || null;
}

// A test of `minutes` started at the lesson's start: { ends: 'HH:MM', over } where `over` is the minutes it
// runs past the lesson's end (0 when it fits, or when the end is not known).
export function testClock(lesson, minutes) {
  const ends = addMinutes(lesson.start, minutes);
  const over = lesson.end ? Math.max(0, minutesOf(ends) - minutesOf(lesson.end)) : 0;
  return { ends, over };
}

