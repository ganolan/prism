import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { perAlertCap } from './probe-ps-alert-popups.js';

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
