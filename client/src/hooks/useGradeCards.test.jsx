import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useGradeCards } from './useGradeCards.js';
import { getGradeCards } from '../services/api.js';

vi.mock('../services/api.js', () => ({ getGradeCards: vi.fn() }));

const COURSE = { id: 7, archived: false, excluded: false, writable: true };
const card = (aid, extra = {}) => ({ assignment: { id: aid }, topics: [], rubric: null, draft: null, hasDraft: false, ...extra });
const ALL = { course: COURSE, cards: { a1: card('a1'), a2: card('a2') } };

beforeEach(() => { vi.clearAllMocks(); getGradeCards.mockReset(); });

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

  it('with assignmentId loads that one card, not the course\'s (the gradebook pop-up)', async () => {
    getGradeCards.mockResolvedValueOnce({ course: COURSE, cards: { a2: card('a2') } });
    const { result, rerender } = renderHook(({ aid }) => useGradeCards({ studentId: 5, courseId: 7, assignmentId: aid }), { initialProps: { aid: 'a2' } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getGradeCards).toHaveBeenCalledWith(5, { courseId: 7, assignmentId: 'a2' });
    expect(result.current.cards).toEqual({ a2: card('a2') });
    // Another task is another key: its cards never show the previous task's.
    getGradeCards.mockReturnValueOnce(new Promise(() => {}));
    rerender({ aid: 'a1' });
    expect(result.current).toMatchObject({ cards: {}, loading: true });
    await waitFor(() => expect(getGradeCards).toHaveBeenLastCalledWith(5, { courseId: 7, assignmentId: 'a1' }));
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

  describe('overlapping requests', () => {
    const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const render = (initial = {}) => renderHook((p) => useGradeCards({ studentId: 5, courseId: 7, enabled: true, ...p }), { initialProps: initial });
    const oneCard = (aid, extra) => ({ course: COURSE, cards: { [aid]: card(aid, extra) } });

    it('a late refetchOne is dropped after a reloadKey full load has been issued, but still resolves its card', async () => {
      getGradeCards.mockResolvedValueOnce(ALL);
      const { result, rerender } = render({ reloadKey: 0 });
      await waitFor(() => expect(result.current.loading).toBe(false));
      const single = deferred();
      getGradeCards.mockReturnValueOnce(single.promise);
      let returned;
      const p = act(async () => { returned = result.current.refetchOne('a2'); await tick(); });
      await p;
      const reloaded = { course: COURSE, cards: { a1: card('a1'), a2: card('a2', { hasDraft: true, draft: { v: 'new' } }) } };
      getGradeCards.mockResolvedValueOnce(reloaded);
      rerender({ reloadKey: 1 });
      await waitFor(() => expect(result.current.cards).toEqual(reloaded.cards));
      single.resolve(oneCard('a2', { draft: { v: 'old' } }));
      await act(async () => { await returned; });
      expect(result.current.cards).toEqual(reloaded.cards);
      expect((await returned).draft).toEqual({ v: 'old' });
    });

    it('a late refetchOne is dropped after the course changes', async () => {
      getGradeCards.mockResolvedValueOnce(ALL);
      const { result, rerender } = render({ courseId: 7 });
      await waitFor(() => expect(result.current.loading).toBe(false));
      const single = deferred();
      getGradeCards.mockReturnValueOnce(single.promise);
      let returned;
      await act(async () => { returned = result.current.refetchOne('a2'); await tick(); });
      const other = { course: { ...COURSE, id: 8 }, cards: { b1: card('b1') } };
      getGradeCards.mockResolvedValueOnce(other);
      rerender({ courseId: 8 });
      await waitFor(() => expect(result.current.cards).toEqual(other.cards));
      single.resolve(oneCard('a2'));
      await act(async () => { await returned; });
      expect(result.current.cards).toEqual(other.cards);
      expect(result.current.course.id).toBe(8);
    });

    it('ignores a superseded full-load response when the course is unchanged', async () => {
      const first = deferred();
      getGradeCards.mockReturnValueOnce(first.promise);
      const { result, rerender } = render({ reloadKey: 0 });
      const second = { course: COURSE, cards: { a1: card('a1', { hasDraft: true }) } };
      getGradeCards.mockResolvedValueOnce(second);
      rerender({ reloadKey: 1 });
      await waitFor(() => expect(result.current.cards).toEqual(second.cards));
      first.resolve(ALL);
      await act(tick);
      expect(result.current.cards).toEqual(second.cards);
    });

    it('for one task the newest refetchOne wins when answers arrive out of order', async () => {
      getGradeCards.mockResolvedValueOnce(ALL);
      const { result } = render();
      await waitFor(() => expect(result.current.loading).toBe(false));
      const older = deferred();
      const newer = deferred();
      getGradeCards.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      let p1, p2;
      await act(async () => { p1 = result.current.refetchOne('a2'); p2 = result.current.refetchOne('a2'); await tick(); });
      newer.resolve(oneCard('a2', { draft: { v: 'newer' } }));
      await act(async () => { await p2; });
      older.resolve(oneCard('a2', { draft: { v: 'older' } }));
      await act(async () => { await p1; });
      expect(result.current.cards.a2.draft).toEqual({ v: 'newer' });
      expect((await p1).draft).toEqual({ v: 'older' });
    });

    it('a full load issued before a refetchOne does not overwrite the newer card when it lands later', async () => {
      const full = deferred();
      getGradeCards.mockReturnValueOnce(full.promise);
      const { result } = render();
      await act(tick); // the full load has asked by now
      expect(getGradeCards).toHaveBeenCalledTimes(1);
      const single = deferred();
      getGradeCards.mockReturnValueOnce(single.promise);
      let p;
      await act(async () => { p = result.current.refetchOne('a2'); await tick(); });
      // The single answer lands first, but there is no snapshot to merge into yet.
      single.resolve(oneCard('a2', { draft: { v: 'post-write' } }));
      await act(async () => { await p; });
      full.resolve({ course: COURSE, cards: { a1: card('a1'), a2: card('a2', { draft: { v: 'pre-write' } }) } });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.cards.a1).toEqual(card('a1'));
      expect(result.current.cards.a2.draft).toEqual({ v: 'post-write' });
    });

    it('a refetchOne that lands after a loaded snapshot but before a slower earlier full load keeps its card', async () => {
      getGradeCards.mockResolvedValueOnce(ALL);
      const { result, rerender } = render({ reloadKey: 0 });
      await waitFor(() => expect(result.current.loading).toBe(false));
      const full = deferred();
      getGradeCards.mockReturnValueOnce(full.promise);
      rerender({ reloadKey: 1 });
      await act(tick); // the reload has asked by now
      expect(getGradeCards).toHaveBeenCalledTimes(2);
      const single = deferred();
      getGradeCards.mockReturnValueOnce(single.promise);
      let p;
      await act(async () => { p = result.current.refetchOne('a2'); await tick(); });
      single.resolve(oneCard('a2', { draft: { v: 'post-write' } }));
      await act(async () => { await p; });
      expect(result.current.cards.a2.draft).toEqual({ v: 'post-write' });
      full.resolve({ course: COURSE, cards: { a1: card('a1'), a2: card('a2', { draft: { v: 'pre-write' } }) } });
      await act(tick);
      expect(result.current.cards.a2.draft).toEqual({ v: 'post-write' });
    });

    it('a successful refetchOne clears a reload error', async () => {
      getGradeCards.mockResolvedValueOnce(ALL).mockRejectedValueOnce(new Error('boom'));
      const { result, rerender } = render({ reloadKey: 0 });
      await waitFor(() => expect(result.current.loading).toBe(false));
      rerender({ reloadKey: 1 });
      await waitFor(() => expect(result.current.error).toBe('boom'));
      getGradeCards.mockResolvedValueOnce(oneCard('a2', { hasDraft: true }));
      await act(async () => { await result.current.refetchOne('a2'); });
      expect(result.current.error).toBeNull();
      expect(result.current.cards.a2.hasDraft).toBe(true);
    });
  });
});
