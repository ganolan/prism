import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCardEditing } from './useCardEditing.js';
import { getSettings } from '../services/api.js';

vi.mock('../services/api.js', () => ({ getSettings: vi.fn().mockResolvedValue({ triage: { resubmitLessonsDefault: 4 } }) }));

const card = (comment) => ({ assignment: { id: 1 }, student: { id: 7, grade_comment: comment }, draft: null });

beforeEach(() => vi.clearAllMocks());

describe('useCardEditing', () => {
  it('Edit reads the task first; Done leaves edit mode and calls onChange', async () => {
    const fresh = card('fresh');
    const refetchOne = vi.fn().mockResolvedValue(fresh);
    const onChange = vi.fn();
    const { result } = renderHook(() => useCardEditing({ cards: { a1: card('old') }, refetchOne, onChange }));
    await act(async () => { await result.current.startEdit('a1'); });
    expect(refetchOne).toHaveBeenCalledWith('a1');
    expect(result.current.isEditing('a1')).toBe(true);
    expect(result.current.resubmitLessons).toBe(4);
    expect(getSettings).toHaveBeenCalledTimes(1);
    await act(async () => { result.current.finishEdit('a1'); });
    expect(result.current.isEditing('a1')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('a failed read on Edit stays read-only with an error', async () => {
    const refetchOne = vi.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useCardEditing({ cards: { a1: card('old') }, refetchOne }));
    await act(async () => { await result.current.startEdit('a1'); });
    expect(result.current.isEditing('a1')).toBe(false);
    expect(result.current.editError('a1')).toBe('Could not load this task. Reload the page.');
  });

  it('a saved patch shows over its card until a newer card arrives', async () => {
    const refetchOne = vi.fn().mockReturnValue(new Promise(() => {}));
    const first = card('old');
    const { result, rerender } = renderHook(({ cards }) => useCardEditing({ cards, refetchOne }), { initialProps: { cards: { a1: first } } });
    act(() => { result.current.saved('a1', { grade_comment: 'published' }); });
    expect(refetchOne).toHaveBeenCalledWith('a1');
    expect(result.current.card('a1').student.grade_comment).toBe('published');
    rerender({ cards: { a1: card('from the server') } });
    expect(result.current.card('a1').student.grade_comment).toBe('from the server');
  });

  it('refreshTask reads the task and calls onChange, resolving to the fresh student', async () => {
    const refetchOne = vi.fn().mockResolvedValue(card('fresh'));
    const onChange = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useCardEditing({ cards: {}, refetchOne, onChange }));
    let student;
    await act(async () => { student = await result.current.refreshTask('a1'); });
    expect(student.grade_comment).toBe('fresh');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
