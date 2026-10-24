import { describe, it, expect } from 'vitest';
import { forRoster } from './psAlerts.js';

describe('psAlerts (#117)', () => {
  it('forRoster keeps learning, health and other alerts, never family ones', () => {
    const alerts = [
      { key: 'ilp', category: 'learning' }, { key: 'epipen', category: 'health' },
      { key: 'no_photo', category: 'other' }, { key: 'siblings', category: 'family' }, { key: 'divorced', category: 'family' },
    ];
    expect(forRoster(alerts).map((a) => a.key)).toEqual(['ilp', 'epipen', 'no_photo']);
    expect(forRoster(undefined)).toEqual([]);
  });
});
