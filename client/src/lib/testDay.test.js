import { describe, it, expect } from 'vitest';
import { upcomingTests, extraMinutes, planLine } from './testDay.js';

const task = (id, dueDate, over = {}) => ({
  schoology_assignment_id: id, title: `Test ${id}`, due_date: dueDate, is_test: 1, published: 1, removed_at: null, ...over,
});

describe('upcomingTests', () => {
  const today = '2026-10-25';

  it('lists published tests due from today to 14 days ahead, nearest first', () => {
    const tests = upcomingTests([
      task('far', '2026-11-05 15:30:00'),
      task('near', '2026-10-27 10:15:00'),
      task('task', '2026-10-26 15:30:00', { is_test: 0 }),
    ], today);
    expect(tests).toEqual([
      { schoologyAssignmentId: 'near', title: 'Test near', dueDate: '2026-10-27 10:15:00' },
      { schoologyAssignmentId: 'far', title: 'Test far', dueDate: '2026-11-05 15:30:00' },
    ]);
  });

  it('counts today and the 14th day, and leaves out the day before and the 15th', () => {
    const ids = upcomingTests([
      task('yesterday', '2026-10-24 23:59:00'),
      task('today', '2026-10-25 08:00:00'),
      task('day14', '2026-11-08 23:59:00'),
      task('day15', '2026-11-09 00:00:00'),
    ], today).map((t) => t.schoologyAssignmentId);
    expect(ids).toEqual(['today', 'day14']);
  });

  it('leaves out unpublished, removed and undated tests', () => {
    expect(upcomingTests([
      task('draft', '2026-10-27', { published: 0 }),
      task('gone', '2026-10-27', { removed_at: '2026-10-20T00:00:00Z' }),
      task('undated', null),
    ], today)).toEqual([]);
  });

  it('gives [] for an empty window or no assignments', () => {
    expect(upcomingTests([task('old', '2026-09-01')], today)).toEqual([]);
    expect(upcomingTests(undefined, today)).toEqual([]);
  });

  it('takes a Date for today', () => {
    expect(upcomingTests([task('near', '2026-10-27')], new Date(2026, 9, 25, 9, 0))).toHaveLength(1);
  });
});

describe('extraMinutes', () => {
  it('rounds to the nearest minute', () => {
    expect(extraMinutes(50, 25)).toBe(13);
    expect(extraMinutes(50, 50)).toBe(25);
    expect(extraMinutes(45, 10)).toBe(5); // 4.5 rounds up
    expect(extraMinutes(50, 0)).toBe(0);
  });
});

describe('planLine', () => {
  it('takes the first description that mentions time or %', () => {
    expect(planLine([
      { category: 'Academic Support', description: 'Learning support 1' },
      { category: 'Seating', description: 'Front of the room (some 20% of lessons)' },
      { category: 'Support Notes', description: 'Extended time (25%)' },
    ])).toBe('Front of the room (some 20% of lessons)');
    expect(planLine([
      { category: 'Academic Support', description: 'Learning support 1' },
      { category: 'Support Notes', description: 'Please allow extra time for in-class assessments.' },
    ])).toBe('Please allow extra time for in-class assessments.');
  });

  it('else the first non-empty description', () => {
    expect(planLine([
      { category: 'Blank', description: '  ' },
      { category: 'Academic Support', description: 'Learning support 1' },
      { category: 'Notes', description: 'Quiet room' },
    ])).toBe('Learning support 1');
  });

  it('does not count a word that only contains "time"', () => {
    expect(planLine([
      { description: 'Visual timetable' },
      { description: 'Sometimes needs a break' },
    ])).toBe('Visual timetable');
  });

  it('is null with nothing to show', () => {
    expect(planLine([])).toBeNull();
    expect(planLine([{ description: '' }, { category: 'Only a label' }])).toBeNull();
    expect(planLine(null)).toBeNull();
  });
});
