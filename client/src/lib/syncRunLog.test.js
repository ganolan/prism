import { describe, it, expect } from 'vitest';
import { runStatus, formatDuration, describeOptions, describeRunEvent } from './syncRunLog.js';

describe('runStatus', () => {
  it('labels each status with a badge colour', () => {
    expect(runStatus({ status: 'completed', error_count: 0 })).toEqual({ label: 'Completed', badge: 'badge-green' });
    expect(runStatus({ status: 'completed_with_errors', error_count: 1 })).toEqual({ label: 'Completed with 1 error', badge: 'badge-amber' });
    expect(runStatus({ status: 'completed_with_errors', error_count: 3 }).label).toBe('Completed with 3 errors');
    expect(runStatus({ status: 'failed' })).toEqual({ label: 'Failed', badge: 'badge-red' });
    expect(runStatus({ status: 'interrupted' })).toEqual({ label: 'Interrupted', badge: 'badge-gray' });
    expect(runStatus({ status: 'running' })).toEqual({ label: 'Running…', badge: 'badge-blue' });
  });
});

describe('formatDuration', () => {
  it('seconds under a minute, minutes + seconds above', () => {
    expect(formatDuration('2026-10-01T10:00:00Z', '2026-10-01T10:00:42Z')).toBe('42s');
    expect(formatDuration('2026-10-01T10:00:00Z', '2026-10-01T10:03:05Z')).toBe('3m 5s');
    expect(formatDuration('2026-10-01T10:00:00Z', null)).toBe('');
  });

  it('hours + minutes past an hour', () => {
    expect(formatDuration('2026-10-01T10:00:00Z', '2026-10-01T11:12:40Z')).toBe('1h 12m');
    expect(formatDuration('2026-10-01T10:00:00Z', '2026-10-01T12:00:05Z')).toBe('2h 0m');
  });
});

describe('describeOptions', () => {
  it('summarises what the run synced', () => {
    expect(describeOptions({ skipSchoology: false, syncBlocks: true, masteryCourseIds: [1, 2] }))
      .toBe('Schoology · blocks · 2 mastery courses');
    expect(describeOptions({ skipSchoology: false, recentOnly: true, recentDays: 14, syncBlocks: false, masteryCourseIds: [] }))
      .toBe('Schoology (last 14 days)');
    expect(describeOptions({ skipSchoology: true, syncBlocks: false, masteryCourseIds: [5] })).toBe('1 mastery course');
    expect(describeOptions(null)).toBe('');
    expect(describeOptions({ trigger: 'scheduled', skipSchoology: false, syncBlocks: true, masteryCourseIds: [1] }))
      .toBe('Scheduled · Schoology · blocks · 1 mastery course');
  });
});

describe('describeRunEvent', () => {
  it('phase rows: icon, label, outcome', () => {
    expect(describeRunEvent({ phase: 'schoology', status: 'done', records: 12 }))
      .toMatchObject({ icon: '✓', text: 'Schoology data: 12 records', level: null });
    expect(describeRunEvent({ phase: 'mastery', courseName: 'Bio', status: 'error', message: 'boom', level: 'error' }))
      .toMatchObject({ icon: '✕', text: 'Mastery · Bio: boom', level: 'error' });
    expect(describeRunEvent({ phase: 'blocks', status: 'running' })).toMatchObject({ icon: '●', text: 'PowerSchool blocks: started' });
    expect(describeRunEvent({ phase: 'blocks', status: 'done', records: 3, notReady: 2, level: 'warning' }))
      .toMatchObject({ text: 'PowerSchool blocks: 3 records, 2 not yet published in PowerSchool', level: 'warning' });
  });

  it('log, error and summary lines', () => {
    expect(describeRunEvent({ type: 'log', message: 'hi' })).toMatchObject({ icon: '', text: 'hi', level: null });
    expect(describeRunEvent({ type: 'log', message: 'Warning: x', level: 'warning' })).toMatchObject({ level: 'warning' });
    expect(describeRunEvent({ type: 'error', message: 'kaput', level: 'error' })).toMatchObject({ icon: '✕', text: 'kaput', level: 'error' });
    expect(describeRunEvent({ type: 'summary', elapsedMs: 63000 })).toMatchObject({ text: 'Finished in 1m 3s' });
    expect(describeRunEvent({ type: 'summary', elapsedMs: 2000, fatal: true }).text).toBe('Stopped after 2s');
  });

  it('skips the stream-only run marker', () => {
    expect(describeRunEvent({ type: 'run', runId: 1 })).toBe(null);
  });
});
