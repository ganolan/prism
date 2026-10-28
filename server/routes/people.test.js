// #203: the profile routes. The service's own tests cover the reads; these cover the route's answers.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../middleware/featureGate.js', async () => {
  const real = await vi.importActual('../middleware/featureGate.js');
  return { ...real, getFeatures: vi.fn(() => ({ people_search: true })) };
});

import router from './people.js';
import { getDb } from '../db/index.js';

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/people', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { server.close(); }
}

beforeEach(() => { getDb().exec('DELETE FROM people_notes; DELETE FROM people; DELETE FROM students;'); });

describe('/api/people/:uid', () => {
  test('a Prism student answers their student id, with no Schoology read', async () => {
    const id = getDb().prepare("INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('600', 'Ana', 'Ng')").run().lastInsertRowid;
    expect(await call('GET', '/api/people/600')).toEqual({ status: 200, body: { student_id: id } });
  });
  test('a path that is not a uid is not this route', async () => {
    expect((await call('GET', '/api/people/abc')).status).toBe(404);
  });
  test('a note on a person never opened is refused; a note on a stored one is kept and deleted', async () => {
    expect((await call('POST', '/api/people/999/notes', { content: 'x' })).status).toBe(404);
    getDb().prepare("INSERT INTO people (schoology_uid, name_display, read_at, last_viewed_at) VALUES ('500', 'Sam Lee', 'x', 'x')").run();
    const added = await call('POST', '/api/people/500/notes', { content: 'Met at Robotics' });
    expect(added.body).toMatchObject({ content: 'Met at Robotics' });
    expect((await call('DELETE', `/api/people/500/notes/${added.body.id}`)).body).toEqual({ deleted: true });
    await call('POST', '/api/people/500/notes', { content: 'Another' });
    expect((await call('DELETE', '/api/people/500')).body).toEqual({ deleted: true });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM people_notes').get().n).toBe(0);
  });
});
