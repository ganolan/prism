// Test day on the Roster tab (#160): the course's next tests, a learning plan's extra minutes, and the
// one line of plan text a card shows. Prism holds lesson dates but not lesson times, so everything here
// is in minutes, never clock times.
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
