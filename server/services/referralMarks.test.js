import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
// Never Schoology for real. The fake below behaves as the probes showed
// (.claude/schoology-api-reference.md "Grade exceptions (flags)").
vi.mock('./schoology.js', () => ({ getSectionGrades: vi.fn(), pushGradeUpdates: vi.fn() }));
vi.mock('./masterySync.js', () => ({ readPairLevels: vi.fn(), writeMasteryScores: vi.fn() }));

import { getDb } from '../db/index.js';
import { getSectionGrades, pushGradeUpdates } from './schoology.js';
import { readPairLevels, writeMasteryScores } from './masterySync.js';
import { referPair, undoReferralPair } from './referralMarks.js';
import { setGradeFlag, readFlagState } from './gradeFlags.js';
import { pairState } from './submissionTimeline.js';

let db, c, s, a;
let record; // the public grade record (null = none yet)
let levels; // Schoology's topic levels for the pair: { topicId: level }
let calls; // the order of Schoology calls

// Public PUT: 1, 2, 5, 6 remove the score and blank the levels; 3 sets 0 and keeps them;
// clearing Missing with grade: null blanks them too.
function applyPut(entry) {
  const was = Number(record?.exception) || 0;
  const next = { ...(record || { assignment_id: entry.assignment_id, enrollment_id: entry.enrollment_id, max_points: 100 }) };
  next.comment = entry.comment;
  next.comment_status = entry.comment_status;
  next.grade = entry.grade ?? null;
  next.exception = Number(entry.exception) || 0;
  if ([1, 2, 5, 6].includes(next.exception)) { next.grade = null; levels = {}; }
  if (next.exception === 3) next.grade = 0;
  if (was === 3 && next.exception === 0 && entry.grade == null) levels = {};
  record = next;
}

const POINTS = { ED: 100, EX: 75, D: 50, EM: 25, IE: 0 };
const referralRow = () => db.prepare('SELECT * FROM referrals WHERE student_id = ? AND assignment_id = ?').get(s, a) || null;
const markOf = () => JSON.parse(referralRow().schoology_mark);
const gradeRow = () => db.prepare('SELECT score, exception FROM grades WHERE student_id = ? AND assignment_id = ?').get(s, a);
const localLevels = () => db.prepare('SELECT topic_id, grade FROM mastery_scores WHERE student_uid = ? ORDER BY topic_id').all('u1');
const copyRow = () => db.prepare('SELECT * FROM excused_grades WHERE student_id = ? AND assignment_id = ?').get(s, a) || null;
const refer = (over = {}) => referPair(db, { studentId: s, assignmentId: a, schoology: true, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  db = getDb();
  db.exec(`DELETE FROM excused_grades; DELETE FROM assessment_drafts; DELETE FROM feedback_snapshots; DELETE FROM status_lines;
    DELETE FROM resubmissions; DELETE FROM referrals; DELETE FROM extensions; DELETE FROM linked_sections;
    DELETE FROM mastery_scores; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories;
    DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;`);
  c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec', 'AP CSP')`).run().lastInsertRowid;
  s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr')`).run(s, c);
  // Missing summative work, long past its due date: on the late-work list at the referral limit.
  a = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, accepts_submissions,
    mastery_grading_period_id, mastery_grading_category_id) VALUES (?, 'sa', 'CP2', '2020-01-06 15:30:00', 1, 'gp', 'gc')`).run(c).lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'X', 'C')`).run(c);
  for (const t of ['t1', 't2']) {
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES (?, 'cat', ?, ?, ?)`).run(t, c, `X.${t}`, `Topic ${t}`);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa', ?, ?)`).run(t, c);
  }
  record = null;
  levels = {};
  calls = [];
  getSectionGrades.mockImplementation(async () => { calls.push('read'); return record ? [{ ...record }] : []; });
  pushGradeUpdates.mockImplementation(async (_section, entries) => {
    calls.push(`put:${entries[0].exception}`);
    entries.forEach(applyPut);
    return { status: 207, data: { grades: { grade: entries.map(() => ({ response_code: 204 })) } } };
  });
  readPairLevels.mockImplementation(async () => { calls.push('levels'); return { ...levels }; });
  // The observations write replaces the pair's levels, clears 1, 2, 5, 6 and computes the score.
  writeMasteryScores.mockImplementation(async ({ gradeInfo }) => {
    calls.push('ie');
    levels = Object.fromEntries(Object.entries(gradeInfo).map(([id, g]) => [id, Object.keys(POINTS).find((k) => POINTS[k] === Number(g.grade))]));
    const pts = Object.values(gradeInfo).map((g) => Number(g.grade));
    record = { ...(record || { assignment_id: 'sa', enrollment_id: 'enr', max_points: 100, comment: '', comment_status: null }),
      exception: 0, grade: pts.reduce((x, y) => x + y, 0) / pts.length };
    return { ok: true };
  });
});

describe('referPair with the Schoology step', () => {
  test('missing work: IE on every topic, read back, then Missing; the referral carries its mark', async () => {
    const out = await refer();
    expect(calls).toEqual(['read', 'levels', 'ie', 'levels', 'read', 'read', 'put:3', 'read']);
    expect(writeMasteryScores).toHaveBeenCalledWith({
      sectionId: 'sec', enrollmentId: 'enr', assignmentId: 'sa', gradingPeriodId: 'gp', gradingCategoryId: 'gc',
      gradeInfo: { t1: { grade: '0', gradingScaleId: 21337256 }, t2: { grade: '0', gradingScaleId: 21337256 } },
    });
    expect(record).toMatchObject({ exception: 3, grade: 0 });
    expect(levels).toEqual({ t1: 'IE', t2: 'IE' });
    expect(out).toMatchObject({ action: 'referred', schoology: { topics: 2, missing: true } });
    expect(markOf()).toMatchObject({ topics: ['t1', 't2'], missing: true });
    expect(markOf().wasMissing).toBeUndefined();
    expect(gradeRow()).toMatchObject({ exception: 3, score: 0 });
    expect(localLevels()).toEqual([{ topic_id: 't1', grade: 'IE' }, { topic_id: 't2', grade: 'IE' }]);
    // The IEs are the referral's, not a grade: no copy is kept, so Restore never offers them.
    expect(copyRow()).toBeNull();
    expect(pairState(db, { studentId: s, assignmentId: a }).timeline.referral.schoology).toEqual({ topics: 2, missing: true, cleared: false });
  });

  test('a Late flag is cleared by the IE write, and Missing replaces it', async () => {
    record = { assignment_id: 'sa', enrollment_id: 'enr', max_points: 100, comment: '', comment_status: null, exception: 6, grade: null };
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, exception) VALUES (?, ?, 'enr', 6)`).run(s, a);
    await refer();
    expect(record).toMatchObject({ exception: 3, grade: 0 });
    expect(markOf().missing).toBe(true);
  });

  test('work already flagged Missing: Missing is cleared first, then IE, then Missing again (wasMissing)', async () => {
    record = { assignment_id: 'sa', enrollment_id: 'enr', max_points: 100, comment: '', comment_status: null, exception: 3, grade: 0 };
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception) VALUES (?, ?, 'enr', 0, 3)`).run(s, a);
    await refer();
    expect(calls.filter((x) => x.startsWith('put') || x === 'ie')).toEqual(['put:0', 'ie', 'put:3']);
    expect(pushGradeUpdates.mock.calls[0][1][0].grade).toBeNull(); // no 0 left counting
    expect(record).toMatchObject({ exception: 3, grade: 0 });
    expect(markOf()).toMatchObject({ missing: true, wasMissing: true });
    expect(copyRow()).toBeNull();
  });

  test.each([
    ['a score', () => { record = { assignment_id: 'sa', enrollment_id: 'enr', max_points: 100, comment: '', exception: 0, grade: 50 }; }],
    ['topic levels', () => { levels = { t1: 'D' }; }],
  ])('Schoology holds %s: refuses, writes nothing, records nothing', async (_name, arrange) => {
    arrange();
    await expect(refer()).rejects.toMatchObject({ code: 'CHANGED' });
    expect(writeMasteryScores).not.toHaveBeenCalled();
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    expect(referralRow()).toBeNull();
  });

  test('Exempt in Schoology: refuses', async () => {
    record = { assignment_id: 'sa', enrollment_id: 'enr', max_points: 100, comment: '', exception: 1, grade: null };
    await expect(refer()).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    expect(referralRow()).toBeNull();
  });

  test('handed-in work is never written (NOT_MISSING)', async () => {
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, submission_type, first_submitted_at, submitted_at, late)
      VALUES (?, ?, 'enr', 'file', ?, ?, 1)`).run(s, a, Date.parse('2020-03-02T10:00:00Z') / 1000, Date.parse('2020-03-02T10:00:00Z') / 1000);
    await expect(refer()).rejects.toMatchObject({ code: 'NOT_MISSING' });
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(referralRow()).toBeNull();
  });

  test('no grading period stored for the task: written as the card writes it (none), checked by the read-back', async () => {
    db.prepare('UPDATE assignments SET mastery_grading_period_id = NULL, mastery_grading_category_id = NULL WHERE id = ?').run(a);
    await refer();
    expect(writeMasteryScores).toHaveBeenCalledWith(expect.objectContaining({ gradingPeriodId: null, gradingCategoryId: null }));
    expect(markOf().missing).toBe(true);
  });

  test('a refused IE write records nothing', async () => {
    writeMasteryScores.mockRejectedValueOnce(new Error('HTTP 500'));
    await expect(refer()).rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED' });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    expect(referralRow()).toBeNull();
  });

  test('IE not read back on every topic: READBACK_MISMATCH, no Missing, no referral', async () => {
    writeMasteryScores.mockImplementationOnce(async () => { levels = { t1: 'IE' }; return {}; });
    await expect(refer()).rejects.toMatchObject({ code: 'READBACK_MISMATCH', message: expect.stringContaining('1 topic of 2') });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    expect(referralRow()).toBeNull();
  });

  test('Missing refused after IE: the referral is recorded (missing: false) with a warning', async () => {
    pushGradeUpdates.mockResolvedValueOnce({ status: 502, data: null });
    const out = await refer();
    expect(out.schoology).toMatchObject({ topics: 2, missing: false, warning: expect.stringContaining('Missing was not set') });
    expect(markOf().missing).toBe(false);
    expect(levels).toEqual({ t1: 'IE', t2: 'IE' });
  });

  test('without the Schoology step: a plain referral, no Schoology call', async () => {
    const out = await refer({ schoology: false });
    expect(out).toMatchObject({ action: 'referred', schoologyMark: null });
    expect(getSectionGrades).not.toHaveBeenCalled();
  });

  test('a linked section is refused before any read', async () => {
    db.prepare(`INSERT INTO linked_sections (course_id, schoology_section_id) VALUES (?, 'sec2')`).run(c);
    await expect(refer()).rejects.toMatchObject({ code: 'LINKED_SECTION' });
    expect(getSectionGrades).not.toHaveBeenCalled();
  });
});

describe('after a referral that wrote IE and Missing', () => {
  test('undo with the Schoology step: one clear removes Missing and the IEs; the referral goes', async () => {
    const r = await refer();
    calls = [];
    const out = await undoReferralPair(db, { id: r.id, schoology: true });
    expect(out).toEqual({ deleted: true, schoology: { cleared: true } });
    expect(calls.filter((x) => x.startsWith('put'))).toEqual(['put:0']);
    expect(pushGradeUpdates.mock.calls.at(-1)[1][0].grade).toBeNull();
    expect(record).toMatchObject({ exception: 0, grade: null });
    expect(levels).toEqual({});
    expect(localLevels()).toEqual([]);
    expect(referralRow()).toBeNull();
    expect(copyRow()).toBeNull();
  });

  test('undo puts back a Missing set before the referral', async () => {
    record = { assignment_id: 'sa', enrollment_id: 'enr', max_points: 100, comment: '', comment_status: null, exception: 3, grade: 0 };
    db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception) VALUES (?, ?, 'enr', 0, 3)`).run(s, a);
    const r = await refer();
    await undoReferralPair(db, { id: r.id, schoology: true });
    expect(record).toMatchObject({ exception: 3, grade: 0 });
    expect(levels).toEqual({});
  });

  test('undo refuses when Schoology changed since, and changes nothing', async () => {
    const r = await refer();
    levels.t2 = 'EX';
    pushGradeUpdates.mockClear();
    await expect(undoReferralPair(db, { id: r.id, schoology: true })).rejects.toMatchObject({ code: 'CHANGED' });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    expect(referralRow()).not.toBeNull();
    // Prism only still works.
    expect(await undoReferralPair(db, { id: r.id })).toEqual({ deleted: true });
  });

  test('clearing Missing from the Flags menu keeps no copy of the IEs, and spends the mark', async () => {
    await refer();
    const out = await setGradeFlag(db, { studentId: s, assignmentId: a, code: 0, expected: { exception: 3, score: 0 } });
    expect(out.saved).toBe(false);
    expect(copyRow()).toBeNull();
    expect(levels).toEqual({});
    expect(markOf().cleared).toEqual(expect.any(String));
    expect((await readFlagState(db, { studentId: s, assignmentId: a })).graded).toBe(false);
  });

  test('the Flags panel shows the pair as ungraded while the IEs stand', async () => {
    await refer();
    const st = await readFlagState(db, { studentId: s, assignmentId: a });
    expect(st).toMatchObject({ exception: 3, graded: false, gradeText: null });
  });

  test('Exempt over the referral: no copy of the IEs, and the referral is withdrawn', async () => {
    await refer();
    const out = await setGradeFlag(db, { studentId: s, assignmentId: a, code: 1, expected: { exception: 3, score: 0 } });
    expect(copyRow()).toBeNull();
    expect(out.withdrawn.map((w) => w.type)).toEqual(['referral']);
    expect(referralRow()).toBeNull();
  });
});
