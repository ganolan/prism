import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('./schoology.js', () => ({ getSectionGrades: vi.fn(), pushGradeComments: vi.fn() }));

import { getDb } from '../db/index.js';
import { getSectionGrades, pushGradeComments } from './schoology.js';
import { previewStatusLine, publishStatusLine, removeStatusLine } from './statusLinePublisher.js';

const L1 = '⟳ Resubmission requested — due Thu 09/10. Fix the loop.';
const L2 = '⟳ Resubmission requested — now due Tue 14/10.';

let db, s, a;
const fresh = (over = {}) => ({ assignment_id: 'sa', enrollment_id: 'enr', grade: '2', exception: 0, comment: '', comment_status: 1, ...over });
const stored = () => db.prepare('SELECT line, kind FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(s, a) || null;
const gradeRow = () => db.prepare('SELECT score, exception, grade_comment, comment_status FROM grades WHERE student_id = ? AND assignment_id = ?').get(s, a);
const sentPayload = () => pushGradeComments.mock.calls.at(-1)[1][0];

beforeEach(() => {
  vi.clearAllMocks();
  db = getDb();
  db.exec('DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM resubmissions; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec', 'AP CSP')`).run().lastInsertRowid;
  s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr')`).run(s, c);
  a = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa', 'CP2')`).run(c).lastInsertRowid;
  db.prepare(`INSERT INTO grades (student_id, assignment_id, enrolment_id, score, grade_comment, comment_status) VALUES (?, ?, 'enr', 1, 'stale', 1)`).run(s, a);
  pushGradeComments.mockResolvedValue({ status: 207, data: {} });
});

describe('publishStatusLine', () => {
  test('reads fresh, prepends the line, echoes grade/exception, sets comment_status 1, mirrors + stores + snapshots', async () => {
    getSectionGrades.mockResolvedValue([
      fresh({ enrollment_id: 'other' }),
      fresh({ grade: '3', exception: 2, comment: 'Good start.', comment_status: null }),
    ]);
    const out = await publishStatusLine(db, { studentId: s, assignmentId: a, line: L1, kind: 'ask' });
    expect(out.comment).toBe(`${L1}\n\nGood start.`);
    expect(getSectionGrades).toHaveBeenCalledWith('sec');
    expect(pushGradeComments).toHaveBeenCalledTimes(1);
    expect(pushGradeComments.mock.calls[0][0]).toBe('sec');
    expect(sentPayload()).toEqual({
      assignment_id: 'sa', enrollment_id: 'enr', comment: `${L1}\n\nGood start.`, comment_status: 1, grade: '3', exception: 2,
    });
    expect(gradeRow()).toMatchObject({ score: 3, exception: 2, grade_comment: `${L1}\n\nGood start.`, comment_status: 1 });
    expect(stored()).toEqual({ line: L1, kind: 'ask' });
    // Captured: the fingerprint strips the stored line (the now-visible teacher text remains).
    const snap = db.prepare('SELECT fingerprint, fingerprint_at FROM feedback_snapshots WHERE student_id = ? AND assignment_id = ?').get(s, a);
    expect(JSON.parse(snap.fingerprint).c).toBe('Good start.');
  });

  test('Review Focus 2: the edited line is stored and replaced exactly by the next action', async () => {
    const edited = `${L1} (bring your notebook)`;
    getSectionGrades.mockResolvedValue([fresh({ comment: 'Teacher note.' })]);
    await publishStatusLine(db, { studentId: s, assignmentId: a, line: edited, kind: 'ask' });
    expect(stored().line).toBe(edited);
    // Schoology now holds what was published (round-tripped with CRLF).
    getSectionGrades.mockResolvedValue([fresh({ comment: `${edited}\r\n\r\nTeacher note.` })]);
    const out = await publishStatusLine(db, { studentId: s, assignmentId: a, line: L2, kind: 'extend_resubmission' });
    expect(out.comment).toBe(`${L2}\n\nTeacher note.`);
    expect(stored()).toEqual({ line: L2, kind: 'extend_resubmission' });
  });

  test('a stored line hand-edited in Schoology is kept as teacher text', async () => {
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'ask')`).run(s, a, L1);
    getSectionGrades.mockResolvedValue([fresh({ comment: `${L1} edited\n\nNote.` })]);
    const out = await publishStatusLine(db, { studentId: s, assignmentId: a, line: L2, kind: 'extend_resubmission' });
    expect(out.comment).toBe(`${L2}\n\n${L1} edited\n\nNote.`);
  });

  test('Review Focus 4: a failed fresh read → SCHOOLOGY_READ_FAILED, no PUT, nothing recorded', async () => {
    getSectionGrades.mockRejectedValue(new Error('Schoology down'));
    await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line: L1, kind: 'ask' }))
      .rejects.toMatchObject({ code: 'SCHOOLOGY_READ_FAILED' });
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(gradeRow().grade_comment).toBe('stale');
    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_snapshots').get().n).toBe(0);
  });

  test('a failed PUT (HTTP error or a failed entry) → SCHOOLOGY_WRITE_FAILED, nothing recorded', async () => {
    getSectionGrades.mockResolvedValue([fresh()]);
    pushGradeComments.mockResolvedValueOnce({ status: 500, data: 'oops' });
    await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line: L1, kind: 'ask' }))
      .rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED' });
    pushGradeComments.mockResolvedValueOnce({ status: 207, data: { grades: { grade: [{ response_code: 400 }] } } });
    await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line: L1, kind: 'ask' }))
      .rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED' });
    pushGradeComments.mockRejectedValueOnce(new Error('network'));
    await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line: L1, kind: 'ask' }))
      .rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED' });
    expect(stored()).toBeNull();
    expect(gradeRow().grade_comment).toBe('stale');
  });

  test('no Schoology grade record yet → comment-only write (no grade echoed); score untouched', async () => {
    getSectionGrades.mockResolvedValue([]);
    const out = await publishStatusLine(db, { studentId: s, assignmentId: a, line: L1, kind: 'extension' });
    expect(out.comment).toBe(L1);
    expect(sentPayload()).toEqual({ assignment_id: 'sa', enrollment_id: 'enr', comment: L1, comment_status: 1 });
    expect(gradeRow()).toMatchObject({ score: 1, grade_comment: L1, comment_status: 1 });
  });

  test('rejects an empty line or an unknown kind before reading Schoology', async () => {
    await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line: '  ', kind: 'ask' })).rejects.toMatchObject({ code: 'BAD_VALUE' });
    await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line: L1, kind: 'nope' })).rejects.toMatchObject({ code: 'BAD_VALUE' });
    await expect(publishStatusLine(db, { studentId: 999, assignmentId: a, line: L1, kind: 'ask' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getSectionGrades).not.toHaveBeenCalled();
  });
});

describe('previewStatusLine', () => {
  test('a hidden comment with teacher text → hiddenWarning; resulting comment composed', async () => {
    getSectionGrades.mockResolvedValue([fresh({ comment: 'Private: talk to parents', comment_status: null })]);
    const p = await previewStatusLine(db, { studentId: s, assignmentId: a, line: L1 });
    expect(p).toEqual({
      currentComment: 'Private: talk to parents', visible: false, storedLine: null,
      resultingComment: `${L1}\n\nPrivate: talk to parents`, hiddenWarning: true,
    });
    expect(pushGradeComments).not.toHaveBeenCalled();
  });

  test('a hidden comment holding only the stored line → no warning; visible comment → no warning', async () => {
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'ask')`).run(s, a, L1);
    getSectionGrades.mockResolvedValue([fresh({ comment: L1, comment_status: null })]);
    expect(await previewStatusLine(db, { studentId: s, assignmentId: a, line: L2 }))
      .toMatchObject({ storedLine: L1, resultingComment: L2, hiddenWarning: false, visible: false });
    getSectionGrades.mockResolvedValue([fresh({ comment: 'Seen', comment_status: 1 })]);
    expect(await previewStatusLine(db, { studentId: s, assignmentId: a, line: L2 }))
      .toMatchObject({ visible: true, hiddenWarning: false, resultingComment: `${L2}\n\nSeen` });
  });

  test('a failed read → SCHOOLOGY_READ_FAILED', async () => {
    getSectionGrades.mockRejectedValue(new Error('down'));
    await expect(previewStatusLine(db, { studentId: s, assignmentId: a, line: L1 })).rejects.toMatchObject({ code: 'SCHOOLOGY_READ_FAILED' });
  });
});

describe('removeStatusLine', () => {
  test('removes only the stored line, keeps the fresh comment_status, deletes the row', async () => {
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'ask')`).run(s, a, L1);
    getSectionGrades.mockResolvedValue([fresh({ grade: '2', comment: `${L1}\n\nKeep this.`, comment_status: null })]);
    const out = await removeStatusLine(db, { studentId: s, assignmentId: a });
    expect(out).toMatchObject({ removed: true, comment: 'Keep this.' });
    expect(sentPayload()).toEqual({ assignment_id: 'sa', enrollment_id: 'enr', comment: 'Keep this.', comment_status: null, grade: '2', exception: 0 });
    expect(gradeRow()).toMatchObject({ grade_comment: 'Keep this.', comment_status: null });
    expect(stored()).toBeNull();
  });

  test('no stored line → nothing read or written', async () => {
    expect(await removeStatusLine(db, { studentId: s, assignmentId: a })).toEqual({ removed: false, comment: null });
    expect(getSectionGrades).not.toHaveBeenCalled();
  });

  test('a stored line of another kind (kinds filter) is left alone', async () => {
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'ask')`).run(s, a, L1);
    expect(await removeStatusLine(db, { studentId: s, assignmentId: a, kinds: ['extension', 'make_up'] })).toEqual({ removed: false, comment: null });
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(stored()).not.toBeNull();
  });

  test('line hand-edited away → no PUT, but the stored row is dropped', async () => {
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'ask')`).run(s, a, L1);
    getSectionGrades.mockResolvedValue([fresh({ comment: `${L1}!\n\nNote` })]);
    expect(await removeStatusLine(db, { studentId: s, assignmentId: a })).toMatchObject({ removed: false, comment: `${L1}!\n\nNote` });
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });

  test('a failed read → SCHOOLOGY_READ_FAILED, the stored row stays', async () => {
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'ask')`).run(s, a, L1);
    getSectionGrades.mockRejectedValue(new Error('down'));
    await expect(removeStatusLine(db, { studentId: s, assignmentId: a })).rejects.toMatchObject({ code: 'SCHOOLOGY_READ_FAILED' });
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(stored()).not.toBeNull();
  });
});
