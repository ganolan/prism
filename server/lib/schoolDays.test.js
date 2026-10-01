import { describe, test, expect } from 'vitest';
import { makeCalendar, addDays, isWeekday, epochToLocalDate } from './schoolDays.js';

// 28/09/2026–09/10/2026 from the 26-27 Master Plan: Thu 01/10 (National Day)
// and Fri 02/10 (PD day) are not school days.
function window() {
  const rows = [];
  for (let d = '2026-09-28'; d <= '2026-10-09'; d = addDays(d, 1)) {
    const off = !isWeekday(d) || d === '2026-10-01' || d === '2026-10-02';
    rows.push({ date: d, in_session: off ? 0 : 1, cycle_letter: off ? null : 'A', source: 'powerschool' });
  }
  return rows;
}

describe('makeCalendar.between (school days d with from < d <= to)', () => {
  const cal = makeCalendar(window());

  test('skips the holiday, PD day and weekend: due Wed 30/09, today Mon 05/10 → 1', () => {
    expect(cal.between('2026-09-30', '2026-10-05')).toEqual({ days: 1, approx: false });
  });

  test('same day → 0', () => {
    expect(cal.between('2026-10-05', '2026-10-05')).toEqual({ days: 0, approx: false });
  });

  test('to before from → 0', () => {
    expect(cal.between('2026-10-06', '2026-10-05').days).toBe(0);
  });

  test('full week after the break → 5', () => {
    expect(cal.between('2026-09-30', '2026-10-09').days).toBe(5);
  });

  test('due on a non-school day counts from the next school day', () => {
    expect(cal.between('2026-10-01', '2026-10-06').days).toBe(2);
  });

  test('beyond the stored calendar falls back to weekdays and flags approx', () => {
    // 09/10 covered (school day); 10–11/10 weekend; 12–13/10 uncovered weekdays.
    expect(cal.between('2026-10-08', '2026-10-13')).toEqual({ days: 3, approx: true });
  });
});

describe('makeCalendar.addSchoolDays (the n-th school day after from)', () => {
  const cal = makeCalendar(window());

  test('across the 01/10–02/10 holidays and the weekend: Wed 30/09 + 1 → Mon 05/10', () => {
    expect(cal.addSchoolDays('2026-09-30', 1)).toEqual({ date: '2026-10-05', approx: false });
  });

  test('inverse of between: between(from, addSchoolDays(from, n)) === n', () => {
    for (const n of [1, 2, 3, 5]) {
      const { date } = cal.addSchoolDays('2026-09-28', n);
      expect(cal.between('2026-09-28', date).days).toBe(n);
    }
    expect(cal.addSchoolDays('2026-09-28', 3).date).toBe('2026-10-05');
  });

  test('from a non-school day counts from the next school day', () => {
    expect(cal.addSchoolDays('2026-10-01', 2).date).toBe('2026-10-06');
  });

  test('n <= 0 → from itself', () => {
    expect(cal.addSchoolDays('2026-10-05', 0)).toEqual({ date: '2026-10-05', approx: false });
  });

  test('beyond the stored calendar falls back to weekdays and flags approx', () => {
    // 09/10 covered; 10–11/10 weekend; then uncovered weekdays 12/10, 13/10.
    expect(cal.addSchoolDays('2026-10-08', 3)).toEqual({ date: '2026-10-13', approx: true });
  });

  test('no calendar → weekdays, approx', () => {
    expect(makeCalendar([]).addSchoolDays('2026-09-25', 2)).toEqual({ date: '2026-09-29', approx: true });
  });

  test('bad date → null date', () => {
    expect(cal.addSchoolDays('nope', 3).date).toBeNull();
  });
});

describe('makeCalendar with no rows', () => {
  test('counts weekdays, approx, source "weekdays"', () => {
    const cal = makeCalendar([]);
    expect(cal.between('2026-09-25', '2026-09-29')).toEqual({ days: 2, approx: true });
    expect(cal.source).toBe('weekdays');
    expect(cal.totalSchoolDays).toBe(0);
  });
});

describe('makeCalendar.info', () => {
  const cal = makeCalendar(window());

  test('school day: number within the stored year + letter', () => {
    expect(cal.info('2026-10-05')).toEqual({
      date: '2026-10-05', isSchoolDay: true, cycleLetter: 'A', schoolDayNumber: 4, approx: false,
    });
  });

  test('holiday: not a school day, no number', () => {
    expect(cal.info('2026-10-01')).toMatchObject({ isSchoolDay: false, schoolDayNumber: null });
  });

  test('source + total', () => {
    expect(cal.source).toBe('powerschool');
    expect(cal.totalSchoolDays).toBe(8);
  });
});

describe('epochToLocalDate', () => {
  test('0 / missing → null', () => {
    expect(epochToLocalDate(0)).toBeNull();
    expect(epochToLocalDate(null)).toBeNull();
  });
  test('04:00Z is the same calendar day in UTC and Hong Kong', () => {
    expect(epochToLocalDate(Date.parse('2026-10-05T04:00:00Z') / 1000)).toBe('2026-10-05');
  });
});
