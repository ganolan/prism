// PowerSchool section_info calendar → school_days rows (triage). The key is
// PowerSchool's own misspelling `calenderDays`; accept `calendarDays` too. Each
// entry is kept verbatim in `raw` (see .claude/powerschool-api-reference.md).
export function extractCalendarDays(sectionInfo) {
  const cal = sectionInfo?.calenderDays || sectionInfo?.calendarDays || {};
  return Object.entries(cal)
    .filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .map(([date, d]) => ({
      date,
      // PowerSchool's `inSession` means "the school year is active", not "classes
      // meet": it's true on public holidays (type "PH"), Professional Development
      // days ("PD"), interims ("O") and Winter Break ("H"), all of which carry
      // cycleDay: null. A day only counts as a school day when BOTH inSession is
      // true AND cycleDay is present — verified live 2026-10-01/02 against the
      // Master Plan (see .claude/powerschool-api-reference.md, section_info note).
      inSession: !!d?.inSession && d?.cycleDay != null,
      cycleLetter: d?.cycleDay?.letter ?? null,
      raw: JSON.stringify(d ?? null),
    }));
}

// Merge one section's days into a Map<date, day>. A section's calendar may only
// mark the days it meets, so a date is in session if ANY section says so; the
// first non-null cycle letter wins.
export function mergeCalendarDays(byDate, days) {
  for (const day of days) {
    const prev = byDate.get(day.date);
    if (!prev) { byDate.set(day.date, { ...day }); continue; }
    prev.inSession = prev.inSession || day.inSession;
    prev.cycleLetter = prev.cycleLetter ?? day.cycleLetter;
  }
  return byDate;
}

// The dates this section (class) actually meets. A section's own calendar spans
// its whole term, so it can't say this by itself; but each day names the bell
// schedule it runs, and section_info lists only the bell schedules that contain
// the section's period. Meets = a school day (as above) whose bellScheduleId is
// one of those. Verified 2026-10-06 against the teacher's timetable
// (scripts/probe-section-meeting-days.js; .claude/powerschool-api-reference.md).
export function extractMeetingDates(sectionInfo) {
  return extractMeetings(sectionInfo).map((m) => m.date);
}

// A bell schedule item's startTime / endTime → 'HH:MM' (24-hour, school time), or null when it cannot be
// read. Accepted: seconds after midnight (a number or a digit string), 'HH:MM' or 'HH:MM:SS', and 'h:mm AM'.
export function bellTime(v) {
  if (v == null || v === '') return null;
  const hhmm = (h, m) => (h >= 0 && h < 24 && m >= 0 && m < 60 ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : null);
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    const sec = Number(v);
    return Number.isFinite(sec) && sec >= 0 && sec < 86400 ? hhmm(Math.floor(sec / 3600), Math.floor((sec % 3600) / 60)) : null;
  }
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/.exec(String(v).trim());
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0);
  }
  return hhmm(h, Number(m[2]));
}

// The section's lessons: [{ date, start, end }], one per date it meets (as above), with the start and end
// time of the section's period in that day's bell schedule (#187), null when the item gives none.
export function extractMeetings(sectionInfo) {
  const own = new Set(Object.keys(sectionInfo?.periodIdToPsmPeriodIdMap || {}).map(String));
  const items = new Map();
  for (const i of sectionInfo?.bellScheduleItems || []) {
    if (own.has(String(i.periodId)) && !items.has(String(i.bellScheduleId))) items.set(String(i.bellScheduleId), i);
  }
  if (items.size === 0) return [];
  return extractCalendarDays(sectionInfo)
    .map((d) => ({ d, item: d.inSession ? items.get(String(JSON.parse(d.raw)?.bellScheduleId)) : null }))
    .filter(({ item }) => item)
    .map(({ d, item }) => ({ date: d.date, start: bellTime(item.startTime), end: bellTime(item.endTime) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// A section's term: the first and last school day of its calendar, which spans the section's whole
// term (full-year sections 165 school days, semester sections 76 or 89; verified 2026-10-06,
// .claude/powerschool-api-reference.md). Semester ends come from these (#174,
// server/lib/semesters.js). No school day → null.
export function termRange(sectionInfo) {
  const days = extractCalendarDays(sectionInfo).filter((d) => d.inSession).map((d) => d.date).sort();
  return days.length ? { start: days[0], end: days[days.length - 1] } : null;
}
