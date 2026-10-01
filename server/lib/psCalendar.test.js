import { describe, test, expect } from 'vitest';
import { extractCalendarDays, mergeCalendarDays } from './psCalendar.js';

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
