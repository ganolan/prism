import { describe, test, expect } from 'vitest';
import { extractCalendarDays, mergeCalendarDays, extractMeetingDates } from './psCalendar.js';

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
});
