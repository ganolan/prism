import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCardBatch } from './useCardBatch.js';
import { sendAllGrades } from '../services/api.js';

vi.mock('../services/api.js', () => ({ sendAllGrades: vi.fn() }));

const students = [
  { schoology_uid: 'u1', first_name: 'Ana', last_name: 'Lee', exception: 0 },
  { schoology_uid: 'u2', first_name: 'Ben', last_name: 'Ng', exception: 3 },
  { schoology_uid: 'u3', first_name: 'Cy', last_name: 'Wu', exception: 0 },
];
const card = (uid, { holds = false } = {}) => ({
  getEntry: vi.fn(() => ({ entry: { uid, comment: `c-${uid}` }, patch: { grade_comment: `c-${uid}` } })),
  applyResult: vi.fn(),
  holdsLevels: vi.fn(() => holds),
});

beforeEach(() => { vi.mocked(sendAllGrades).mockReset(); });

describe('useCardBatch (#200: the Grading tab and the Attempts tab each keep their own)', () => {
  test('publishAll sends only registered pending cards that are shown, and applies each result', async () => {
    const onSaved = vi.fn();
    const { result } = renderHook(() => useCardBatch({ courseId: 5, students, onSaved }));
    const c1 = card('u1'), c3 = card('u3');
    act(() => {
      result.current.registerCard('u1', c1); result.current.registerCard('u3', c3);
      result.current.onPendingChange('u1', 'publish'); result.current.onPendingChange('u3', 'publish');
    });
    vi.mocked(sendAllGrades).mockResolvedValue({ results: [{ uid: 'u1', ok: true }] });
    await act(() => result.current.publishAll((uid) => uid !== 'u3'));
    expect(sendAllGrades).toHaveBeenCalledWith(5, [{ uid: 'u1', comment: 'c-u1' }]);
    expect(c1.applyResult).toHaveBeenCalledWith(true, { uid: 'u1', ok: true });
    expect(c3.getEntry).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith('u1', expect.objectContaining({ grade_comment: 'c-u1' }));
    expect(result.current.bulkResult).toBe('Published 1 grade.');
  });

  test('a card on a final flag is named as held', async () => {
    const { result } = renderHook(() => useCardBatch({ courseId: 5, students, onSaved: vi.fn() }));
    act(() => { result.current.registerCard('u2', card('u2', { holds: true })); result.current.onPendingChange('u2', 'held'); });
    vi.mocked(sendAllGrades).mockResolvedValue({ results: [{ uid: 'u2', ok: true }] });
    await act(() => result.current.publishAll(() => true));
    expect(result.current.bulkResult).toMatch(/Levels kept as a draft until the flag is cleared: Ben Ng/);
  });

  test('a rejected batch marks every card failed and keeps them pending', async () => {
    const { result } = renderHook(() => useCardBatch({ courseId: 5, students, onSaved: vi.fn() }));
    const c1 = card('u1');
    act(() => { result.current.registerCard('u1', c1); result.current.onPendingChange('u1', 'publish'); });
    vi.mocked(sendAllGrades).mockRejectedValue(new Error('Schoology unreachable'));
    await act(() => result.current.publishAll(() => true));
    expect(c1.applyResult).toHaveBeenCalledWith(false);
    expect(result.current.bulkResult).toBe('Error: Schoology unreachable');
    expect(result.current.pendingByUid).toEqual({ u1: 'publish' });
  });
});
