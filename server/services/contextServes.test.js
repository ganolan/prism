import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { recordServe, serveFor, pruneServes, CONTEXT_FALLBACK_MS } from './contextServes.js';

const T0 = new Date('2026-10-20T10:00:00.000Z');
const at = (ms) => new Date(T0.getTime() + ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
let a1; let a2;

// Record a serve as if it happened at `servedAtMs` relative to T0.
function serveAt(assignmentId, servedAtMs, dataAsOf) {
  return recordServe(getDb(), { assignmentId, dataAsOf, now: at(servedAtMs) });
}

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM context_serves; DELETE FROM assignments; DELETE FROM courses;');
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'MGD')`).run().lastInsertRowid;
  a1 = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'One')`).run(courseId).lastInsertRowid;
  a2 = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-2', 'Two')`).run(courseId).lastInsertRowid;
});

describe('recordServe and serveFor', () => {
  test('a serve is found by its id', () => {
    const id = serveAt(a1, -30 * MIN, at(-31 * MIN));
    expect(id).toEqual(expect.any(Number));
    expect(serveFor(getDb(), { assignmentId: a1, contextId: id, now: at(0) }))
      .toEqual({ dataAsOf: at(-31 * MIN), servedAt: at(-30 * MIN), source: 'context_id' });
  });

  test("another assignment's context_id is refused", () => {
    const id = serveAt(a2, -5 * MIN, at(-6 * MIN));
    expect(() => serveFor(getDb(), { assignmentId: a1, contextId: id, now: at(0) })).toThrow(/another assignment/i);
  });

  test('an unknown id falls back to the oldest serve in the last 3 hours, and says so', () => {
    serveAt(a1, -2 * HOUR, at(-2 * HOUR - MIN));
    serveAt(a1, -10 * MIN, at(-11 * MIN));
    expect(serveFor(getDb(), { assignmentId: a1, contextId: 9999, now: at(0) }))
      .toEqual({ dataAsOf: at(-2 * HOUR - MIN), servedAt: at(-2 * HOUR), source: 'fallback', unknownId: true });
  });

  test('with no id, the fallback is the OLDEST serve in 3 hours', () => {
    serveAt(a1, -10 * MIN, at(-11 * MIN));
    serveAt(a1, -150 * MIN, at(-151 * MIN));
    serveAt(a1, -60 * MIN, at(-61 * MIN));
    serveAt(a2, -170 * MIN, at(-171 * MIN)); // another assignment never counts
    expect(serveFor(getDb(), { assignmentId: a1, now: at(0) }))
      .toEqual({ dataAsOf: at(-151 * MIN), servedAt: at(-150 * MIN), source: 'fallback' });
  });

  test('a serve 4 hours old is ignored: task_synced_at (else never) and now', () => {
    serveAt(a1, -4 * HOUR, at(-4 * HOUR - MIN));
    expect(CONTEXT_FALLBACK_MS).toBe(3 * HOUR);
    expect(serveFor(getDb(), { assignmentId: a1, now: at(0) })).toEqual({ dataAsOf: 'never', servedAt: at(0), source: 'none' });
    getDb().prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run(at(-20 * MIN), a1);
    expect(serveFor(getDb(), { assignmentId: a1, now: at(0) })).toEqual({ dataAsOf: at(-20 * MIN), servedAt: at(0), source: 'none' });
  });

  test('two sessions on one task each get their own serve by id', () => {
    const stored = serveAt(a1, -40 * MIN, at(-3 * 24 * 60 * MIN));
    const fresh = serveAt(a1, -5 * MIN, at(-6 * MIN));
    expect(serveFor(getDb(), { assignmentId: a1, contextId: stored, now: at(0) }))
      .toMatchObject({ dataAsOf: at(-3 * 24 * 60 * MIN), servedAt: at(-40 * MIN) });
    expect(serveFor(getDb(), { assignmentId: a1, contextId: fresh, now: at(0) }))
      .toMatchObject({ dataAsOf: at(-6 * MIN), servedAt: at(-5 * MIN) });
  });
});

describe('pruneServes', () => {
  test('deletes serves older than 30 days and keeps the rest', () => {
    const old = serveAt(a1, -31 * 24 * HOUR, at(-31 * 24 * HOUR));
    const kept = serveAt(a1, -29 * 24 * HOUR, at(-29 * 24 * HOUR));
    pruneServes(getDb(), { now: at(0) });
    const ids = getDb().prepare('SELECT id FROM context_serves').all().map(r => r.id);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(old);
  });

  test('recordServe prunes as it records', () => {
    const old = serveAt(a1, -40 * 24 * HOUR, at(-40 * 24 * HOUR));
    serveAt(a1, 0, at(-MIN));
    expect(getDb().prepare('SELECT id FROM context_serves WHERE id = ?').get(old)).toBeUndefined();
  });
});
