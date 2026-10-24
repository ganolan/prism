import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './extraTime.js';
import { getDb } from '../db/index.js';

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/extra-time', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}/api/extra-time${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

let a;
let b;

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM student_extra_time; DELETE FROM enrolments; DELETE FROM students;');
  const add = (first) => db.prepare('INSERT INTO students (first_name, last_name) VALUES (?, ?)').run(first, 'Test').lastInsertRowid;
  a = add('Ann');
  b = add('Ben');
});

describe('/api/extra-time', () => {
  test('puts a figure and reads it back, only for the students asked about', async () => {
    const put = await call('PUT', `/${a}`, { percent: 25 });
    expect(put.status).toBe(200);
    expect(put.body.percent).toBe(25);
    expect(Number.isNaN(Date.parse(put.body.updatedAt))).toBe(false);

    const got = await call('GET', `?studentIds=${a},${b}`);
    expect(got.body).toEqual({ [a]: { percent: 25, updatedAt: put.body.updatedAt } });
    expect(await call('GET', `?studentIds=${b}`)).toEqual({ status: 200, body: {} });
    expect(await call('GET', '')).toEqual({ status: 200, body: {} });
  });

  test('a second put replaces the figure', async () => {
    await call('PUT', `/${a}`, { percent: 25 });
    await call('PUT', `/${a}`, { percent: 50 });
    const got = await call('GET', `?studentIds=${a}`);
    expect(got.body[a].percent).toBe(50);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM student_extra_time').get().n).toBe(1);
  });

  test('accepts the ends of the range, 0 and 200', async () => {
    expect((await call('PUT', `/${a}`, { percent: 0 })).status).toBe(200);
    expect((await call('PUT', `/${a}`, { percent: 200 })).status).toBe(200);
  });

  test.each([201, -1, 12.5, '25', null])('refuses %j with 400 and stores nothing', async (percent) => {
    const res = await call('PUT', `/${a}`, { percent });
    expect(res.status).toBe(400);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM student_extra_time').get().n).toBe(0);
  });

  test('refuses a missing percent with 400', async () => {
    expect((await call('PUT', `/${a}`, {})).status).toBe(400);
  });

  test('deletes a figure, and deleting again is fine', async () => {
    await call('PUT', `/${a}`, { percent: 25 });
    expect(await call('DELETE', `/${a}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call('GET', `?studentIds=${a}`)).body).toEqual({});
    expect((await call('DELETE', `/${a}`)).status).toBe(200);
  });

  test('an unknown student is 404', async () => {
    const res = await call('PUT', '/999999', { percent: 25 });
    expect(res.status).toBe(404);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM student_extra_time').get().n).toBe(0);
  });

  test('a bad studentIds list is 400', async () => {
    expect((await call('GET', '?studentIds=1,x')).status).toBe(400);
  });

  test('the figure goes when its student is deleted', async () => {
    await call('PUT', `/${a}`, { percent: 25 });
    getDb().prepare('DELETE FROM students WHERE id = ?').run(a);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM student_extra_time').get().n).toBe(0);
  });
});
