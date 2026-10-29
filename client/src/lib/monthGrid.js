// A Monday-to-Friday month grid for the Attendance tab's lesson calendar (#39, Graham 29 Oct 2026).
// Dates are 'YYYY-MM-DD' strings built from local parts, so no time zone shifts a day.
const pad = (n) => String(n).padStart(2, '0');
export const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

// → { year, month (0-11), label: 'October 2026', weeks: [[iso | null ×5]] }: each week Mon..Fri, null for a day
// outside the month; weekends are left out.
export function monthGrid(year, month) {
  const days = new Date(year, month + 1, 0).getDate();
  const weeks = [];
  let week = null;
  for (let d = 1; d <= days; d++) {
    const dow = new Date(year, month, d).getDay(); // 0 Sun .. 6 Sat
    if (dow === 0 || dow === 6) continue;
    if (!week || dow === 1) { week = [null, null, null, null, null]; weeks.push(week); }
    week[dow - 1] = isoOf(year, month, d);
  }
  const label = new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return { year, month, label, weeks };
}

// The first and last day of a month, as ISO dates.
export const monthRange = (year, month) => [isoOf(year, month, 1), isoOf(year, month, new Date(year, month + 1, 0).getDate())];

// The month before or after ({ year, month } + step).
export function stepMonth({ year, month }, step) {
  const d = new Date(year, month + step, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

// The month an ISO date is in.
export const monthOf = (iso) => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) - 1 });
