import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useGradeCards } from './useGradeCards.js';
import { getGradeCards } from '../services/api.js';

vi.mock('../services/api.js', () => ({ getGradeCards: vi.fn() }));

const COURSE = { id: 7, archived: false, excluded: false, writable: true };
const card = (aid, extra = {}) => ({ assignment: { id: aid }, topics: [], rubric: null, draft: null, hasDraft: false, ...extra });
const ALL = { course: COURSE, cards: { a1: card('a1'), a2: card('a2') } };

beforeEach(() => vi.clearAllMocks());

describe('useGradeCards', () => {
  it('loads a course\'s cards when enabled', async () => {
    getGradeCards.mockResolvedValueOnce(ALL);
    const { result } = renderHook(() => useGradeCards({ studentId: 5, courseId: 7, enabled: true }));
    expect(result.current.loading).toBe(true);
    expect(result.current.cards).toEqual({});
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.cards).toEqual(ALL.cards);
    expect(result.current.course).toEqual(COURSE);
    expect(result.current.error).toBeNull();
    expect(getGradeCards).toHaveBeenCalledWith(5, { courseId: 7 });
  });

  it('does nothing while disabled', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useGradeCards({ studentId: 5, courseId: 7, enabled }), { initialProps: { enabled: false } });
    await new Promise((r) => setTimeout(r, 0));
    expect(getGradeCards).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ cards: {}, course: null, loading: false, error: null });
    getGradeCards.mockResolvedValueOnce(ALL);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.cards).toEqual(ALL.cards));
  });

  it('refetchOne replaces one card and returns it', async () => {
    getGradeCards.mockResolvedValueOnce(ALL);
    const { result } = renderHook(() => useGradeCards({ studentId: 5, courseId: 7, enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const fresh = card('a2', { hasDraft: true });
    getGradeCards.mockResolvedValueOnce({ course: { ...COURSE, archived: true }, cards: { a2: fresh } });
    let returned;
    await act(async () => { returned = await result.current.refetchOne('a2'); });
    expect(getGradeCards).toHaveBeenLastCalledWith(5, { courseId: 7, assignmentId: 'a2' });
    expect(returned).toEqual(fresh);
    expect(result.current.cards).toEqual({ a1: ALL.cards.a1, a2: fresh });
    expect(result.current.course.archived).toBe(true);
  });

  it('reloadKey refetches without blanking the cards', async () => {
    getGradeCards.mockResolvedValueOnce(ALL);
    const { result, rerender } = renderHook(({ k }) => useGradeCards({ studentId: 5, courseId: 7, enabled: true, reloadKey: k }), { initialProps: { k: 0 } });
    await waitFor(() => expect(result.current.cards).toEqual(ALL.cards));
    const next = { course: COURSE, cards: { a1: card('a1', { hasDraft: true }) } };
    getGradeCards.mockReturnValueOnce(new Promise(() => {}));
    rerender({ k: 1 });
    expect(result.current.cards).toEqual(ALL.cards);
    getGradeCards.mockResolvedValueOnce(next);
    rerender({ k: 2 });
    await waitFor(() => expect(result.current.cards).toEqual(next.cards));
    expect(getGradeCards).toHaveBeenCalledTimes(3);
  });

  it('drops the previous course\'s cards when the course changes and ignores a superseded response', async () => {
    let resolveFirst;
    getGradeCards.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; })).mockResolvedValueOnce({ course: { ...COURSE, id: 8 }, cards: { b1: card('b1') } });
    const { result, rerender } = renderHook(({ c }) => useGradeCards({ studentId: 5, courseId: c, enabled: true }), { initialProps: { c: 7 } });
    rerender({ c: 8 });
    await waitFor(() => expect(result.current.cards).toEqual({ b1: card('b1') }));
    resolveFirst(ALL);
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.cards).toEqual({ b1: card('b1') });
  });

  it('reports a failed load as error and keeps going', async () => {
    getGradeCards.mockRejectedValueOnce(new Error('Student not found'));
    const { result } = renderHook(() => useGradeCards({ studentId: 5, courseId: 7, enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Student not found');
    expect(result.current.cards).toEqual({});
  });
});
