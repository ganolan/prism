import { describe, it, expect } from 'vitest';
import { timelineParts, timelineSummary, CLOCK_HELP } from './submissionTimeline.js';

const at = (s) => Math.floor(new Date(s.replace(' ', 'T') + ':00').getTime() / 1000);
const t = (over = {}) => ({
  due: { date: '2026-10-06', time: '15:00' }, extension: null, deadline: '2026-10-06',
  submission: { state: 'submitted', firstAt: null, latestAt: null, late: null, day: null, lateMinutes: null, schoologyLate: null },
  overdue: null, resubmission: null, referral: null, limit: 8, ...over,
});
const sub = (s) => t({ submission: { ...t().submission, ...s } });
const texts = (tl) => timelineParts(tl).map((p) => p.text);

describe('timelineParts', () => {
  it('due date, then when it was submitted and that it was on time', () => {
    expect(texts(sub({ firstAt: at('2026-10-06 14:10'), late: false }))).toEqual(['Due Tue 06/10 15:00', 'Submitted Tue 06/10 14:10 · on time']);
  });

  it('late on the due date itself: minutes (hours past 60)', () => {
    const parts = timelineParts(sub({ firstAt: at('2026-10-06 15:42'), late: true, day: 1, lateMinutes: 42 }));
    expect(parts[1]).toMatchObject({ text: 'Submitted Tue 06/10 15:42 · 42 min late', tone: 'late' });
    expect(texts(sub({ firstAt: at('2026-10-06 17:05'), late: true, day: 1, lateMinutes: 125 }))[1]).toBe('Submitted Tue 06/10 17:05 · 2 h 5 min late');
  });

  it('late but before the next school day (e.g. over a weekend)', () => {
    expect(texts(sub({ firstAt: at('2026-10-10 11:00'), late: true, day: 1, lateMinutes: null }))[1])
      .toBe('Submitted Sat 10/10 11:00 · late, before the next school day');
  });

  it('late by school days; a later revision is shown too', () => {
    expect(texts(sub({ firstAt: at('2026-10-12 09:00'), latestAt: at('2026-10-13 10:00'), late: true, day: 4 }))[1])
      .toBe('Submitted Mon 12/10 09:00 · 3 school days late · latest Tue 13/10 10:00');
    expect(texts(sub({ firstAt: at('2026-10-07 09:00'), late: true, day: 2 }))[1]).toBe('Submitted Wed 07/10 09:00 · 1 school day late');
  });

  it('an extension shows on the due line; Schoology\'s disagreeing late flag is explained on hover', () => {
    const parts = timelineParts(t({
      extension: { schoolDays: 2, until: '2026-10-09', note: 'sick' }, deadline: '2026-10-09',
      submission: { ...t().submission, firstAt: at('2026-10-09 10:00'), late: false, schoologyLate: true },
    }));
    expect(parts[0]).toMatchObject({ text: 'Due Tue 06/10 15:00 · extended 2 school days to Fri 09/10', title: 'sick' });
    expect(parts[1]).toMatchObject({ text: 'Submitted Fri 09/10 10:00 · on time (extension)' });
    expect(parts[1].title).toMatch(/Schoology marks it late/);
  });

  it('no stored time: says late from Schoology, or just submitted', () => {
    expect(texts(sub({ late: true }))[1]).toBe('Submitted · late (per Schoology)');
    expect(texts(sub({ late: null }))[1]).toBe('Submitted');
  });

  it('missing work says which clock day it is on, red after the limit', () => {
    const inProgress = timelineParts(t({ submission: { ...t().submission, state: 'in_progress' }, overdue: { day: 6, overLimit: false } }));
    expect(inProgress[1]).toMatchObject({ text: 'In progress, not submitted · 5 school days overdue', tone: 'late' });
    const missing = timelineParts(t({ submission: { ...t().submission, state: 'not_submitted' }, overdue: { day: 9, overLimit: true } }));
    expect(missing[1]).toMatchObject({ text: 'Not submitted · 8 school days overdue, over the limit', tone: 'over' });
    expect(texts(t({ submission: { ...t().submission, state: 'not_started' } }))[1]).toBe('Not started');
  });

  it('excused, and work not handed in online, say so or nothing', () => {
    expect(texts(t({ submission: { ...t().submission, state: 'excused' } }))).toEqual(['Due Tue 06/10 15:00', 'Excused']);
    expect(texts(t({ submission: { ...t().submission, state: 'untracked' } }))).toEqual(['Due Tue 06/10 15:00']);
  });

  it('resubmission ask and arrival, and a referral', () => {
    expect(texts(t({ resubmission: { state: 'waiting', askedOn: '2026-10-07', until: '2026-10-12', arrivedOn: null, afterDeadline: false } }))[2])
      .toBe('Resubmission asked Wed 07/10, due Mon 12/10');
    const arrived = timelineParts(t({ resubmission: { state: 'arrived', askedOn: '2026-10-07', until: '2026-10-12', arrivedOn: '2026-10-13', afterDeadline: true } }));
    expect(arrived[2]).toMatchObject({ text: 'Resubmission arrived Tue 13/10, after its deadline', tone: 'late' });
    expect(texts(t({ referral: { on: '2026-10-19', day: 9 } }))[2]).toBe('Referred Mon 19/10 (8 school days late)');
  });

  it('no timeline → nothing', () => {
    expect(timelineParts(null)).toEqual([]);
  });
});

describe('timelineSummary / CLOCK_HELP', () => {
  it('joins the parts for a tooltip', () => {
    expect(timelineSummary(sub({ firstAt: at('2026-10-06 14:10'), late: false }))).toBe('Due Tue 06/10 15:00\nSubmitted Tue 06/10 14:10 · on time');
  });

  it('explains the clock in school days, with the limit', () => {
    expect(CLOCK_HELP(8)).toBe('Counted in school days after the due date (or the extended date). Work 8 or more school days late is referred.');
  });
});
