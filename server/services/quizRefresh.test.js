import { test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { groupsToRefresh, refreshRecentQuizzes } from './quizRefresh.js';
import { QuizError } from './quizError.js';

let db, recent, old, never, archived, fresh, stale, live, student, test1;
const NOW = new Date('2026-10-13T20:00:00Z');
const attempt = (group, completedAt) => db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, completed_at, fetched_at)
  VALUES (?, ?, ?, ?, ?, 'now')`).run(group, db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, ?, 'T', 1)`).run(live, `a${group}-${completedAt}`).lastInsertRowid, student, `x${group}`, completedAt);

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  live = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('a', 'Live')`).run().lastInsertRowid;
  const gone = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('b', 'Old', 1)`).run().lastInsertRowid;
  student = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u', 'A', 'B')`).run().lastInsertRowid;
  const add = (course, title, loadedAt, createdAt = '2026-09-01 08:00:00') =>
    db.prepare('INSERT INTO quiz_groups (course_id, title, loaded_at, created_at) VALUES (?, ?, ?, ?)').run(course, title, loadedAt, createdAt).lastInsertRowid;
  // Every group was loaded last night: the window follows the students' attempts, not loaded_at.
  recent = add(live, 'Recent', '2026-10-13 03:00:00');
  attempt(recent, '2026-10-01 09:30');
  old = add(live, 'Old', '2026-10-13 03:00:00');
  attempt(old, '2026-09-01 09:30');
  never = add(live, 'Never', null);
  archived = add(gone, 'Archived', '2026-10-13 03:00:00');
  fresh = add(live, 'Fresh, nobody sat it yet', '2026-10-13 03:00:00', '2026-10-10 08:00:00');
  stale = add(live, 'Created long ago, nobody sat it', '2026-10-13 03:00:00', '2026-08-01 08:00:00');
});

test('groups whose latest attempt is within 28 days (or, with no attempt yet, created within 28 days), in courses that are not archived', () => {
  expect(groupsToRefresh(db, { now: NOW }).map(g => g.title)).toEqual(['Recent', 'Fresh, nobody sat it yet']);
});

test('reloads each group and reports per group', async () => {
  db.prepare('DELETE FROM quiz_groups WHERE id = ?').run(fresh);
  const load = vi.fn(async () => ({ attempts: 9, failed: [] }));
  expect(await refreshRecentQuizzes(db, { now: NOW, load })).toEqual([{ groupId: recent, title: 'Recent', status: 'done', attempts: 9 }]);
  expect(load).toHaveBeenCalledWith(db, { groupId: recent });
});

test('an expired session stops after the first group', async () => {
  const load = vi.fn(async () => { throw new QuizError('NO_SESSION', 'Reconnect Schoology'); });
  const r = await refreshRecentQuizzes(db, { now: NOW, load });
  expect(r).toEqual([{ groupId: recent, title: 'Recent', status: 'error', code: 'NO_SESSION', message: 'Reconnect Schoology' }]);
  expect(load).toHaveBeenCalledTimes(1);
});

test('another failure moves on to the next group', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce({ attempts: 3, failed: [] });
  expect((await refreshRecentQuizzes(db, { now: NOW, load })).map(x => x.status)).toEqual(['error', 'done']);
});
