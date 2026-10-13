import { test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { groupsToRefresh, refreshRecentQuizzes } from './quizRefresh.js';
import { QuizError } from './quizError.js';

let db, recent, old, never, archived;
const NOW = new Date('2026-10-13T20:00:00Z');
beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM courses;');
  const live = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('a', 'Live')`).run().lastInsertRowid;
  const gone = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('b', 'Old', 1)`).run().lastInsertRowid;
  const add = (course, title, loadedAt) => db.prepare('INSERT INTO quiz_groups (course_id, title, loaded_at) VALUES (?, ?, ?)').run(course, title, loadedAt).lastInsertRowid;
  recent = add(live, 'Recent', '2026-10-01 08:00:00');
  old = add(live, 'Old', '2026-09-01 08:00:00');
  never = add(live, 'Never', null);
  archived = add(gone, 'Archived', '2026-10-10 08:00:00');
});

test('groups loaded in the last 28 days, in courses that are not archived', () => {
  expect(groupsToRefresh(db, { now: NOW }).map(g => g.title)).toEqual(['Recent']);
});

test('reloads each group and reports per group', async () => {
  const load = vi.fn(async () => ({ attempts: 9, failed: [] }));
  expect(await refreshRecentQuizzes(db, { now: NOW, load })).toEqual([{ groupId: recent, title: 'Recent', status: 'done', attempts: 9 }]);
  expect(load).toHaveBeenCalledWith(db, { groupId: recent });
});

test('an expired session stops after the first group', async () => {
  db.prepare(`UPDATE quiz_groups SET loaded_at = '2026-10-12 08:00:00' WHERE id = ?`).run(old);
  const load = vi.fn(async () => { throw new QuizError('NO_SESSION', 'Reconnect Schoology'); });
  const r = await refreshRecentQuizzes(db, { now: NOW, load });
  expect(r).toEqual([{ groupId: recent, title: 'Recent', status: 'error', code: 'NO_SESSION', message: 'Reconnect Schoology' }]);
  expect(load).toHaveBeenCalledTimes(1);
});

test('another failure moves on to the next group', async () => {
  db.prepare(`UPDATE quiz_groups SET loaded_at = '2026-10-12 08:00:00' WHERE id = ?`).run(old);
  const load = vi.fn().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce({ attempts: 3, failed: [] });
  expect((await refreshRecentQuizzes(db, { now: NOW, load })).map(x => x.status)).toEqual(['error', 'done']);
});
