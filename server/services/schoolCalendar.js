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

// Replace one course's meeting dates (its lessons). Empty is a no-op, so a
// failed or odd fetch never wipes a good timetable.
// `meetings`: dates ('YYYY-MM-DD') or { date, start, end } (psCalendar.extractMeetings, #187).
export function storeClassMeetings(db, courseId, meetings, now = new Date().toISOString()) {
  if (!meetings.length) return 0;
  const insert = db.prepare('INSERT OR IGNORE INTO class_meetings (course_id, date, start_time, end_time, synced_at) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM class_meetings WHERE course_id = ?').run(courseId);
    for (const m of meetings) {
      const { date, start = null, end = null } = typeof m === 'string' ? { date: m } : m;
      insert.run(courseId, date, start, end, now);
    }
  })();
  return meetings.length;
}

// A class's lessons from `from` to `to` (inclusive), with their times: [{ date, start, end }] (#187).
export function loadClassTimes(db, courseId, from, to) {
  return db.prepare(`SELECT date, start_time AS start, end_time AS "end" FROM class_meetings
    WHERE course_id = ? AND date >= ? AND date <= ? ORDER BY date`).all(courseId, from, to);
}

export function loadClassMeetings(db, courseId) {
  return db.prepare('SELECT date FROM class_meetings WHERE course_id = ? ORDER BY date').all(courseId).map((r) => r.date);
}
