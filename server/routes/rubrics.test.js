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

  test('POST /upload reuses an existing rubric on identical content (no new row)', async () => {
    saveRubric(getDb(), { name: 'Existing', source: 'csv', criteria: [
      { position: 1, criterion_name: 'UI/UX', standard_title: 'Select', reporting_category: 'Produce',
        descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' } },
    ] });
    const fd = new FormData();
    fd.append('name', 'Re-upload');
    fd.append('file', new Blob([
      'Criteria,Reporting Category,Standard,Exhibiting Depth,Exhibiting,Developing,Emerging\nUI/UX,Produce,Select,a,b,c,d',
    ], { type: 'text/csv' }), 'dupe.csv');
    const up = await call('POST', '/api/rubrics/upload', fd, true);
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ reused: true, match: 'exact', name: 'Existing' });
    expect((await call('GET', '/api/rubrics')).body).toHaveLength(1); // no duplicate created
  });

  test('POST /upload creates a new rubric when content does not match (reused:false)', async () => {
    const fd = new FormData();
    fd.append('name', 'Novel');
    fd.append('file', new Blob([
      'Criteria,Reporting Category,Standard,Exhibiting Depth,Exhibiting,Developing,Emerging\nNovel,Produce,Brand new,z,y,x,w',
    ], { type: 'text/csv' }), 'novel.csv');
    const up = await call('POST', '/api/rubrics/upload', fd, true);
    expect(up.body).toMatchObject({ reused: false });
    expect((await call('GET', '/api/rubrics')).body).toHaveLength(1);
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

test('PUT /row-levels saves Prism-only row levels and validates them', async () => {
  const db = getDb();
  db.exec('DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM assignments; DELETE FROM courses;');
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-F', 'MGD')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-F', 'Flappy (F)', '23495360')`).run(courseId);
  const rubricId = saveRubric(db, { name: 'Flappy', source: 'mcp', criteria: [{ position: 1, criterion_name: 'Playtesting' }] });
  db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-F', ?, 'now')`).run(rubricId, courseId);
  const put = (path, body) => call('PUT', path, body);
  const ok = await put('/api/rubrics/row-levels/sa-F/uid-B', { rowLevels: { Playtesting: 'EX' } });
  expect(ok.status).toBe(200);
  expect(ok.body).toEqual({ ok: true, row_levels: { Playtesting: 'EX' } });
  const bad = await put('/api/rubrics/row-levels/sa-F/uid-B', { rowLevels: { Evaluation: 'EX' } });
  expect(bad.status).toBe(400);
});

describe('GET /assignments?ids= (shared feedback view, #135)', () => {
  test('returns every attached rubric for the listed assignments in one request', async () => {
    const db = getDb();
    db.exec('DELETE FROM rubric_attachments;');
    const id = saveRubric(db, { name: 'Batch', source: 'csv', criteria: [
      { position: 1, criterion_name: 'UI/UX', standard_title: 'S', reporting_category: 'Produce', descriptors: { ED: 'Polished.', EX: 'Clear.' } },
    ] });
    db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-1', NULL, 'now')`).run(id);
    const { status, body } = await call('GET', '/api/rubrics/assignments?ids=sa-1,sa-2');
    expect(status).toBe(200);
    expect(Object.keys(body.attachments)).toEqual(['sa-1']);
    expect(body.attachments['sa-1'].rubric.criteria[0].descriptors.ED).toBe('Polished.');
  });

  test('?student_uid= adds that student\'s feedback-row levels and nobody else\'s', async () => {
    const db = getDb();
    db.exec('DELETE FROM rubric_row_levels; DELETE FROM rubric_attachments; DELETE FROM assignments; DELETE FROM courses;');
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-R', 'MGD')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id) VALUES (?, 'sa-R', 'Flappy (F)', '23495360')`).run(courseId);
    const id = saveRubric(db, { name: 'Flappy', source: 'mcp', criteria: [{ position: 1, criterion_name: 'Playtesting' }] });
    db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa-R', ?, 'now')`).run(id, courseId);
    db.prepare(`INSERT INTO rubric_row_levels (assignment_schoology_id, student_uid, criterion_name, level) VALUES ('sa-R', 'u-A', 'Playtesting', 'EX'), ('sa-R', 'u-B', 'Playtesting', 'IE')`).run();
    const { body } = await call('GET', '/api/rubrics/assignments?ids=sa-R&student_uid=u-A');
    expect(body.attachments['sa-R']).toMatchObject({ mode: 'feedback_rows', rowLevels: { Playtesting: 'EX' } });
    expect(JSON.stringify(body)).not.toContain('u-B');
  });

  test('no ids is an empty result, not an error', async () => {
    const { status, body } = await call('GET', '/api/rubrics/assignments');
    expect(status).toBe(200);
    expect(body).toEqual({ attachments: {} });
  });
});
