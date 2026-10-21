import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
// Flags are written to Schoology: never for real. The fake below behaves as the live probes
// showed (.claude/schoology-api-reference.md "Grade exceptions (flags)").
vi.mock('./schoology.js', () => ({ getSectionGrades: vi.fn(), pushGradeUpdates: vi.fn() }));
// Clearing Missing reads the pair's topic levels fresh from Schoology (#40): never for real.
vi.mock('./masterySync.js', () => ({ readPairLevels: vi.fn() }));

import { getDb } from '../db/index.js';
import { getSectionGrades, pushGradeUpdates } from './schoology.js';
import { readPairLevels } from './masterySync.js';
import { readFlagState, setGradeFlag, retireCopy } from './gradeFlags.js';
import { cardBaselineFor } from './unfinishedGrading.js';
import { saveRubric } from './rubricStore.js';
import { flagLine } from '../lib/statusLines.js';
import { todayLocal } from '../lib/schoolDays.js';

let db, c, s, a;
let record; // the pair's Schoology grade record (null = none yet)

// Schoology as probed: 1, 2, 5, 6 remove the score (and every topic level); 3 sets it to 0 and
// keeps the levels; 0 clears and leaves the score as sent; the comment always stays.
function applyPut(entry) {
  const next = { ...(record || { assignment_id: entry.assignment_id, enrollment_id: entry.enrollment_id, max_points: 100 }) };
  next.comment = entry.comment;
  next.comment_status = entry.comment_status;
  next.grade = entry.grade ?? null;
  if ('exception' in entry) next.exception = Number(entry.exception) || 0;
  if ([1, 2, 5, 6].includes(next.exception)) next.grade = null;
  if (next.exception === 3) next.grade = 0;
  record = next;
}

const sent = (i = 0) => pushGradeUpdates.mock.calls[i][1][0];
const gradeRow = () => db.prepare('SELECT score, exception, grade_comment, comment_status FROM grades WHERE student_id = ? AND assignment_id = ?').get(s, a);
const copyRow = () => db.prepare('SELECT * FROM excused_grades WHERE student_id = ? AND assignment_id = ?').get(s, a) || null;
const draftRow = () => {
  const r = db.prepare('SELECT draft_json, enrolment_id FROM assessment_drafts WHERE student_id = ? AND assignment_id = ?').get(s, a);
  return r ? { ...JSON.parse(r.draft_json), enrolment_id: r.enrolment_id } : null;
};
const storedLine = () => db.prepare('SELECT line, kind, source_type, source_id FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(s, a) || null;
const levels = () => db.prepare('SELECT topic_id, grade FROM mastery_scores WHERE student_uid = ? ORDER BY topic_id').all('u1');
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const flag = (code, over = {}) => setGradeFlag(db, {
  studentId: s, assignmentId: a, code, expected: { exception: record?.exception ?? 0, score: record?.grade ?? null }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db = getDb();
  db.exec(`DELETE FROM excused_grades; DELETE FROM assessment_drafts; DELETE FROM feedback_snapshots; DELETE FROM status_lines;
    DELETE FROM resubmissions; DELETE FROM referrals; DELETE FROM extensions; DELETE FROM rubric_row_levels;
    DELETE FROM rubric_attachments; DELETE FROM rubric_descriptors; DELETE FROM rubric_criteria; DELETE FROM rubrics;
    DELETE FROM mastery_scores; DELETE FROM mastery_alignments; DELETE FROM measurement_topics; DELETE FROM reporting_categories;
    DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;`);
  c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec', 'AP CSP')`).run().lastInsertRowid;
  s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr')`).run(s, c);
  a = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date) VALUES (?, 'sa', 'CP2', '2026-10-20 15:30:00')`).run(c).lastInsertRowid;
  // Aligned to two topics, both at Exhibiting: Schoology's computed score is 75.
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'X', 'C')`).run(c);
  for (const t of ['t1', 't2']) {
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES (?, 'cat', ?, ?, ?)`).run(t, c, `X.${t}`, `Topic ${t}`);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa', ?, ?)`).run(t, c);
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'sa', ?, 75, 'EX')`).run(t);
  }
  db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception, grade_comment, comment_status) VALUES (?, ?, 'enr', 75, 0, 'Good work.', 1)`).run(s, a);
  record = { assignment_id: 'sa', enrollment_id: 'enr', grade: 75, exception: 0, max_points: 100, comment: 'Good work.', comment_status: 1 };
  getSectionGrades.mockImplementation(async () => (record ? [{ ...record, enrollment_id: 'other' }, { ...record }] : []));
  // By default Schoology holds what Prism last read: the pair's local topic levels.
  readPairLevels.mockImplementation(async () => Object.fromEntries(levels().map((r) => [r.topic_id, r.grade])));
  pushGradeUpdates.mockImplementation(async (_section, entries) => {
    entries.forEach(applyPut);
    return { status: 207, data: { grades: { grade: entries.map(() => ({ response_code: 204 })) } } };
  });
});

describe('setGradeFlag: setting a flag', () => {
  test('stores the copy before the PUT, sends the code with every other field echoed, reads back, mirrors', async () => {
    let copyAtPut = null;
    pushGradeUpdates.mockImplementationOnce(async (_section, entries) => {
      copyAtPut = copyRow();
      entries.forEach(applyPut);
      return { status: 207, data: { grades: { grade: [{ response_code: 204 }] } } };
    });
    const out = await flag(1);
    expect(copyAtPut).toMatchObject({ flag: 1, restored_at: null });
    expect(JSON.parse(copyAtPut.saved_json)).toEqual({
      score: 75, max_points: 100, comment: 'Good work.', comment_status: 1, topics: { t1: 'EX', t2: 'EX' }, rows: {}, scale_level: null,
    });
    expect(pushGradeUpdates).toHaveBeenCalledTimes(1);
    expect(pushGradeUpdates.mock.calls[0][0]).toBe('sec');
    expect(sent()).toEqual({ assignment_id: 'sa', enrollment_id: 'enr', comment: 'Good work.', comment_status: 1, grade: '75', exception: 1 });
    expect(getSectionGrades).toHaveBeenCalledTimes(2); // the fresh read, then the read-back
    expect(gradeRow()).toMatchObject({ score: null, exception: 1, grade_comment: 'Good work.', comment_status: 1 });
    // Schoology blanked every topic level (probe): Prism's mirror drops them; the copy keeps them.
    expect(levels()).toEqual([]);
    expect(out).toMatchObject({ exception: 1, saved: true, withdrawn: [], line: null, restored: null });
  });

  test.each([2, 5, 6])('code %i removes the score: read-back score null mirrored', async (code) => {
    const out = await flag(code);
    expect(sent().exception).toBe(code);
    expect(gradeRow()).toMatchObject({ score: null, exception: code });
    expect(copyRow()).toMatchObject({ flag: code });
    expect(out.exception).toBe(code);
  });

  test('Missing (3): the read-back 0 is mirrored and the levels stay', async () => {
    await flag(3);
    expect(gradeRow()).toMatchObject({ score: 0, exception: 3 });
    expect(levels()).toHaveLength(2);
    expect(JSON.parse(copyRow().saved_json).score).toBe(75);
  });

  test('an ungraded pair keeps no copy (saved: false) and still writes the flag', async () => {
    db.exec('DELETE FROM mastery_scores');
    db.prepare('UPDATE grades SET score = NULL').run();
    record = { ...record, grade: null };
    const out = await flag(1);
    expect(out.saved).toBe(false);
    expect(copyRow()).toBeNull();
    expect(sent()).toEqual({ assignment_id: 'sa', enrollment_id: 'enr', comment: 'Good work.', comment_status: 1, exception: 1 });
    expect(gradeRow().exception).toBe(1);
  });

  test('no Schoology record yet: a comment-free flag write', async () => {
    db.exec('DELETE FROM mastery_scores; DELETE FROM grades');
    record = null;
    const out = await setGradeFlag(db, { studentId: s, assignmentId: a, code: 1, expected: { exception: 0, score: null } });
    expect(sent()).toEqual({ assignment_id: 'sa', enrollment_id: 'enr', comment: '', comment_status: null, exception: 1 });
    expect(out).toMatchObject({ exception: 1, saved: false });
    expect(gradeRow()).toMatchObject({ exception: 1, score: null });
  });

  test('a flag replacing a flag keeps the first copy (the grade the first flag removed)', async () => {
    await flag(6);
    const first = copyRow().saved_json;
    const out = await flag(1);
    expect(out.saved).toBe(true);
    expect(copyRow()).toMatchObject({ flag: 1, saved_json: first });
  });

  describe('a waiting copy against a grade that changed since', () => {
    // Exempt over EX/EX (75), cleared without restoring: copy A waits. The teacher regrades ED/ED (100).
    beforeEach(async () => {
      await flag(1);
      await flag(0, { restore: false });
      expect(JSON.parse(copyRow().saved_json).topics).toEqual({ t1: 'EX', t2: 'EX' });
      for (const t of ['t1', 't2']) db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'sa', ?, 100, 'ED')`).run(t);
      record = { ...record, grade: 100 };
      db.prepare('UPDATE grades SET score = 100').run();
    });

    test('Missing set outside Prism (levels kept), then Exempt: the new copy holds ED/ED, not copy A', async () => {
      record = { ...record, exception: 3, grade: 0 };
      db.prepare('UPDATE grades SET exception = 3, score = 0').run();
      await flag(1);
      expect(JSON.parse(copyRow().saved_json)).toMatchObject({ score: null, topics: { t1: 'ED', t2: 'ED' } });
      expect(copyRow()).toMatchObject({ flag: 1, restored_at: null });
      const out = await flag(0);
      expect(out.restored).toEqual({ draft: true, notRestored: [] });
      expect(draftRow().pending).toEqual({ t1: 'ED', t2: 'ED' });
    });

    test('Late set outside Prism (local levels not yet dropped), then Exempt: the new copy holds ED/ED', async () => {
      record = { ...record, exception: 6, grade: null };
      db.prepare('UPDATE grades SET exception = 6, score = NULL').run();
      await flag(1);
      expect(JSON.parse(copyRow().saved_json)).toMatchObject({ score: null, topics: { t1: 'ED', t2: 'ED' } });
      expect(levels()).toEqual([]); // held by the new copy, so the mirror may drop them
    });

    test('a regrade then Exempt in Prism: the new grade replaces copy A', async () => {
      await flag(1);
      expect(JSON.parse(copyRow().saved_json)).toMatchObject({ score: 100, topics: { t1: 'ED', t2: 'ED' } });
    });
  });

  test('a waiting copy that holds everything now is kept (nothing regraded since)', async () => {
    await flag(1);
    await flag(0, { restore: false });
    const first = copyRow().saved_json;
    await flag(6);
    expect(copyRow()).toMatchObject({ flag: 6, saved_json: first });
  });

  test('storing the copy fails: no PUT, error thrown, nothing changed', async () => {
    db.exec(`CREATE TRIGGER fail_copy BEFORE INSERT ON excused_grades BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    try {
      await expect(flag(1)).rejects.toMatchObject({ code: 'SAVE_FAILED' });
    } finally {
      db.exec('DROP TRIGGER fail_copy');
    }
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    expect(gradeRow()).toMatchObject({ score: 75, exception: 0 });
    expect(levels()).toHaveLength(2);
  });

  test('the fresh exception or score differs from expected: CHANGED (names it), no PUT', async () => {
    record = { ...record, exception: 6, grade: null };
    await expect(setGradeFlag(db, { studentId: s, assignmentId: a, code: 1, expected: { exception: 0, score: 75 } }))
      .rejects.toMatchObject({ code: 'CHANGED', message: expect.stringMatching(/flag.*Late.*score/s) });
    record = { ...record, exception: 0, grade: 50 };
    await expect(setGradeFlag(db, { studentId: s, assignmentId: a, code: 1, expected: { exception: 0, score: 75 } }))
      .rejects.toMatchObject({ code: 'CHANGED', message: expect.stringMatching(/score.*50/) });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    expect(copyRow()).toBeNull();
  });

  test('a score that differs only as string vs number is not a change', async () => {
    record = { ...record, grade: '75' };
    await expect(setGradeFlag(db, { studentId: s, assignmentId: a, code: 1, expected: { exception: '0', score: 75 } })).resolves.toMatchObject({ exception: 1 });
  });

  test('read-back shows the old exception and score (Schoology wrote nothing): READBACK_MISMATCH, grades unchanged, copy rolled back', async () => {
    pushGradeUpdates.mockResolvedValueOnce({ status: 207, data: { grades: { grade: [{ response_code: 204 }] } } }); // accepted, changed nothing
    await expect(flag(1)).rejects.toMatchObject({ code: 'READBACK_MISMATCH' });
    expect(gradeRow()).toMatchObject({ score: 75, exception: 0 });
    expect(levels()).toHaveLength(2);
    expect(copyRow()).toBeNull();
  });

  test('read-back that wrote nothing puts back the earlier waiting copy exactly', async () => {
    await flag(6);
    await flag(0, { restore: false });
    const kept = copyRow();
    pushGradeUpdates.mockResolvedValueOnce({ status: 207, data: {} });
    await expect(flag(1)).rejects.toMatchObject({ code: 'READBACK_MISMATCH' });
    expect(copyRow()).toEqual(kept);
  });

  test('read-back that shows some other change: READBACK_MISMATCH, grades unchanged, copy kept', async () => {
    pushGradeUpdates.mockImplementationOnce(async (_section, entries) => {
      entries.forEach((e) => applyPut({ ...e, exception: 2 })); // something else landed
      return { status: 207, data: {} };
    });
    await expect(flag(1)).rejects.toMatchObject({ code: 'READBACK_MISMATCH' });
    expect(gradeRow()).toMatchObject({ score: 75, exception: 0 });
    expect(copyRow()).toMatchObject({ flag: 1, restored_at: null });
  });

  test('a failed read-back: READBACK_MISMATCH, grades unchanged, copy kept', async () => {
    getSectionGrades.mockImplementationOnce(async () => [{ ...record }]).mockRejectedValueOnce(new Error('timeout'));
    await expect(flag(1)).rejects.toMatchObject({ code: 'READBACK_MISMATCH' });
    expect(gradeRow()).toMatchObject({ score: 75, exception: 0 });
    expect(copyRow()).not.toBeNull();
  });

  test.each([
    ['a 502 answer', { status: 502, data: '<html>CloudFront</html>' }],
    ['a 207 with a per-entry 400', { status: 207, data: { grades: { grade: [{ response_code: 400, message: 'Invalid exception code' }] } } }],
  ])('%s: SCHOOLOGY_WRITE_FAILED, nothing mirrored, no copy left behind', async (_label, answer) => {
    pushGradeUpdates.mockResolvedValueOnce(answer);
    await expect(flag(1)).rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED' });
    expect(pushGradeUpdates).toHaveBeenCalledTimes(1); // never retried
    expect(gradeRow()).toMatchObject({ score: 75, exception: 0 });
    expect(levels()).toHaveLength(2);
    expect(copyRow()).toBeNull();
  });

  test('a failed write puts back the copy that was there before', async () => {
    await flag(6);
    await flag(0, { restore: false });
    const kept = copyRow();
    record = { ...record, grade: 50 }; // regraded since: a new grade to save
    db.prepare('UPDATE grades SET score = 50').run();
    pushGradeUpdates.mockRejectedValueOnce(new Error('network'));
    await expect(flag(1)).rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED' });
    expect(copyRow()).toEqual(kept);
  });
});

describe('setGradeFlag: withdrawing records', () => {
  let extId, reqId, refId;
  beforeEach(() => {
    extId = db.prepare(`INSERT INTO extensions (student_id, assignment_id, course_id, lessons, until) VALUES (?, ?, ?, 3, '2026-10-23')`).run(s, a, c).lastInsertRowid;
    reqId = db.prepare(`INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons, until) VALUES (?, ?, ?, 'request', 'open', datetime('now'), 3, '2026-10-27')`).run(s, a, c).lastInsertRowid;
    refId = db.prepare(`INSERT INTO referrals (student_id, assignment_id, course_id, action, days_late) VALUES (?, ?, ?, 'referred', 12)`).run(s, a, c).lastInsertRowid;
  });

  test.each([1])('code %i (Exempt) undoes the open extension, request and referral (record only) and lists them', async (code) => {
    const out = await flag(code);
    expect(out.withdrawn).toEqual([
      { type: 'extension', id: extId, label: 'Extension to Fri 23/10/2026' },
      { type: 'resubmission', id: reqId, label: 'Resubmission request, due Tue 27/10/2026' },
      { type: 'referral', id: refId, label: 'Referral' },
    ]);
    expect(count('extensions')).toBe(0);
    expect(count('resubmissions')).toBe(0);
    expect(count('referrals')).toBe(0);
    expect(pushGradeUpdates).toHaveBeenCalledTimes(1); // the flag only: no line to change
  });

  test('a make-up (an extension on a test) is labelled as one', async () => {
    db.prepare('UPDATE assignments SET is_test = 1 WHERE id = ?').run(a);
    const out = await flag(1);
    expect(out.withdrawn[0]).toEqual({ type: 'extension', id: extId, label: 'Make-up by Fri 23/10/2026' });
  });

  test.each([6, 2, 3, 5])('code %i withdraws nothing (Absent is a marker, not a decision)', async (code) => {
    const out = await flag(code);
    expect(out.withdrawn).toEqual([]);
    expect(count('extensions') + count('resubmissions') + count('referrals')).toBe(3);
  });

  test('a closed request is not withdrawn', async () => {
    db.prepare(`UPDATE resubmissions SET status = 'closed', close_note = 'grade stands'`).run();
    const out = await flag(1);
    expect(out.withdrawn.map((w) => w.type)).toEqual(['extension', 'referral']);
    expect(count('resubmissions')).toBe(1);
  });

  test('without a reason, the stored line of a withdrawn record is removed', async () => {
    const line = 'Extension - now due Fri 23/10 (3 school days).';
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind, source_type, source_id) VALUES (?, ?, ?, 'extension', 'extension', ?)`).run(s, a, line, extId);
    record = { ...record, comment: `${line}\n\nGood work.` };
    const out = await flag(1);
    expect(out.line).toEqual({ removed: true });
    expect(pushGradeUpdates).toHaveBeenCalledTimes(2);
    expect(sent(1)).toMatchObject({ comment: 'Good work.', exception: 1 });
    expect(storedLine()).toBeNull();
  });

  test('without a reason, a line Prism did not publish for a withdrawn record stays', async () => {
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, 'Make-up - sit by Fri 23/10.', 'make_up')`).run(s, a);
    record = { ...record, comment: 'Make-up - sit by Fri 23/10.\n\nGood work.' };
    const out = await flag(6);
    expect(out.line).toBeNull();
    expect(pushGradeUpdates).toHaveBeenCalledTimes(1);
    expect(storedLine()).not.toBeNull();
  });

  test('with a reason: one publishStatusLine (kind flag) that replaces the stored line', async () => {
    const old = 'Extension - now due Fri 23/10 (3 school days).';
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind, source_type, source_id) VALUES (?, ?, ?, 'extension', 'extension', ?)`).run(s, a, old, extId);
    record = { ...record, comment: `${old}\n\nGood work.` };
    const out = await flag(1, { reason: 'Medical leave from 13 to 24 October.' });
    const line = flagLine({ code: 1, on: todayLocal(), note: 'Medical leave from 13 to 24 October.' });
    expect(out.line).toEqual({ published: true, line });
    expect(pushGradeUpdates).toHaveBeenCalledTimes(2);
    expect(sent(1)).toEqual({ assignment_id: 'sa', enrollment_id: 'enr', comment: `${line}\n\nGood work.`, comment_status: 1, exception: 1 });
    expect(storedLine()).toMatchObject({ line, kind: 'flag', source_type: null });
    expect(gradeRow()).toMatchObject({ exception: 1, grade_comment: `${line}\n\nGood work.` });
  });

  test('publishing the line fails after the flag write: the result has the new exception and line.error; records stay withdrawn', async () => {
    pushGradeUpdates
      .mockImplementationOnce(async (_section, entries) => { entries.forEach(applyPut); return { status: 207, data: {} }; })
      .mockResolvedValueOnce({ status: 500, data: 'oops' });
    const out = await flag(1, { reason: 'Medical leave.' });
    expect(out.exception).toBe(1);
    expect(out.line).toMatchObject({ error: expect.any(String), code: 'SCHOOLOGY_WRITE_FAILED' });
    expect(out.withdrawn).toHaveLength(3);
    expect(count('extensions') + count('resubmissions') + count('referrals')).toBe(0);
    expect(gradeRow().exception).toBe(1);
    expect(storedLine()).toBeNull();
  });

  test('a reason that is not plain text is refused before anything is read', async () => {
    await expect(flag(1, { reason: 'café ⟳' })).rejects.toMatchObject({ code: 'BAD_LINE' });
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(count('extensions')).toBe(1);
  });
});

describe('setGradeFlag: clearing', () => {
  test('restores the saved copy as the card\'s draft, with a base the card accepts', async () => {
    await flag(1);
    db.prepare(`INSERT INTO assessment_drafts (assignment_id, student_id, enrolment_id, draft_json) VALUES (?, ?, 'enr', '{"pending":{"t1":"IE"},"comment":"old","base":"x"}')`).run(a, s);
    const out = await flag(0, { restore: true });
    expect(sent(1)).toEqual({ assignment_id: 'sa', enrollment_id: 'enr', comment: 'Good work.', comment_status: 1, exception: 0 });
    expect(gradeRow()).toMatchObject({ score: null, exception: 0 });
    const draft = draftRow();
    const aRow = db.prepare('SELECT * FROM assignments WHERE id = ?').get(a);
    expect(draft).toEqual({
      pending: { t1: 'EX', t2: 'EX' }, comment: 'Good work.', display: true, displayTouched: false,
      base: cardBaselineFor(db, aRow)({ schoology_uid: 'u1' }), enrolment_id: 'enr',
    });
    expect(out).toMatchObject({ exception: 0, restored: { draft: true, notRestored: [] } });
    expect(copyRow().restored_at).not.toBeNull();
    expect(count('assessment_drafts')).toBe(1);
  });

  test('a saved overall that differs from the levels\' computed score is listed, not staged', async () => {
    record = { ...record, grade: 90 }; // 90 typed over two levels of 75
    db.prepare('UPDATE grades SET score = 90').run();
    await flag(1);
    const out = await flag(0);
    expect(out.restored).toEqual({ draft: true, notRestored: ['90'] });
    expect(draftRow().pending).toEqual({ t1: 'EX', t2: 'EX' });
  });

  test('a points-only task: the score is listed (nothing the card can stage), no draft', async () => {
    db.exec('DELETE FROM mastery_scores; DELETE FROM mastery_alignments');
    await flag(1);
    const out = await flag(0);
    expect(out.restored).toEqual({ draft: false, notRestored: ['75'] });
    expect(draftRow()).toBeNull();
    // Nothing staged: the copy stays waiting, so "Restore saved grade" is still offered.
    expect(copyRow().restored_at).toBeNull();
    expect(out.saved).toBe(true);
    const again = await flag(0);
    expect(again.restored).toEqual({ draft: false, notRestored: ['75'] });
    expect(pushGradeUpdates).toHaveBeenCalledTimes(2); // the restore-only path writes nothing
  });

  test('a score-scale task with feedback rows: row: and __scale__ levels staged', async () => {
    db.exec('DELETE FROM mastery_scores; DELETE FROM mastery_alignments');
    db.prepare('UPDATE assignments SET grading_scale_id = 23495360 WHERE id = ?').run(a);
    const rubricId = saveRubric(db, { name: 'Flappy', source: 'mcp', criteria: [{ position: 1, criterion_name: 'Playtesting' }, { position: 2, criterion_name: 'Code' }] });
    db.prepare(`INSERT INTO rubric_attachments (rubric_id, assignment_schoology_id, course_id, created_at) VALUES (?, 'sa', ?, 'now')`).run(rubricId, c);
    db.prepare(`INSERT INTO rubric_row_levels (assignment_schoology_id, student_uid, criterion_name, level) VALUES ('sa', 'u1', 'Playtesting', 'EX'), ('sa', 'u1', 'Code', 'D')`).run();
    await flag(5);
    expect(JSON.parse(copyRow().saved_json)).toMatchObject({ score: 75, topics: {}, rows: { Playtesting: 'EX', Code: 'D' }, scale_level: 'EX' });
    const out = await flag(0);
    const aRow = db.prepare('SELECT * FROM assignments WHERE id = ?').get(a);
    expect(draftRow()).toMatchObject({
      pending: { 'row:Playtesting': 'EX', 'row:Code': 'D', __scale__: 'EX' },
      base: cardBaselineFor(db, aRow)({ schoology_uid: 'u1' }),
    });
    expect(out.restored).toEqual({ draft: true, notRestored: [] });
  });

  test('a score-scale task whose score is not a level\'s points: listed, not staged', async () => {
    db.exec('DELETE FROM mastery_scores; DELETE FROM mastery_alignments');
    db.prepare('UPDATE assignments SET grading_scale_id = 23495360 WHERE id = ?').run(a);
    record = { ...record, grade: 90 };
    db.prepare('UPDATE grades SET score = 90').run();
    await flag(1);
    const out = await flag(0);
    expect(out.restored).toEqual({ draft: false, notRestored: ['90'] });
  });

  test('restore: false keeps the copy with restored_at null and writes no draft', async () => {
    await flag(1);
    const out = await flag(0, { restore: false });
    expect(out.restored).toBeNull();
    expect(copyRow()).toMatchObject({ restored_at: null });
    expect(draftRow()).toBeNull();
  });

  test('clearing removes the flag status line', async () => {
    await flag(6, { reason: 'Handed in after the deadline.' });
    const line = storedLine().line;
    expect(record.comment).toBe(`${line}\n\nGood work.`);
    const out = await flag(0, { restore: false });
    expect(out.line).toEqual({ removed: true });
    expect(storedLine()).toBeNull();
    expect(record).toMatchObject({ exception: 0, comment: 'Good work.' });
  });

  test('clearing Missing sends grade: null, so no 0 is left counting (probe dd0509e), and drops the blanked levels', async () => {
    await flag(3);
    await flag(0, { restore: false });
    expect(sent(1)).toEqual({ assignment_id: 'sa', enrollment_id: 'enr', comment: 'Good work.', comment_status: 1, grade: null, exception: 0 });
    expect(gradeRow()).toMatchObject({ score: null, exception: 0 });
    // Schoology blanks the levels Missing kept: Prism's mirror drops them, the copy holds them.
    expect(levels()).toEqual([]);
    expect(JSON.parse(copyRow().saved_json).topics).toEqual({ t1: 'EX', t2: 'EX' });
    expect(copyRow().restored_at).toBeNull();
  });

  test('clearing Missing: levels graded since the flag (not in the copy) are saved into it before the PUT, then restored', async () => {
    db.exec('DELETE FROM mastery_scores');
    db.prepare('UPDATE grades SET score = NULL').run();
    record = { ...record, grade: null };
    await flag(3); // ungraded: no copy
    expect(copyRow()).toBeNull();
    // Missing keeps levels: the teacher's levels land beside it (e.g. set in Schoology's own gradebook).
    for (const t of ['t1', 't2']) db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'sa', ?, 100, 'ED')`).run(t);
    let copyAtPut = null;
    pushGradeUpdates.mockImplementationOnce(async (_section, entries) => {
      copyAtPut = copyRow();
      entries.forEach(applyPut);
      return { status: 207, data: { grades: { grade: [{ response_code: 204 }] } } };
    });
    const out = await flag(0);
    expect(sent(1)).toMatchObject({ grade: null, exception: 0 });
    expect(copyAtPut).toMatchObject({ flag: 3, restored_at: null });
    expect(JSON.parse(copyAtPut.saved_json)).toMatchObject({ score: null, topics: { t1: 'ED', t2: 'ED' } });
    expect(out.restored).toEqual({ draft: true, notRestored: [] });
    expect(draftRow().pending).toEqual({ t1: 'ED', t2: 'ED' });
    expect(levels()).toEqual([]);
  });

  test('clearing Missing: levels entered in Schoology since Prism last read them are read fresh and saved before the PUT', async () => {
    db.exec('DELETE FROM mastery_scores');
    db.prepare('UPDATE grades SET score = NULL').run();
    record = { ...record, grade: null };
    await flag(3); // ungraded locally: no copy
    readPairLevels.mockResolvedValueOnce({ t1: 'D', t2: 'EM' }); // only in Schoology
    let copyAtPut = null;
    pushGradeUpdates.mockImplementationOnce(async (_section, entries) => {
      copyAtPut = copyRow();
      entries.forEach(applyPut);
      return { status: 207, data: {} };
    });
    await flag(0, { restore: false });
    expect(readPairLevels).toHaveBeenLastCalledWith({ sectionId: 'sec', studentUid: 'u1', assignmentId: 'sa', topicIds: ['t1', 't2'] });
    expect(copyAtPut).toMatchObject({ flag: 3, restored_at: null });
    expect(JSON.parse(copyAtPut.saved_json).topics).toEqual({ t1: 'D', t2: 'EM' });
  });

  test('clearing Missing: Schoology\'s fresh levels win over stale local ones in the copy, and every local level of the pair goes', async () => {
    db.exec('DELETE FROM mastery_scores');
    db.prepare('UPDATE grades SET score = NULL').run();
    record = { ...record, grade: null };
    await flag(3);
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'sa', 't1', 25, 'EM')`).run(); // stale
    readPairLevels.mockResolvedValueOnce({ t1: 'ED' });
    await flag(0, { restore: false });
    expect(JSON.parse(copyRow().saved_json).topics).toEqual({ t1: 'ED' });
    expect(levels()).toEqual([]);
  });

  test('clearing Missing: the fresh level read fails: SCHOOLOGY_READ_FAILED, nothing written', async () => {
    await flag(3);
    pushGradeUpdates.mockClear();
    const before = copyRow();
    readPairLevels.mockRejectedValueOnce(new Error('Not logged in to Schoology'));
    await expect(flag(0)).rejects.toMatchObject({ code: 'SCHOOLOGY_READ_FAILED' });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    expect(copyRow()).toEqual(before);
    expect(gradeRow()).toMatchObject({ exception: 3 });
  });

  test('clearing Missing on a task with no topics reads no levels', async () => {
    db.exec('DELETE FROM mastery_scores; DELETE FROM mastery_alignments');
    await flag(3);
    await flag(0, { restore: false });
    expect(readPairLevels).not.toHaveBeenCalled();
    expect(sent(1)).toMatchObject({ grade: null, exception: 0 });
  });

  test('clearing Missing: Schoology cleared the flag but kept its 0: READBACK_MISMATCH, local levels and row kept', async () => {
    await flag(3);
    pushGradeUpdates.mockImplementationOnce(async (_section, entries) => {
      entries.forEach((e) => applyPut({ ...e, grade: '0' })); // the 0 stayed
      return { status: 207, data: {} };
    });
    await expect(flag(0, { restore: false })).rejects.toMatchObject({ code: 'READBACK_MISMATCH', message: expect.stringMatching(/0/) });
    expect(levels()).toHaveLength(2);
    expect(gradeRow()).toMatchObject({ score: 0, exception: 3 });
    expect(copyRow()).not.toBeNull();
  });

  test('clearing Missing with a waiting copy that holds everything keeps that copy as it is', async () => {
    await flag(3);
    const first = copyRow();
    await flag(0, { restore: false });
    expect(copyRow()).toMatchObject({ flag: 3, saved_json: first.saved_json, restored_at: null });
  });

  test('clearing Missing fails at Schoology: the copy is put back, levels and the 0 stay', async () => {
    db.exec('DELETE FROM mastery_scores');
    db.prepare('UPDATE grades SET score = NULL').run();
    record = { ...record, grade: null };
    await flag(3);
    for (const t of ['t1', 't2']) db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'sa', ?, 100, 'ED')`).run(t);
    pushGradeUpdates.mockResolvedValueOnce({ status: 502, data: 'down' });
    await expect(flag(0)).rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED' });
    expect(copyRow()).toBeNull();
    expect(levels()).toHaveLength(2);
    expect(gradeRow()).toMatchObject({ score: 0, exception: 3 });
  });

  test('clearing another flag never sends grade: null', async () => {
    await flag(6);
    await flag(0, { restore: false });
    expect(sent(1)).not.toHaveProperty('grade');
    expect(sent(1).exception).toBe(0);
  });

  test('restore with no flag set: restores the kept copy without a write', async () => {
    await flag(1);
    await flag(0, { restore: false });
    pushGradeUpdates.mockClear();
    const out = await flag(0, { restore: true });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    expect(out.restored).toEqual({ draft: true, notRestored: [] });
    expect(draftRow().pending).toEqual({ t1: 'EX', t2: 'EX' });
  });

  test('clearing with nothing to clear or restore: NOT_ELIGIBLE, no write', async () => {
    await expect(flag(0)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });
});

describe('setGradeFlag: refusals', () => {
  test('two overlapping calls on one pair: the second rejects BUSY before any read', async () => {
    let release;
    getSectionGrades.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([{ ...record }]); }));
    const first = flag(1);
    await vi.waitFor(() => expect(getSectionGrades).toHaveBeenCalledTimes(1));
    await expect(flag(6)).rejects.toMatchObject({ code: 'BUSY' });
    expect(getSectionGrades).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toMatchObject({ exception: 1 });
    await expect(flag(0, { restore: false })).resolves.toMatchObject({ exception: 0 }); // the lock was released
  });

  test('an archived or excluded course: NOT_ELIGIBLE, nothing read', async () => {
    db.prepare('UPDATE courses SET archived = 1').run();
    await expect(flag(1)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    db.prepare('UPDATE courses SET archived = 0, excluded = 1').run();
    await expect(flag(1)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    expect(getSectionGrades).not.toHaveBeenCalled();
  });

  test('no current enrolment: NOT_ELIGIBLE', async () => {
    db.prepare(`UPDATE enrolments SET dropped_at = datetime('now')`).run();
    await expect(flag(1)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    expect(getSectionGrades).not.toHaveBeenCalled();
  });

  test.each([4, -1, 7, 'late', null, 1.5])('code %s: BAD_VALUE', async (code) => {
    await expect(flag(code)).rejects.toMatchObject({ code: 'BAD_VALUE' });
    expect(getSectionGrades).not.toHaveBeenCalled();
  });

  test('missing expected: BAD_VALUE', async () => {
    await expect(setGradeFlag(db, { studentId: s, assignmentId: a, code: 1 })).rejects.toMatchObject({ code: 'BAD_VALUE' });
  });

  test('the flag already set: NOT_ELIGIBLE, no write', async () => {
    await flag(1);
    pushGradeUpdates.mockClear();
    await expect(flag(1)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });

  test('unknown student or assignment: NOT_FOUND', async () => {
    await expect(setGradeFlag(db, { studentId: 999, assignmentId: a, code: 1, expected: { exception: 0, score: 75 } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setGradeFlag(db, { studentId: s, assignmentId: 999, code: 1, expected: { exception: 0, score: 75 } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('a failed fresh read: SCHOOLOGY_READ_FAILED, no copy, no PUT', async () => {
    getSectionGrades.mockRejectedValueOnce(new Error('down'));
    await expect(flag(1)).rejects.toMatchObject({ code: 'SCHOOLOGY_READ_FAILED' });
    expect(copyRow()).toBeNull();
    expect(pushGradeUpdates).not.toHaveBeenCalled();
  });
});

describe('readFlagState', () => {
  test('the fresh record, whether it is graded, the saved copy, open records and draft', async () => {
    const extId = db.prepare(`INSERT INTO extensions (student_id, assignment_id, course_id, lessons, until) VALUES (?, ?, ?, 3, '2026-10-23')`).run(s, a, c).lastInsertRowid;
    const before = await readFlagState(db, { studentId: s, assignmentId: a });
    expect(before).toEqual({
      exception: 0, score: 75, comment: 'Good work.', commentStatus: 1, graded: true, savedGrade: null,
      openRecords: [{ type: 'extension', id: extId, label: 'Extension to Fri 23/10/2026' }], hasDraft: false,
    });
    expect(pushGradeUpdates).not.toHaveBeenCalled();
    await flag(6);
    const after = await readFlagState(db, { studentId: s, assignmentId: a });
    expect(after).toMatchObject({ exception: 6, score: null, graded: false, hasDraft: false });
    expect(after.savedGrade).toMatchObject({ flag: 6, score: 75, topics: { t1: 'EX', t2: 'EX' }, notRestored: [], savedAt: expect.any(String) });
  });

  test('a failed read: SCHOOLOGY_READ_FAILED', async () => {
    getSectionGrades.mockRejectedValueOnce(new Error('down'));
    await expect(readFlagState(db, { studentId: s, assignmentId: a })).rejects.toMatchObject({ code: 'SCHOOLOGY_READ_FAILED' });
  });
});

describe('retireCopy', () => {
  test('marks a waiting copy retired (restored_at set): a new grade was published over a marker', async () => {
    await flag(6);
    expect(copyRow().restored_at).toBeNull();
    expect(retireCopy(db, { studentId: s, assignmentId: a })).toBe(true);
    expect(copyRow().restored_at).not.toBeNull();
    const state = await readFlagState(db, { studentId: s, assignmentId: a });
    expect(state.savedGrade).toBeNull();
  });

  test('no copy, or one already restored: nothing changes', async () => {
    expect(retireCopy(db, { studentId: s, assignmentId: a })).toBe(false);
    await flag(6);
    db.prepare(`UPDATE excused_grades SET restored_at = '2026-10-01 00:00:00'`).run();
    expect(retireCopy(db, { studentId: s, assignmentId: a })).toBe(false);
    expect(copyRow().restored_at).toBe('2026-10-01 00:00:00');
  });
});
