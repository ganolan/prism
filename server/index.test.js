import { describe, test, expect } from 'vitest';
import express from 'express';
import { getScaleTable, schoologyScaleId } from './lib/proficiencyScale.js';
import { getFeatures } from './middleware/featureGate.js';
import { getGradingScalesMap } from './db/scales.js';
import { resolveVersion } from './lib/version.js';

// Build a minimal express app that mirrors only the inline app.get() handlers
// from server/index.js (the router-based routes are tested in routes/*.test.js).
// We do NOT import server/index.js directly because it calls app.listen() at
// module level — instead we recreate just the handlers under test here.
function buildApp() {
  const app = express();
  app.use(express.json());

  app.get('/api/features', (req, res) => {
    res.json(getFeatures());
  });

  app.get('/api/version', (req, res) => {
    res.json(resolveVersion());
  });

  app.get('/api/grading-scales', (req, res) => {
    res.json(getGradingScalesMap());
  });

  // Task 11: GET /api/proficiency-scale
  app.get('/api/proficiency-scale', (req, res) => {
    res.json({ levels: getScaleTable(), schoologyScaleId: schoologyScaleId() });
  });

  return app;
}

async function get(path) {
  const app = buildApp();
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://localhost:${port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('GET /api/proficiency-scale', () => {
  test('returns 200 with the scale table and scaleId', async () => {
    const res = await get('/api/proficiency-scale');
    expect(res.status).toBe(200);
    expect(res.body.schoologyScaleId).toBe(21337256);
    expect(res.body.levels.map((l) => l.code)).toEqual(['ED', 'EX', 'D', 'EM', 'IE']);
  });
});

describe('GET /api/version', () => {
  test('returns 200 with sha, builtAt and mode', async () => {
    const res = await get('/api/version');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['builtAt', 'mode', 'sha']);
    expect(['release', 'dev']).toContain(res.body.mode);
  });
});
