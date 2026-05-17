import { describe, it, expect } from 'vitest';
import { reduceSyncEvents } from './syncEvents.js';

describe('reduceSyncEvents', () => {
  it('builds an ordered phase list, updating status in place', () => {
    const { phases } = reduceSyncEvents([
      { phase: 'schoology', status: 'running' },
      { phase: 'schoology', status: 'done', records: 42 },
      { phase: 'mastery', courseId: 5, courseName: 'Biology 9', status: 'running' },
      { phase: 'mastery', courseId: 5, courseName: 'Biology 9', status: 'done', records: 7 },
    ]);
    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({ kind: 'schoology', status: 'done', records: 42 });
    expect(phases[1]).toMatchObject({ kind: 'mastery', courseId: 5, status: 'done', records: 7 });
  });

  it('collects log lines and the summary', () => {
    const { logLines, summary } = reduceSyncEvents([
      { type: 'log', message: 'Fetched 4 sections' },
      { type: 'summary', mastery: [], elapsedMs: 100 },
    ]);
    expect(logLines).toEqual(['Fetched 4 sections']);
    expect(summary).toMatchObject({ elapsedMs: 100 });
  });

  it('records failures with their errorKind', () => {
    const { failures } = reduceSyncEvents([
      { phase: 'mastery', courseId: 1, courseName: 'A', status: 'error', errorKind: 'login', message: 'expired' },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ courseId: 1, errorKind: 'login' });
  });

  it('computes progress as completed phases over total', () => {
    const { progress } = reduceSyncEvents([
      { phase: 'schoology', status: 'done' },
      { phase: 'mastery', courseId: 1, courseName: 'A', status: 'running' },
    ]);
    expect(progress).toBe(0.5);
  });

  it('marks fatal when a summary is fatal', () => {
    const { fatal } = reduceSyncEvents([{ type: 'summary', fatal: true, mastery: [] }]);
    expect(fatal).toBe(true);
  });
});
