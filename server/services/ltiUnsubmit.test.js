import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { unsubmitLti, tryUnsubmitLti, assertCanUnsubmit, unsubmitAvailable } from './ltiUnsubmit.js';
import { sessionDeps, sessionStatus, resetSessionStatusCache } from './schoologySession.js';
import { fakeLtiUnsubmit, assignmentPage, SCHOOLOGY } from '../testing/fakeLtiUnsubmit.js';

const BASE = SCHOOLOGY;
const AID = '8000000001';
const UID = '90001';
const POST = `/iapi2/assignments/${AID}/submission-action/${UID}`;
const LIST = `/iapi2/assignments/${AID}/in-progress-documents/`;

const fake = (opts = {}) => fakeLtiUnsubmit({ uid: UID, aid: AID, ...opts });
const run = (f, extra = {}) => unsubmitLti(db, { studentId, assignmentId }, { jar: f.jar, fetchImpl: f.fetchImpl, wait: async () => {}, ...extra });

let db, studentId, assignmentId;
const state = () => db.prepare('SELECT lti_submission_state FROM grades WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId).lti_submission_state;
const posts = (f) => f.requests.filter((q) => q.method === 'POST');

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM resubmissions; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec', 'Course')`).run().lastInsertRowid;
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Test', 'Student')`).run(UID).lastInsertRowid;
  assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission) VALUES (?, ?, 'Notebook', 1)`)
    .run(courseId, AID).lastInsertRowid;
  db.prepare(`INSERT INTO grades (student_id, assignment_id, score, lti_submission_state) VALUES (?, ?, 3, 'submitted')`).run(studentId, assignmentId);
  resetSessionStatusCache();
  sessionDeps.openJar = vi.fn(() => { throw new Error('tests must inject a fake jar'); });
});
afterEach(() => resetSessionStatusCache());

describe('unsubmitLti (plain HTTP, #141)', () => {
  test('success: reads the CSRF pair from the assignment page, POSTs exactly {"isSubmit":false}, verifies, marks in progress', async () => {
    const f = fake();
    expect(await run(f)).toEqual({ unsubmitted: true });
    expect(f.requests[0]).toMatchObject({ method: 'GET', path: `/assignments/${AID}/info` });
    const [post] = posts(f);
    expect(post.path).toBe(POST);
    expect(post.body).toBe('{"isSubmit":false}');
    expect(post.headers).toMatchObject({ cookie: 'SESS=old', 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': 'tok', 'X-CSRF-Key': 'key' });
    expect(f.requests.some((q) => q.method === 'GET' && q.path === LIST)).toBe(true);
    expect(state()).toBe('in_progress');
    // Only one write, and never a re-submit.
    expect(posts(f)).toHaveLength(1);
    expect(f.requests.some((q) => String(q.body ?? '').includes('true'))).toBe(false);
    expect((await sessionStatus({ hasSession: () => true, check: false })).live).toBe('connected');
  });

  test('the default jar and fetch come from sessionDeps', async () => {
    const f = fake();
    sessionDeps.openJar = vi.fn(() => f.jar);
    const prevFetch = sessionDeps.fetch;
    sessionDeps.fetch = f.fetchImpl;
    try {
      await unsubmitLti(db, { studentId, assignmentId }, { wait: async () => {} });
    } finally { sessionDeps.fetch = prevFetch; }
    expect(posts(f)).toHaveLength(1);
  });

  test('not LTI → NOT_ELIGIBLE before any request', async () => {
    db.prepare('UPDATE assignments SET is_lti_submission = 0').run();
    const f = fake();
    await expect(run(f)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    expect(f.requests).toHaveLength(0);
  });

  test('not submitted → NOT_ELIGIBLE before any request', async () => {
    for (const s of ['in_progress', 'not_started', null]) {
      db.prepare('UPDATE grades SET lti_submission_state = ?').run(s);
      const f = fake();
      await expect(run(f)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
      expect(f.requests).toHaveLength(0);
    }
  });

  test('no saved session → SCHOOLOGY_SESSION', async () => {
    await expect(unsubmitLti(db, { studentId, assignmentId }, { jar: null }))
      .rejects.toMatchObject({ code: 'SCHOOLOGY_SESSION', message: 'Schoology connection expired: reconnect in Settings' });
    expect(state()).toBe('submitted');
  });

  test('a dead session (sent to sign-in, renewal fails) → SCHOOLOGY_SESSION, nothing POSTed, the live status becomes expired', async () => {
    const f = fake({ page: { login: true } });
    f.jar.renew = vi.fn(async () => false);
    await expect(run(f)).rejects.toMatchObject({ code: 'SCHOOLOGY_SESSION' });
    expect(f.jar.renew).toHaveBeenCalledTimes(1);
    expect(posts(f)).toHaveLength(0);
    expect((await sessionStatus({ hasSession: () => true, check: false })).live).toBe('expired');
  });

  test('a session renewed through Microsoft goes on to unsubmit', async () => {
    let first = true;
    const f = fake({ page: () => (first ? ((first = false), { login: true }) : { text: assignmentPage() }) });
    f.jar.renew = vi.fn(async () => true);
    expect(await run(f)).toEqual({ unsubmitted: true });
    expect(posts(f)).toHaveLength(1);
  });

  test('a 4xx → known refusal, state unchanged', async () => {
    for (const status of [400, 403]) {
      const f = fake({ post: { status, json: { data: null } } });
      await expect(run(f)).rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED', message: expect.stringMatching(new RegExp(`HTTP ${status}`)) });
      expect(state()).toBe('submitted');
    }
  });

  test('200 with an unexpected body → unconfirmed (may or may not have worked)', async () => {
    const f = fake({ post: { text: '<html>oops</html>' } });
    await expect(run(f)).rejects.toMatchObject({ code: 'SCHOOLOGY_UNCONFIRMED', message: expect.stringMatching(/^Schoology didn't confirm the unsubmit/) });
    expect(state()).toBe('submitted');
  });

  test('a 5xx → unconfirmed', async () => {
    const f = fake({ post: { status: 502, text: 'bad gateway' } });
    await expect(run(f)).rejects.toMatchObject({ code: 'SCHOOLOGY_UNCONFIRMED' });
  });

  test('every request carries a timeout signal; a POST that times out is unconfirmed, not failed', async () => {
    const ok = fake();
    const signals = [];
    await run(ok, { fetchImpl: (url, init) => { signals.push(init.signal); return ok.fetchImpl(url, init); } });
    expect(signals.length).toBeGreaterThan(2);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
    db.prepare(`UPDATE grades SET lti_submission_state = 'submitted'`).run();
    const hung = fake({ post: { throws: Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }) } });
    await expect(run(hung)).rejects.toMatchObject({ code: 'SCHOOLOGY_UNCONFIRMED', message: expect.stringMatching(/timed out/) });
    expect(state()).toBe('submitted');
  });

  test('a POST sent to sign-in → SCHOOLOGY_SESSION (Schoology did not take it)', async () => {
    const f = fake({ post: { login: true } });
    await expect(run(f)).rejects.toMatchObject({ code: 'SCHOOLOGY_SESSION' });
    expect(state()).toBe('submitted');
  });

  test('a verification read that fails counts as not confirmed', async () => {
    const f = fake({ inProgress: { throws: Object.assign(new Error('t'), { name: 'TimeoutError' }) } });
    await expect(run(f)).rejects.toMatchObject({ code: 'SCHOOLOGY_UNCONFIRMED' });
  });

  test('an assignment page that cannot be read is an honest failure, not "expired" (nothing POSTed)', async () => {
    for (const page of [{ throws: new Error('ENOTFOUND') }, { status: 500, text: 'err' }]) {
      resetSessionStatusCache();
      const f = fake({ page });
      await expect(run(f)).rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED', message: expect.stringMatching(/Could not open the assignment page/) });
      expect(posts(f)).toHaveLength(0);
      expect((await sessionStatus({ hasSession: () => true, check: false })).live).toBeNull();
    }
  });

  test('accepted but the student is not in progress afterwards → unconfirmed (after retries)', async () => {
    const f = fake({ inProgress: { json: { data: [{ id: 12345 }] } } });
    await expect(run(f)).rejects.toMatchObject({ code: 'SCHOOLOGY_UNCONFIRMED', message: expect.stringMatching(/does not show as in progress/) });
    expect(f.requests.filter((q) => q.path === LIST)).toHaveLength(3);
    expect(state()).toBe('submitted');
  });

  test('no CSRF pair on the page → failure, nothing POSTed', async () => {
    const f = fake({ csrf: {} });
    await expect(run(f)).rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED' });
    expect(posts(f)).toHaveLength(0);
  });

  test('a later success clears a recorded unsubmit_error for the pair', async () => {
    db.prepare(`INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons, unsubmit_error)
      SELECT ?, ?, course_id, 'request', 'open', datetime('now'), 3, 'old failure' FROM assignments WHERE id = ?`).run(studentId, assignmentId, assignmentId);
    await run(fake());
    expect(db.prepare('SELECT unsubmit_error FROM resubmissions').get().unsubmit_error).toBeNull();
  });
});

describe('tryUnsubmitLti / eligibility', () => {
  test('a failure becomes { ok: false, error, code, url } — the assignment page with the Unsubmit button', async () => {
    const r = await tryUnsubmitLti(db, { studentId, assignmentId }, { jar: null });
    expect(r).toEqual({
      ok: false, code: 'SCHOOLOGY_SESSION', error: 'Schoology connection expired: reconnect in Settings', uncertain: false,
      url: `${BASE}/assignments/${AID}/info`,
    });
  });

  test('an unconfirmed failure is marked uncertain', async () => {
    const f = fake({ post: { status: 503, text: '' } });
    expect(await tryUnsubmitLti(db, { studentId, assignmentId }, { jar: f.jar, fetchImpl: f.fetchImpl }))
      .toMatchObject({ ok: false, code: 'SCHOOLOGY_UNCONFIRMED', uncertain: true });
  });

  test('success → { ok: true }', async () => {
    const f = fake();
    expect(await tryUnsubmitLti(db, { studentId, assignmentId }, { jar: f.jar, fetchImpl: f.fetchImpl })).toEqual({ ok: true });
  });

  test('unsubmitAvailable / assertCanUnsubmit', () => {
    expect(unsubmitAvailable(db, { studentId, assignmentId })).toBe(true);
    expect(assertCanUnsubmit(db, { studentId, assignmentId })).toMatchObject({ uid: UID, schoologyAssignmentId: AID });
    db.prepare(`UPDATE grades SET lti_submission_state = 'in_progress'`).run();
    expect(unsubmitAvailable(db, { studentId, assignmentId })).toBe(false);
    expect(unsubmitAvailable(db, { studentId: 999, assignmentId })).toBe(false);
  });
});
