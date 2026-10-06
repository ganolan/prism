import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { storeSchoolDays, loadCalendar, storeClassMeetings, loadClassMeetings } from './schoolCalendar.js';

const day = (date, inSession, letter = null) => ({ date, inSession, cycleLetter: letter, raw: '{}' });

beforeEach(() => { getDb().exec('DELETE FROM school_days;'); });

describe('storeSchoolDays', () => {
  test('replaces the stored PowerSchool calendar', () => {
    const db = getDb();
    storeSchoolDays(db, [day('2026-10-05', true, 'A'), day('2026-10-06', true, 'B')], '2026-10-01T00:00:00Z');
    storeSchoolDays(db, [day('2026-10-07', true, 'A')], '2026-10-02T00:00:00Z');
    expect(db.prepare('SELECT date FROM school_days ORDER BY date').all().map((r) => r.date)).toEqual(['2026-10-07']);
  });

  test('empty list is a no-op and keeps the stored calendar', () => {
    const db = getDb();
    storeSchoolDays(db, [day('2026-10-05', true)], '2026-10-01T00:00:00Z');
    expect(storeSchoolDays(db, [])).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM school_days').get().n).toBe(1);
  });
});

describe('loadCalendar', () => {
  test('builds a calendar from the stored rows, with syncedAt', () => {
    const db = getDb();
    storeSchoolDays(db, [day('2026-10-05', true, 'A'), day('2026-10-06', false)], '2026-10-01T00:00:00Z');
    const cal = loadCalendar(db);
    expect(cal.source).toBe('powerschool');
    expect(cal.totalSchoolDays).toBe(1);
    expect(cal.isSchoolDay('2026-10-06')).toBe(false);
    expect(cal.syncedAt).toBe('2026-10-01T00:00:00Z');
  });

  test('empty table → weekday calendar', () => {
    const cal = loadCalendar(getDb());
    expect(cal.source).toBe('weekdays');
    expect(cal.syncedAt).toBeNull();
  });
});

describe('storeClassMeetings / loadClassMeetings', () => {
  let courseId;
  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM class_meetings; DELETE FROM courses;');
    courseId = db.prepare("INSERT INTO courses (schoology_section_id, course_name) VALUES ('cm', 'AIML')").run().lastInsertRowid;
  });

  test('replaces a course\'s meeting dates and reads them back in order', () => {
    const db = getDb();
    storeClassMeetings(db, courseId, ['2026-10-08', '2026-10-06']);
    expect(loadClassMeetings(db, courseId)).toEqual(['2026-10-06', '2026-10-08']);
    storeClassMeetings(db, courseId, ['2026-10-12']);
    expect(loadClassMeetings(db, courseId)).toEqual(['2026-10-12']);
  });

  test('an empty fetch keeps the stored dates', () => {
    const db = getDb();
    storeClassMeetings(db, courseId, ['2026-10-06']);
    expect(storeClassMeetings(db, courseId, [])).toBe(0);
    expect(loadClassMeetings(db, courseId)).toEqual(['2026-10-06']);
  });
});
