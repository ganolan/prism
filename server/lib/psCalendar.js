// PowerSchool section_info calendar → school_days rows (triage). The key is
// PowerSchool's own misspelling `calenderDays`; accept `calendarDays` too. Each
// entry is kept verbatim in `raw` (see .claude/powerschool-api-reference.md).
export function extractCalendarDays(sectionInfo) {
  const cal = sectionInfo?.calenderDays || sectionInfo?.calendarDays || {};
  return Object.entries(cal)
    .filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .map(([date, d]) => ({
      date,
      inSession: !!d?.inSession,
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
