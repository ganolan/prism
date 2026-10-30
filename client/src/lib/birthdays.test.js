import { describe, it, expect } from 'vitest';
import { birthdayIn, ageOn, birthdayNear, nextBirthday, markDay, isBirthdayToday, birthdayMarkLabel } from './birthdays.js';

// Weekdays are school days, except a made-up holiday week 2026-12-14 to 12-25.
const weekday = (d) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6; };
const school = (d) => weekday(d) && !(d >= '2026-12-14' && d <= '2026-12-25');

describe('birthdayMarkLabel (Graham, 30 Oct 2026: "Birthday today" for a weekend birthday misled)', () => {
  it('on the day, the weekend birthday marked on Friday, the holiday birthday marked before the break, and no mark', () => {
    expect(birthdayMarkLabel('2010-10-30', '2026-10-30', school)).toBe('Birthday today'); // Fri
    expect(birthdayMarkLabel('2010-10-31', '2026-10-30', school)).toBe('Birthday on Saturday');
    expect(birthdayMarkLabel('2010-11-01', '2026-10-30', school)).toBe('Birthday on Sunday');
    expect(birthdayMarkLabel('2010-12-20', '2026-12-11', school)).toBe('Birthday over the break'); // 9 days on, in the holiday week
    expect(birthdayMarkLabel('2010-11-02', '2026-10-30', school)).toBeNull(); // Monday's birthday is marked on Monday
  });
});

describe('birthdays', () => {
  it('birthdayIn: 29 February is the 28th in a year without one', () => {
    expect(birthdayIn('2010-06-15', 2026)).toBe('2026-06-15');
    expect(birthdayIn('2008-02-29', 2027)).toBe('2027-02-28');
    expect(birthdayIn('2008-02-29', 2028)).toBe('2028-02-29');
  });

  it('ageOn counts whole years, turning on the birthday', () => {
    expect(ageOn('2010-10-29', '2026-10-28')).toBe(15);
    expect(ageOn('2010-10-29', '2026-10-29')).toBe(16);
    expect(ageOn('2008-02-29', '2027-02-28')).toBe(19);
  });

  it('birthdayNear: from 3 days back to 7 ahead, across the new year, with the age turned', () => {
    expect(birthdayNear('2010-11-04', '2026-10-28')).toEqual({ date: '2026-11-04', days: 7, turns: 16 });
    expect(birthdayNear('2010-11-05', '2026-10-28')).toBeNull();
    expect(birthdayNear('2010-10-25', '2026-10-28')).toEqual({ date: '2026-10-25', days: -3, turns: 16 });
    expect(birthdayNear('2010-10-24', '2026-10-28')).toBeNull();
    expect(birthdayNear('2011-01-02', '2026-12-29')).toEqual({ date: '2027-01-02', days: 4, turns: 16 });
    expect(birthdayNear('2010-12-30', '2027-01-01')).toEqual({ date: '2026-12-30', days: -2, turns: 16 });
    expect(birthdayNear(null, '2026-10-28')).toBeNull();
  });

  it('nextBirthday is on or after today, into next year', () => {
    expect(nextBirthday('2010-10-28', '2026-10-28')).toEqual({ date: '2026-10-28', days: 0, turns: 16 });
    expect(nextBirthday('2010-10-27', '2026-10-28')).toEqual({ date: '2027-10-27', days: 364, turns: 17 });
  });

  it('a weekend or holiday birthday is marked on the school day before', () => {
    expect(markDay('2026-10-31', school)).toBe('2026-10-30'); // Saturday → Friday
    expect(markDay('2026-11-01', school)).toBe('2026-10-30'); // Sunday → Friday
    expect(markDay('2026-12-18', school)).toBe('2026-12-11'); // in the holiday week → the Friday before
    expect(isBirthdayToday('2010-10-31', '2026-10-30', school)).toBe(true);
    expect(isBirthdayToday('2010-11-01', '2026-10-30', school)).toBe(true);
    expect(isBirthdayToday('2010-10-31', '2026-10-29', school)).toBe(false);
    expect(isBirthdayToday('2010-12-18', '2026-12-11', school)).toBe(true);
  });

  it('a school-day birthday is marked on the day only; never on a day without school', () => {
    expect(isBirthdayToday('2010-10-28', '2026-10-28', school)).toBe(true);
    expect(isBirthdayToday('2010-10-29', '2026-10-28', school)).toBe(false);
    expect(isBirthdayToday('2010-10-27', '2026-10-28', school)).toBe(false);
    expect(isBirthdayToday('2010-10-31', '2026-10-31', school)).toBe(false); // the Saturday itself
    expect(isBirthdayToday(null, '2026-10-28', school)).toBe(false);
  });
});
