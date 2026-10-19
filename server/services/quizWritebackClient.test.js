// openClient (spec §14, §15): the writer's only way to Schoology, over plain HTTP (#141) on the fake
// web seam, so a test sees exactly what would be sent. Never reaches the network.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { openClient } from './quizWriteback.js';
import { resetSessionStatusCache, sessionStatus } from './schoologySession.js';
import { fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';

const BYQ = '/assignment/900/assessment_results/question_stats/2001/21';
const GI = '/iapi/grades/assessment_component_submission_rubric_grade_info/91/2001/92/5001';
const HOME = (csrf = { csrf_token: 'tok', csrf_key: 'key' }) => ({
  text: `<script>jQuery.extend(Drupal.settings, ${JSON.stringify({ s_common: csrf })});</script>`,
});
const EXPIRED = 'Schoology connection expired while posting: reconnect in Settings';

const fake = (routes = {}) => fakeSchoologyWeb({ routes: {
  '/home': HOME(),
  [`POST ${BYQ}`]: { status: 302, text: '', headers: { location: `https://schoology.hkis.edu.hk${BYQ}` } },
  [`PUT ${GI}`]: { json: { data: {} } },
  [BYQ]: { text: '<html>page</html>' },
  ...routes,
} });
const open = (f, opts = {}) => openClient({ pauseMs: 0, web: { jar: f.jar, fetchImpl: f.fetchImpl }, ...opts });
const writes = (f) => f.requests.filter((q) => q.method !== 'GET');
beforeEach(() => resetSessionStatusCache());

describe('openClient (plain HTTP)', () => {
  test('no saved session: NO_SESSION before any request', async () => {
    await expect(openClient({ pauseMs: 0, web: { jar: null } })).rejects.toMatchObject({ code: 'NO_SESSION' });
  });

  test('a form save goes only to a grade-by-question page', async () => {
    const f = fake();
    const c = await open(f);
    for (const path of ['/assignment/900/assessment_results/student_stats/701/5001', `${BYQ}/x`, '/assignment/900/unsubmit', GI]) {
      await expect(c.post(path, 'a=1')).rejects.toThrow(/Refusing to post/);
    }
    expect(f.requests).toEqual([]);
  });

  test('a rubric save goes only to the rubric grade path', async () => {
    const f = fake();
    const c = await open(f);
    for (const path of ['/iapi/grades/rubric/91', BYQ, `${GI}/1`]) {
      await expect(c.putRubric(path, {})).rejects.toThrow(/Refusing to put/);
    }
    expect(f.requests).toEqual([]);
  });

  test('the form save posts the body as a form; the rubric save is a JSON PUT with the CSRF pair from /home', async () => {
    const f = fake();
    const c = await open(f);
    expect(await c.post(BYQ, 'a=1&op=Save+Changes')).toMatchObject({ status: 302 });
    const json = { gradeInfo: { 146: { grade: 3, comment: '' } }, overrideGrade: null, comment: 'Good' };
    expect(await c.putRubric(GI, json)).toMatchObject({ status: 200 });
    const [post, put] = writes(f);
    expect([post.path, post.headers['Content-Type'], post.body, post.headers.cookie]).toEqual([BYQ, 'application/x-www-form-urlencoded', 'a=1&op=Save+Changes', 'SESS=old']);
    expect([put.path, put.headers['X-Csrf-Token'], put.headers['X-Csrf-Key'], put.headers['Content-Type'], put.headers.Accept, put.json])
      .toEqual([GI, 'tok', 'key', 'application/json;charset=UTF-8', 'application/json', json]);
    // The CSRF pair is read once.
    await c.putRubric(GI, json);
    expect(f.requests.filter((q) => q.path === '/home')).toHaveLength(1);
  });

  test('reads go through the HTTP reader', async () => {
    const f = fake();
    const c = await open(f);
    expect(await c.get(BYQ)).toMatchObject({ status: 200, text: '<html>page</html>' });
  });

  test('each save waits the pause first, like each read', async () => {
    const f = fake();
    const sleep = vi.fn(async () => {});
    const c = await open(f, { pauseMs: 400, sleep });
    await c.putRubric(GI, {});
    await c.post(BYQ, 'a=1');
    expect(sleep.mock.calls).toEqual([[400], [400]]);
    expect(writes(f)).toHaveLength(2);
  });

  test('no CSRF values on /home: no rubric save is sent', async () => {
    const f = fake({ '/home': HOME({}) });
    const c = await open(f);
    expect(await c.putRubric(GI, {})).toEqual({ status: 0, error: 'no CSRF values on the page' });
    expect(writes(f)).toEqual([]);
  });

  test.each([
    ['form save', (c) => c.post(BYQ, 'a=1'), `POST ${BYQ}`],
    ['rubric save', (c) => c.putRubric(GI, {}), `PUT ${GI}`],
  ])('a %s sent to sign-in: NO_SESSION, and the session reads expired', async (_n, call, key) => {
    const f = fake({ [key]: { login: true } });
    const c = await open(f);
    await expect(call(c)).rejects.toMatchObject({ code: 'NO_SESSION', message: EXPIRED });
    expect((await sessionStatus({ check: false, hasSession: () => true })).live).toBe('expired');
  });

  test('a refused save is returned with its status', async () => {
    const f = fake({ [`PUT ${GI}`]: { status: 403, json: { data: null } } });
    const c = await open(f);
    expect(await c.putRubric(GI, {})).toMatchObject({ status: 403 });
  });

  describe('a save that fails outright (HTTP 0) checks the session', () => {
    const down = { throws: new TypeError('fetch failed') };
    test('home still loads: the failure is returned for that student', async () => {
      const f = fake({ [`PUT ${GI}`]: down });
      const c = await open(f);
      expect(await c.putRubric(GI, {})).toMatchObject({ status: 0, error: expect.stringMatching(/fetch failed/) });
    });
    test.each([
      ['form save', (c) => c.post(BYQ, 'a=1'), `POST ${BYQ}`],
      ['rubric save', (c) => c.putRubric(GI, {}), `PUT ${GI}`],
    ])('%s, then home is sent to sign-in: NO_SESSION', async (_n, call, key) => {
      // The session ends with the failed save: /home is sent to sign-in only after it.
      let failed = false;
      const f = fake({ [key]: () => { failed = true; return down; }, '/home': () => (failed ? { login: true } : HOME()) });
      const c = await open(f);
      await c.get(BYQ);
      await expect(call(c)).rejects.toMatchObject({ code: 'NO_SESSION' });
    });
    test('home does not answer either: UNREACHABLE', async () => {
      let homes = 0;
      const f = fake({ [`POST ${BYQ}`]: down, '/home': () => (homes++ === 0 ? HOME() : down) });
      const c = await open(f);
      await c.putRubric(GI, {});
      await expect(c.post(BYQ, 'a=1')).rejects.toMatchObject({ code: 'UNREACHABLE' });
    });
  });
});
