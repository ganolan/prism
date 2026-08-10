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

  it('a type:error event sets fatal and records the message in the log', () => {
    const { fatal, logLines } = reduceSyncEvents([
      { type: 'error', message: 'orchestrator blew up' },
    ]);
    expect(fatal).toBe(true);
    expect(logLines).toContain('orchestrator blew up');
  });

  it('returns the default empty shape for no events', () => {
    expect(reduceSyncEvents([])).toEqual({
      phases: [], logLines: [], summary: null, fatal: false, failures: [], progress: 0,
    });
  });

  it('builds a blocks phase and carries notReady through (#126)', () => {
    const { phases } = reduceSyncEvents([
      { phase: 'blocks', status: 'running' },
      { phase: 'blocks', status: 'done', records: 2, skipped: 3, notReady: 2 },
    ]);
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ kind: 'blocks', label: 'PowerSchool blocks', status: 'done', records: 2, notReady: 2 });
  });

  it('handles log lines interleaved with multiple phases', () => {
    const { phases, logLines } = reduceSyncEvents([
      { phase: 'schoology', status: 'running' },
      { type: 'log', message: 'Fetched 4 sections' },
      { phase: 'schoology', status: 'done', records: 10 },
      { phase: 'mastery', courseId: 1, courseName: 'A', status: 'running' },
      { type: 'log', message: '[A] loading' },
      { phase: 'mastery', courseId: 2, courseName: 'B', status: 'running' },
      { phase: 'mastery', courseId: 1, courseName: 'A', status: 'done', records: 3 },
    ]);
    expect(phases.map((p) => p.key)).toEqual(['schoology', 'mastery:1', 'mastery:2']);
    expect(phases[1]).toMatchObject({ status: 'done', records: 3 });
    expect(phases[2]).toMatchObject({ status: 'running' });
    expect(logLines).toEqual(['Fetched 4 sections', '[A] loading']);
  });
});
