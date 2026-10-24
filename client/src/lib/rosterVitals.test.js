import { describe, it, expect } from 'vitest';
import { unreadCounts, rosterFilterOptions, applyRosterFilters, alertChipLabel, LEARNING_PLAN, UNREAD } from './rosterVitals.js';

const plan = { key: 'accommodation_plan', label: 'Accommodation plan', category: 'learning' };
const ls2 = { key: 'learning_support_2', label: 'Learning support 2', category: 'learning' };
const epipen = { key: 'epipen', label: 'EpiPen', category: 'health' };
const allergies = { key: 'allergies', label: 'Allergies', category: 'health' };
const mobility = { key: 'mobility', label: 'Mobility', category: 'other' };
const siblings = { key: 'siblings', label: 'Siblings', category: 'family' };

const S = [
  { id: 1, ps_alerts: [plan, epipen] },
  { id: 2, ps_alerts: [ls2] },
  { id: 3, ps_alerts: [allergies, siblings] },
  { id: 4, ps_alerts: [mobility] },
  { id: 5, ps_alerts: [] },
  { id: 6 },
];

describe('unreadCounts', () => {
  it('sums each student\'s unread comments across the course\'s tasks', () => {
    expect(unreadCounts({
      a1: { 1: { count: 3, unread: 2 }, 2: { count: 1, unread: 0 } },
      a2: { 1: { count: 1, unread: 1 }, 5: { count: 2, unread: 1 } },
    })).toEqual({ 1: 3, 2: 0, 5: 1 });
    expect(unreadCounts(null)).toEqual({});
  });
});

describe('rosterFilterOptions', () => {
  it('one Learning plan pill for every learning alert, then each other alert type, with counts; never family', () => {
    const { alerts, alertStudents } = rosterFilterOptions(S, { 1: 2 });
    expect(alerts).toEqual([
      { key: LEARNING_PLAN, label: 'Learning plan', count: 2 },
      { key: 'allergies', label: 'Allergies', count: 1 },
      { key: 'epipen', label: 'EpiPen', count: 1 },
      { key: 'mobility', label: 'Mobility', count: 1 },
    ]);
    expect(alertStudents).toBe(4);
  });

  it('Follow up: Unread comments while some student has one; none when comments are unavailable', () => {
    expect(rosterFilterOptions(S, { 1: 2, 4: 1, 5: 0 })).toMatchObject({
      followUp: [{ key: UNREAD, label: 'Unread comments', count: 2 }], followUpStudents: 2,
    });
    expect(rosterFilterOptions(S, { 1: 0 }).followUp).toEqual([]);
    expect(rosterFilterOptions(S, null).followUp).toEqual([]);
  });

  it('a pill that is on stays while nobody matches it, at 0', () => {
    const { alerts, followUp } = rosterFilterOptions([{ id: 9, ps_alerts: [] }], {}, new Set(['epipen', UNREAD]), { epipen: 'EpiPen' });
    expect(alerts).toEqual([{ key: 'epipen', label: 'EpiPen', count: 0 }]);
    expect(followUp).toEqual([{ key: UNREAD, label: 'Unread comments', count: 0 }]);
  });
});

describe('applyRosterFilters', () => {
  it('nothing on: everyone', () => {
    expect(applyRosterFilters(S, new Set(), {})).toEqual(S);
  });

  it('pills combine as any of', () => {
    const ids = (sel, unread = {}) => applyRosterFilters(S, new Set(sel), unread).map((s) => s.id);
    expect(ids([LEARNING_PLAN])).toEqual([1, 2]);
    expect(ids(['mobility', 'allergies'])).toEqual([3, 4]);
    expect(ids([LEARNING_PLAN, UNREAD], { 5: 1, 1: 1 })).toEqual([1, 2, 5]);
    expect(ids(['siblings'])).toEqual([]);
  });
});

describe('alertChipLabel', () => {
  it('short labels on the chip; the rest as PowerSchool alerts are labelled', () => {
    expect(alertChipLabel(plan)).toBe('Plan');
    expect(alertChipLabel(ls2)).toBe('LS 2');
    expect(alertChipLabel(epipen)).toBe('EpiPen');
  });
});
