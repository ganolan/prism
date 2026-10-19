import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useMasteryRefresh } from './useMasteryRefresh.js';

describe('useMasteryRefresh (#52)', () => {
  it('refreshes once per key; reloads the page\'s mastery only when Schoology was read', async () => {
    const refresh = vi.fn(async () => ({ refreshed: true, syncedAt: '2026-10-19T06:00:00.000Z' }));
    const onRefreshed = vi.fn();
    const { result, rerender } = renderHook(({ k }) => useMasteryRefresh(k, refresh, onRefreshed), { initialProps: { k: 5 } });
    expect(result.current.status).toBe('refreshing');
    await waitFor(() => expect(result.current).toEqual({ status: 'done', syncedAt: '2026-10-19T06:00:00.000Z', error: null, signIn: false }));
    expect(onRefreshed).toHaveBeenCalledTimes(1);
    rerender({ k: 5 });
    expect(refresh).toHaveBeenCalledTimes(1);
    refresh.mockResolvedValueOnce({ refreshed: false, syncedAt: '2026-10-19T06:01:00.000Z' });
    rerender({ k: 6 });
    await waitFor(() => expect(result.current.syncedAt).toBe('2026-10-19T06:01:00.000Z'));
    expect(onRefreshed).toHaveBeenCalledTimes(1);
  });

  it('a null key waits: nothing is asked', () => {
    const refresh = vi.fn();
    const { result } = renderHook(() => useMasteryRefresh(null, refresh, vi.fn()));
    expect(result.current.status).toBe('idle');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a failed refresh reports the error and signIn; a request that throws is an error too', async () => {
    const { result } = renderHook(() => useMasteryRefresh(1, async () => ({ refreshed: false, syncedAt: 'x', error: 'Log in', signIn: true }), vi.fn()));
    await waitFor(() => expect(result.current).toEqual({ status: 'error', syncedAt: 'x', error: 'Log in', signIn: true }));
    const thrown = renderHook(() => useMasteryRefresh(2, async () => { throw new Error('offline'); }, vi.fn()));
    await waitFor(() => expect(thrown.result.current).toMatchObject({ status: 'error', error: 'offline' }));
  });
});
