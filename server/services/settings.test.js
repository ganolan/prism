import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { getTriageSettings, updateTriageSettings, TRIAGE_DEFAULTS } from './settings.js';

beforeEach(() => { getDb().exec('DELETE FROM settings;'); });

describe('triage settings', () => {
  test('defaults when nothing is stored', () => {
    expect(getTriageSettings(getDb())).toEqual({
      referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false,
      makeUpAmberDay: 2, makeUpRedDay: 4,
    });
    expect(TRIAGE_DEFAULTS.referralLimitDays).toBe(8);
  });

  test('round-trips a patch and keeps the other values', () => {
    const s = updateTriageSettings(getDb(), { referralLimitDays: 6, showFormativeDefault: true });
    expect(s).toEqual({
      referralLimitDays: 6, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: true, makeUpAmberDay: 2, makeUpRedDay: 4,
    });
    expect(getTriageSettings(getDb())).toEqual(s);
  });

  test('clamps out-of-range numbers and ignores unknown keys', () => {
    const s = updateTriageSettings(getDb(), { referralLimitDays: 0, feedbackLimitDays: 999, warnLeadDays: -2, bogus: 1 });
    expect(s).toMatchObject({ referralLimitDays: 1, feedbackLimitDays: 60, warnLeadDays: 0 });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM settings WHERE key LIKE '%bogus%'`).get().n).toBe(0);
  });

  test('make-up clock (day numbers, test day = day 1): amber 1–31, red 2–31', () => {
    expect(updateTriageSettings(getDb(), { makeUpAmberDay: 0, makeUpRedDay: 1 })).toMatchObject({ makeUpAmberDay: 1, makeUpRedDay: 2 });
    expect(updateTriageSettings(getDb(), { makeUpAmberDay: 99, makeUpRedDay: 99 })).toMatchObject({ makeUpAmberDay: 31, makeUpRedDay: 31 });
    expect(updateTriageSettings(getDb(), { makeUpAmberDay: 3, makeUpRedDay: 6 })).toMatchObject({ makeUpAmberDay: 3, makeUpRedDay: 6 });
  });

  test('make-up amber above red is clamped to red — and stored clamped', () => {
    expect(updateTriageSettings(getDb(), { makeUpAmberDay: 7, makeUpRedDay: 5 })).toMatchObject({ makeUpAmberDay: 5, makeUpRedDay: 5 });
    const stored = () => getDb().prepare(`SELECT value FROM settings WHERE key = 'triage.makeUpAmberDay'`).get().value;
    expect(stored()).toBe('5');
    // Lowering red later pulls amber down with it.
    updateTriageSettings(getDb(), { makeUpAmberDay: 4, makeUpRedDay: 6 });
    expect(updateTriageSettings(getDb(), { makeUpRedDay: 3 })).toMatchObject({ makeUpAmberDay: 3, makeUpRedDay: 3 });
    expect(stored()).toBe('3');
  });

  describe('legacy make-up keys (school days after the test) convert once to day numbers', () => {
    const put = (key, value) => getDb().prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(`triage.${key}`, value);
    const stored = (key) => getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(`triage.${key}`)?.value;

    test('old rows only → new = old + 1, persisted', () => {
      put('makeUpAmberDays', '2');
      put('makeUpRedDays', '5');
      expect(getTriageSettings(getDb())).toMatchObject({ makeUpAmberDay: 3, makeUpRedDay: 6 });
      expect(stored('makeUpAmberDay')).toBe('3');
      expect(stored('makeUpRedDay')).toBe('6');
      // Once: reading again (or a later old-row change) never re-adds.
      getDb().prepare(`UPDATE settings SET value = '9' WHERE key = 'triage.makeUpRedDays'`).run();
      expect(getTriageSettings(getDb())).toMatchObject({ makeUpAmberDay: 3, makeUpRedDay: 6 });
      expect(getTriageSettings(getDb())).not.toHaveProperty('makeUpRedDays');
    });

    test('once converted, a read executes no write (PrisMCP reads during a sync write must not hit SQLITE_BUSY)', () => {
      put('makeUpAmberDays', '1');
      put('makeUpRedDays', '3');
      getTriageSettings(getDb()); // converts
      const spy = vi.spyOn(getDb(), 'prepare');
      try {
        expect(getTriageSettings(getDb())).toMatchObject({ makeUpAmberDay: 2, makeUpRedDay: 4 });
        const sql = spy.mock.calls.map(([text]) => text);
        expect(sql.length).toBeGreaterThan(0);
        expect(sql.filter((t) => /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(t))).toEqual([]);
      } finally {
        spy.mockRestore();
      }
      // The old rows stay (rollback-safe).
      expect(stored('makeUpAmberDays')).toBe('1');
      expect(stored('makeUpRedDays')).toBe('3');
    });

    test('no legacy rows → a read executes no write', () => {
      const spy = vi.spyOn(getDb(), 'prepare');
      try {
        getTriageSettings(getDb());
        expect(spy.mock.calls.map(([t]) => t).filter((t) => /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(t))).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    test('old 0 (on the test day) becomes day 1; old defaults 1/3 become 2/4', () => {
      put('makeUpAmberDays', '0');
      put('makeUpRedDays', '3');
      expect(getTriageSettings(getDb())).toMatchObject({ makeUpAmberDay: 1, makeUpRedDay: 4 });
    });

    test('a new row already stored wins; the missing one still converts', () => {
      put('makeUpAmberDays', '1');
      put('makeUpRedDays', '3');
      put('makeUpRedDay', '7');
      expect(getTriageSettings(getDb())).toMatchObject({ makeUpAmberDay: 2, makeUpRedDay: 7 });
    });

    test('an update converts first, so a one-key patch keeps the other converted value', () => {
      put('makeUpAmberDays', '2');
      put('makeUpRedDays', '5');
      expect(updateTriageSettings(getDb(), { makeUpRedDay: 8 })).toMatchObject({ makeUpAmberDay: 3, makeUpRedDay: 8 });
    });

    test('a corrupt old value falls back to the new default and never writes', () => {
      put('makeUpRedDays', 'not json');
      const spy = vi.spyOn(getDb(), 'prepare');
      try {
        expect(getTriageSettings(getDb())).toMatchObject({ makeUpRedDay: 4 });
        expect(spy.mock.calls.map(([t]) => t).filter((t) => /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(t))).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  test('a corrupt stored value falls back to the default', () => {
    getDb().prepare(`INSERT INTO settings (key, value) VALUES ('triage.referralLimitDays', 'not json')`).run();
    expect(getTriageSettings(getDb()).referralLimitDays).toBe(8);
  });
});
