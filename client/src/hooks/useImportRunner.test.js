import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useImportRunner } from './useImportRunner.js';

const ok = (n) => ({ studentsCount: n, assignmentsCount: n, gradesCount: n });

describe('useImportRunner', () => {
  it('runs targets sequentially, recording counts and a log line each', async () => {
    const order = [];
    const importer = vi.fn(async (id) => { order.push(id); return ok(2); });
    const { result } = renderHook(() => useImportRunner({ importer }));

    await act(async () => {
      await result.current.run([
        { sectionId: 's1', title: 'Robotics' },
        { sectionId: 's2', title: 'Drama' },
      ]);
    });

    expect(order).toEqual(['s1', 's2']);
    expect(result.current.model.status).toBe('done');
    expect(result.current.model.done).toBe(2);
    expect(result.current.model.rows.every((r) => r.status === 'done')).toBe(true);
    expect(result.current.model.log).toContain('Imported Robotics (2 students, 2 grades)');
    expect(result.current.model.progress).toBe(1);
  });

  it('records a failure, continues the batch, and reports succeededIds', async () => {
    const importer = vi.fn(async (id) => { if (id === 's1') throw new Error('403'); return ok(1); });
    const onComplete = vi.fn();
    const { result } = renderHook(() => useImportRunner({ importer, onComplete }));

    await act(async () => {
      await result.current.run([
        { sectionId: 's1', title: 'Bad' },
        { sectionId: 's2', title: 'Good' },
      ]);
    });

    expect(result.current.model.failures).toEqual([{ sectionId: 's1', title: 'Bad', error: '403' }]);
    expect(result.current.model.rows[1].status).toBe('done');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ total: 2, succeeded: 1, succeededIds: ['s2'] }));
  });

  it('retryFailed re-runs only the failed sections', async () => {
    let failFirst = true;
    const importer = vi.fn(async (id) => {
      if (id === 's1' && failFirst) { failFirst = false; throw new Error('temporary'); }
      return ok(1);
    });
    const { result } = renderHook(() => useImportRunner({ importer }));

    await act(async () => {
      await result.current.run([
        { sectionId: 's1', title: 'Flaky' },
        { sectionId: 's2', title: 'Fine' },
      ]);
    });
    expect(result.current.model.failures).toHaveLength(1);

    importer.mockClear();
    await act(async () => { result.current.retryFailed(); });
    await waitFor(() => expect(result.current.model.failures).toHaveLength(0));
    expect(importer).toHaveBeenCalledTimes(1);
    expect(importer).toHaveBeenCalledWith('s1');
    expect(result.current.model.status).toBe('done');
    expect(result.current.model.failures).toHaveLength(0);
  });

  it('reset returns the model to idle', async () => {
    const { result } = renderHook(() => useImportRunner({ importer: async () => ok(1) }));
    await act(async () => { await result.current.run([{ sectionId: 's1', title: 'X' }]); });
    act(() => { result.current.reset(); });
    expect(result.current.model.status).toBe('idle');
  });

  it('handles an empty target list as an immediate no-op completion', async () => {
    const importer = vi.fn();
    const onComplete = vi.fn();
    const { result } = renderHook(() => useImportRunner({ importer, onComplete }));
    await act(async () => { await result.current.run([]); });
    expect(importer).not.toHaveBeenCalled();
    expect(result.current.model.status).toBe('done');
    expect(result.current.model.progress).toBe(1);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ total: 0, succeeded: 0, succeededIds: [] }));
  });
});
