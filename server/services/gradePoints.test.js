import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { gradePointsCheck, readBackPoints, sameScore } from './gradePoints.js';
import { hasNoScale, isTestTask } from '../lib/pointsTask.js';

const SCALES = [{
  schoologyScaleId: 7165818, name: 'Completion Scale',
  levels: [{ code: 'C', label: 'Complete', points: 100 }, { code: 'I', label: 'Incomplete', points: 0 }],
}];

describe('gradePointsCheck (#41, #181)', () => {
  let courseId;
  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM mastery_scores; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM assignments; DELETE FROM courses;');
    courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'Course')`).run().lastInsertRowid;
    const add = (id, scale, extra = {}) => db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, grading_scale_id, assignment_type, is_test, max_points) VALUES (?, ?, ?, ?, ?, ?, 50)`
    ).run(courseId, id, id, scale, extra.type ?? 'assignment', extra.isTest ?? 0);
    add('pts', '0');
    add('pts-null', null);
    add('scale', '7165818');
    add('letter', '1293963');
    add('test', '0', { type: 'assessment' });
    add('test-flag', '0', { isTest: 1 });
    add('aligned', '0');
    db.prepare(`INSERT INTO reporting_categories (id, course_id, title, external_id) VALUES ('cat-1', ?, 'Cat', 'c1')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t-1', 'cat-1', ?, 'T.1', 'Topic')`).run(courseId);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('aligned', 't-1', ?)`).run(courseId);
  });
  const check = (id, points) => gradePointsCheck(getDb(), courseId, id, points, SCALES);

  test('a scale task takes only one of its levels', () => {
    expect(check('scale', 100)).toMatchObject({ error: null, pointsTask: false });
    expect(check('scale', 80).error).toBe('80 is not a level of Completion Scale');
  });

  test('a points-only task takes any score of 0 or more, over the maximum too', () => {
    expect(check('pts', 42.5)).toMatchObject({ error: null, pointsTask: true });
    expect(check('pts', 0)).toMatchObject({ error: null, pointsTask: true });
    expect(check('pts', 75)).toMatchObject({ error: null, pointsTask: true }); // extra credit
    expect(check('pts', '45')).toMatchObject({ error: null, pointsTask: true });
    expect(check('pts-null', 10)).toMatchObject({ error: null, pointsTask: true });
  });

  test('a points-only task refuses a negative, empty or non-numeric score', () => {
    for (const bad of [-1, '', 'abc', true, Number.NaN]) expect(check('pts', bad).error).toMatch(/is not a score of 0 or more/);
  });

  test('tests and quizzes, aligned tasks and named scales take no points', () => {
    expect(check('test', 10).error).toBe('Schoology scores tests and quizzes: Prism writes no points to them');
    expect(check('test-flag', 10).error).toBe('Schoology scores tests and quizzes: Prism writes no points to them');
    expect(check('aligned', 10).error).toBe('Assignment aligned is not on a scale Prism can grade');
    expect(check('letter', 10).error).toBe('Assignment letter is not on a scale Prism can grade');
    expect(check('missing', 10).error).toBe('Assignment missing is not on a scale Prism can grade');
  });
});

describe('gradePoints helpers', () => {
  test('hasNoScale and isTestTask', () => {
    expect([null, '', '0', 0].map(hasNoScale)).toEqual([true, true, true, true]);
    expect(hasNoScale('7165818')).toBe(false);
    expect(isTestTask({ assignment_type: 'assessment' })).toBe(true);
    expect(isTestTask({ assignment_type: 'assignment', is_test: 1 })).toBe(true);
    expect(isTestTask({ assignment_type: 'assignment', is_test: null })).toBe(false);
  });

  test('sameScore compares as numbers, with null and empty as no score', () => {
    expect(sameScore('45.00', 45)).toBe(true);
    expect(sameScore(null, '')).toBe(true);
    expect(sameScore(null, 0)).toBe(false);
    expect(sameScore('0', 0)).toBe(true);
    expect(sameScore('40', 45)).toBe(false);
  });
});

describe('readBackPoints (#181)', () => {
  test('a matching record: the sent score, with its exception', async () => {
    const out = await readBackPoints({ read: async () => [{ enrollment_id: 'e1', grade: '45.00', exception: '0' }], enrollmentId: 'e1', points: 45, sentException: 0 });
    expect(out).toEqual({ score: 45, exception: 0 });
  });

  test('a different score in Schoology: mirror what it holds, with a warning', async () => {
    const out = await readBackPoints({ read: async () => [{ enrollment_id: 'e1', grade: '40', exception: 0 }], enrollmentId: 'e1', points: 45, sentException: 0 });
    expect(out).toEqual({ score: 40, exception: 0, warning: 'Schoology holds 40, not the 45 sent: check the grade in Schoology' });
  });

  test('a failed read or a missing record keeps the sent score and says so', async () => {
    const failed = await readBackPoints({ read: async () => { throw new Error('timeout'); }, enrollmentId: 'e1', points: 45, sentException: 0 });
    expect(failed).toMatchObject({ score: 45, exception: 0 });
    expect(failed.warning).toMatch(/could not read the score back from Schoology \(timeout\)/);
    const missing = await readBackPoints({ read: async () => [], enrollmentId: 'e1', points: 45, sentException: 0 });
    expect(missing).toMatchObject({ score: 45, exception: 0 });
    expect(missing.warning).toMatch(/missing from Schoology's grades read/);
  });
});
