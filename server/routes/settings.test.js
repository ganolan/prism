import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './settings.js';
import { getDb } from '../db/index.js';

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

beforeEach(() => { getDb().exec('DELETE FROM settings;'); });

describe('/api/settings', () => {
  test('GET returns triage defaults', async () => {
    const { status, body } = await call('GET', '/api/settings');
    expect(status).toBe(200);
    expect(body.triage.feedbackLimitDays).toBe(10);
  });

  test('PUT updates and returns the full triage settings', async () => {
    const { body } = await call('PUT', '/api/settings', { triage: { feedbackLimitDays: 12 } });
    expect(body.triage).toMatchObject({ feedbackLimitDays: 12, referralLimitDays: 8 });
  });
});

describe('/api/settings — scheduled sync', () => {
  test('GET returns the schedule defaults and an inactive status when no scheduler runs (dev clone)', async () => {
    const { body } = await call('GET', '/api/settings');
    expect(body.syncSchedule).toMatchObject({ enabled: true, time: '03:00', mastery: 'all' });
    expect(body.syncScheduleStatus).toEqual({ active: false, nextRunAt: null, last: null });
  });

  test('PUT saves schedule changes without touching triage', async () => {
    const { body } = await call('PUT', '/api/settings', { syncSchedule: { time: '05:45', recentOnly: true } });
    expect(body.syncSchedule).toMatchObject({ time: '05:45', recentOnly: true });
    expect(body.triage.feedbackLimitDays).toBe(10);
  });
});
