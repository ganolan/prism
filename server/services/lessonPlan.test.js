import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { storeSchoolDays, storeClassMeetings } from './schoolCalendar.js';
import { lessonPlan } from './lessonPlan.js';

let courseId;

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM class_meetings; DELETE FROM school_days; DELETE FROM courses;');
  courseId = db.prepare("INSERT INTO courses (schoology_section_id, course_name) VALUES ('lp', 'AIML')").run().lastInsertRowid;
  // Mon 05/10 .. Fri 16/10, with Thu 08/10 a holiday (not a school day).
  const days = [];
  for (let d = 5; d <= 16; d++) {
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    const weekend = [10, 11].includes(d);
    days.push({ date, inSession: !weekend && d !== 8, cycleLetter: 'A', raw: '{}' });
  }
  storeSchoolDays(db, days);
  storeClassMeetings(db, courseId, ['2026-10-06', '2026-10-09', '2026-10-13', '2026-10-15']);
});

describe('lessonPlan', () => {
  test('day n is the n-th school day after the start date (skipping weekends and holidays)', () => {
    const plan = lessonPlan(getDb(), { courseId, from: '2026-10-06', today: '2026-10-06' });
    expect(plan.days.slice(0, 4).map((d) => d.date)).toEqual(['2026-10-07', '2026-10-09', '2026-10-12', '2026-10-13']);
    expect(plan.days).toHaveLength(60);
  });

  test('meetings are the class\'s lessons after today, within the plan', () => {
    const plan = lessonPlan(getDb(), { courseId, from: '2026-10-01', today: '2026-10-06' });
    expect(plan.meetings).toEqual(['2026-10-09', '2026-10-13', '2026-10-15']);
  });

  test('no timetable for the class: no meetings; a bad start date falls back to today', () => {
    const other = getDb().prepare("INSERT INTO courses (schoology_section_id, course_name) VALUES ('x', 'X')").run().lastInsertRowid;
    const plan = lessonPlan(getDb(), { courseId: other, from: 'nope', today: '2026-10-06' });
    expect(plan).toMatchObject({ from: '2026-10-06', meetings: [] });
  });
});
