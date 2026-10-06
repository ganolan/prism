import { describe, it, expect } from 'vitest';
import { lessonHint, schoolDaysForLesson } from './lessonHint.js';

// School days after the start date 06/10: 07, 09, 12, 13, 14, 15, 16 (08 is a holiday).
const PLAN = {
  from: '2026-10-06', today: '2026-10-06',
  days: ['2026-10-07', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
    .map((date, i) => ({ n: i + 1, date, approx: false })),
  meetings: ['2026-10-09', '2026-10-13', '2026-10-15'],
};

describe('lessonHint', () => {
  it('names the landing date and how many lessons from today it is', () => {
    expect(lessonHint(PLAN, 1)).toEqual({ date: '2026-10-07', text: '→ Wed 07/10 · no lessons before then' });
    expect(lessonHint(PLAN, 2).text).toBe('→ Fri 09/10 · 1 lesson from today');
    expect(lessonHint(PLAN, 6).text).toBe('→ Thu 15/10 · 3 lessons from today');
  });

  it('a deadline already behind today says so', () => {
    const past = { ...PLAN, today: '2026-10-13' };
    expect(lessonHint(past, 2).text).toBe('→ Fri 09/10 · already passed');
  });

  it('without a timetable it gives just the date; without a plan, nothing', () => {
    expect(lessonHint({ ...PLAN, meetings: [] }, 2).text).toBe('→ Fri 09/10');
    expect(lessonHint(null, 2)).toBeNull();
    expect(lessonHint(PLAN, 99)).toBeNull();
  });
});

describe('schoolDaysForLesson', () => {
  it('the school-day count that lands on the k-th lesson from today', () => {
    expect(schoolDaysForLesson(PLAN, 1)).toBe(2); // Fri 09/10
    expect(schoolDaysForLesson(PLAN, 2)).toBe(4); // Tue 13/10
  });

  it('counts lessons after the start date when that is later than today (an extension before the due date)', () => {
    expect(schoolDaysForLesson({ ...PLAN, from: '2026-10-09' , days: PLAN.days.slice(2).map((d, i) => ({ ...d, n: i + 1 })) }, 1)).toBe(2); // Tue 13/10
  });

  it('null when there is no such lesson in the plan', () => {
    expect(schoolDaysForLesson(PLAN, 4)).toBeNull();
    expect(schoolDaysForLesson({ ...PLAN, meetings: [] }, 1)).toBeNull();
  });
});
