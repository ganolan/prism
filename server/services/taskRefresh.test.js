import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';

vi.mock('./schoology.js', () => ({ getAssignmentSubmissions: vi.fn(), getAssignmentGrades: vi.fn() }));

import { getAssignmentSubmissions, getAssignmentGrades } from './schoology.js';
import { refreshTasks } from './taskRefresh.js';

const T0 = Date.parse('2026-10-19T15:00:00.000Z');

describe('refreshTasks (#108)', () => {
  let db;
  let c1;
  let c2;
  let refreshMastery;
  let afterRead;

  const addCourse = (section, archived = 0) => {
    const id = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES (?, 'C', ?)`).run(section, archived).lastInsertRowid;
    const sid = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Ada', 'L')`).run(`u-${section}`).lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, ?)`).run(sid, id, `e-${section}`);
    return id;
  };
  const addTask = (courseId, ext, { lti = 0, test = 0, dropbox = 1, removed = null } = {}) => db.prepare(`
    INSERT INTO assignments (course_id, schoology_assignment_id, title, accepts_submissions, is_lti_submission, is_test, removed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(courseId, ext, ext, dropbox, lti, test, removed).lastInsertRowid;
  const align = (ext) => {
    db.prepare(`INSERT OR IGNORE INTO measurement_topics (id, title) VALUES ('T', 'Topic')`).run();
    db.prepare(`INSERT INTO mastery_alignments (course_id, assignment_schoology_id, topic_id) VALUES (?, ?, 'T')`).run(c1, ext);
  };
  const stamp = (id) => db.prepare('SELECT submissions_read_at FROM assignments WHERE id = ?').get(id).submissions_read_at;
  const run = (ids, opts = {}) => refreshTasks(ids, {
    db, now: () => T0, openReader: async () => null, deps: { refreshMastery, afterRead }, ...opts,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    getAssignmentSubmissions.mockReset().mockResolvedValue([]);
    getAssignmentGrades.mockReset().mockResolvedValue([]);
    refreshMastery = vi.fn().mockResolvedValue({ refreshed: true });
    afterRead = vi.fn();
    c1 = addCourse('S1');
    c2 = addCourse('S2');
  });

  test('skips tasks read under 2 minutes ago unless force', async () => {
    const a = addTask(c1, 'A');
    db.prepare('UPDATE assignments SET submissions_read_at = ? WHERE id = ?').run(new Date(T0 - 60_000).toISOString(), a);
    const r = await run([a]);
    expect(r.refreshed).toBe(0);
    expect(getAssignmentSubmissions).not.toHaveBeenCalled();
    const forced = await run([a], { force: true });
    expect(forced.refreshed).toBe(1);
    expect(getAssignmentSubmissions).toHaveBeenCalledWith('S1', 'A');
  });

  test('no session: reads native tasks and grades, keeps lti state, answers signIn', async () => {
    const n = addTask(c1, 'N');
    const l = addTask(c1, 'L', { lti: 1 });
    db.prepare(`UPDATE assignments SET lti_fetch_status = 'ok' WHERE id = ?`).run(l);
    const r = await run([n, l]);
    expect(getAssignmentSubmissions).toHaveBeenCalledWith('S1', 'N');
    expect(getAssignmentGrades).toHaveBeenCalledWith('S1', 'N');
    expect(getAssignmentGrades).toHaveBeenCalledWith('S1', 'L');
    expect(db.prepare('SELECT lti_fetch_status FROM assignments WHERE id = ?').get(l).lti_fetch_status).toBe('ok');
    expect(stamp(n)).not.toBeNull();
    expect(stamp(l)).toBeNull();
    expect(r.signIn).toBe(true);
  });

  test('one course failing does not stop the others', async () => {
    const a = addTask(c1, 'A');
    const b = addTask(c2, 'B');
    getAssignmentSubmissions.mockImplementation(async (section) => {
      if (section === 'S1') throw new Error('Schoology API 403');
      return [];
    });
    const r = await run([a, b]);
    expect(r.failed).toEqual([a]);
    expect(r.error).toMatch(/403/);
    expect(stamp(b)).not.toBeNull();
    expect(stamp(a)).toBeNull();
    expect(r.refreshed).toBe(1);
  });

  test('two calls for the same task share one read', async () => {
    const a = addTask(c1, 'A');
    const [r1, r2] = await Promise.all([run([a]), run([a])]);
    expect(getAssignmentSubmissions).toHaveBeenCalledTimes(1);
    expect(r1.refreshed).toBe(1);
    expect(r2.refreshed).toBe(1);
  });

  test('skips archived-course and removed tasks without error', async () => {
    const old = addTask(addCourse('S9', 1), 'OLD');
    const gone = addTask(c1, 'GONE', { removed: '2026-10-01' });
    const r = await run([old, gone, 99999]);
    expect(r).toMatchObject({ refreshed: 0, failed: [] });
    expect(r.error).toBeUndefined();
    expect(getAssignmentSubmissions).not.toHaveBeenCalled();
  });

  test('reads mastery only for aligned tasks, and not when mastery is false', async () => {
    const a = addTask(c1, 'A');
    const u = addTask(c1, 'U');
    align('A');
    await run([a, u]);
    expect(refreshMastery).toHaveBeenCalledTimes(1);
    expect(refreshMastery).toHaveBeenCalledWith(c1, 'A', expect.objectContaining({ force: false }));
    refreshMastery.mockClear();
    await run([a, u], { force: true, mastery: false });
    expect(refreshMastery).not.toHaveBeenCalled();
  });

  test('a task with no submission channel is stamped after its grades read', async () => {
    const paper = addTask(c1, 'P', { dropbox: 0 });
    await run([paper]);
    expect(getAssignmentSubmissions).not.toHaveBeenCalled();
    expect(getAssignmentGrades).toHaveBeenCalledWith('S1', 'P');
    expect(stamp(paper)).not.toBeNull();
  });

  test('records snapshots and settles resubmissions for each course read', async () => {
    const a = addTask(c1, 'A');
    const b = addTask(c2, 'B');
    await run([a, b]);
    expect(afterRead.mock.calls.map(([, opts]) => opts.courseId).sort()).toEqual([c1, c2].sort());
  });

  test('readAt is the oldest stamp among the tasks', async () => {
    const a = addTask(c1, 'A');
    const b = addTask(c1, 'B');
    const older = new Date(T0 - 60_000).toISOString();
    db.prepare('UPDATE assignments SET submissions_read_at = ? WHERE id = ?').run(older, a);
    const r = await run([a, b]);
    expect(r.readAt).toBe(older);
  });

  // Final review #1: a task Schoology no longer has (deleted there, not yet marked removed)
  // answers 404; the course's other tasks are still read.
  test('one task answering 404 fails alone; the others and every grade are read', async () => {
    const gone = addTask(c1, 'GONE');
    const ok = addTask(c1, 'OK');
    const paper = addTask(c1, 'P', { dropbox: 0 });
    getAssignmentSubmissions.mockImplementation(async (_s, aid) => {
      if (aid === 'GONE') throw Object.assign(new Error('Schoology API 404'), { status: 404 });
      return [];
    });
    const r = await run([gone, ok, paper]);
    expect(r.failed).toEqual([gone]);
    expect(stamp(ok)).not.toBeNull();
    expect(stamp(paper)).not.toBeNull();
    expect(getAssignmentGrades).toHaveBeenCalledTimes(3);
  });

  // Final review #2: saved but lapsed cookies: the reader exists, its reads answer null.
  test('a lapsed session (reader present, expired) answers signIn', async () => {
    const l = addTask(c1, 'L', { lti: 1 });
    const reader = { expired: true, fetchDocuments: async () => null, fetchTestAttempts: async () => null, close: async () => {} };
    const r = await run([l], { openReader: async () => reader });
    expect(r.signIn).toBe(true);
    expect(r.error).toMatch(/Log in to Schoology/);
  });

  // Final review #3: mastery only for the ids given (the course page: its triage tasks).
  test('mastery as a list reads mastery for those tasks only', async () => {
    const a = addTask(c1, 'A');
    const b = addTask(c1, 'B');
    align('A');
    align('B');
    await run([a, b], { mastery: [b] });
    expect(refreshMastery).toHaveBeenCalledTimes(1);
    expect(refreshMastery).toHaveBeenCalledWith(c1, 'B', expect.anything());
  });
});
