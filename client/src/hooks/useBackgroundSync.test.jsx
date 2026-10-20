import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useBackgroundSync } from './useBackgroundSync.js';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  ensureSync: vi.fn(),
  getCurrentSync: vi.fn(),
  getSyncRun: vi.fn(),
}));

const idleQueue = { running: null, runId: null, queued: [], held: [] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useBackgroundSync', () => {
  it('fresh scope: nothing to follow', async () => {
    api.ensureSync.mockResolvedValue({ state: 'fresh' });
    const { result } = renderHook(() => useBackgroundSync({ kind: 'courses', courseIds: [5] }, { pollMs: 5 }));
    await waitFor(() => expect(result.current.state).toBe('fresh'));
    expect(api.getCurrentSync).not.toHaveBeenCalled();
  });

  it('a queued sync: waiting, then syncing, then done (and onDone reloads the page)', async () => {
    api.ensureSync.mockResolvedValue({ state: 'queued', runId: 9 });
    api.getCurrentSync
      .mockResolvedValueOnce({ ...idleQueue, running: { runId: 3 }, runId: 3, queued: [{ runId: 9 }] })
      .mockResolvedValueOnce({ ...idleQueue, running: { runId: 9 }, runId: 9 })
      .mockResolvedValue(idleQueue);
    api.getSyncRun.mockResolvedValue({ id: 9, status: 'completed' });
    const onDone = vi.fn();
    // Each poll answer holds for 150 ms, so every state can be seen.
    const { result } = renderHook(() => useBackgroundSync({ kind: 'courses', courseIds: [5] }, { onDone, pollMs: 150 }));
    await waitFor(() => expect(result.current.state).toBe('queued'));
    await waitFor(() => expect(result.current.state).toBe('running'));
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(result.current.runId).toBe(9);
    expect(onDone).toHaveBeenCalledWith('completed', 9);
  });

  it('a failed run: failed; a held run: held', async () => {
    api.ensureSync.mockResolvedValue({ state: 'running', runId: 9 });
    api.getCurrentSync.mockResolvedValue(idleQueue);
    api.getSyncRun.mockResolvedValue({ id: 9, status: 'completed_with_errors' });
    const { result, rerender } = renderHook(({ scope }) => useBackgroundSync(scope, { pollMs: 5 }), { initialProps: { scope: { kind: 'courses', courseIds: [5] } } });
    await waitFor(() => expect(result.current.state).toBe('failed'));
    api.ensureSync.mockResolvedValue({ state: 'queued', runId: 10 });
    api.getCurrentSync.mockResolvedValue({ ...idleQueue, held: [{ runId: 10 }] });
    rerender({ scope: { kind: 'courses', courseIds: [6] } });
    await waitFor(() => expect(result.current.state).toBe('held'));
  });

  it('follow(runId) tracks a run a button started', async () => {
    api.ensureSync.mockResolvedValue({ state: 'fresh' });
    api.getCurrentSync.mockResolvedValue({ ...idleQueue, running: { runId: 12 }, runId: 12 });
    const { result } = renderHook(() => useBackgroundSync({ kind: 'task', courseId: 5, assignmentId: 'A' }, { pollMs: 5 }));
    await waitFor(() => expect(result.current.state).toBe('fresh'));
    act(() => { result.current.follow(12); }); // follow keeps polling: never hand its promise to act
    await waitFor(() => expect(result.current).toMatchObject({ state: 'running', runId: 12 }));
  });

  it('no scope (archived, not loaded yet): idle, no request', async () => {
    const { result } = renderHook(() => useBackgroundSync(null, { pollMs: 5 }));
    expect(result.current.state).toBe('idle');
    await new Promise((r) => setTimeout(r, 20));
    expect(api.ensureSync).not.toHaveBeenCalled();
  });
});
