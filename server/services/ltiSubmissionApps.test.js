import { describe, test, expect, beforeEach, vi } from 'vitest';
import { getLtiSubmissionApp, getSubmittedDocuments, ltiAppDeps, clearLtiAppCache } from './ltiSubmissionApps.js';
import { GOOGLE_DRIVE } from '../lib/ltiSubmissionApp.js';

const PAGE = `<script>jQuery.extend(Drupal.settings, {"assignment":{"ltiSubmissionApp":{` +
  `"launchUrl":"\\/apps\\/lti\\/1073361950\\/run\\/assignment\\/555?context=assignment_submission",` +
  `"submissionsTargetUrl":"https:\\/\\/lti-submission-google.app.schoology.com\\/lti\\/assignment-template\\/1"}}});</script>`;

function fakeWeb({ page = PAGE, pageStatus = 200, loginRedirect = false, submitted = { data: [{ id: 101 }] }, submittedStatus = 200 } = {}) {
  const requests = [];
  const fetchImpl = vi.fn(async (url, opts = {}) => {
    const u = new URL(url);
    requests.push({ path: u.pathname, headers: opts.headers || {} });
    if (loginRedirect) return new Response('', { status: 302, headers: { location: 'https://login.microsoftonline.com/x' } });
    if (u.pathname === '/assignment/555') return new Response(page, { status: pageStatus });
    if (u.pathname === '/iapi2/assignments/555/submitted-documents/') {
      return new Response(JSON.stringify(submitted), { status: submittedStatus });
    }
    return new Response('nope', { status: 404 });
  });
  return { fetchImpl, requests };
}

let web;
beforeEach(() => {
  clearLtiAppCache();
  web = fakeWeb();
  ltiAppDeps.fetch = web.fetchImpl;
  ltiAppDeps.cookieJar = () => ({ header: () => 'SESS=1', take: () => {} });
});

describe('getLtiSubmissionApp', () => {
  test('reads the app from the assignment page over plain HTTP, with the session cookie', async () => {
    const app = await getLtiSubmissionApp({ assignmentId: '555' });
    expect(app).toMatchObject({ status: 'ok', appId: '1073361950', provider: GOOGLE_DRIVE });
    expect(web.requests).toEqual([{ path: '/assignment/555', headers: { cookie: 'SESS=1' } }]);
  });

  test('cached: a second call makes no request; refresh reads again', async () => {
    await getLtiSubmissionApp({ assignmentId: '555' });
    await getLtiSubmissionApp({ assignmentId: '555' });
    expect(web.requests).toHaveLength(1);
    await getLtiSubmissionApp({ assignmentId: '555', refresh: true });
    expect(web.requests).toHaveLength(2);
  });

  test('a page with no submission app is no_app', async () => {
    ltiAppDeps.fetch = fakeWeb({ page: '<html>Essay</html>' }).fetchImpl;
    expect(await getLtiSubmissionApp({ assignmentId: '555' })).toEqual({ status: 'no_app' });
  });

  test('no saved session, an expired session, or an HTTP failure is a status, never a throw', async () => {
    ltiAppDeps.cookieJar = () => null;
    expect(await getLtiSubmissionApp({ assignmentId: '555' })).toEqual({ status: 'no_session' });

    ltiAppDeps.cookieJar = () => ({ header: () => '', take: () => {} });
    ltiAppDeps.fetch = fakeWeb({ loginRedirect: true }).fetchImpl;
    expect(await getLtiSubmissionApp({ assignmentId: '555' })).toEqual({ status: 'session_expired' });

    ltiAppDeps.fetch = fakeWeb({ pageStatus: 500 }).fetchImpl;
    expect(await getLtiSubmissionApp({ assignmentId: '555' })).toEqual({ status: 'error' });
  });

  test('failures are not cached', async () => {
    ltiAppDeps.fetch = fakeWeb({ pageStatus: 500 }).fetchImpl;
    await getLtiSubmissionApp({ assignmentId: '555' });
    ltiAppDeps.fetch = web.fetchImpl;
    expect((await getLtiSubmissionApp({ assignmentId: '555' })).status).toBe('ok');
  });
});

describe('getSubmittedDocuments', () => {
  test("reads the grader's submitted list as JSON", async () => {
    expect(await getSubmittedDocuments({ assignmentId: '555' })).toEqual({ status: 'ok', entries: [{ id: 101 }] });
    expect(web.requests[0]).toEqual({ path: '/iapi2/assignments/555/submitted-documents/', headers: { cookie: 'SESS=1', Accept: 'application/json' } });
  });

  test('a refused or malformed answer is an error', async () => {
    ltiAppDeps.fetch = fakeWeb({ submittedStatus: 403, submitted: { data: null } }).fetchImpl;
    expect(await getSubmittedDocuments({ assignmentId: '555' })).toEqual({ status: 'error' });
    ltiAppDeps.fetch = fakeWeb({ submitted: { nope: true } }).fetchImpl;
    expect(await getSubmittedDocuments({ assignmentId: '555' })).toEqual({ status: 'error' });
  });

  test('a sign-in redirect is session_expired', async () => {
    ltiAppDeps.fetch = fakeWeb({ loginRedirect: true }).fetchImpl;
    expect(await getSubmittedDocuments({ assignmentId: '555' })).toEqual({ status: 'session_expired' });
  });
});
