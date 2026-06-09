import { describe, test, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useProficiencyScale } from './useProficiencyScale.js';
import * as api from '../services/api.js';

test('loads and binds the scale', async () => {
  vi.spyOn(api, 'getProficiencyScale').mockResolvedValue({
    schoologyScaleId: 21337256,
    levels: [
      { code: 'ED', label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' },
      { code: 'EX', label: 'Exhibiting', points: 75, gradeScaled: '62.50' },
      { code: 'IE', label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' },
    ],
  });
  const { result } = renderHook(() => useProficiencyScale());
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.pointsToLevel(80)).toBe('EX');
  expect(result.current.levelToPoints('EX')).toBe(75);
});
