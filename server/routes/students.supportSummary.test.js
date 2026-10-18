// GET /api/students/:id/support-summary (#163): the PowerSchool Student Support
// Summary, read on demand (server/services/psSupportSummary.js, tested there).
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../services/psSupportSummary.js', async () => {
  const real = await vi.importActual('../services/psSupportSummary.js');
  return { ...real, readSupportSummary: vi.fn() };
});
vi.mock('../middleware/featureGate.js', async () => {
  const real = await vi.importActual('../middleware/featureGate.js');
  return { ...real, getFeatures: vi.fn(() => ({ powerschool_alerts: true })) };
});

import router from './students.js';
import { readSupportSummary, SupportSummaryError } from '../services/psSupportSummary.js';
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

beforeEach(() => { vi.mocked(readSupportSummary).mockReset(); vi.mocked(getFeatures).mockReturnValue({ powerschool_alerts: true }); });

describe('GET /api/students/:id/support-summary', () => {
  test('answers the rows and when they were read', async () => {
    vi.mocked(readSupportSummary).mockResolvedValue({ rows: [{ category: 'Support Notes', description: 'x' }], readAt: '2026-10-18T10:00:00.000Z' });
    const r = await get('/api/students/7/support-summary');
    expect(r).toEqual({ status: 200, body: { rows: [{ category: 'Support Notes', description: 'x' }], readAt: '2026-10-18T10:00:00.000Z' } });
    expect(readSupportSummary).toHaveBeenCalledWith(expect.anything(), 7);
  });

  test.each([
    ['NO_ALERT', 404], ['NOT_FOUND', 404], ['NOT_LINKED', 404], ['NO_COURSE', 409], ['NOT_ON_ROSTER', 409],
    ['SESSION_EXPIRED', 503], ['SECURITY_VIOLATION', 502], ['PS_FAILED', 502],
  ])('%s → %i with the reason', async (code, status) => {
    vi.mocked(readSupportSummary).mockRejectedValue(new SupportSummaryError(code, `because ${code}`));
    const r = await get('/api/students/7/support-summary');
    expect(r).toEqual({ status, body: { error: `because ${code}`, code } });
  });

  test('404 while the powerschool_alerts feature is off, with no read', async () => {
    vi.mocked(getFeatures).mockReturnValue({ powerschool_alerts: false });
    expect((await get('/api/students/7/support-summary')).status).toBe(404);
    expect(readSupportSummary).not.toHaveBeenCalled();
  });
});
