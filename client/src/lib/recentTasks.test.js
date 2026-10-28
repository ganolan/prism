import { describe, it, expect } from 'vitest';
import { recentTasks } from './recentTasks.js';

const courses = [{ id: 1, course_name: 'AP CSP', archived: 0 }, { id: 2, course_name: 'Old course', archived: 1 }];
const task = (n, due, more = {}) => ({
  assignment_id: n, schoology_assignment_id: String(1000 + n), assignment_title: `Task ${n}`, course_id: 1,
  due_date: due, exception: null, score: null, timeline: null, ...more,
});
const submitted = (late = false, extra = {}) => ({ submission: { state: 'submitted', firstAt: 1761300000, late, day: late ? 2 : null, ...extra }, overdue: null });

describe('recentTasks (#185)', () => {
  it('lists tasks due by today in current courses, newest due first, at most the limit', () => {
    const grades = [
      task(1, '2026-10-20 15:00:00'), task(2, '2026-10-27 23:59:00'), task(3, '2026-10-29 08:00:00'),
      task(4, '2026-10-28 23:59:00'), task(5, null), task(6, '2026-10-26 08:00:00', { course_id: 2 }),
    ];
    const out = recentTasks(grades, courses, { today: '2026-10-28', limit: 2 });
    expect(out.map((t) => t.title)).toEqual(['Task 4', 'Task 2']);
    expect(out[0]).toMatchObject({ courseId: 1, courseName: 'AP CSP', due: '2026-10-28', schoologyAssignmentId: '1004' });
  });

  it('a flag stands for the status: Missing and Exempt by name', () => {
    const out = recentTasks([
      task(1, '2026-10-27', { exception: 3, timeline: { submission: { state: 'not_submitted' }, overdue: { day: 2 } } }),
      task(2, '2026-10-26', { exception: '1' }),
    ], courses, { today: '2026-10-28' });
    expect(out.map((t) => [t.flag, t.text, t.tone])).toEqual([[3, 'Missing', 'over'], [1, 'Exempt', 'quiet']]);
  });

  it('uses the submission timeline words: on time, late, overdue and over the limit', () => {
    const out = recentTasks([
      task(1, '2026-10-27', { timeline: submitted(false) }),
      task(2, '2026-10-26', { timeline: submitted(true) }),
      task(3, '2026-10-23', { timeline: { submission: { state: 'not_submitted' }, overdue: { day: 3, overLimit: false } } }),
      task(4, '2026-10-12', { timeline: { submission: { state: 'not_started' }, overdue: { day: 12, overLimit: true } } }),
    ], courses, { today: '2026-10-28' });
    expect(out.map((t) => t.tone)).toEqual(['ok', 'late', 'late', 'over']);
    expect(out[0].text).toMatch(/^Submitted \d\d\/\d\d \d\d:\d\d$/);
    expect(out[1].text).toMatch(/^Submitted \d\d\/\d\d \d\d:\d\d \(1 school day late\)$/);
    expect(out[2].text).toBe('Not submitted (2 school days overdue)');
    expect(out[3].text).toBe('Not started (11 school days overdue, over the limit)');
  });

  it('with nothing tracked online it says whether the task is graded, never that work is missing', () => {
    const out = recentTasks([
      task(1, '2026-10-27', { score: 3.5, timeline: { submission: { state: 'unknown' }, overdue: null } }),
      task(2, '2026-10-26', { timeline: { submission: { state: 'unknown' }, overdue: null } }),
    ], courses, { today: '2026-10-28' });
    expect(out.map((t) => [t.text, t.tone])).toEqual([['Graded', 'quiet'], ['Not graded yet', 'quiet']]);
  });

  it('an Exempt state without the flag reads Exempt', () => {
    const [t] = recentTasks([task(1, '2026-10-27', { timeline: { submission: { state: 'excused' }, overdue: null } })], courses, { today: '2026-10-28' });
    expect([t.text, t.tone]).toEqual(['Exempt', 'quiet']);
  });
});
