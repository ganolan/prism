import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { updateSyncScheduleSettings } from './settings.js';
import { NIGHTLY_DATA_KEY, recordNightlyDataRead, nightlyDataStatus } from './nightlyData.js';

let db;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
});

describe('nightly data stamp', () => {
  test('no stamp yet: readAt is null', () => {
    expect(nightlyDataStatus(db, { schedulerActive: true }).readAt).toBeNull();
  });

  test('recordNightlyDataRead then nightlyDataStatus returns that readAt; a later read replaces it', () => {
    recordNightlyDataRead(db, '2026-10-20T03:00:00.000Z');
    expect(nightlyDataStatus(db, { schedulerActive: true }).readAt).toBe('2026-10-20T03:00:00.000Z');
    recordNightlyDataRead(db, '2026-10-21T03:00:00.000Z');
    expect(nightlyDataStatus(db, { schedulerActive: true }).readAt).toBe('2026-10-21T03:00:00.000Z');
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?').get(NIGHTLY_DATA_KEY).n).toBe(1);
  });

  test('a stored value that is not JSON reads as no stamp', () => {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, 'not json', datetime('now'))`).run(NIGHTLY_DATA_KEY);
    expect(nightlyDataStatus(db, { schedulerActive: true }).readAt).toBeNull();
  });
});

describe('nightly flag', () => {
  test('true only when the scheduler is armed, Settings enabled and syncBlocks are all true', () => {
    updateSyncScheduleSettings(db, { enabled: true, syncBlocks: true });
    expect(nightlyDataStatus(db, { schedulerActive: true }).nightly).toBe(true);
  });

  test('false when the scheduler is not armed', () => {
    updateSyncScheduleSettings(db, { enabled: true, syncBlocks: true });
    expect(nightlyDataStatus(db, { schedulerActive: false }).nightly).toBe(false);
  });

  test('false when Settings enabled is off', () => {
    updateSyncScheduleSettings(db, { enabled: false, syncBlocks: true });
    expect(nightlyDataStatus(db, { schedulerActive: true }).nightly).toBe(false);
  });

  test('false when Settings syncBlocks is off', () => {
    updateSyncScheduleSettings(db, { enabled: true, syncBlocks: false });
    expect(nightlyDataStatus(db, { schedulerActive: true }).nightly).toBe(false);
  });
});
