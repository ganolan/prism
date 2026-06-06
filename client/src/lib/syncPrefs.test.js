import { describe, it, expect, beforeEach } from 'vitest';
import { getSyncPrefs, setSyncPrefs, clampDays } from './syncPrefs.js';

beforeEach(() => localStorage.clear());

describe('getSyncPrefs', () => {
  it('returns the defaults (off / 30) when nothing is stored', () => {
    expect(getSyncPrefs()).toEqual({ recentOnly: false, recentDays: 30 });
  });

  it('reads back a stored pref, clamping the day value', () => {
    setSyncPrefs({ recentOnly: true, recentDays: 9999 });
    expect(getSyncPrefs()).toEqual({ recentOnly: true, recentDays: 365 });
  });

  it('falls back to the default day window when the stored value is non-numeric', () => {
    localStorage.setItem('prism:sync:recent-days', 'corrupt');
    expect(getSyncPrefs().recentDays).toBe(30);
  });

  it('reads recentOnly false back from a stored "false"', () => {
    setSyncPrefs({ recentOnly: false, recentDays: 30 });
    expect(getSyncPrefs().recentOnly).toBe(false);
  });
});

describe('setSyncPrefs', () => {
  it('round-trips through localStorage', () => {
    setSyncPrefs({ recentOnly: true, recentDays: 45 });
    expect(getSyncPrefs()).toEqual({ recentOnly: true, recentDays: 45 });
  });
});

describe('clampDays', () => {
  it('floors and clamps into 1..365, defaulting on non-numbers', () => {
    expect(clampDays(45)).toBe(45);
    expect(clampDays(0)).toBe(1);
    expect(clampDays(500)).toBe(365);
    expect(clampDays('x')).toBe(30);
  });
});
