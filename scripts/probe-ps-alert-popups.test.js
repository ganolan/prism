import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { perAlertCap, onlyKeys } from './probe-ps-alert-popups.js';

// Graham approved up to 3 students per alert (25/10/2026). The cap feeds .slice(0, n), where a
// negative n would read every holder but the last few: no value may get past 0..3.
describe('perAlertCap', () => {
  it('defaults to 3 and caps a larger value at 3', () => {
    expect(perAlertCap(undefined)).toBe(3);
    expect(perAlertCap('3')).toBe(3);
    expect(perAlertCap('10')).toBe(3);
    expect(perAlertCap('2')).toBe(2);
  });

  it('turns a negative or non-numeric value into 0, never a bypass of the cap', () => {
    expect(perAlertCap('-5')).toBe(0);
    expect(perAlertCap('abc')).toBe(0);
    expect(perAlertCap('')).toBe(0);
  });
});

it('--only keeps the named keys and never a family alert (#202)', () => {
  const defs = [{ key: 'epipen', category: 'health' }, { key: 'divorced', category: 'family' }];
  expect(onlyKeys(undefined, defs)).toBeNull();
  expect([...onlyKeys('epipen, divorced,,ilp', defs)]).toEqual(['epipen', 'ilp']);
});

