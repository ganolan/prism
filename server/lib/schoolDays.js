// School-day arithmetic for triage (late-work referral + feedback-owed clocks,
// docs/superpowers/specs/2026-10-01-triage-late-work-and-feedback-owed-design.md).
// Pure: built from school_days rows (the PowerSchool calendar), no DB access.
// Dates are local calendar dates as 'YYYY-MM-DD'. Outside the stored calendar's
// date span we fall back to Mon–Fri and flag the result `approx`.

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isWeekday(iso) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

// Today's local date (the machine's timezone — Hong Kong on prod).
export function todayLocal(now = new Date()) {
  return now.toLocaleDateString('en-CA');
}

// Epoch seconds → local 'YYYY-MM-DD'; null for 0/missing.
export function epochToLocalDate(secs) {
  const n = Number(secs);
  return n > 0 ? new Date(n * 1000).toLocaleDateString('en-CA') : null;
}

export function makeCalendar(rows = []) {
  const inSession = new Set();
  const letters = new Map();
  let min = null;
  let max = null;
  let source = null;
  for (const r of rows) {
    if (!r || !ISO.test(r.date)) continue;
    if (r.in_session) inSession.add(r.date);
    if (r.cycle_letter) letters.set(r.date, r.cycle_letter);
    if (min === null || r.date < min) min = r.date;
    if (max === null || r.date > max) max = r.date;
    source = source || r.source || 'powerschool';
  }
  const sessionDays = [...inSession].sort();
  const covers = (d) => min !== null && d >= min && d <= max;
  const isSchoolDay = (d) => (covers(d) ? inSession.has(d) : isWeekday(d));

  // School days d with from < d <= to (0 when to <= from).
  function between(from, to) {
    let days = 0;
    let approx = min === null;
    if (!ISO.test(from) || !ISO.test(to) || to <= from) return { days, approx };
    for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
      if (!covers(d)) approx = true;
      if (isSchoolDay(d)) days++;
    }
    return { days, approx };
  }

  function info(date) {
    const idx = sessionDays.indexOf(date);
    return {
      date,
      isSchoolDay: isSchoolDay(date),
      cycleLetter: letters.get(date) ?? null,
      schoolDayNumber: idx >= 0 ? idx + 1 : null,
      approx: !covers(date),
    };
  }

  return { between, isSchoolDay, info, covers, source: source || 'weekdays', totalSchoolDays: inSession.size };
}
