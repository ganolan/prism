import { describe, it, expect } from 'vitest';
import { reduceSyncEvents, formatPhaseTime } from './syncEvents.js';

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

  it('a Comments phase (submission comment threads) is tracked with its count and time', () => {
    const { phases } = reduceSyncEvents([
      { phase: 'comments', status: 'running' },
      { phase: 'comments', status: 'done', records: 12, elapsedMs: 7000 },
    ]);
    expect(phases).toEqual([expect.objectContaining({ key: 'comments', kind: 'comments', label: 'Submission comments', status: 'done', records: 12, elapsedMs: 7000 })]);
  });

  it('#117: an alerts phase is tracked like the blocks phase', () => {
    const { phases, failures } = reduceSyncEvents([
      { phase: 'alerts', status: 'running' },
      { phase: 'alerts', status: 'error', errorKind: 'login', message: 'expired' },
    ]);
    expect(phases).toEqual([expect.objectContaining({ key: 'alerts', kind: 'alerts', label: 'PowerSchool alerts', status: 'error', errorKind: 'login' })]);
    expect(failures).toHaveLength(1);
  });

  it('collects log lines and the summary', () => {
    const { logLines, summary } = reduceSyncEvents([
      { type: 'log', message: 'Fetched 4 sections' },
      { type: 'summary', mastery: [], elapsedMs: 100 },
    ]);
    expect(logLines).toEqual(['Fetched 4 sections']);
    expect(summary).toMatchObject({ elapsedMs: 100 });
  });

  it('keeps each finished phase elapsedMs (#143)', () => {
    const { phases } = reduceSyncEvents([
      { phase: 'schoology', status: 'running' },
      { phase: 'schoology', status: 'done', records: 4, elapsedMs: 61000 },
      { phase: 'blocks', status: 'error', message: 'x', elapsedMs: 8500 },
      { phase: 'mastery', courseId: 5, courseName: 'Biology 9', status: 'done', records: 7, elapsedMs: 30000 },
      { phase: 'quizzes', status: 'done', records: 2, elapsedMs: 4000 },
    ]);
    expect(phases.map((p) => p.elapsedMs)).toEqual([61000, 8500, 30000, 4000]);
  });

  it('formats a phase time: tenths under 10s, whole seconds, then minutes', () => {
    expect(formatPhaseTime(8500)).toBe('8.5s');
    expect(formatPhaseTime(400)).toBe('0.4s');
    expect(formatPhaseTime(42400)).toBe('42s');
    expect(formatPhaseTime(63000)).toBe('1m 3s');
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

  it('a blocks-phase error carries errorKind into failures (#126)', () => {
    const { failures } = reduceSyncEvents([
      { phase: 'blocks', status: 'running' },
      { phase: 'blocks', status: 'error', errorKind: 'login', message: 'Not logged in to Schoology' },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'blocks', errorKind: 'login', message: 'Not logged in to Schoology' });
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
  it('reduces the quizzes phase', () => {
    const s = reduceSyncEvents([{ phase: 'quizzes', status: 'running' }, { phase: 'quizzes', status: 'done', records: 2 }]);
    expect(s.phases).toEqual([{ key: 'quizzes', kind: 'quizzes', label: 'Quiz results', status: 'done', records: 2 }]);
  });
});
