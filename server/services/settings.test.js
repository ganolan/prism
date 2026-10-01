import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { getTriageSettings, updateTriageSettings, TRIAGE_DEFAULTS } from './settings.js';

beforeEach(() => { getDb().exec('DELETE FROM settings;'); });

describe('triage settings', () => {
  test('defaults when nothing is stored', () => {
    expect(getTriageSettings(getDb())).toEqual({
      referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false,
    });
    expect(TRIAGE_DEFAULTS.referralLimitDays).toBe(8);
  });

  test('round-trips a patch and keeps the other values', () => {
    const s = updateTriageSettings(getDb(), { referralLimitDays: 6, showFormativeDefault: true });
    expect(s).toEqual({ referralLimitDays: 6, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: true });
    expect(getTriageSettings(getDb())).toEqual(s);
  });

  test('clamps out-of-range numbers and ignores unknown keys', () => {
    const s = updateTriageSettings(getDb(), { referralLimitDays: 0, feedbackLimitDays: 999, warnLeadDays: -2, bogus: 1 });
    expect(s).toMatchObject({ referralLimitDays: 1, feedbackLimitDays: 60, warnLeadDays: 0 });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM settings WHERE key LIKE '%bogus%'`).get().n).toBe(0);
  });

  test('a corrupt stored value falls back to the default', () => {
    getDb().prepare(`INSERT INTO settings (key, value) VALUES ('triage.referralLimitDays', 'not json')`).run();
    expect(getTriageSettings(getDb()).referralLimitDays).toBe(8);
  });
});
