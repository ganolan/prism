// openClient (spec §14, §15): the writer's only way to Schoology. The fake page runs the REAL in-page
// functions against a stub window (Drupal CSRF settings) and fetch, so a test sees what would be sent.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { openClient } from './quizWriteback.js';
import { resetSessionStatusCache } from './schoologySession.js';

const BASE = 'https://schoology.hkis.edu.hk';
const BYQ = '/assignment/900/assessment_results/question_stats/2001/21';
const GI = '/iapi/grades/assessment_component_submission_rubric_grade_info/91/2001/92/5001';
const LOGIN = 'https://login.microsoftonline.com/x';

// `respond(url, init)` answers each fetch ({ status, url }) or throws (a blocked SSO redirect, a timeout).
// `landings` lists where each later visit to /home lands (a URL, or an Error the visit throws).
function fakeSession({ respond = (url) => ({ status: 200, url }), csrf = { csrf_token: 'tok', csrf_key: 'key' }, landings = [] } = {}) {
  const requests = [];
  let at = 'about:blank';
  let visits = 0;
  const fetchStub = vi.fn(async (url, init = {}) => {
    requests.push({ url, ...init });
    const r = await respond(url, init);
    return { status: r.status, url: r.url ?? url, text: async () => r.text ?? '' };
  });
  const page = {
    goto: vi.fn(async () => {
      const next = visits++ === 0 ? `${BASE}/home` : (landings.shift() ?? `${BASE}/home`);
      if (next instanceof Error) { if (!next.stay) at = 'about:blank'; throw next; }
      at = next;
    }),
    url: () => at,
    evaluate: vi.fn(async (fn, arg) => {
      const prev = [globalThis.window, globalThis.fetch];
      globalThis.window = { Drupal: { settings: { s_common: csrf } } };
      globalThis.fetch = fetchStub;
      try { return await fn(arg); } finally { [globalThis.window, globalThis.fetch] = prev; }
    }),
  };
  const close = vi.fn(async () => {});
  return { openPage: async () => ({ page, close }), requests, page, close };
}

const open = (s) => openClient({ pauseMs: 0, openPage: s.openPage });
beforeEach(() => resetSessionStatusCache());

describe('openClient', () => {
  test('no saved session: NO_SESSION before any request', async () => {
    await expect(openClient({ pauseMs: 0, openPage: async () => null })).rejects.toMatchObject({ code: 'NO_SESSION' });
  });

  test('a form save goes only to a grade-by-question page', async () => {
    const s = fakeSession();
    const c = await open(s);
    for (const path of ['/assignment/900/assessment_results/student_stats/701/5001', `${BYQ}/x`, '/assignment/900/unsubmit', GI]) {
      await expect(c.post(path, 'a=1')).rejects.toThrow(/Refusing to post/);
    }
    expect(s.requests).toEqual([]);
  });

  test('a rubric save goes only to the rubric grade path', async () => {
    const s = fakeSession();
    const c = await open(s);
    for (const path of ['/iapi/grades/rubric/91', BYQ, `${GI}/1`]) {
      await expect(c.putRubric(path, {})).rejects.toThrow(/Refusing to put/);
    }
    expect(s.requests).toEqual([]);
  });

  test('the form save posts the body as a form; the rubric save is a JSON PUT with Drupal\'s CSRF headers', async () => {
    const s = fakeSession({ respond: (url, init) => ({ status: init.method === 'POST' ? 302 : 200, url }) });
    const c = await open(s);
    expect(await c.post(BYQ, 'a=1&op=Save+Changes')).toMatchObject({ status: 302 });
    const json = { gradeInfo: { 146: { grade: 3, comment: '' } }, overrideGrade: null, comment: 'Good' };
    expect(await c.putRubric(GI, json)).toMatchObject({ status: 200 });
    const [post, put] = s.requests;
    expect([post.url, post.method, post.headers['Content-Type'], post.body, post.credentials]).toEqual([`${BASE}${BYQ}`, 'POST', 'application/x-www-form-urlencoded', 'a=1&op=Save+Changes', 'include']);
    expect([put.url, put.method, put.headers['X-Csrf-Token'], put.headers['X-Csrf-Key'], put.headers['Content-Type'], JSON.parse(put.body)])
      .toEqual([`${BASE}${GI}`, 'PUT', 'tok', 'key', 'application/json;charset=UTF-8', json]);
  });

  test('each save waits the pause first, like each read', async () => {
    const s = fakeSession();
    const sleep = vi.fn(async () => {});
    const c = await openClient({ pauseMs: 400, openPage: s.openPage, sleep });
    await c.putRubric(GI, {});
    await c.post(BYQ, 'a=1');
    expect(sleep.mock.calls).toEqual([[400], [400]]);
    expect(s.requests).toHaveLength(2);
  });

  test('no CSRF values on the page: no rubric save is sent', async () => {
    const s = fakeSession({ csrf: {} });
    const c = await open(s);
    expect(await c.putRubric(GI, {})).toEqual({ status: 0, error: 'no CSRF values on the page' });
    expect(s.requests).toEqual([]);
  });

  test('a save that lands on the sign-in page: NO_SESSION', async () => {
    const s = fakeSession({ respond: () => ({ status: 200, url: LOGIN }) });
    const c = await open(s);
    await expect(c.post(BYQ, 'a=1')).rejects.toMatchObject({ code: 'NO_SESSION', message: 'Schoology connection expired while posting: reconnect in Settings' });
  });

  describe('a request that fails outright (HTTP 0) checks the session', () => {
    const blocked = () => { throw new TypeError('Failed to fetch'); };
    test('home still loads: the failure is returned for that student', async () => {
      const s = fakeSession({ respond: blocked });
      const c = await open(s);
      expect(await c.putRubric(GI, {})).toMatchObject({ status: 0, error: 'Failed to fetch' });
      expect(await c.get(BYQ)).toMatchObject({ status: 0 });
    });
    test.each([
      ['form save', (c) => c.post(BYQ, 'a=1')],
      ['rubric save', (c) => c.putRubric(GI, {})],
      ['read', (c) => c.get(BYQ)],
    ])('%s, then home lands on sign-in: NO_SESSION', async (_n, call) => {
      const s = fakeSession({ respond: blocked, landings: [LOGIN] });
      const c = await open(s);
      await expect(call(c)).rejects.toMatchObject({ code: 'NO_SESSION', message: 'Schoology connection expired while posting: reconnect in Settings' });
    });
    test('home times out and the page stays where it was: UNREACHABLE, not a live session', async () => {
      const s = fakeSession({ respond: blocked, landings: [Object.assign(new Error('Timeout 30000ms exceeded'), { stay: true })] });
      const c = await open(s);
      await expect(c.get(BYQ)).rejects.toMatchObject({ code: 'UNREACHABLE' });
    });
    test('home does not load: UNREACHABLE', async () => {
      const s = fakeSession({ respond: blocked, landings: [new Error('net::ERR_INTERNET_DISCONNECTED')] });
      const c = await open(s);
      await expect(c.post(BYQ, 'a=1')).rejects.toMatchObject({ code: 'UNREACHABLE' });
    });
  });
});
