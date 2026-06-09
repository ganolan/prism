import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });   // set before getDb() is first called

import router from './rubrics.js';
import { getDb } from '../db/index.js';
import { saveRubric } from '../services/rubricStore.js';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/rubrics', router);
  const server = app.listen(0);
  return { server, port: server.address().port };
}
async function call(method, path, body, isForm) {
  const { server, port } = startServer();
  try {
    const opts = { method };
    if (isForm) opts.body = body;
    else if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    const res = await fetch(`http://localhost:${port}${path}`, opts);
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  } finally { server.close(); }
}

beforeEach(() => {
  const db = getDb();
  db.exec(`DELETE FROM rubric_descriptors; DELETE FROM rubric_criteria; DELETE FROM rubrics;`);
});

describe('rubrics route', () => {
  test('GET /template returns the CSV header', async () => {
    const { status, body } = await call('GET', '/api/rubrics/template');
    expect(status).toBe(200);
    expect(String(body)).toContain('Criteria,Reporting Category,Standard');
  });

  test('POST /upload then GET / lists the rubric', async () => {
    const fd = new FormData();
    fd.append('name', 'MAD');
    fd.append('file', new Blob([
      'Criteria,Reporting Category,Standard,Exhibiting Depth,Exhibiting,Developing,Emerging\nUI/UX,Produce,Select,a,b,c,d',
    ], { type: 'text/csv' }), 'r.csv');
    const up = await call('POST', '/api/rubrics/upload', fd, true);
    expect(up.status).toBe(200);
    const list = await call('GET', '/api/rubrics');
    expect(list.body).toEqual([expect.objectContaining({ name: 'MAD', criteria_count: 1 })]);
  });

  test('GET /config exposes the suggestion accent', async () => {
    const { body } = await call('GET', '/api/rubrics/config');
    expect(body.suggestionAccent).toBe('#e21ad6');
  });

  test('PATCH /:id renames the rubric (name-only) and returns ok', async () => {
    const id = saveRubric(getDb(), { name: 'Typo Naem', source: 'csv',
      criteria: [{ position: 1, criterion_name: 'C1', standard_title: 'S', reporting_category: 'P', descriptors: {} }] });
    const res = await call('PATCH', `/api/rubrics/${id}`, { name: 'Fixed Name' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const list = await call('GET', '/api/rubrics');
    expect(list.body[0]).toMatchObject({ id, name: 'Fixed Name', criteria_count: 1 }); // renamed, criteria intact
  });

  test('PATCH /:id rejects an empty/whitespace name with 400 and leaves the name unchanged', async () => {
    const id = saveRubric(getDb(), { name: 'Keep', source: 'csv', criteria: [] });
    const res = await call('PATCH', `/api/rubrics/${id}`, { name: '   ' });
    expect(res.status).toBe(400);
    expect((await call('GET', '/api/rubrics')).body[0]).toMatchObject({ name: 'Keep' });
  });

  test('DELETE /:id removes the rubric and cascades to its attachments', async () => {
    const id = saveRubric(getDb(), { name: 'Doomed', source: 'csv', criteria: [] });
    // FK cascade relies on getDb() setting PRAGMA foreign_keys = ON (server/db/index.js:150).
    getDb().prepare(
      `INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at)
       VALUES (?, '800', NULL, '2026-01-01')`
    ).run(id);
    const del = await call('DELETE', `/api/rubrics/${id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });
    expect((await call('GET', '/api/rubrics')).body).toEqual([]);
    expect(getDb().prepare(`SELECT COUNT(*) c FROM rubric_attachments`).get().c).toBe(0);
  });
});
