import { describe, it, expect } from 'vitest';
import { canEditPoints, hasNoScale, isTestTask, parsePoints } from './pointsTask.js';
// The server writes points, builds draft baselines and restores saved scores with a mirror of this module.
import * as server from '../../../server/lib/pointsTask.js';

const TASK = { grading_scale_id: '0', assignment_type: 'assignment', is_test: 0 };

describe('canEditPoints (#181)', () => {
  it('a task in plain points with no topics and no score scale', () => {
    expect(canEditPoints(TASK, [], null)).toBe(true);
    expect(canEditPoints({ ...TASK, grading_scale_id: null }, [], null)).toBe(true);
  });

  it('not a test or quiz, a task with topics, a score scale or a named Schoology scale', () => {
    expect(canEditPoints({ ...TASK, assignment_type: 'assessment' }, [], null)).toBe(false);
    expect(canEditPoints({ ...TASK, is_test: 1 }, [], null)).toBe(false);
    expect(canEditPoints(TASK, [{ id: 't1' }], null)).toBe(false);
    expect(canEditPoints(TASK, [], { name: 'Completion Scale' })).toBe(false);
    expect(canEditPoints({ ...TASK, grading_scale_id: '1293963' }, [], null)).toBe(false);
    expect(canEditPoints(null, [], null)).toBe(false);
  });
});

describe('parsePoints', () => {
  it('a number of 0 or more', () => {
    expect(['0', '45', ' 42.5 ', '.5', '100.00'].map(parsePoints)).toEqual([0, 45, 42.5, 0.5, 100]);
  });

  it('null for anything else', () => {
    expect(['', '-3', 'abc', '4,5', '1e3', '45.', null].map(parsePoints)).toEqual([null, null, null, null, null, null, null]);
  });
});

describe('parity with server/lib/pointsTask.js', () => {
  const tasks = [TASK, { ...TASK, assignment_type: 'assessment' }, { ...TASK, is_test: 1 }, { ...TASK, grading_scale_id: '7165818' }, { grading_scale_id: null }, null];
  it.each(tasks.map((t) => [JSON.stringify(t), t]))('%s', (_name, task) => {
    expect(server.hasNoScale(task?.grading_scale_id)).toBe(hasNoScale(task?.grading_scale_id));
    expect(server.isTestTask(task)).toBe(isTestTask(task));
    for (const [topics, scale] of [[[], null], [[{ id: 't' }], null], [[], { name: 'S' }]]) {
      expect(server.canEditPoints(task, topics, scale)).toBe(canEditPoints(task, topics, scale));
    }
  });

  it.each(['0', '45', '42.5', '.5', '', '-3', 'abc', '45.'])('parsePoints(%j)', (text) => {
    expect(server.parsePoints(text)).toBe(parsePoints(text));
  });
});
