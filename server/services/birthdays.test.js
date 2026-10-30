// #191: the dashboard's birthdays and each student row's age and birthday_today, on the school calendar.
import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { storeSchoolDays } from './schoolCalendar.js';
import { birthdaysAround, withBirthdays } from './birthdays.js';

let db;
let course;
const student = (first, dob, { enrolled = true, dropped = false, inCourse } = {}) => {
  const id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name, date_of_birth) VALUES (?, ?, 'Lee', ?)`).run(`u-${first}`, first, dob).lastInsertRowid;
  if (enrolled) db.prepare('INSERT INTO enrolments (student_id, course_id, dropped_at) VALUES (?, ?, ?)').run(id, inCourse ?? course, dropped ? '2026-10-01' : null);
  return id;
};

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  course = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'AI & ML')`).run().lastInsertRowid;
  // School days: the weekdays of October and November 2026.
  const days = [];
  for (let d = new Date(Date.UTC(2026, 9, 1)); d < new Date(Date.UTC(2026, 11, 1)); d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    days.push({ date: d.toISOString().slice(0, 10), inSession: w !== 0 && w !== 6, cycleLetter: null, raw: '{}' });
  }
  storeSchoolDays(db, days);
});

describe('birthdaysAround', () => {
  test('current students with a birthday 3 days back to 7 ahead, nearest first, once each, with their courses', () => {
    const other = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s2', 'Robotics')`).run().lastInsertRowid;
    const ana = student('Ana', '2010-10-31'); // Saturday: marked Friday 30/10
    db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(ana, other);
    student('Bo', '2011-10-26'); // 4 days back: out
    student('Cy', '2010-10-27');
    student('Di', '2010-11-06'); student('Jo', '2010-11-07'); // 7 ahead: in; 8 ahead: out
    student('Ed', '2010-10-30', { dropped: true });
    student('Flo', '2010-10-30', { enrolled: false });
    student('Gus', null);
    const archived = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('s3', 'Old', 1)`).run().lastInsertRowid;
    student('Hal', '2010-10-30', { inCourse: archived });
    const r = birthdaysAround(db, { today: '2026-10-30' });
    expect(r.today).toBe('2026-10-30');
    expect(r.students.map((s) => [s.name, s.date, s.days, s.turns, s.birthday_today])).toEqual([
      ['Cy Lee', '2026-10-27', -3, 16, false],
      ['Ana Lee', '2026-10-31', 1, 16, true],
      ['Di Lee', '2026-11-06', 7, 16, false],
    ]);
    expect(r.students[1].courses).toEqual(['AI & ML', 'Robotics']);
  });
});

test('a birthday deep in a holiday is listed on the school day it is marked, though more than 7 days ahead', () => {
  db.prepare("UPDATE school_days SET in_session = 0 WHERE date >= '2026-11-02' AND date <= '2026-11-20'").run();
  student('Kim', '2010-11-13');
  const r = birthdaysAround(db, { today: '2026-10-30' });
  expect(r.students).toEqual([expect.objectContaining({ name: 'Kim Lee', first: 'Kim', date: '2026-11-13', days: 14, turns: 16, birthday_today: true, birthday_label: 'Birthday over the break' })]);
});

describe('withBirthdays', () => {
  test('adds the age and birthday_today; none without a date of birth', () => {
    const add = withBirthdays(db, { today: '2026-10-30' });
    // Graham, 30 Oct 2026: a weekend birthday marked on the Friday says when it is, not "Birthday today".
    expect(add({ id: 1, date_of_birth: '2010-11-01' })).toMatchObject({ age: 15, birthday_today: true, birthday_label: 'Birthday on Sunday' }); // Sunday → Friday
    expect(add({ id: 4, date_of_birth: '2010-10-30' })).toMatchObject({ birthday_today: true, birthday_label: 'Birthday today' });
    expect(add({ id: 2, date_of_birth: '2010-10-29' })).toMatchObject({ age: 16, birthday_today: false, birthday_label: null });
    expect(add({ id: 3, date_of_birth: null })).toMatchObject({ age: null, birthday_today: false, birthday_label: null });
  });
});
