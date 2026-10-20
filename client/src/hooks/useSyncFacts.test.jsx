import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSyncFacts } from './useSyncFacts.js';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({ getSyncStatus: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); });

describe('useSyncFacts', () => {
  it('fetches the status on mount and exposes its parts', async () => {
    api.getSyncStatus.mockResolvedValue({ nightlyData: { readAt: null, nightly: true }, pastImport: { state: 'none', done: 0, total: 0 } });
    const { result } = renderHook(() => useSyncFacts());
    await waitFor(() => expect(result.current.nightlyData).toEqual({ readAt: null, nightly: true }));
    expect(result.current.pastImport).toEqual({ state: 'none', done: 0, total: 0 });
  });

  it('final review #9: an older answer that arrives late never overwrites a newer one', async () => {
    const answers = [];
    api.getSyncStatus.mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    const { result } = renderHook(() => useSyncFacts());
    await waitFor(() => expect(answers).toHaveLength(1)); // the mount fetch, still waiting
    act(() => { result.current.reload(); });
    expect(answers).toHaveLength(2);
    await act(async () => { answers[1]({ pastImport: { state: 'importing', done: 3, total: 9 } }); });
    expect(result.current.pastImport).toEqual({ state: 'importing', done: 3, total: 9 });
    await act(async () => { answers[0]({ pastImport: { state: 'waiting', done: 0, total: 0 } }); });
    expect(result.current.pastImport).toEqual({ state: 'importing', done: 3, total: 9 });
  });
});
