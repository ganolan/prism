import { describe, test, expect } from 'vitest';
import { extractCalendarDays, mergeCalendarDays, extractMeetingDates, extractMeetings, bellTime, termRange } from './psCalendar.js';

describe('extractCalendarDays', () => {
  test('reads calenderDays (PS spelling): date, inSession, letter, raw', () => {
    const days = extractCalendarDays({
      calenderDays: {
        '2026-10-05': { inSession: true, cycleDay: { letter: 'B' } },
        '2026-10-01': { inSession: false },
        '2026-11-26': { inSession: true, cycleDay: null, type: 'PH' },
        notADate: { inSession: true },
      },
    });
    expect(days).toEqual([
      { date: '2026-10-05', inSession: true, cycleLetter: 'B', raw: '{"inSession":true,"cycleDay":{"letter":"B"}}' },
      { date: '2026-10-01', inSession: false, cycleLetter: null, raw: '{"inSession":false}' },
      { date: '2026-11-26', inSession: false, cycleLetter: null, raw: '{"inSession":true,"cycleDay":null,"type":"PH"}' },
    ]);
  });

  test('accepts calendarDays; missing calendar → []', () => {
    expect(extractCalendarDays({ calendarDays: { '2026-10-05': { inSession: true } } })).toHaveLength(1);
    expect(extractCalendarDays(null)).toEqual([]);
  });
});

describe('mergeCalendarDays', () => {
  test('in session if ANY section says so; first non-null letter wins', () => {
    const m = new Map();
    mergeCalendarDays(m, [{ date: '2026-10-05', inSession: false, cycleLetter: null, raw: 'a' }]);
    mergeCalendarDays(m, [{ date: '2026-10-05', inSession: true, cycleLetter: 'B', raw: 'b' }]);
    expect(m.get('2026-10-05')).toMatchObject({ inSession: true, cycleLetter: 'B', raw: 'a' });
  });
});

describe('extractMeetingDates', () => {
  // Shapes as observed 2026-10-06 (scripts/probe-section-meeting-days.js): a section's
  // bellScheduleItems hold only its own period; each calendar day names its bell schedule.
  const day = (letter, bellScheduleId, extra = {}) => ({ inSession: true, cycleDay: { letter }, bellScheduleId, ...extra });
  const section = {
    periodIdToPsmPeriodIdMap: { 4451: '18328571' },
    bellScheduleItems: [
      { bellScheduleId: 4223, periodId: 4451 },
      { bellScheduleId: 4262, periodId: 4451 },
      { bellScheduleId: 9999, periodId: 1234 }, // another period: ignored
    ],
    calenderDays: {
      '2026-10-05': day('A', 4235),                          // other blocks' day
      '2026-10-06': day('B', 4223),                          // meets
      '2026-10-07': day('B', 9999),                          // only another period's schedule
      '2026-10-08': day('A', 4262),                          // meets
      '2026-10-01': { inSession: true, cycleDay: null, bellScheduleId: 4223, type: 'PH' }, // holiday
      '2026-10-10': { inSession: false, cycleDay: null, bellScheduleId: 0 },
      bogus: day('A', 4223),
    },
  };

  test('a class meets on school days whose bell schedule includes its period', () => {
    expect(extractMeetingDates(section)).toEqual(['2026-10-06', '2026-10-08']);
  });

  test('accepts calendarDays, and returns [] when there is nothing to go on', () => {
    expect(extractMeetingDates({ ...section, calenderDays: undefined, calendarDays: section.calenderDays })).toEqual(['2026-10-06', '2026-10-08']);
    expect(extractMeetingDates({ calenderDays: section.calenderDays })).toEqual([]);
    expect(extractMeetingDates(null)).toEqual([]);
  });

  // #187: bell times are seconds after midnight, as numbers (scripts/probe-ps-bell-times.js, 2026-10-28:
  // e.g. "Day 1" 30900 to 35100 for Block 1, minutesAttended 70).
  test('extractMeetings gives each lesson the start and end of the day\'s bell schedule item', () => {
    const timed = {
      ...section,
      bellScheduleItems: [
        { bellScheduleId: 4223, periodId: 4451, startTime: 30900, endTime: 35100 },
        { bellScheduleId: 4262, periodId: 4451, startTime: 45000, endTime: null },
        { bellScheduleId: 9999, periodId: 1234, startTime: 1, endTime: 2 },
      ],
    };
    expect(extractMeetings(timed)).toEqual([
      { date: '2026-10-06', start: '08:35', end: '09:45' },
      { date: '2026-10-08', start: '12:30', end: null },
    ]);
    expect(extractMeetings(section).map((m) => m.start)).toEqual([null, null]); // items without times
  });
});

describe('bellTime', () => {
  test.each([
    [30900, '08:35'], [54000, '15:00'], ['30900', '08:35'], [0, '00:00'],
    ['08:35', '08:35'], ['8:35:00', '08:35'], ['1:05 PM', '13:05'], ['12:10 am', '00:10'],
    [null, null], ['', null], [86400, null], [-1, null], ['25:00', null], ['13:00 PM', null], ['soon', null],
  ])('%j → %j', (v, want) => expect(bellTime(v)).toBe(want));
});

// #174: a section's calendar spans its whole term (verified 2026-10-06), so its first and last
// school day are the term's.
describe('termRange', () => {
  test('is the first and last school day of the calendar', () => {
    expect(termRange({
      calenderDays: {
        '2027-01-09': { inSession: false },
        '2026-08-20': { inSession: true, cycleDay: { letter: 'A' } },
        '2026-08-19': { inSession: true, cycleDay: null, type: 'PD' },
        '2027-01-08': { inSession: true, cycleDay: { letter: 'B' } },
        '2026-10-05': { inSession: true, cycleDay: { letter: 'A' } },
      },
    })).toEqual({ start: '2026-08-20', end: '2027-01-08' });
  });

  test('no school day → null', () => {
    expect(termRange({ calenderDays: {} })).toBeNull();
    expect(termRange({ calenderDays: { '2026-10-01': { inSession: false } } })).toBeNull();
    expect(termRange(null)).toBeNull();
  });
});
