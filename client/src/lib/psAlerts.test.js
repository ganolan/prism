import { describe, it, expect, beforeEach, vi } from 'vitest';
import { forRoster, getRosterAlertsShown, setRosterAlertsShown } from './psAlerts.js';

describe('psAlerts (#117)', () => {
  beforeEach(() => localStorage.clear());

  it('forRoster keeps learning, health and other alerts, never family ones', () => {
    const alerts = [
      { key: 'ilp', category: 'learning' }, { key: 'epipen', category: 'health' },
      { key: 'no_photo', category: 'other' }, { key: 'siblings', category: 'family' }, { key: 'divorced', category: 'family' },
    ];
    expect(forRoster(alerts).map((a) => a.key)).toEqual(['ilp', 'epipen', 'no_photo']);
    expect(forRoster(undefined)).toEqual([]);
  });

  it('the roster choice is off until set, then remembered', () => {
    expect(getRosterAlertsShown()).toBe(false);
    setRosterAlertsShown(true);
    expect(getRosterAlertsShown()).toBe(true);
    setRosterAlertsShown(false);
    expect(getRosterAlertsShown()).toBe(false);
  });

  it('storage that throws reads as off and never throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      expect(getRosterAlertsShown()).toBe(false);
      expect(() => setRosterAlertsShown(true)).not.toThrow();
    } finally { get.mockRestore(); set.mockRestore(); }
  });
});
