import { describe, it, expect } from 'vitest';
import { unreadCounts, rosterFilterOptions, applyRosterFilters, alertChipLabel, LEARNING_PLAN, UNREAD, ABSENCES } from './rosterVitals.js';

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

describe('gender pills', () => {
  const G = [
    { id: 1, gender: 'F' }, { id: 2, gender: 'F' }, { id: 3, gender: 'M' }, { id: 4, gender: null }, { id: 5 },
  ];

  it('F, M, NB, ? codes with the full label as the tip, each with its count, only while someone matches', () => {
    const o = rosterFilterOptions([...G, { id: 6, gender: 'X' }], null);
    expect(o.gender).toEqual([
      { key: 'gender:F', label: 'F', tip: 'Female', count: 2 },
      { key: 'gender:M', label: 'M', tip: 'Male', count: 1 },
      { key: 'gender:NB', label: 'NB', tip: 'Recorded in PowerSchool as "X"', count: 1 },
      { key: 'gender:none', label: '?', tip: 'Not recorded in PowerSchool', count: 2 },
    ]);
    expect(o.genderStudents).toBe(6);
    expect(rosterFilterOptions(G, null).gender.map((p) => p.label)).toEqual(['F', 'M', '?']); // nobody is NB
    expect(rosterFilterOptions([{ id: 1, gender: 'M' }], null).gender).toEqual([{ key: 'gender:M', label: 'M', tip: 'Male', count: 1 }]);
  });

  it('a pill that is on stays at 0 while nobody matches it', () => {
    const o = rosterFilterOptions([{ id: 1, gender: 'M' }], null, new Set(['gender:F']));
    expect(o.gender.map((p) => [p.key, p.count])).toEqual([['gender:F', 0], ['gender:M', 1]]);
  });

  it('Gender pills are any of within the row, and the row narrows the other pills (AND)', () => {
    const ids = (sel, st = G, unread = {}) => applyRosterFilters(st, new Set(sel), unread).map((x) => x.id);
    expect(ids(['gender:F'])).toEqual([1, 2]);
    expect(ids(['gender:F', 'gender:M'])).toEqual([1, 2, 3]);
    expect(ids(['gender:none'])).toEqual([4, 5]);
    expect(ids(['gender:NB'], [...G, { id: 6, gender: 'X' }])).toEqual([6]);
    expect(ids(['gender:NB', 'gender:none'], [...G, { id: 6, gender: 'X' }])).toEqual([4, 5, 6]);
    // Unread comments are any of with the alert pills, then narrowed by Gender.
    expect(ids([UNREAD], G, { 1: 1, 3: 1, 5: 1 })).toEqual([1, 3, 5]);
    expect(ids(['gender:F', UNREAD], G, { 1: 1, 3: 1, 5: 1 })).toEqual([1]);
    expect(ids(['gender:F', 'gender:M', UNREAD], G, { 1: 1, 3: 1, 5: 1 })).toEqual([1, 3]);
    expect(ids(['gender:none', UNREAD], G, { 1: 1, 3: 1, 5: 1 })).toEqual([5]);
  });

  it('any value other than F or M is NB; only a blank or missing value is ?', () => {
    expect(rosterFilterOptions([{ id: 1, gender: 'X' }], null).gender).toEqual([{ key: 'gender:NB', label: 'NB', tip: 'Recorded in PowerSchool as "X"', count: 1 }]);
  });
});

describe('3 or more absences (#208)', () => {
  const att = (absences) => ({ absences, lates: 0, excused: 0, lessons: [] });
  const R = [
    { id: 1, attendance: att(3) },
    { id: 2, attendance: att(5) },
    { id: 3, attendance: att(2) },
    { id: 4 }, // attendance not read
  ];

  it('a Follow up pill counting the students with 3 or more, beside Unread comments', () => {
    const o = rosterFilterOptions(R, { 3: 1 });
    expect(o.followUp).toEqual([
      { key: UNREAD, label: 'Unread comments', count: 1 },
      { key: ABSENCES, label: '3 or more absences', count: 2 },
    ]);
    expect(o.followUpStudents).toBe(3);
  });

  it('is listed only while a student matches or it is on', () => {
    expect(rosterFilterOptions([R[2], R[3]], null).followUp).toEqual([]);
    expect(rosterFilterOptions([R[2]], null, new Set([ABSENCES])).followUp).toEqual([{ key: ABSENCES, label: '3 or more absences', count: 0 }]);
  });

  it('filters to those students, "any of" with Unread comments', () => {
    expect(applyRosterFilters(R, new Set([ABSENCES])).map((s) => s.id)).toEqual([1, 2]);
    expect(applyRosterFilters(R, new Set([ABSENCES, UNREAD]), { 3: 1 }).map((s) => s.id)).toEqual([1, 2, 3]);
  });
});
