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
  const own = new Set(Object.keys(sectionInfo?.periodIdToPsmPeriodIdMap || {}).map(String));
  const bells = new Set(
    (sectionInfo?.bellScheduleItems || [])
      .filter((i) => own.has(String(i.periodId)))
      .map((i) => String(i.bellScheduleId)),
  );
  if (bells.size === 0) return [];
  return extractCalendarDays(sectionInfo)
    .filter((d) => d.inSession && bells.has(String(JSON.parse(d.raw)?.bellScheduleId)))
    .map((d) => d.date)
    .sort();
}
