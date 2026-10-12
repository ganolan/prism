import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAttemptLinks } from './useAttemptLinks.js';
import { getAttemptLinks } from '../services/api.js';

vi.mock('../services/api.js', () => ({ getAttemptLinks: vi.fn() }));

const A = { 1: { url: 'https://schoology.hkis.edu.hk/a', completedAt: '2026-10-09 09:31' } };

beforeEach(() => vi.clearAllMocks());

describe('useAttemptLinks', () => {
  it('returns the links for the assignment once loaded', async () => {
    getAttemptLinks.mockResolvedValueOnce({ links: A });
    const { result } = renderHook(() => useAttemptLinks({ assignmentId: 'a' }));
    expect(result.current).toEqual({});
    await waitFor(() => expect(result.current).toEqual(A));
    expect(getAttemptLinks).toHaveBeenCalledWith({ assignmentId: 'a' });
  });

  it('asks by student when given a studentId', async () => {
    getAttemptLinks.mockResolvedValueOnce({ links: { a1: { url: 'https://x.example/1' } } });
    const { result } = renderHook(() => useAttemptLinks({ studentId: 5 }));
    await waitFor(() => expect(result.current).toEqual({ a1: { url: 'https://x.example/1' } }));
    expect(getAttemptLinks).toHaveBeenCalledWith({ studentId: 5 });
  });

  it('drops the previous assignment\'s links the moment the assignment changes, even if the new fetch never resolves', async () => {
    getAttemptLinks.mockResolvedValueOnce({ links: A }).mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(({ id }) => useAttemptLinks({ assignmentId: id }), { initialProps: { id: 'a' } });
    await waitFor(() => expect(result.current).toEqual(A));
    rerender({ id: 'b' });
    expect(result.current).toEqual({});
  });

  it('ignores a response for a superseded assignment', async () => {
    let resolveA;
    getAttemptLinks.mockImplementationOnce(() => new Promise(r => { resolveA = r; })).mockResolvedValueOnce({ links: {} });
    const { result, rerender } = renderHook(({ id }) => useAttemptLinks({ assignmentId: id }), { initialProps: { id: 'a' } });
    rerender({ id: 'b' });
    await waitFor(() => expect(getAttemptLinks).toHaveBeenCalledTimes(2));
    resolveA({ links: A });
    await new Promise(r => setTimeout(r, 0));
    expect(result.current).toEqual({});
  });

  it('degrades to {} when the call returns undefined (automocked api) or throws', async () => {
    getAttemptLinks.mockReturnValueOnce(undefined);
    const { result, rerender } = renderHook(({ id }) => useAttemptLinks({ assignmentId: id }), { initialProps: { id: 'a' } });
    await waitFor(() => expect(getAttemptLinks).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual({});
    getAttemptLinks.mockImplementationOnce(() => { throw new Error('boom'); });
    rerender({ id: 'b' });
    await waitFor(() => expect(getAttemptLinks).toHaveBeenCalledTimes(2));
    expect(result.current).toEqual({});
  });

  it('makes no call without an id', () => {
    const { result } = renderHook(() => useAttemptLinks({}));
    expect(getAttemptLinks).not.toHaveBeenCalled();
    expect(result.current).toEqual({});
  });
});
