import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { unsubmitLti, tryUnsubmitLti, assertCanUnsubmit, unsubmitAvailable } from './ltiUnsubmit.js';
import { sessionDeps, sessionStatus, resetSessionStatusCache } from './schoologySession.js';
import { fakeSchoologyPage } from '../testing/fakeSchoologyPage.js';

const BASE = 'https://schoology.hkis.edu.hk';
const AID = '8000000001';
const UID = '90001';

const fakeSession = (opts = {}) => fakeSchoologyPage({ uid: UID, aid: AID, ...opts });

let db, studentId, assignmentId;
const state = () => db.prepare('SELECT lti_submission_state FROM grades WHERE student_id = ? AND assignment_id = ?').get(studentId, assignmentId).lti_submission_state;

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM resubmissions; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec', 'Course')`).run().lastInsertRowid;
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Test', 'Student')`).run(UID).lastInsertRowid;
  assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission) VALUES (?, ?, 'Notebook', 1)`)
    .run(courseId, AID).lastInsertRowid;
  db.prepare(`INSERT INTO grades (student_id, assignment_id, score, lti_submission_state) VALUES (?, ?, 3, 'submitted')`).run(studentId, assignmentId);
  resetSessionStatusCache();
  sessionDeps.openPage = vi.fn(() => { throw new Error('tests must inject a fake page'); });
});
afterEach(() => resetSessionStatusCache());

describe('unsubmitLti', () => {
  test('success: loads the assignment page, POSTs exactly {"isSubmit":false} with the CSRF pair, verifies, marks in progress', async () => {
    const f = fakeSession();
    const r = await unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session });
    expect(r).toEqual({ unsubmitted: true });
    expect(f.page.goto).toHaveBeenCalledWith(`${BASE}/assignments/${AID}/info`, expect.any(Object));
    const post = f.requests.find((q) => q.method === 'POST');
    expect(post.url).toBe(`${BASE}/iapi2/assignments/${AID}/submission-action/${UID}`);
    expect(post.body).toBe('{"isSubmit":false}');
    expect(post.headers).toMatchObject({ 'Content-Type': 'application/json', Accept: 'application/json', 'X-Csrf-Token': 'tok', 'X-Csrf-Key': 'key' });
    expect(post.credentials).toBe('include');
    expect(f.requests.some((q) => q.url === `${BASE}/iapi2/assignments/${AID}/in-progress-documents/`)).toBe(true);
    expect(state()).toBe('in_progress');
    expect(f.session.close).toHaveBeenCalled();
    // Only one write, and never a re-submit.
    expect(f.requests.filter((q) => q.method === 'POST')).toHaveLength(1);
    expect(f.requests.some((q) => String(q.body).includes('true'))).toBe(false);
  });

  test('not LTI → NOT_ELIGIBLE before any browser work', async () => {
    db.prepare('UPDATE assignments SET is_lti_submission = 0').run();
    const openPage = vi.fn();
    await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    expect(openPage).not.toHaveBeenCalled();
  });

  test('not submitted → NOT_ELIGIBLE before any browser work', async () => {
    for (const s of ['in_progress', 'not_started', null]) {
      db.prepare('UPDATE grades SET lti_submission_state = ?').run(s);
      const openPage = vi.fn();
      await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
      expect(openPage).not.toHaveBeenCalled();
    }
  });

  test('no saved session → SCHOOLOGY_SESSION', async () => {
    await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => null }))
      .rejects.toMatchObject({ code: 'SCHOOLOGY_SESSION', message: 'Schoology connection expired — reconnect in Settings' });
    expect(state()).toBe('submitted');
  });

  test('a dead session (bounced to SSO) → SCHOOLOGY_SESSION, nothing POSTed, the live status becomes expired', async () => {
    const f = fakeSession({ landing: 'https://login.microsoftonline.com/xyz' });
    await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session })).rejects.toMatchObject({ code: 'SCHOOLOGY_SESSION' });
    expect(f.requests).toHaveLength(0);
    expect(f.session.close).toHaveBeenCalled();
    expect((await sessionStatus({ hasSession: () => true, check: false })).live).toBe('expired');
  });

  test('non-200 → failure, state unchanged', async () => {
    const f = fakeSession({ post: (respond) => respond(403, { data: null }) });
    await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session }))
      .rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED', message: expect.stringMatching(/HTTP 403/) });
    expect(state()).toBe('submitted');
  });

  test('200 with an unexpected body → unconfirmed (may or may not have worked)', async () => {
    const f = fakeSession({ post: (respond) => respond(200, '<html>oops</html>') });
    await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session }))
      .rejects.toMatchObject({ code: 'SCHOOLOGY_UNCONFIRMED', message: expect.stringMatching(/^Schoology didn't confirm the unsubmit/) });
    expect(state()).toBe('submitted');
  });

  test('a 5xx → unconfirmed; a 4xx → known refusal', async () => {
    let f = fakeSession({ post: (respond) => respond(502, 'bad gateway') });
    await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session })).rejects.toMatchObject({ code: 'SCHOOLOGY_UNCONFIRMED' });
    f = fakeSession({ post: (respond) => respond(400, { data: null }) });
    await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session })).rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED' });
  });

  test('every in-page fetch carries a timeout signal; a POST that times out is unconfirmed, not failed', async () => {
    const ok = fakeSession();
    await unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => ok.session });
    expect(ok.requests.length).toBeGreaterThan(1);
    for (const q of ok.requests) expect(q.signal).toBeInstanceOf(AbortSignal);
    db.prepare(`UPDATE grades SET lti_submission_state = 'submitted'`).run();
    const hung = fakeSession({ post: () => { throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }); } });
    await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => hung.session }))
      .rejects.toMatchObject({ code: 'SCHOOLOGY_UNCONFIRMED', message: expect.stringMatching(/TimeoutError/) });
    expect(state()).toBe('submitted');
  });

  test('a verification read that times out counts as not confirmed', async () => {
    const f = fakeSession({ inProgress: () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } });
    await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session })).rejects.toMatchObject({ code: 'SCHOOLOGY_UNCONFIRMED' });
  });

  test('a navigation error / about:blank is an honest failure, not "expired" (nothing POSTed)', async () => {
    for (const setup of [
      (f) => { f.page.goto.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED')); f.page.url.mockReturnValue('about:blank'); },
      (f) => { f.page.url.mockReturnValue('about:blank'); },
    ]) {
      resetSessionStatusCache();
      const f = fakeSession();
      setup(f);
      await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session }))
        .rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED', message: expect.stringMatching(/Could not open the assignment page/) });
      expect(f.requests).toHaveLength(0);
      expect((await sessionStatus({ hasSession: () => true, check: false })).live).toBeNull();
    }
  });

  test('a browser that fails to launch → known failure', async () => {
    await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => { throw new Error('no chromium'); } }))
      .rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED' });
  });

  test('accepted but the student is not in progress afterwards → failure (after retries)', async () => {
    const f = fakeSession({ inProgress: (respond) => respond(200, { data: [{ id: 12345 }] }) });
    await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session }))
      .rejects.toMatchObject({ code: 'SCHOOLOGY_UNCONFIRMED', message: expect.stringMatching(/does not show as in progress/) });
    expect(f.requests.filter((q) => q.url.includes('in-progress-documents'))).toHaveLength(3);
    expect(state()).toBe('submitted');
  });

  test('no CSRF pair on the page → failure, nothing POSTed', async () => {
    const f = fakeSession({ csrf: {} });
    await expect(unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session })).rejects.toMatchObject({ code: 'SCHOOLOGY_WRITE_FAILED' });
    expect(f.requests).toHaveLength(0);
  });

  test('a later success clears a recorded unsubmit_error for the pair', async () => {
    db.prepare(`INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons, unsubmit_error)
      SELECT ?, ?, course_id, 'request', 'open', datetime('now'), 3, 'old failure' FROM assignments WHERE id = ?`).run(studentId, assignmentId, assignmentId);
    const f = fakeSession();
    await unsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session });
    expect(db.prepare('SELECT unsubmit_error FROM resubmissions').get().unsubmit_error).toBeNull();
  });
});

describe('tryUnsubmitLti / eligibility', () => {
  test('a failure becomes { ok: false, error, code, url } — the assignment page with the Unsubmit button', async () => {
    const r = await tryUnsubmitLti(db, { studentId, assignmentId }, { openPage: async () => null });
    expect(r).toEqual({
      ok: false, code: 'SCHOOLOGY_SESSION', error: 'Schoology connection expired — reconnect in Settings', uncertain: false,
      url: `${BASE}/assignments/${AID}/info`,
    });
  });

  test('an unconfirmed failure is marked uncertain', async () => {
    const f = fakeSession({ post: (respond) => respond(503, '') });
    expect(await tryUnsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session }))
      .toMatchObject({ ok: false, code: 'SCHOOLOGY_UNCONFIRMED', uncertain: true });
  });

  test('success → { ok: true }', async () => {
    const f = fakeSession();
    expect(await tryUnsubmitLti(db, { studentId, assignmentId }, { openPage: async () => f.session })).toEqual({ ok: true });
  });

  test('unsubmitAvailable / assertCanUnsubmit', () => {
    expect(unsubmitAvailable(db, { studentId, assignmentId })).toBe(true);
    expect(assertCanUnsubmit(db, { studentId, assignmentId })).toMatchObject({ uid: UID, schoologyAssignmentId: AID });
    db.prepare(`UPDATE grades SET lti_submission_state = 'in_progress'`).run();
    expect(unsubmitAvailable(db, { studentId, assignmentId })).toBe(false);
    expect(unsubmitAvailable(db, { studentId: 999, assignmentId })).toBe(false);
  });
});
