// #39: the attendance routes' answers. The service's own tests cover the reads and the save.
import { describe, test, expect, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../middleware/featureGate.js', async () => {
  const real = await vi.importActual('../middleware/featureGate.js');
  return { ...real, getFeatures: vi.fn(() => ({ attendance: true })) };
});
vi.mock('../services/attendanceMarking.js', () => ({
  readLesson: vi.fn(async (db, id, date) => ({ date, lesson: true, students: [] })),
  saveLesson: vi.fn(async () => { throw Object.assign(new Error('Attendance changed in PowerSchool'), { code: 'CHANGED', lesson: { date: '2026-10-29' } }); }),
}));

import router from './attendance.js';

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/attendance', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

describe('/api/attendance/:courseId', () => {
  test('GET reads one lesson', async () => {
    expect(await call('GET', '/api/attendance/580?date=2026-10-29')).toEqual({ status: 200, body: { date: '2026-10-29', lesson: true, students: [] } });
  });
  test('a refused save answers 409 with the fresh lesson', async () => {
    expect(await call('POST', '/api/attendance/580', { date: '2026-10-29', marks: {}, fingerprint: 'x' }))
      .toEqual({ status: 409, body: { error: 'Attendance changed in PowerSchool', code: 'CHANGED', lesson: { date: '2026-10-29' } } });
  });
});
