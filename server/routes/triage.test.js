import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
// Status-line publishing reads/writes the student's Schoology comment — never for real.
vi.mock('../services/schoology.js', () => ({ getSectionGrades: vi.fn(), pushGradeComments: vi.fn() }));

import router from './triage.js';
import { getDb } from '../db/index.js';
import { getSectionGrades, pushGradeComments } from '../services/schoology.js';
import { addDays, todayLocal } from '../lib/schoolDays.js';
import { storeSchoolDays } from '../services/schoolCalendar.js';

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/triage', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

let studentId, assignmentId, courseId;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM resubmissions; DELETE FROM referrals; DELETE FROM extensions; DELETE FROM school_days; DELETE FROM mastery_alignments; DELETE FROM grades; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'AP CSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'X', 'C')`).run(courseId);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat', ?, 'X.1', 'T')`).run(courseId);
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(studentId, courseId);
  // Due long ago (weekday fallback, no calendar) → well past the limit.
  assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, accepts_submissions) VALUES (?, 'a1', 'CP2', '2020-01-06 15:30:00', 1)`).run(courseId).lastInsertRowid;
  db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('a1', 't1', ?)`).run(courseId);
});

describe('/api/triage', () => {
  test('GET returns both lists', async () => {
    const { status, body } = await call('GET', '/api/triage');
    expect(status).toBe(200);
    expect(body.lateWork).toHaveLength(1);
    expect(body.feedbackOwed).toEqual([]);
    expect(body.calendar.source).toBe('weekdays');
  });

  test('GET /calendar returns freshness only, without the full triage payload', async () => {
    const empty = await call('GET', '/api/triage/calendar');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ source: 'weekdays', totalSchoolDays: 0, syncedAt: null });

    storeSchoolDays(getDb(), [{ date: '2026-10-05', inSession: true, cycleLetter: 'A', raw: '{}' }], '2026-10-01T00:00:00Z');
    const loaded = await call('GET', '/api/triage/calendar');
    expect(loaded.status).toBe(200);
    expect(loaded.body).toEqual({ source: 'powerschool', totalSchoolDays: 1, syncedAt: '2026-10-01T00:00:00Z' });
    expect(loaded.body.lateWork).toBeUndefined();
  });

  test('POST referral → 201; it then leaves the list; DELETE undoes', async () => {
    const created = await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'referred' });
    expect(created.status).toBe(201);
    expect((await call('GET', '/api/triage')).body.lateWork).toEqual([]);
    expect((await call('GET', '/api/triage/referrals')).body).toHaveLength(1);
    expect((await call('DELETE', `/api/triage/referrals/${created.body.id}`)).body).toEqual({ deleted: true });
  });

  test('POST errors map to status codes', async () => {
    expect((await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/triage/referrals', { studentId, assignmentId: 999, action: 'referred' })).status).toBe(404);
    await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'referred' });
    expect((await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'referred' })).status).toBe(409);
    expect((await call('POST', '/api/triage/referrals', { studentId, assignmentId, action: 'exempt' })).body.code).toBe('BAD_ACTION');
  });

  test("POST 'referred' before the limit → 409 NOT_AT_LIMIT", async () => {
    // Due 3 calendar days ago → 1–2 weekdays late (weekday fallback): under the limit.
    const recent = getDb().prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, accepts_submissions) VALUES (?, 'a2', 'Recent', ?, 1)`)
      .run(courseId, `${addDays(todayLocal(), -3)} 15:30:00`).lastInsertRowid;
    getDb().prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('a2', 't1', ?)`).run(courseId);
    const res = await call('POST', '/api/triage/referrals', { studentId, assignmentId: recent, action: 'referred' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_AT_LIMIT');
  });

  test('POST extension → 201 with until; listed by course; the row carries it; DELETE undoes', async () => {
    const created = await call('POST', '/api/triage/extensions', { studentId, assignmentId, lessons: 3, note: 'sick' });
    expect(created.status).toBe(201);
    // Due Mon 06/01/2020, weekday fallback → until Thu 09/01/2020.
    expect(created.body).toMatchObject({ lessons: 3, note: 'sick', source: 'app', until: '2020-01-09', studentName: 'Maya Chen' });
    expect((await call('GET', `/api/triage/extensions?courseId=${courseId}`)).body).toHaveLength(1);
    expect((await call('GET', `/api/triage/extensions?courseId=${courseId + 1}`)).body).toEqual([]);
    const row = (await call('GET', '/api/triage')).body.lateWork[0];
    expect(row.extension).toMatchObject({ id: created.body.id, lessons: 3, until: '2020-01-09' });
    expect((await call('GET', '/api/triage')).body.historyCount).toBe(1);
    expect((await call('DELETE', `/api/triage/extensions/${created.body.id}`)).body).toEqual({ deleted: true });
    expect((await call('GET', '/api/triage/extensions')).body).toEqual([]);
  });

  test('PUT makeup-ignore/:assignmentId flips tracking for a test; errors map to status codes', async () => {
    const quiz = getDb().prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, is_test, test_fetch_status) VALUES (?, 'q1', 'Quiz', '2020-01-06 14:00:00', 1, 'ok')`)
      .run(courseId).lastInsertRowid;
    getDb().prepare(`INSERT INTO grades (student_id, assignment_id, test_attempt) VALUES (?, ?, 'none')`).run(studentId, quiz);
    expect((await call('GET', '/api/triage')).body.makeUps).toHaveLength(1);
    const res = await call('PUT', `/api/triage/makeup-ignore/${quiz}`, { ignored: true });
    expect(res).toMatchObject({ status: 200, body: { assignmentId: quiz, title: 'Quiz', ignored: true } });
    const t = (await call('GET', '/api/triage')).body;
    expect(t.makeUps).toEqual([]);
    expect(t.makeUpsIgnored).toBe(1);
    expect(await call('PUT', `/api/triage/makeup-ignore/${quiz}`, { ignored: 'no' })).toMatchObject({ status: 400, body: { code: 'BAD_VALUE' } });
    expect((await call('PUT', '/api/triage/makeup-ignore/999', { ignored: true })).status).toBe(404);
    expect(await call('PUT', `/api/triage/makeup-ignore/${assignmentId}`, { ignored: true })).toMatchObject({ status: 409, body: { code: 'NOT_ELIGIBLE' } });
  });

  test('POST extension errors map to status codes', async () => {
    const bad = await call('POST', '/api/triage/extensions', { studentId, assignmentId, lessons: 0 });
    expect(bad).toMatchObject({ status: 400, body: { code: 'BAD_LESSONS' } });
    expect((await call('POST', '/api/triage/extensions', { studentId: 999, assignmentId, lessons: 3 })).status).toBe(404);
    expect((await call('POST', '/api/triage/extensions', { studentId, assignmentId: 999, lessons: 3 })).status).toBe(404);
    getDb().prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
    expect((await call('POST', '/api/triage/extensions', { studentId, assignmentId, lessons: 3 })))
      .toMatchObject({ status: 409, body: { code: 'NOT_ELIGIBLE' } });
  });
});

describe('resubmission routes', () => {
  // The outer beforeEach already seeds an enrolled student + a current-course assignment.
  function seedPair() { return { s: studentId, a: assignmentId }; }

  test('ask → list → extend → grade stands (after the deadline) → undo', async () => {
    const { s, a } = seedPair();
    const asked = await call('POST', '/api/triage/resubmissions', { studentId: s, assignmentId: a, lessons: 2, note: 'redo' });
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ outcome: 'asked', lessons: 2, note: 'redo' });
    expect((await call('POST', '/api/triage/resubmissions', { studentId: s, assignmentId: a })).status).toBe(409);
    expect((await call('PUT', `/api/triage/resubmissions/${asked.body.id}`, { lessons: 4 })).body.lessons).toBe(4);
    // Asked today → the deadline is ahead: grade stands is refused.
    const early = await call('PUT', `/api/triage/resubmissions/${asked.body.id}`, { gradeStands: true });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('NOT_AT_DEADLINE');
    getDb().prepare(`UPDATE resubmissions SET requested_at = '2020-01-06 04:00:00' WHERE id = ?`).run(asked.body.id);
    const stands = await call('PUT', `/api/triage/resubmissions/${asked.body.id}`, { gradeStands: true });
    expect(stands.status).toBe(200);
    expect(stands.body).toMatchObject({ status: 'closed', outcome: 'grade_stands', closeNote: 'grade stands' });
    expect((await call('GET', '/api/triage/resubmissions')).body).toHaveLength(1);
    expect((await call('DELETE', `/api/triage/resubmissions/${asked.body.id}`)).body).toEqual({ deleted: true });
  });

  test('{ close: true } is still accepted as an alias for grade stands', async () => {
    const { s, a } = seedPair();
    const asked = await call('POST', '/api/triage/resubmissions', { studentId: s, assignmentId: a, lessons: 1 });
    expect((await call('PUT', `/api/triage/resubmissions/${asked.body.id}`, { close: true })).status).toBe(409);
    getDb().prepare(`UPDATE resubmissions SET requested_at = '2020-01-06 04:00:00' WHERE id = ?`).run(asked.body.id);
    expect((await call('PUT', `/api/triage/resubmissions/${asked.body.id}`, { close: true })).body.outcome).toBe('grade_stands');
  });

  test('the Reviewed route is gone (404)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/triage', router);
    const server = app.listen(0);
    try {
      const res = await fetch(`http://localhost:${server.address().port}/api/triage/resubmissions/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: 1, assignmentId: 1 }),
      });
      expect(res.status).toBe(404);
    } finally { server.close(); }
  });
});

describe('status lines on triage actions (Amendment B)', () => {
  const LINE = '⟳ Resubmission requested — due Thu 09/10. Fix the loop.';
  const fresh = (over = {}) => ({ assignment_id: 'a1', enrollment_id: 'enr', grade: '2', exception: 1, comment: 'Teacher note.', comment_status: 1, ...over });
  const storedLine = () => getDb().prepare('SELECT line, kind FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId) || null;
  const payload = () => pushGradeComments.mock.calls.at(-1)[1][0];
  const count = (table) => getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const ask = (body = {}) => call('POST', '/api/triage/resubmissions', { studentId, assignmentId, lessons: 2, ...body });
  const backdate = (id) => getDb().prepare(`UPDATE resubmissions SET requested_at = '2020-01-06 04:00:00' WHERE id = ?`).run(id);

  beforeEach(() => {
    vi.clearAllMocks();
    getDb().prepare(`UPDATE enrolments SET schoology_enrolment_id = 'enr' WHERE student_id = ?`).run(studentId);
    getSectionGrades.mockResolvedValue([fresh()]);
    pushGradeComments.mockResolvedValue({ status: 207, data: {} });
  });

  test('ask with commentLine: publishes (fresh read, echoes grade/exception, comment_status 1), then records', async () => {
    const res = await ask({ commentLine: LINE });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ outcome: 'asked', lessons: 2, statusLine: { comment: `${LINE}\n\nTeacher note.`, line: LINE } });
    expect(getSectionGrades).toHaveBeenCalledWith('s');
    expect(payload()).toEqual({ assignment_id: 'a1', enrollment_id: 'enr', comment: `${LINE}\n\nTeacher note.`, comment_status: 1, grade: '2', exception: 1 });
    expect(storedLine()).toEqual({ line: LINE, kind: 'ask' });
  });

  test('without commentLine nothing touches Schoology (Prism-only, as before)', async () => {
    expect((await ask()).status).toBe(201);
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(storedLine()).toBeNull();
  });

  test('ALREADY_OPEN is checked before any read or PUT', async () => {
    await ask();
    const res = await ask({ commentLine: LINE });
    expect(res).toMatchObject({ status: 409, body: { code: 'ALREADY_OPEN' } });
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(storedLine()).toBeNull();
  });

  test('NOT_ELIGIBLE / BAD_LESSONS are checked before any PUT', async () => {
    expect(await ask({ lessons: 0, commentLine: LINE })).toMatchObject({ status: 400, body: { code: 'BAD_LESSONS' } });
    getDb().prepare('UPDATE courses SET archived = 1').run();
    expect(await ask({ commentLine: LINE })).toMatchObject({ status: 409, body: { code: 'NOT_ELIGIBLE' } });
    expect(pushGradeComments).not.toHaveBeenCalled();
  });

  test('Review Focus 4: the fresh read fails → 502, nothing published, nothing recorded', async () => {
    getSectionGrades.mockRejectedValue(new Error('Schoology down'));
    const res = await ask({ commentLine: LINE });
    expect(res).toMatchObject({ status: 502, body: { code: 'SCHOOLOGY_READ_FAILED' } });
    expect(res.body.error).toMatch(/nothing was published/);
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(count('resubmissions')).toBe(0);
    expect(storedLine()).toBeNull();
  });

  test('the PUT fails → 502, nothing recorded', async () => {
    pushGradeComments.mockResolvedValue({ status: 401, data: 'nope' });
    expect(await ask({ commentLine: LINE })).toMatchObject({ status: 502, body: { code: 'SCHOOLOGY_WRITE_FAILED' } });
    expect(count('resubmissions')).toBe(0);
    expect(storedLine()).toBeNull();
  });

  test('published but the Prism record then fails → 500 saying the comment WAS published', async () => {
    // A concurrent ask lands between validation and record (e.g. a second tab).
    pushGradeComments.mockImplementation(async () => {
      getDb().prepare(`INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons, source) VALUES (?, ?, ?, 'request', 'open', datetime('now'), 2, 'app')`)
        .run(studentId, assignmentId, courseId);
      return { status: 207, data: {} };
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await ask({ commentLine: LINE });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'RECORD_FAILED_AFTER_PUBLISH', published: true, comment: `${LINE}\n\nTeacher note.` });
    expect(res.body.error).toMatch(/WAS published/);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('extend with an edited line: kind extend_resubmission, the stored (edited) line replaced exactly (Review Focus 2)', async () => {
    const edited = `${LINE} Bring your notebook.`;
    const asked = await ask({ commentLine: edited });
    expect(storedLine().line).toBe(edited);
    getSectionGrades.mockResolvedValue([fresh({ comment: `${edited}\r\n\r\nTeacher note.` })]);
    const next = '⟳ Resubmission requested — now due Mon 13/10.';
    const res = await call('PUT', `/api/triage/resubmissions/${asked.body.id}`, { lessons: 4, commentLine: next });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lessons: 4, statusLine: { comment: `${next}\n\nTeacher note.` } });
    expect(storedLine()).toEqual({ line: next, kind: 'extend_resubmission' });
  });

  test('extend validation (bad lessons, closed request) happens before any PUT', async () => {
    const asked = await ask();
    expect(await call('PUT', `/api/triage/resubmissions/${asked.body.id}`, { lessons: 99, commentLine: LINE }))
      .toMatchObject({ status: 400, body: { code: 'BAD_LESSONS' } });
    getDb().prepare(`UPDATE resubmissions SET status = 'done'`).run();
    expect(await call('PUT', `/api/triage/resubmissions/${asked.body.id}`, { lessons: 3, commentLine: LINE }))
      .toMatchObject({ status: 409, body: { code: 'NOT_ELIGIBLE' } });
    expect(pushGradeComments).not.toHaveBeenCalled();
  });

  test('grade stands: NOT_AT_DEADLINE before any PUT; after the deadline publishes kind grade_stands and closes', async () => {
    const asked = await ask();
    const stands = '⟳ Resubmission deadline (Wed 08/01) passed — your grade stands.';
    expect(await call('PUT', `/api/triage/resubmissions/${asked.body.id}`, { gradeStands: true, commentLine: stands }))
      .toMatchObject({ status: 409, body: { code: 'NOT_AT_DEADLINE' } });
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(pushGradeComments).not.toHaveBeenCalled();
    backdate(asked.body.id);
    const res = await call('PUT', `/api/triage/resubmissions/${asked.body.id}`, { gradeStands: true, commentLine: stands });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'grade_stands', statusLine: { line: stands } });
    expect(payload().comment_status).toBe(1);
    expect(storedLine()).toEqual({ line: stands, kind: 'grade_stands' });
  });

  test('undo with removeLine removes only the stored line, then deletes the record', async () => {
    const asked = await ask({ commentLine: LINE });
    getSectionGrades.mockResolvedValue([fresh({ comment: `${LINE}\n\nTeacher note.`, comment_status: null })]);
    const res = await call('DELETE', `/api/triage/resubmissions/${asked.body.id}?removeLine=1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, statusLine: { removed: true, comment: 'Teacher note.' } });
    expect(payload()).toMatchObject({ comment: 'Teacher note.', comment_status: null, grade: '2', exception: 1 });
    expect(storedLine()).toBeNull();
    expect(count('resubmissions')).toBe(0);
  });

  test('undo without removeLine leaves Schoology alone; a failed read with removeLine keeps the record', async () => {
    const first = await ask({ commentLine: LINE });
    vi.clearAllMocks();
    getSectionGrades.mockRejectedValue(new Error('down'));
    expect(await call('DELETE', `/api/triage/resubmissions/${first.body.id}?removeLine=1`)).toMatchObject({ status: 502 });
    expect(count('resubmissions')).toBe(1);
    expect(storedLine()).not.toBeNull();
    expect((await call('DELETE', `/api/triage/resubmissions/${first.body.id}`)).body).toEqual({ deleted: true });
    expect(pushGradeComments).not.toHaveBeenCalled();
    expect(storedLine()).not.toBeNull();
  });

  test('extension with commentLine: kind extension for work, make_up for a Schoology test; undo removes it', async () => {
    const ext = '⟳ Extension — now due Thu 09/01 (3 lessons).';
    const res = await call('POST', '/api/triage/extensions', { studentId, assignmentId, lessons: 3, commentLine: ext });
    expect(res.status).toBe(201);
    expect(storedLine()).toEqual({ line: ext, kind: 'extension' });

    const quiz = getDb().prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, is_test) VALUES (?, 'q1', 'Quiz', '2020-01-06 14:00:00', 1)`)
      .run(courseId).lastInsertRowid;
    getSectionGrades.mockResolvedValue([fresh({ assignment_id: 'q1', comment: '' })]);
    const makeUp = '⟳ Make-up — sit by Thu 09/01.';
    expect((await call('POST', '/api/triage/extensions', { studentId, assignmentId: quiz, lessons: 3, commentLine: makeUp })).status).toBe(201);
    expect(getDb().prepare('SELECT kind FROM status_lines WHERE assignment_id = ?').get(quiz).kind).toBe('make_up');
    expect(payload()).toMatchObject({ assignment_id: 'q1', comment: makeUp, comment_status: 1 });

    getSectionGrades.mockResolvedValue([fresh({ comment: `${ext}\n\nTeacher note.` })]);
    const undone = await call('DELETE', `/api/triage/extensions/${res.body.id}?removeLine=1`);
    expect(undone.body).toMatchObject({ deleted: true, statusLine: { removed: true, comment: 'Teacher note.' } });
    expect(storedLine()).toBeNull();
  });

  test('an extension undo leaves a resubmission line alone; extension validation precedes any PUT', async () => {
    await ask({ commentLine: LINE });
    vi.clearAllMocks();
    expect(await call('POST', '/api/triage/extensions', { studentId, assignmentId, lessons: 0, commentLine: 'x' }))
      .toMatchObject({ status: 400, body: { code: 'BAD_LESSONS' } });
    expect(pushGradeComments).not.toHaveBeenCalled();
    const x = await call('POST', '/api/triage/extensions', { studentId, assignmentId, lessons: 2 });
    expect((await call('DELETE', `/api/triage/extensions/${x.body.id}?removeLine=1`)).body).toEqual({ deleted: true, statusLine: { removed: false, comment: null } });
    expect(getSectionGrades).not.toHaveBeenCalled();
    expect(storedLine()).toEqual({ line: LINE, kind: 'ask' });
  });

  test('GET status-line/preview: hidden comment → hiddenWarning; failed read → 502', async () => {
    getSectionGrades.mockResolvedValue([fresh({ comment: 'Private note', comment_status: null })]);
    const res = await call('GET', `/api/triage/status-line/preview?studentId=${studentId}&assignmentId=${assignmentId}&line=${encodeURIComponent(LINE)}`);
    expect(res).toMatchObject({ status: 200, body: { visible: false, hiddenWarning: true, storedLine: null, resultingComment: `${LINE}\n\nPrivate note` } });
    getSectionGrades.mockRejectedValue(new Error('down'));
    expect(await call('GET', `/api/triage/status-line/preview?studentId=${studentId}&assignmentId=${assignmentId}&line=x`))
      .toMatchObject({ status: 502, body: { code: 'SCHOOLOGY_READ_FAILED' } });
    expect(pushGradeComments).not.toHaveBeenCalled();
  });
});
