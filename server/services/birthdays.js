// Birthdays and age (#191), from the date of birth the Demographics read stores (psDemographicsSync.js), with the
// rules of client/src/lib/birthdays.js and the school calendar (a weekend or holiday birthday is marked on the
// school day before). Prism's privacy is the page's: these answers carry the date and the age, and the client draws
// only "Birthday today" with Private details off (docs/design-language.md).
import { todayLocal } from '../lib/schoolDays.js';
import { loadCalendar } from './schoolCalendar.js';
import { studentFullName, preferredFirstName } from './studentNames.js';
import { ageOn, birthdayNear, nextBirthday, isBirthdayToday } from '../../client/src/lib/birthdays.js';

// Fields for one student row: { age, birthday_today } (age null without a date of birth).
export function birthdayFields(student, today, isSchoolDay) {
  const dob = student?.date_of_birth || null;
  return { age: dob ? ageOn(dob, today) : null, birthday_today: isBirthdayToday(dob, today, isSchoolDay) };
}

// The same for many rows, with one calendar read. → (row) => row with the fields added.
export function withBirthdays(db, { today = todayLocal() } = {}) {
  const cal = loadCalendar(db);
  return (row) => ({ ...row, ...birthdayFields(row, today, cal.isSchoolDay) });
}

// The dashboard's list: every student enrolled in a current course whose birthday is from 3 days back to 7 days
// ahead, or whose birthday is marked today (one deep in a holiday is marked on the last school day before it),
// nearest first. → { today, students: [{ id, name, first, date, days, turns, birthday_today, courses }] }.
export function birthdaysAround(db, { today = todayLocal() } = {}) {
  const cal = loadCalendar(db);
  const rows = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher, s.date_of_birth, c.course_name
    FROM students s
    JOIN enrolments e ON e.student_id = s.id AND e.dropped_at IS NULL
    JOIN courses c ON c.id = e.course_id AND c.archived = 0 AND c.excluded = 0
    WHERE s.date_of_birth IS NOT NULL
    ORDER BY c.course_name
  `).all();
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, { row: r, courses: [] });
    byId.get(r.id).courses.push(r.course_name);
  }
  const students = [];
  for (const { row, courses } of byId.values()) {
    const mark = isBirthdayToday(row.date_of_birth, today, cal.isSchoolDay);
    const near = birthdayNear(row.date_of_birth, today) ?? (mark ? nextBirthday(row.date_of_birth, today) : null);
    if (!near) continue;
    students.push({
      id: row.id, name: studentFullName(row), first: preferredFirstName(row), date: near.date, days: near.days, turns: near.turns,
      birthday_today: mark, courses,
    });
  }
  students.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return { today, students };
}
