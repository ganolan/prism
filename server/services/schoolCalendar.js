// Persistence for the triage school-day calendar (school_days table).
import { makeCalendar } from '../lib/schoolDays.js';

// Replace the stored PowerSchool calendar with `days` (whole year per sync). An
// empty list is a no-op, so a failed or empty fetch never wipes a good calendar.
export function storeSchoolDays(db, days, now = new Date().toISOString()) {
  if (!days.length) return 0;
  const insert = db.prepare(`
    INSERT INTO school_days (date, in_session, cycle_letter, raw, source, synced_at)
    VALUES (?, ?, ?, ?, 'powerschool', ?)
  `);
  db.transaction(() => {
    db.prepare(`DELETE FROM school_days WHERE source = 'powerschool'`).run();
    for (const d of days) insert.run(d.date, d.inSession ? 1 : 0, d.cycleLetter, d.raw, now);
  })();
  return days.length;
}

export function loadCalendar(db) {
  const rows = db.prepare('SELECT date, in_session, cycle_letter, source, synced_at FROM school_days').all();
  const syncedAt = rows.reduce((m, r) => (r.synced_at && (!m || r.synced_at > m) ? r.synced_at : m), null);
  return { ...makeCalendar(rows), syncedAt };
}
