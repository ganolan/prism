import { describe, test, expect, vi } from 'vitest';
import express from 'express';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import schoologyRouter from './schoology.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Flag for review is gone (#40, 21 Oct 2026). server/index.js cannot be imported (it listens), so
// the app below mounts the one router that shares the /api root with the old route, plus index.js's
// own /api catch-all, which is what answers a path no router owns.
function app() {
  const a = express();
  a.use(express.json());
  a.use('/api', schoologyRouter);
  a.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.status(200).send('index.html');
  });
  return a;
}

async function request(method, path, body) {
  const server = app().listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status };
  } finally {
    server.close();
  }
}

describe('the /api/flags routes are removed (#40)', () => {
  test('GET /api/flags answers 404', async () => {
    expect((await request('GET', '/api/flags')).status).toBe(404);
  });

  test('the route file is gone and server/index.js does not mount it', () => {
    expect(existsSync(join(root, 'routes', 'flags.js'))).toBe(false);
    const index = readFileSync(join(root, 'index.js'), 'utf-8');
    expect(index).not.toMatch(/routes\/flags/);
    expect(index).not.toMatch(/\/api\/flags/);
  });
});
