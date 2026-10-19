/**
 * oneDriveLinks.js
 *
 * On-demand lookup of the student copies of a OneDrive lti_submission assignment
 * in the teacher's OneDrive (#120), through SharePoint REST over plain HTTP
 * (sharePointWeb.js, #141): the saved session's Microsoft sign-in cookies sign
 * into SharePoint without a browser. Read-only GETs.
 *
 * The teacher's OneDrive is discovered, not configured: SharePoint's
 * GetMyProperties returns the signed-in user's PersonalUrl, so this works for
 * whichever teacher owns the session. Only the tenant host is config
 * (`microsoft.sharepointHost`).
 *
 * Best-effort like the other session services: every failure resolves to a
 * status, never a throw. Successful listings are cached briefly so reopening
 * the page doesn't sign in again; failures are not cached.
 */
import { getMicrosoftConfig } from '../middleware/featureGate.js';
import { signInToSharePoint, listAssignmentFiles } from './sharePointWeb.js';
export const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map();    // `${sectionId}:${assignmentId}` → { at, result }
const inFlight = new Map(); // same key → Promise<result>

// Replaced in tests: the real session signs in to SharePoint over HTTP.
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
 * straight back; the rest share ONE SharePoint session (one sign-in) instead
 * of one each. → Map(`${sectionId}:${assignmentId}` → result).
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

// A signed-in SharePoint session from the saved state:
// { status: 'ok', origin, listFiles(sectionId, assignmentId), close() } or
// { status: 'no_session' | 'sso_failed' | 'error' }.
async function openSharePointSession() {
  const origin = new URL(getMicrosoftConfig().sharepointHost.replace(/\/+$/, '')).origin;
  const s = await signInToSharePoint({ origin });
  if (s.status !== 'ok') return { status: s.status };
  return { status: 'ok', origin: s.origin, listFiles: listAssignmentFiles(s), close: async () => {} };
}
