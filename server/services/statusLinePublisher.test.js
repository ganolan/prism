import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('./schoology.js', () => ({ getSectionGrades: vi.fn(), pushGradeComments: vi.fn() }));

import { getDb } from '../db/index.js';
import { getSectionGrades, pushGradeComments } from './schoology.js';
import { previewStatusLine, publishStatusLine, removeStatusLine, lockPair, setStatusLineSource, checkLine } from './statusLinePublisher.js';
import { captureFeedbackSnapshots, currentFingerprints, snapshotMap } from './feedbackSnapshots.js';
import { resubmissionStateFromSnapshot } from '../lib/resubmission.js';

const L1 = 'Resubmission requested - due Thu 09/10. Fix the loop.';
const L2 = 'Resubmission requested - now due Tue 14/10.';

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

  test('no Schoology record but Prism has a score or exception → SCHOOLOGY_READ_FAILED, no PUT (never write blind)', async () => {
    getSectionGrades.mockResolvedValue([fresh({ enrollment_id: 'someone-else' })]);
    await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line: L1, kind: 'ask' })).rejects.toMatchObject({ code: 'SCHOOLOGY_READ_FAILED' });
    db.prepare('UPDATE grades SET score = NULL, exception = 1 WHERE student_id = ?').run(s);
    await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line: L1, kind: 'ask' })).rejects.toMatchObject({ code: 'SCHOOLOGY_READ_FAILED' });
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });

  test('no Schoology grade record yet (and no Prism grade) → comment-only write (no grade echoed)', async () => {
    db.prepare('UPDATE grades SET score = NULL, exception = 0 WHERE student_id = ?').run(s);
    getSectionGrades.mockResolvedValue([]);
    const out = await publishStatusLine(db, { studentId: s, assignmentId: a, line: L1, kind: 'extension' });
    expect(out.comment).toBe(L1);
    expect(sentPayload()).toEqual({ assignment_id: 'sa', enrollment_id: 'enr', comment: L1, comment_status: 1 });
    expect(gradeRow()).toMatchObject({ score: null, grade_comment: L1, comment_status: 1 });
  });

  test('ASCII guarantee: typographic characters are normalised; the stored and published line is the plain one', async () => {
    getSectionGrades.mockResolvedValue([fresh({ comment: 'Note.' })]);
    const out = await publishStatusLine(db, { studentId: s, assignmentId: a, line: '  Extension \u2014 now due Fri 09/10. \u201Csee me\u201D\u2026 ', kind: 'extension' });
    expect(out.line).toBe('Extension - now due Fri 09/10. "see me"...');
    expect(sentPayload().comment).toBe('Extension - now due Fri 09/10. "see me"...\n\nNote.');
    expect(stored().line).toBe('Extension - now due Fri 09/10. "see me"...');
  });

  test('ASCII guarantee: anything else non-ASCII is refused before reading Schoology', async () => {
    for (const line of ['\u27F3 Resubmission requested', 'Bien jou\u00E9', 'Due Fri \u{1F389}']) {
      await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line, kind: 'ask' }))
        .rejects.toMatchObject({ code: 'BAD_LINE', message: 'Use plain characters in the status line' });
    }
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(checkLine('a\u2019b')).toBe("a'b");
  });

  test('rejects an empty or multi-line line, or an unknown kind, before reading Schoology', async () => {
    await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line: '  ', kind: 'ask' })).rejects.toMatchObject({ code: 'BAD_LINE' });
    await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line: `${L1}\nmore`, kind: 'ask' })).rejects.toMatchObject({ code: 'BAD_LINE' });
    await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line: `${L1}\rmore`, kind: 'ask' })).rejects.toMatchObject({ code: 'BAD_LINE' });
    await expect(publishStatusLine(db, { studentId: s, assignmentId: a, line: L1, kind: 'nope' })).rejects.toMatchObject({ code: 'BAD_VALUE' });
    await expect(publishStatusLine(db, { studentId: 999, assignmentId: a, line: L1, kind: 'ask' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getSectionGrades).not.toHaveBeenCalled();
  });
});

// R1 (residual review): a status-line publish mirrors the fresh Schoology grade, which may
// carry a regrade the last sync never saw. It must not count as a Prism save after a
// resubmission R, or the next sync would take the pre-regrade sync as R's baseline and the
// regrade (given BEFORE R) would read as the answer — R silently dismissed.
describe('a status-line publish never answers a resubmission (R1)', () => {
  const stateOf = (requestedAt = 0) => {
    const cur = currentFingerprints(db, {}).get(`${s}:${a}`);
    return resubmissionStateFromSnapshot({
      snapshot: snapshotMap(db, {}).get(`${s}:${a}`), currentFingerprint: cur.fingerprint, requestedAt, gradedAt: Number(cur.grade.submitted_at) || 0,
    });
  };

  test('sync at 60 → Schoology regrade to 70 at 200 → resubmission at 300 → Prism Extend publish → sync: arrived', async () => {
    db.prepare('UPDATE grades SET score = 60, grade_comment = NULL, submitted_at = 100, latest_revision_at = 50 WHERE student_id = ?').run(s);
    captureFeedbackSnapshots(db);                                    // the last sync saw 60
    // In Schoology (unsynced): regraded to 70 at 200, then the student resubmits at 300.
    getSectionGrades.mockResolvedValue([fresh({ grade: '70', comment: '' })]);
    await publishStatusLine(db, { studentId: s, assignmentId: a, line: L2, kind: 'extend_resubmission' });
    // The publish mirrored 70 but is not a teacher save: no stamp, and the grade time is untouched.
    expect(db.prepare('SELECT score, submitted_at FROM grades WHERE student_id = ?').get(s)).toEqual({ score: 70, submitted_at: 100 });
    expect(snapshotMap(db, {}).get(`${s}:${a}`)).toMatchObject({ fingerprint_at: 0 });
    // The next sync sees R = 300; Schoology's grade time moved to the publish (400).
    db.prepare('UPDATE grades SET submitted_at = 400, latest_revision_at = 300 WHERE student_id = ?').run(s);
    expect(captureFeedbackSnapshots(db)).toEqual({ arrivals: 1 });
    expect(stateOf()).toBe('arrived');
    expect(stateOf(250)).toBe('arrived');                           // an open ask before R: not fulfilled
  });

  test('publishing over a hidden comment (it becomes visible) never answers a pending arrival', async () => {
    db.prepare(`UPDATE grades SET score = 60, grade_comment = 'Private: talk to parents', comment_status = NULL, submitted_at = 100, latest_revision_at = 50 WHERE student_id = ?`).run(s);
    captureFeedbackSnapshots(db);
    db.prepare('UPDATE grades SET latest_revision_at = 300 WHERE student_id = ?').run(s);
    captureFeedbackSnapshots(db);                                    // R = 300 arrives
    expect(stateOf()).toBe('arrived');
    getSectionGrades.mockResolvedValue([fresh({ grade: '60', comment: 'Private: talk to parents', comment_status: null })]);
    const out = await publishStatusLine(db, { studentId: s, assignmentId: a, line: L2, kind: 'extend_resubmission' });
    expect(out.comment).toBe(`${L2}\n\nPrivate: talk to parents`);  // now visible to the student
    expect(stateOf()).toBe('arrived');
    db.prepare('UPDATE grades SET submitted_at = 400 WHERE student_id = ?').run(s);   // next sync: grade time = the publish
    captureFeedbackSnapshots(db);
    expect(stateOf()).toBe('arrived');
    expect(stateOf(250)).toBe('arrived');
  });

  test('an arrival already answered stays answered after a publish', async () => {
    db.prepare(`UPDATE grades SET score = 60, grade_comment = NULL, submitted_at = 100, latest_revision_at = 50 WHERE student_id = ?`).run(s);
    captureFeedbackSnapshots(db);
    db.prepare('UPDATE grades SET latest_revision_at = 300 WHERE student_id = ?').run(s);
    captureFeedbackSnapshots(db);
    db.prepare('UPDATE grades SET score = 70, submitted_at = 350 WHERE student_id = ?').run(s);   // regraded after R
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 350 });
    expect(stateOf()).toBe(null);
    getSectionGrades.mockResolvedValue([fresh({ grade: '70', comment: 'Hidden', comment_status: null })]);
    await publishStatusLine(db, { studentId: s, assignmentId: a, line: L1, kind: 'extension' });
    db.prepare('UPDATE grades SET submitted_at = 400 WHERE student_id = ?').run(s);
    captureFeedbackSnapshots(db);
    expect(stateOf()).toBe(null);
  });

  test('removing a line also leaves the save stamp alone', async () => {
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'ask')`).run(s, a, L1);
    captureFeedbackSnapshots(db);
    getSectionGrades.mockResolvedValue([fresh({ grade: '3', comment: `${L1}\n\nKeep this.` })]);
    await removeStatusLine(db, { studentId: s, assignmentId: a });
    expect(snapshotMap(db, {}).get(`${s}:${a}`)).toMatchObject({ fingerprint_at: 0 });
  });
});

describe('previewStatusLine', () => {
  test('a hidden comment with teacher text → hiddenWarning; resulting comment composed', async () => {
    getSectionGrades.mockResolvedValue([fresh({ comment: 'Private: talk to parents', comment_status: null })]);
    const p = await previewStatusLine(db, { studentId: s, assignmentId: a, line: L1 });
    expect(p).toEqual({
      currentComment: 'Private: talk to parents', visible: false, storedLine: null, storedSource: null,
      resultingComment: `${L1}\n\nPrivate: talk to parents`, hiddenWarning: true,
      normalisedLine: L1, lineProblem: null,
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
    expect((await previewStatusLine(db, { studentId: s, assignmentId: a, line: 'Due Fri \u2013 \u2018ok\u2019' })).resultingComment)
      .toBe("Due Fri - 'ok'\n\nSeen");                                 // previews what would be published
  });

  test("returns the stored line's source record (null until one is set)", async () => {
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'ask')`).run(s, a, L1);
    getSectionGrades.mockResolvedValue([fresh({ comment: L1, comment_status: 1 })]);
    expect((await previewStatusLine(db, { studentId: s, assignmentId: a, line: '' })).storedSource).toBeNull();
    setStatusLineSource(db, { studentId: s, assignmentId: a, type: 'resubmission', id: 12 });
    expect((await previewStatusLine(db, { studentId: s, assignmentId: a, line: '' })).storedSource)
      .toEqual({ sourceType: 'resubmission', sourceId: 12 });
  });

  test('lineProblem flags a line publish would refuse (BAD_LINE); normalisedLine is what would be published', async () => {
    getSectionGrades.mockResolvedValue([fresh({ comment: 'Seen', comment_status: 1 })]);
    expect(await previewStatusLine(db, { studentId: s, assignmentId: a, line: 'Due \u2013 \u201Cok\u201D' }))
      .toMatchObject({ normalisedLine: 'Due - "ok"', lineProblem: null });
    expect(await previewStatusLine(db, { studentId: s, assignmentId: a, line: '\u27F3 Bien jou\u00E9' }))
      .toMatchObject({ lineProblem: 'BAD_LINE', lineProblemMessage: 'Use plain characters in the status line' });
    expect(await previewStatusLine(db, { studentId: s, assignmentId: a, line: 'two\nlines' }))
      .toMatchObject({ lineProblem: 'BAD_LINE' });
    expect(await previewStatusLine(db, { studentId: s, assignmentId: a, line: '' }))
      .toMatchObject({ normalisedLine: '', lineProblem: null });           // no line yet: nothing to flag
    expect(pushGradeComments).not.toHaveBeenCalled();
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

  test('source filter: only the line published by that record is removed', async () => {
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, ?, 'ask')`).run(s, a, L1);
    setStatusLineSource(db, { studentId: s, assignmentId: a, type: 'resubmission', id: 2 });
    expect(await removeStatusLine(db, { studentId: s, assignmentId: a, source: { type: 'resubmission', id: 1 } })).toEqual({ removed: false, comment: null });
    expect(await removeStatusLine(db, { studentId: s, assignmentId: a, source: { type: 'extension', id: 2 } })).toEqual({ removed: false, comment: null });
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(stored()).not.toBeNull();
    getSectionGrades.mockResolvedValue([fresh({ comment: L1 })]);
    expect(await removeStatusLine(db, { studentId: s, assignmentId: a, source: { type: 'resubmission', id: '2' } })).toMatchObject({ removed: true, comment: '' });
    expect(stored()).toBeNull();
  });

  test('a new publish clears the previous source (the route sets it after recording)', async () => {
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind, source_type, source_id) VALUES (?, ?, ?, 'ask', 'resubmission', 7)`).run(s, a, L1);
    getSectionGrades.mockResolvedValue([fresh({ comment: L1 })]);
    await publishStatusLine(db, { studentId: s, assignmentId: a, line: L2, kind: 'extend_resubmission' });
    expect(db.prepare('SELECT source_type, source_id FROM status_lines WHERE student_id = ?').get(s)).toEqual({ source_type: null, source_id: null });
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

describe('lockPair', () => {
  test('a held pair is BUSY until released; other pairs are free', () => {
    const release = lockPair(1, 2);
    expect(() => lockPair('1', '2')).toThrow(expect.objectContaining({ code: 'BUSY' }));
    const other = lockPair(1, 3);
    other();
    release();
    release(); // idempotent
    const again = lockPair(1, 2);
    again();
  });
});
