/**
 * oneDriveLinks.js
 *
 * On-demand lookup of the student copies of a OneDrive lti_submission assignment
 * in the teacher's OneDrive (#120), through SharePoint REST in the saved
 * Playwright browser session (the Microsoft SSO cookies from mastery:login sign
 * into SharePoint silently). Read-only GETs.
 *
 * The teacher's OneDrive is discovered, not configured: SharePoint's
 * GetMyProperties returns the signed-in user's PersonalUrl, so this works for
 * whichever teacher owns the session. Only the tenant host is config
 * (`microsoft.sharepointHost`).
 *
 * Best-effort like the other browser-session services: every failure resolves to
 * a status, never a throw. Successful listings are cached briefly so reopening
 * the page doesn't relaunch a browser; failures are not cached.
 */
import { existsSync } from 'fs';
import { sessionStateFile } from '../lib/sessionPaths.js';
import { findFolderById } from '../lib/oneDriveSubmissions.js';
import { getMicrosoftConfig } from '../middleware/featureGate.js';

// Created by the Schoology Microsoft OneDrive app in the teacher's Documents.
export const ASSIGNMENTS_FOLDER = 'Schoology Microsoft OneDrive Assignments';
export const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map();    // `${sectionId}:${assignmentId}` → { at, result }
const inFlight = new Map(); // same key → Promise<result>

/**
 * @returns {Promise<
 *   { status: 'ok', origin: string, files: Array<{Name, ServerRelativeUrl, LinkingUrl, TimeLastModified}> } |
 *   { status: 'no_session' | 'sso_failed' | 'no_folder' | 'error' }
 * >}
 *   no_folder = the app has made no copies for this assignment (never opened by
 *   anyone, a Google Drive assignment, or created by a different teacher).
 */
export async function getAssignmentFiles({ sectionId, assignmentId, refresh = false }) {
  const key = `${sectionId}:${assignmentId}`;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  if (inFlight.has(key)) return inFlight.get(key);

  const p = listAssignmentFiles(String(sectionId), String(assignmentId))
    .then((result) => {
      if (result.status === 'ok') cache.set(key, { at: Date.now(), result });
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** Test hook. */
export function clearOneDriveCache() {
  cache.clear();
}

async function listAssignmentFiles(sectionId, assignmentId) {
  if (!existsSync(sessionStateFile())) return { status: 'no_session' };
  const host = getMicrosoftConfig().sharepointHost.replace(/\/+$/, '');
  const origin = new URL(host).origin;

  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: sessionStateFile() });
    const page = await context.newPage();

    // A SharePoint UI page runs the Microsoft SSO redirect chain; wait to land back.
    await page.goto(`${origin}/_layouts/15/onedrive.aspx`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForURL((u) => u.origin === origin, { timeout: 60000 }).catch(() => {});
    if (new URL(page.url()).origin !== origin) return { status: 'sso_failed' };

    const getJson = (url) => page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { Accept: 'application/json;odata=nometadata' }, credentials: 'include' });
      if (r.status !== 200) return null;
      try { return await r.json(); } catch { return null; }
    }, url);

    const me = await getJson(`${origin}/_api/SP.UserProfiles.PeopleManager/GetMyProperties?$select=PersonalUrl`);
    if (!me?.PersonalUrl) return { status: 'sso_failed' };
    const personal = me.PersonalUrl.replace(/\/?$/, '/');           // https://…/personal/{user}/
    const personalPath = new URL(personal).pathname;                  // /personal/{user}/
    const byPath = (p) => `${personal}_api/web/GetFolderByServerRelativePath(decodedurl='${encodeURIComponent(p.replace(/'/g, "''"))}')`;
    const subfolders = async (p) => (await getJson(`${byPath(p)}/Folders?$select=Name,ServerRelativeUrl`))?.value ?? null;

    const section = findFolderById(await subfolders(`${personalPath}Documents/${ASSIGNMENTS_FOLDER}`), sectionId);
    if (!section) return { status: 'no_folder' };
    const assignment = findFolderById(await subfolders(section.ServerRelativeUrl), assignmentId);
    if (!assignment) return { status: 'no_folder' };

    const files = await getJson(`${byPath(assignment.ServerRelativeUrl)}/Files?$select=Name,ServerRelativeUrl,LinkingUrl,TimeLastModified`);
    if (!Array.isArray(files?.value)) return { status: 'error' };
    return { status: 'ok', origin, files: files.value };
  } catch (err) {
    console.error('[onedrive links] Error:', err.message);
    return { status: 'error' };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
