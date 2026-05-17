import { describe, test, expect, vi } from 'vitest';
import express from 'express';

const h = vi.hoisted(() => ({ loggedIn: true }));

vi.mock('../services/masterySync.js', () => ({
  hasMasterySession: () => h.loggedIn,
  // Other named exports the route imports — unused in this test.
  syncMasteryForCourse: vi.fn(),
  syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn(),
  writeMasteryOverride: vi.fn(),
  getMasteryForCourse: vi.fn(),
  getRubricScoresForStudent: vi.fn(),
  interactiveLogin: vi.fn(),
}));
vi.mock('../services/schoology.js', () => ({
  pushGradeComments: vi.fn(),
  getSectionGrades: vi.fn(),
}));

import router from './mastery.js';

async function get(path) {
  const app = express();
  app.use('/api/mastery', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('GET /api/mastery/login-status', () => {
  test('reports loggedIn true when a session file exists', async () => {
    h.loggedIn = true;
    const { status, body } = await get('/api/mastery/login-status');
    expect(status).toBe(200);
    expect(body).toEqual({ loggedIn: true });
  });

  test('reports loggedIn false when no session file exists', async () => {
    h.loggedIn = false;
    const { body } = await get('/api/mastery/login-status');
    expect(body).toEqual({ loggedIn: false });
  });
});
