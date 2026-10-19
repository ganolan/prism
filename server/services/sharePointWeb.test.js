// SharePoint over plain HTTP (#141): the sign-in by hand from the saved Microsoft cookies, on a fake
// fetch. Never reaches the network.
import { describe, test, expect } from 'vitest';
import { signInToSharePoint, listAssignmentFiles } from './sharePointWeb.js';

const SP = 'https://hkis-my.sharepoint.com';
const AUTH = 'https://login.microsoftonline.com/tenant/oauth2/authorize';
const STATE = { cookies: [
  { domain: '.login.microsoftonline.com', name: 'ESTSAUTHPERSISTENT', value: 'p' },
  { domain: 'schoology.hkis.edu.hk', name: 'SESS1', value: 's' },
] };
const FORM = `<html><body><form method="POST" name="hiddenform" action="${SP}/_forms/default.aspx"><input type="hidden" name="ear_jwe" value="j&amp;1" /><input type="hidden" name="state" value="st" /><noscript><input type="submit" value="Continue" /></noscript></form></body></html>`;

// routes: 'METHOD host+path' → (req) => ({ status, location?, setCookie?, body? }). Records requests.
function fakeFetch(routes) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const req = { method: init.method || 'GET', url, key: `${init.method || 'GET'} ${u.host}${u.pathname}`, headers: init.headers || {}, body: init.body };
    requests.push(req);
    const route = routes[req.key];
    if (!route) return new Response('not faked', { status: 404 });
    const r = route(req);
    const headers = new Headers();
    if (r.location) headers.set('location', r.location);
    for (const c of r.setCookie ?? []) headers.append('set-cookie', c);
    return new Response(r.body ?? '', { status: r.status, headers });
  };
  return { fetchImpl, requests };
}

const signInRoutes = (over = {}) => ({
  [`GET hkis-my.sharepoint.com/_layouts/15/onedrive.aspx`]: (req) => (String(req.headers.cookie).includes('FedAuth=f')
    ? { status: 200, body: 'onedrive' } : { status: 302, location: `${SP}/_forms/default.aspx` }),
  [`GET hkis-my.sharepoint.com/_forms/default.aspx`]: () => ({ status: 302, location: `${AUTH}?client_id=x` }),
  [`GET login.microsoftonline.com/tenant/oauth2/authorize`]: (req) => (String(req.headers.cookie).includes('ESTSAUTHPERSISTENT=p')
    ? { status: 200, body: FORM } : { status: 200, body: '<html><script>$Config={"pgid":"Login"}</script></html>' }),
  [`POST hkis-my.sharepoint.com/_forms/default.aspx`]: () => ({ status: 302, location: `${SP}/_layouts/15/onedrive.aspx`, setCookie: ['FedAuth=f; path=/; secure', 'rtFa=r; domain=sharepoint.com; path=/'] }),
  [`GET hkis-my.sharepoint.com/_api/SP.UserProfiles.PeopleManager/GetMyProperties`]: (req) => (String(req.headers.cookie).includes('FedAuth=f')
    ? { status: 200, body: JSON.stringify({ PersonalUrl: `${SP}/personal/t_school/` }) } : { status: 403 }),
  ...over,
});

describe('signInToSharePoint', () => {
  test('follows the sign-in, posts Microsoft\'s form back to SharePoint, then reads with FedAuth', async () => {
    const f = fakeFetch(signInRoutes());
    const s = await signInToSharePoint({ state: STATE, origin: SP, fetchImpl: f.fetchImpl });
    expect(s).toMatchObject({ status: 'ok', personal: `${SP}/personal/t_school/` });
    const post = f.requests.find((q) => q.method === 'POST');
    expect(Object.fromEntries(new URLSearchParams(post.body))).toEqual({ ear_jwe: 'j&1', state: 'st' });
    // Microsoft's cookies go only to Microsoft; Schoology's go nowhere here.
    const auth = f.requests.find((q) => q.key.startsWith('GET login.microsoftonline.com'));
    expect(auth.headers.cookie).toBe('ESTSAUTHPERSISTENT=p');
    for (const q of f.requests) expect(String(q.headers.cookie ?? '')).not.toMatch(/SESS1/);
    // rtFa (domain sharepoint.com) is sent to the tenant host too.
    const me = f.requests.find((q) => q.key.includes('GetMyProperties'));
    expect(me.headers.cookie).toMatch(/FedAuth=f/);
    expect(me.headers.cookie).toMatch(/rtFa=r/);
    expect(me.headers.Accept).toBe('application/json;odata=nometadata');
    // SharePoint refuses Node's own User-Agent: every request sends a browser-like one.
    for (const q of f.requests) expect(q.headers['User-Agent']).toMatch(/^Mozilla\/5\.0 /);
  });

  test('no saved session → no_session', async () => {
    expect(await signInToSharePoint({ state: null, origin: SP, fetchImpl: async () => { throw new Error('no'); } })).toEqual({ status: 'no_session' });
  });

  test('Microsoft wants a real sign-in (a page with no form) → sso_failed, nothing posted', async () => {
    const f = fakeFetch(signInRoutes());
    const s = await signInToSharePoint({ state: { cookies: [] }, origin: SP, fetchImpl: f.fetchImpl });
    expect(s).toEqual({ status: 'sso_failed' });
    expect(f.requests.some((q) => q.method === 'POST')).toBe(false);
  });

  test('a form that would post anywhere but the SharePoint host is never sent', async () => {
    const f = fakeFetch(signInRoutes({
      [`GET login.microsoftonline.com/tenant/oauth2/authorize`]: () => ({ status: 200, body: FORM.replace(`${SP}/_forms`, 'https://evil.example/_forms') }),
    }));
    expect(await signInToSharePoint({ state: STATE, origin: SP, fetchImpl: f.fetchImpl })).toEqual({ status: 'sso_failed' });
    expect(f.requests.some((q) => q.method === 'POST')).toBe(false);
  });

  test('signed in but GetMyProperties has no PersonalUrl → sso_failed', async () => {
    const f = fakeFetch(signInRoutes({ [`GET hkis-my.sharepoint.com/_api/SP.UserProfiles.PeopleManager/GetMyProperties`]: () => ({ status: 200, body: '{}' }) }));
    expect(await signInToSharePoint({ state: STATE, origin: SP, fetchImpl: f.fetchImpl })).toEqual({ status: 'sso_failed' });
  });

  test('a request that fails outright → error', async () => {
    expect(await signInToSharePoint({ state: STATE, origin: SP, fetchImpl: async () => { throw new TypeError('fetch failed'); } })).toEqual({ status: 'error' });
  });
});

describe('listAssignmentFiles (shared by both transports)', () => {
  const ROOT = '/personal/t_school/Documents/Schoology Microsoft OneDrive Assignments';
  const folders = {
    [ROOT]: [{ Name: 'AIML - 8458134359', ServerRelativeUrl: `${ROOT}/AIML - 8458134359` }],
    [`${ROOT}/AIML - 8458134359`]: [{ Name: 'Task - 8555933030', ServerRelativeUrl: `${ROOT}/AIML - 8458134359/Task - 8555933030` }],
  };
  const files = [{ Name: 'A B - Task - 1.pptx', ServerRelativeUrl: 'x', LinkingUrl: 'l', TimeLastModified: 't' }];
  const getJson = async (url) => {
    const path = decodeURIComponent(url.match(/decodedurl='([^']+)'/)[1]).replace(/''/g, "'");
    if (url.includes('/Folders?')) return { value: folders[path] ?? [] };
    if (url.includes('/Files?')) return { value: files };
    return null;
  };
  test('section folder, then assignment folder, then its files', async () => {
    const list = listAssignmentFiles({ origin: SP, personal: `${SP}/personal/t_school/`, getJson });
    expect(await list('8458134359', '8555933030')).toEqual({ status: 'ok', origin: SP, files });
    expect(await list('8458134359', '1')).toEqual({ status: 'no_folder' });
    expect(await list('2', '8555933030')).toEqual({ status: 'no_folder' });
  });
});
