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

// Replaced in tests: the real session drives a headless browser.
export const oneDriveDeps = {
  openSession: () => openSharePointSession(),
};

const keyOf = (sectionId, assignmentId) => `${sectionId}:${assignmentId}`;

function cached(key) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.result : null;
}

/**
 * @returns {Promise<
 *   { status: 'ok', origin: string, files: Array<{Name, ServerRelativeUrl, LinkingUrl, TimeLastModified}> } |
 *   { status: 'no_session' | 'sso_failed' | 'no_folder' | 'error' }
 * >}
 *   no_folder = the app has made no copies for this assignment (never opened by
 *   anyone, a Google Drive assignment, or created by a different teacher).
 */
export async function getAssignmentFiles({ sectionId, assignmentId, refresh = false }) {
  const out = await getAssignmentFilesMany([{ sectionId, assignmentId }], { refresh });
  return out.get(keyOf(sectionId, assignmentId));
}

/**
 * Several assignments at once (the student page, #135): cached listings come
 * straight back; the rest share ONE browser session (one SSO round trip, one
 * browser launch) instead of one each. → Map(`${sectionId}:${assignmentId}` → result).
 */
export async function getAssignmentFilesMany(pairs, { refresh = false } = {}) {
  const out = new Map();
  const waits = [];
  const todo = [];
  for (const { sectionId, assignmentId } of pairs) {
    const key = keyOf(sectionId, assignmentId);
    if (out.has(key) || todo.some((t) => t.key === key)) continue;
    const hit = refresh ? null : cached(key);
    if (hit) out.set(key, hit);
    else if (inFlight.has(key)) waits.push(inFlight.get(key).then((r) => out.set(key, r)));
    else todo.push({ key, sectionId: String(sectionId), assignmentId: String(assignmentId) });
  }
  if (todo.length) {
    // One deferred per key, so a concurrent caller for the same assignment joins this run.
    for (const t of todo) {
      let resolve;
      const p = new Promise((r) => { resolve = r; });
      t.resolve = resolve;
      inFlight.set(t.key, p);
    }
    waits.push(listInOneSession(todo).then((results) => {
      for (const t of todo) {
        const result = results.get(t.key);
        if (result.status === 'ok') cache.set(t.key, { at: Date.now(), result });
        out.set(t.key, result);
        inFlight.delete(t.key);
        t.resolve(result);
      }
    }));
  }
  await Promise.all(waits);
  return out;
}

async function listInOneSession(todo) {
  const results = new Map();
  let session;
  try {
    session = await oneDriveDeps.openSession();
    if (session.status !== 'ok') {
      for (const t of todo) results.set(t.key, { status: session.status });
      return results;
    }
    for (const t of todo) {
      try {
        results.set(t.key, await session.listFiles(t.sectionId, t.assignmentId));
      } catch (err) {
        console.error('[onedrive links] Error:', err.message);
        results.set(t.key, { status: 'error' });
      }
    }
  } catch (err) {
    console.error('[onedrive links] Error:', err.message);
    for (const t of todo) if (!results.has(t.key)) results.set(t.key, { status: 'error' });
  } finally {
    if (session?.close) await session.close().catch(() => {});
  }
  return results;
}

/** Test hook. */
export function clearOneDriveCache() {
  cache.clear();
}

// A signed-in SharePoint session in the saved browser state:
// { status: 'ok', origin, listFiles(sectionId, assignmentId), close() } or
// { status: 'no_session' | 'sso_failed' | 'error' }.
async function openSharePointSession() {
  if (!existsSync(sessionStateFile())) return { status: 'no_session' };
  const host = getMicrosoftConfig().sharepointHost.replace(/\/+$/, '');
  const origin = new URL(host).origin;

  let browser;
  const fail = async (status) => {
    if (browser) await browser.close().catch(() => {});
    return { status };
  };
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: sessionStateFile() });
    const page = await context.newPage();

    // A SharePoint UI page runs the Microsoft SSO redirect chain; wait to land back.
    await page.goto(`${origin}/_layouts/15/onedrive.aspx`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForURL((u) => u.origin === origin, { timeout: 60000 }).catch(() => {});
    if (new URL(page.url()).origin !== origin) return fail('sso_failed');

    const getJson = (url) => page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { Accept: 'application/json;odata=nometadata' }, credentials: 'include' });
      if (r.status !== 200) return null;
      try { return await r.json(); } catch { return null; }
    }, url);

    const me = await getJson(`${origin}/_api/SP.UserProfiles.PeopleManager/GetMyProperties?$select=PersonalUrl`);
    if (!me?.PersonalUrl) return fail('sso_failed');
    const personal = me.PersonalUrl.replace(/\/?$/, '/');           // https://…/personal/{user}/
    const personalPath = new URL(personal).pathname;                  // /personal/{user}/
    const byPath = (p) => `${personal}_api/web/GetFolderByServerRelativePath(decodedurl='${encodeURIComponent(p.replace(/'/g, "''"))}')`;
    // Folder listings are reused within the session (many assignments share a section).
    const folderCache = new Map();
    const subfolders = async (p) => {
      if (!folderCache.has(p)) folderCache.set(p, (await getJson(`${byPath(p)}/Folders?$select=Name,ServerRelativeUrl`))?.value ?? null);
      return folderCache.get(p);
    };

    return {
      status: 'ok',
      origin,
      async listFiles(sectionId, assignmentId) {
        const section = findFolderById(await subfolders(`${personalPath}Documents/${ASSIGNMENTS_FOLDER}`), sectionId);
        if (!section) return { status: 'no_folder' };
        const assignment = findFolderById(await subfolders(section.ServerRelativeUrl), assignmentId);
        if (!assignment) return { status: 'no_folder' };
        const files = await getJson(`${byPath(assignment.ServerRelativeUrl)}/Files?$select=Name,ServerRelativeUrl,LinkingUrl,TimeLastModified`);
        if (!Array.isArray(files?.value)) return { status: 'error' };
        return { status: 'ok', origin, files: files.value };
      },
      close: () => browser.close(),
    };
  } catch (err) {
    console.error('[onedrive links] Error:', err.message);
    return fail('error');
  }
}
