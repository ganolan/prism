// GET /api/students/:id/alert-detail/:alertKey (#160): one alert's detail, read on demand
// (server/services/psAlertDetail.js, tested there).
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../services/psAlertDetail.js', () => ({ readAlertDetail: vi.fn() }));
vi.mock('../middleware/featureGate.js', async () => {
  const real = await vi.importActual('../middleware/featureGate.js');
  return { ...real, getFeatures: vi.fn(() => ({ powerschool_alerts: true })) };
});

import router from './students.js';
import { readAlertDetail } from '../services/psAlertDetail.js';
import { SupportSummaryError } from '../services/psSupportSummary.js';
import { getFeatures } from '../middleware/featureGate.js';

async function get(path) {
  const app = express();
  app.use('/api/students', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

beforeEach(() => { vi.mocked(readAlertDetail).mockReset(); vi.mocked(getFeatures).mockReturnValue({ powerschool_alerts: true }); });

describe('GET /api/students/:id/alert-detail/:alertKey', () => {
  test('answers the detail', async () => {
    const detail = { alertKey: 'no_photo', kind: 'text', text: 'x', suggestedPercent: null, readAt: '2026-10-25T10:00:00.000Z' };
    vi.mocked(readAlertDetail).mockResolvedValue(detail);
    expect(await get('/api/students/7/alert-detail/no_photo')).toEqual({ status: 200, body: detail });
    expect(readAlertDetail).toHaveBeenCalledWith(expect.anything(), 7, 'no_photo');
  });

  test.each([
    ['NOT_ROSTER', 400], ['NO_ALERT', 404], ['NOT_FOUND', 404], ['NOT_LINKED', 404], ['NO_COURSE', 409], ['NOT_ON_ROSTER', 409],
    ['SESSION_EXPIRED', 503], ['SECURITY_VIOLATION', 502], ['PS_FAILED', 502],
  ])('%s -> %i with the reason', async (code, status) => {
    vi.mocked(readAlertDetail).mockRejectedValue(new SupportSummaryError(code, `because ${code}`));
    expect(await get('/api/students/7/alert-detail/allergies')).toEqual({ status, body: { error: `because ${code}`, code } });
  });

  test('404 while the powerschool_alerts feature is off, with no read', async () => {
    vi.mocked(getFeatures).mockReturnValue({ powerschool_alerts: false });
    expect((await get('/api/students/7/alert-detail/allergies')).status).toBe(404);
    expect(readAlertDetail).not.toHaveBeenCalled();
  });
});
