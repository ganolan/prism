// SharePoint (the teacher's OneDrive) over plain HTTP, no browser (#141, spiked 2026-10-19 with
// scripts/probe-sharepoint-http.js). The saved session holds no SharePoint cookies, but it holds
// Microsoft's remembered sign-in (ESTSAUTHPERSISTENT on login.microsoftonline.com), and that is enough:
//   GET {origin}/_layouts/15/onedrive.aspx → 302s through /_forms/default.aspx to Microsoft's
//   /oauth2/authorize → 200, a form_post page (fields ear_jwe, state) addressed to {origin}/_forms/default.aspx
//   → POST it → 302, FedAuth + rtFa set → SharePoint REST answers.
// Microsoft's cookies are read from the saved state and never written back (the browser path did not
// save them either). Read-only GETs after the sign-in. See .claude/schoology-api-reference.md
// ("OneDrive lti_submission file links").
import { existsSync, readFileSync } from 'fs';
import { sessionStateFile } from '../lib/sessionPaths.js';
import { findFolderById } from '../lib/oneDriveSubmissions.js';
import { stateCookieJar, USER_AGENT } from '../lib/stateCookieJar.js';

export { USER_AGENT };

// Created by the Schoology Microsoft OneDrive app in the teacher's Documents.
export const ASSIGNMENTS_FOLDER = 'Schoology Microsoft OneDrive Assignments';
const MICROSOFT = /(^|\.)(microsoftonline\.com|windows\.net|live\.com)$/;
const MAX_HOPS = 12;
const decode = (v) => v.replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The form Microsoft's page asks the browser to submit: { action, fields } or null.
function formPost(html, base) {
  const form = html.match(/<form\b[^>]*\baction="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  const fields = [];
  for (const [tag] of form[2].matchAll(/<input\b[^>]*>/gi)) {
    if (!/type="hidden"/i.test(tag)) continue;
    const name = tag.match(/\bname="([^"]*)"/i)?.[1];
    if (name) fields.push([decode(name), decode(tag.match(/\bvalue="([^"]*)"/i)?.[1] ?? '')]);
  }
  return { action: new URL(decode(form[1]), base).href, fields };
}

function readState(file = sessionStateFile()) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Sign in to SharePoint from the saved Microsoft cookies.
 * → { status: 'ok', origin, personal, getJson(url) } | { status: 'no_session' | 'sso_failed' | 'error' }.
 * personal = the signed-in user's OneDrive URL (GetMyProperties PersonalUrl, ends in '/').
 * getJson(url) → the parsed answer of a 200, else null. sso_failed when Microsoft wants a real sign-in
 * (a page with no form to post back), a form addressed anywhere but `origin`, or no PersonalUrl.
 */
export async function signInToSharePoint({ state, origin, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  let saved;
  try { saved = state === undefined ? readState() : state; } catch { return { status: 'no_session' }; }
  if (!saved) return { status: 'no_session' };
  const home = new URL(origin);
  // Schoology's cookies never go to SharePoint or Microsoft.
  const jar = stateCookieJar(saved.cookies, { exclude: (c) => /schoology/i.test(c.domain) });
  const request = async (url, init = {}) => {
    const res = await fetchImpl(url, {
      ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { cookie: jar.header(url), 'User-Agent': USER_AGENT, ...init.headers },
    });
    jar.take(res, url);
    const location = res.headers.get('location');
    return { status: res.status, url, location: location ? new URL(location, url).href : null, text: await res.text() };
  };
  try {
    let r = await request(`${home.origin}/_layouts/15/onedrive.aspx`);
    for (let hops = 0; ; hops++) {
      if (hops >= MAX_HOPS) return { status: 'sso_failed' };
      if (r.location) { r = await request(r.location); continue; }
      const host = new URL(r.url).host;
      if (r.status === 200 && host === home.host) break;
      if (r.status !== 200 || !MICROSOFT.test(host)) return { status: 'sso_failed' };
      const form = formPost(r.text, r.url);
      // Only Microsoft's answer to SharePoint is sent on: a form for any other host is never posted.
      if (!form || new URL(form.action).origin !== home.origin) return { status: 'sso_failed' };
      r = await request(form.action, {
        method: 'POST', body: new URLSearchParams(form.fields).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    }
    const getJson = async (url) => {
      const res = await request(url, { headers: { Accept: 'application/json;odata=nometadata' } });
      if (res.status !== 200) return null;
      try { return JSON.parse(res.text); } catch { return null; }
    };
    const me = await getJson(`${home.origin}/_api/SP.UserProfiles.PeopleManager/GetMyProperties?$select=PersonalUrl`);
    if (!me?.PersonalUrl) return { status: 'sso_failed' };
    return { status: 'ok', origin: home.origin, personal: me.PersonalUrl.replace(/\/?$/, '/'), getJson };
  } catch (err) {
    console.error('[sharepoint] Error:', err.message);
    return { status: 'error' };
  }
}

/**
 * The student copies of one assignment, through any transport's getJson (this module's, or a browser
 * page's in scripts/parity-onedrive-links.js). → (sectionId, assignmentId) →
 * { status: 'ok', origin, files } | { status: 'no_folder' | 'error' }. Folder listings are reused
 * within one session (many assignments share a section).
 */
export function listAssignmentFiles({ origin, personal, getJson }) {
  const personalPath = new URL(personal).pathname; // /personal/{user}/
  const byPath = (p) => `${personal}_api/web/GetFolderByServerRelativePath(decodedurl='${encodeURIComponent(p.replace(/'/g, "''"))}')`;
  const folderCache = new Map();
  const subfolders = async (p) => {
    if (!folderCache.has(p)) folderCache.set(p, (await getJson(`${byPath(p)}/Folders?$select=Name,ServerRelativeUrl`))?.value ?? null);
    return folderCache.get(p);
  };
  return async (sectionId, assignmentId) => {
    const section = findFolderById(await subfolders(`${personalPath}Documents/${ASSIGNMENTS_FOLDER}`), sectionId);
    if (!section) return { status: 'no_folder' };
    const assignment = findFolderById(await subfolders(section.ServerRelativeUrl), assignmentId);
    if (!assignment) return { status: 'no_folder' };
    const files = await getJson(`${byPath(assignment.ServerRelativeUrl)}/Files?$select=Name,ServerRelativeUrl,LinkingUrl,TimeLastModified`);
    if (!Array.isArray(files?.value)) return { status: 'error' };
    return { status: 'ok', origin, files: files.value };
  };
}
