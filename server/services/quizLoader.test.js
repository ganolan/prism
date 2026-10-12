// server/services/quizLoader.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { readFileSync } from 'fs';
import { getDb } from '../db/index.js';
import { createGroup } from './quizGroups.js';
import { loadGroup, readQuestionLists, assertReadOnlyUrl } from './quizLoader.js';
import { parseQuizQuestions } from '../lib/parseQuizQuestions.js';

const fx = (n) => readFileSync(new URL(`../lib/__fixtures__/quiz/${n}`, import.meta.url), 'utf8');
const BASE = 'https://schoology.hkis.edu.hk';
const RUBRIC = JSON.stringify({ response_code: 200, body: { id: 55233026, title: 'FRQ', total_points: 4, rows: [{ id: 146012384, title: 'Row', max_points: 4, columns: [{ pts: 2, description: 'Developing: x' }] }] } });
const GRADE = JSON.stringify({ response_code: 200, body: { gradeInfo: { 146012384: { grade: '2', comment: '' } } } });

// A fake session page: `pages` maps a path (no host) to { status, text }, or to a function.
function fakeOpenPage(pages, { landing = `${BASE}/home` } = {}) {
  const requested = [];
  const page = {
    goto: vi.fn(async () => {}),
    url: () => landing,
    evaluate: vi.fn(async (_fn, { url }) => {
      const path = url.replace(BASE, '');
      requested.push(path);
      const hit = pages[path];
      if (!hit) return { status: 404, text: '', finalUrl: url };
      const r = typeof hit === 'function' ? await hit() : hit;
      return { finalUrl: url, ...r };
    }),
  };
  const close = vi.fn(async () => {});
  return { openPage: vi.fn(async () => ({ page, close })), requested, close };
}

let db, groupId, studentA, studentC;
beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM mastery_alignments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'C')`).run().lastInsertRowid;
  const t = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'T', 1)`).run(c).lastInsertRowid;
  studentA = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'A', 'A')`).run().lastInsertRowid;
  studentC = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('703', 'C', 'C')`).run().lastInsertRowid;
  groupId = createGroup(db, { courseId: c, assignmentRefs: ['900'], title: 'T', questionLists: [{ assignmentId: t, questions: parseQuizQuestions(fx('questions.html')) }] }).id;
});

const happyPages = () => ({
  '/assignment/900/assessment_results': { status: 200, text: fx('results.html') },
  '/assignment/900/assessment_results/student_stats/701': { status: 200, text: fx('student-stats.html').replaceAll('/703/', '/701/') },
  '/assignment/900/assessment_results/student_stats/703': { status: 200, text: fx('student-stats.html') },
  '/assignment/900/assessment_results/student_stats/701/5002': { status: 200, text: fx('attempt.html') },
  '/assignment/900/assessment_results/student_stats/703/5002': { status: 200, text: fx('attempt.html') },
  '/iapi/grades/rubric/55233026': { status: 200, text: RUBRIC },
  '/iapi/grades/assessment_component_submission_rubric_grade_info/55233026/1003/3561143308/5002': { status: 200, text: GRADE },
});

describe('loadGroup', () => {
  test('reads results, the latest attempt for each taker, and each rubric once; stores them', async () => {
    const f = fakeOpenPage(happyPages());
    const r = await loadGroup(db, { groupId }, { openPage: f.openPage, pauseMs: 0 });
    expect(r).toMatchObject({ attempts: 2, notTaken: 1, failed: [], unknownUids: [], mismatches: [], multipleAttempts: ['701', '703'] });
    expect(db.prepare('SELECT student_id, schoology_attempt_id FROM quiz_attempts ORDER BY student_id').all())
      .toEqual([{ student_id: studentA, schoology_attempt_id: '5002' }, { student_id: studentC, schoology_attempt_id: '5002' }]);
    expect(f.requested.filter(p => p === '/iapi/grades/rubric/55233026')).toHaveLength(1);
    expect(f.requested.some(p => /unsubmit|delete/.test(p))).toBe(false);
    expect(f.close).toHaveBeenCalled();
    expect(db.prepare('SELECT loaded_at FROM quiz_groups WHERE id = ?').get(groupId).loaded_at).toBeTruthy();
  });

  test('the counted attempt is the one that started latest, even when listed first', async () => {
    const pages = happyPages();
    const stats = fx('student-stats.html');
    // Put the newer attempt (5002) before the older one (5001) in page order.
    const rows = stats.split('\n');
    const swapped = [rows[0], rows[2], rows[1], ...rows.slice(3)].join('\n').replaceAll('/703/', '/701/');
    pages['/assignment/900/assessment_results/student_stats/701'] = { status: 200, text: swapped };
    const f = fakeOpenPage(pages);
    const r = await loadGroup(db, { groupId }, { openPage: f.openPage, pauseMs: 0 });
    expect(r.failed).toEqual([]);
    expect(f.requested).toContain('/assignment/900/assessment_results/student_stats/701/5002');
    expect(f.requested).not.toContain('/assignment/900/assessment_results/student_stats/701/5001');
    expect(db.prepare('SELECT schoology_attempt_id FROM quiz_attempts WHERE student_id = ?').get(studentA).schoology_attempt_id).toBe('5002');
  });

  test('an unknown uid is skipped with a warning and the rest still load', async () => {
    db.prepare(`DELETE FROM students WHERE schoology_uid = '701'`).run();
    const r = await loadGroup(db, { groupId }, { openPage: fakeOpenPage(happyPages()).openPage, pauseMs: 0 });
    expect(r.unknownUids).toEqual(['701']);
    expect(r.attempts).toBe(1);
  });

  test('a failed attempt page is reported for that student only', async () => {
    const pages = happyPages();
    pages['/assignment/900/assessment_results/student_stats/701/5002'] = { status: 500, text: '' };
    const r = await loadGroup(db, { groupId }, { openPage: fakeOpenPage(pages).openPage, pauseMs: 0 });
    expect(r.failed).toEqual([{ uid: '701', reason: 'attempt page HTTP 500' }]);
    expect(r.attempts).toBe(1);
  });

  test('a bounce to sign-in mid-load stops with NO_SESSION and keeps what was stored', async () => {
    const pages = happyPages();
    pages['/assignment/900/assessment_results/student_stats/703/5002'] = () => ({ status: 200, text: '<html>sign in</html>', finalUrl: 'https://login.microsoftonline.com/x' });
    await expect(loadGroup(db, { groupId }, { openPage: fakeOpenPage(pages).openPage, pauseMs: 0 }))
      .rejects.toMatchObject({ code: 'NO_SESSION' });
    expect(db.prepare('SELECT COUNT(*) n FROM quiz_attempts').get().n).toBe(1);
  });

  test('no saved session: NO_SESSION before any request', async () => {
    await expect(loadGroup(db, { groupId }, { openPage: async () => null, pauseMs: 0 })).rejects.toMatchObject({ code: 'NO_SESSION' });
  });

  test('a second load of the same group while one runs: BUSY', async () => {
    let release;
    const pages = happyPages();
    pages['/assignment/900/assessment_results'] = () => new Promise(r => { release = () => r({ status: 200, text: fx('results.html') }); });
    const f = fakeOpenPage(pages);
    const first = loadGroup(db, { groupId }, { openPage: f.openPage, pauseMs: 0 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(loadGroup(db, { groupId }, { openPage: f.openPage, pauseMs: 0 })).rejects.toMatchObject({ code: 'BUSY' });
    release();
    await first;
  });
});

describe('readQuestionLists', () => {
  test('one parsed list per test', async () => {
    const f = fakeOpenPage({ '/assignment/900/assessment_questions': { status: 200, text: fx('questions.html') } });
    const lists = await readQuestionLists(db, { assignmentRefs: ['900'] }, { openPage: f.openPage, pauseMs: 0 });
    expect(lists[0]).toMatchObject({ schoologyId: '900', title: 'T' });
    expect(lists[0].questions).toHaveLength(3);
  });
});

test('assertReadOnlyUrl refuses write-action paths', () => {
  expect(() => assertReadOnlyUrl('/assignment/1/assessment_results/student_stats/2/3/unsubmit')).toThrow();
  expect(() => assertReadOnlyUrl('/x/DELETE')).toThrow();
  expect(() => assertReadOnlyUrl('/assignment/1/assessment_results')).not.toThrow();
});
