import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePrivateDetails, getPrivateDetails, setPrivateDetails } from './privateDetails.js';

// #160: one switch for everything private on the roster, remembered on the device, default off.
describe('privateDetails', () => {
  beforeEach(() => { localStorage.clear(); setPrivateDetails(false); localStorage.clear(); });

  it('privateDetails defaults off and survives a localStorage that throws', () => {
    expect(getPrivateDetails()).toBe(false);
    const { result } = renderHook(() => usePrivateDetails());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem('prism:private-details')).toBe('true');

    const get = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      // Unreadable storage reads as off; a write that throws still works for this page.
      expect(getPrivateDetails()).toBe(false);
      const { result: blocked } = renderHook(() => usePrivateDetails());
      expect(blocked.current[0]).toBe(false);
      expect(() => act(() => blocked.current[1](true))).not.toThrow();
      expect(blocked.current[0]).toBe(true);
    } finally {
      get.mockRestore(); set.mockRestore();
      act(() => setPrivateDetails(false));
    }
  });

  it('is remembered for a later visit, under one key for every course', () => {
    setPrivateDetails(true);
    const { result } = renderHook(() => usePrivateDetails());
    expect(result.current[0]).toBe(true);
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe('prism:private-details');
  });

  it('every component using it sees the same switch', () => {
    const a = renderHook(() => usePrivateDetails());
    const b = renderHook(() => usePrivateDetails());
    act(() => a.result.current[1](true));
    expect(b.result.current[0]).toBe(true);
    act(() => b.result.current[1](false));
    expect(a.result.current[0]).toBe(false);
  });
});
