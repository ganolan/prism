import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { setPublished, PublishError } from './assessmentPublish.js';

let courseId;
let assignmentId;

// A fake Schoology: GET answers the stored state, PUT {published} stores it
// (as the 18/10/2026 probe showed: 204, then the GET reads the new value).
function fakeSchoology(initial, { putStatus = 204, ignorePut = false } = {}) {
  const state = { published: initial };
  const calls = [];
  return {
    calls,
    state,
    apiGet: vi.fn(async (path) => { calls.push(['GET', path]); return { id: 8601, published: state.published }; }),
    apiPut: vi.fn(async (path, body) => {
      calls.push(['PUT', path, body]);
      if (putStatus === 204 && !ignorePut) state.published = body.published;
      return { status: putStatus, data: null };
    }),
  };
}

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM grades; DELETE FROM assignments; DELETE FROM courses;');
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('7001', 'AP CSP', 0)`).run().lastInsertRowid;
  assignmentId = db.prepare(
    `INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, '8601', 'Unit 2 Test', 0)`,
  ).run(courseId).lastInsertRowid;
});

const localPublished = () => getDb().prepare('SELECT published FROM assignments WHERE id = ?').get(assignmentId).published;

describe('setPublished', () => {
  test('publishes: re-reads, PUTs {published: 1}, reads back, stores the read-back value', async () => {
    const s = fakeSchoology(0);
    const r = await setPublished(getDb(), { courseId, assignmentId, published: 1 }, s);
    expect(r).toEqual({ assignmentId, published: 1, changed: true });
    expect(s.calls).toEqual([
      ['GET', '/sections/7001/assignments/8601'],
      ['PUT', '/sections/7001/assignments/8601', { published: 1 }],
      ['GET', '/sections/7001/assignments/8601'],
    ]);
    expect(localPublished()).toBe(1);
  });

  test('unpublishes the same way', async () => {
    getDb().prepare('UPDATE assignments SET published = 1 WHERE id = ?').run(assignmentId);
    const s = fakeSchoology(1);
    const r = await setPublished(getDb(), { courseId, assignmentId, published: 0 }, s);
    expect(r.published).toBe(0);
    expect(s.apiPut).toHaveBeenCalledWith('/sections/7001/assignments/8601', { published: 0 });
    expect(localPublished()).toBe(0);
  });

  test('sends no write when Schoology already has the requested state, and catches Prism up', async () => {
    const s = fakeSchoology(1); // published in Schoology since the last sync
    const r = await setPublished(getDb(), { courseId, assignmentId, published: 1 }, s);
    expect(r).toEqual({ assignmentId, published: 1, changed: false });
    expect(s.apiPut).not.toHaveBeenCalled();
    expect(localPublished()).toBe(1);
  });

  test('a failed PUT is an error and leaves Prism unchanged', async () => {
    const s = fakeSchoology(0, { putStatus: 403 });
    await expect(setPublished(getDb(), { courseId, assignmentId, published: 1 }, s))
      .rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(localPublished()).toBe(0);
  });

  test('a read-back that disagrees is an error, and Prism stores what Schoology shows', async () => {
    const s = fakeSchoology(0, { ignorePut: true });
    await expect(setPublished(getDb(), { courseId, assignmentId, published: 1 }, s))
      .rejects.toMatchObject({ code: 'READBACK_MISMATCH' });
    expect(localPublished()).toBe(0);
  });

  test('refuses an archived course without calling Schoology', async () => {
    getDb().prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
    const s = fakeSchoology(0);
    await expect(setPublished(getDb(), { courseId, assignmentId, published: 1 }, s))
      .rejects.toMatchObject({ code: 'NOT_LIVE' });
    expect(s.calls).toEqual([]);
  });

  test('refuses an assignment from another course, or one deleted in Schoology', async () => {
    const s = fakeSchoology(0);
    const other = getDb().prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('7002', 'Other')`).run().lastInsertRowid;
    await expect(setPublished(getDb(), { courseId: other, assignmentId, published: 1 }, s))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    getDb().prepare(`UPDATE assignments SET removed_at = '2026-10-01' WHERE id = ?`).run(assignmentId);
    await expect(setPublished(getDb(), { courseId, assignmentId, published: 1 }, s))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s.calls).toEqual([]);
  });

  test('refuses a value other than 0 or 1', async () => {
    const s = fakeSchoology(0);
    for (const bad of [undefined, 2, 'yes', null]) {
      await expect(setPublished(getDb(), { courseId, assignmentId, published: bad }, s))
        .rejects.toBeInstanceOf(PublishError);
    }
    expect(s.calls).toEqual([]);
  });
});
