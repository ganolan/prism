// One queue for every sync (background sync, 20/10/2026): the nightly run, Sync Courses, Sync
// Course, Sync Assignment and the pages' background syncs are all requests here, and one runs at
// a time. Each request is a sync_runs row from the moment it is queued ('queued' → 'running' →
// finished, or 'held' while the Schoology session is down), so a page or the progress dialog can
// follow it by its runId at once.
//
//   request = { kind: 'all' | 'courses' | 'task', courseIds?, masteryCourseIds?, courseId?,
//               assignmentId?, includeHidden?, syncBlocks?, skipSchoology?, refreshQuizzes?,
//               trigger: 'page' | 'button' | 'scheduled', force? }
//
// Joining: a request whose courses a queued or running request already covers joins it instead of
// queueing twice. A forced request (a button) may join only a queued one: a running one may have
// read the course before the teacher's change. Button requests go ahead of queued page requests.
// A mastery-only or blocks-only retry (skipSchoology) covers nothing.
//
// Everything or nothing (Graham, 20/10/2026): before a request that reads Schoology starts, the
// session is checked (renewed when possible). 'expired' or 'none' holds it until a sign-in
// (resumeHeld); 'unknown' (Schoology not reached) runs it, and it fails visibly. The nightly run is
// never held: nobody can sign in at 03:00. A run whose mastery hit a sign-in error is held too.
import { getDb } from '../db/index.js';
import { runUnifiedSync } from './syncOrchestrator.js';
import { appendEvent, finishRun, pruneRuns, KEEP_RUNS } from './syncRuns.js';
import { sessionStatus } from './schoologySession.js';
import { runTaskSync } from './taskSyncRun.js';

export const SYNC_FRESH_MS = 10 * 60 * 1000;

export const queueDeps = { sessionStatus, runUnifiedSync, runTaskSync, getDb };

let running = null; // { runId, request, covered }
let queue = []; // [{ runId, request, covered }]
let held = []; // [{ runId, request, covered }]
let pumping = null; // the promise of the current pump loop
const listeners = new Map(); // runId → [fn(evt)]
const waiters = new Map(); // runId → [resolve(finalStatus)]

export function resetQueue() {
  running = null; queue = []; held = []; pumping = null; listeners.clear(); waiters.clear();
}

// Resolves with the run's final status once it finishes (or 'held'). For the nightly run.
export function whenDone(runId) {
  return new Promise((resolve) => waiters.set(runId, [...(waiters.get(runId) ?? []), resolve]));
}

// The scheduler's launch: queue a request and follow it to its end → { runId, done }.
export function launchQueued(request) {
  const r = enqueue(request);
  return { runId: r.runId, done: whenDone(r.runId) };
}

function settle(runId, status) {
  for (const resolve of waiters.get(runId) ?? []) resolve(status);
  waiters.delete(runId);
}

// Resolves when nothing is running and nothing is queued (tests, graceful stop).
export async function idle() {
  while (pumping) await pumping;
}

const db = () => queueDeps.getDb();

// The course ids a request reads. 'all' = the current courses (hidden ones only when included).
export function coveredCourseIds(request) {
  if (request.skipSchoology) return [];
  if (request.kind === 'courses') return (request.courseIds ?? []).map(Number);
  if (request.kind === 'task') return [];
  return db().prepare(`
    SELECT id FROM courses WHERE COALESCE(archived, 0) = 0 AND COALESCE(excluded, 0) = 0
      AND (COALESCE(hidden, 0) = 0 OR ?) ORDER BY id`).all(request.includeHidden ? 1 : 0).map((r) => r.id);
}

function covers(entry, request) {
  if (entry.request.skipSchoology) return false;
  const have = new Set(entry.covered);
  if (request.kind === 'task') {
    const same = entry.request.kind === 'task' && Number(entry.request.courseId) === Number(request.courseId)
      && String(entry.request.assignmentId) === String(request.assignmentId);
    return same || have.has(Number(request.courseId));
  }
  const want = coveredCourseIds(request);
  return want.length > 0 && want.every((id) => have.has(id));
}

// The options runUnifiedSync takes, from a request. Everything is read: mastery for every course.
function unifiedOptions(request, covered) {
  return {
    courseIds: request.kind === 'courses' ? covered : null,
    masteryCourseIds: request.masteryCourseIds ?? covered,
    skipSchoology: !!request.skipSchoology,
    includeHidden: !!request.includeHidden,
    syncBlocks: request.syncBlocks ?? (request.kind === 'all'),
    refreshQuizzes: !!request.refreshQuizzes,
    trigger: request.trigger,
  };
}

const view = (e) => e && { runId: e.runId, kind: e.request.kind, courseIds: e.covered, trigger: e.request.trigger,
  ...(e.request.kind === 'task' ? { courseId: Number(e.request.courseId), assignmentId: String(e.request.assignmentId) } : {}) };

// What is syncing now, what waits, and what waits for a sign-in. `running`/`runId` stay for older callers.
export function currentSync() {
  return {
    running: view(running), runId: running?.runId ?? null,
    queued: queue.map(view), held: held.map(view),
  };
}

// Queue a request (or join one that covers it). → { runId, state: 'queued' | 'running' | 'held', joined }.
export function enqueue(request, { onEvent } = {}) {
  const join = (e, state) => {
    if (onEvent) listeners.set(e.runId, [...(listeners.get(e.runId) ?? []), onEvent]);
    return { runId: e.runId, state, joined: true };
  };
  if (!request.force && running && covers(running, request)) return join(running, 'running');
  const queuedCover = queue.find((e) => covers(e, request));
  if (queuedCover) return join(queuedCover, 'queued');

  const covered = request.kind === 'task' ? [Number(request.courseId)] : coveredCourseIds(request);
  const runId = Number(db().prepare(
    `INSERT INTO sync_runs (started_at, status, options_json) VALUES (?, 'queued', ?)`,
  ).run(new Date().toISOString(), JSON.stringify({ ...request, coveredCourseIds: covered })).lastInsertRowid);
  const entry = { runId, request, covered: request.kind === 'task' ? [] : covered };
  if (onEvent) listeners.set(runId, [onEvent]);
  // Buttons go ahead of queued page requests (behind other button and scheduled ones).
  const firstPage = request.trigger === 'button' ? queue.findIndex((e) => e.request.trigger === 'page') : -1;
  if (firstPage >= 0) queue.splice(firstPage, 0, entry); else queue.push(entry);
  pump();
  return { runId, state: 'queued', joined: false };
}

// A page asks for its scope after it loads (POST /api/sync/ensure). Fresh = every course in it
// (or the task) was synced, or tried, within SYNC_FRESH_MS; archived courses are only re-read by a
// button. A scope a queued or running request already covers follows that run. Otherwise the
// stale part is queued as a page request. → { state: 'fresh' | 'queued' | 'running', runId? }.
//   scope = { kind: 'all' } | { kind: 'courses', courseIds } | { kind: 'task', courseId, assignmentId }
export function ensure(scope, { now = Date.now() } = {}) {
  const d = db();
  const isFresh = (...stamps) => stamps.some((s) => s && now - Date.parse(s) < SYNC_FRESH_MS);
  if (scope.kind === 'task') {
    const t = d.prepare(`SELECT a.task_synced_at, a.task_sync_attempted_at, c.archived FROM assignments a
      JOIN courses c ON c.id = a.course_id WHERE a.schoology_assignment_id = ? AND a.course_id = ?`).get(String(scope.assignmentId), Number(scope.courseId));
    if (!t || t.archived || isFresh(t.task_synced_at, t.task_sync_attempted_at)) return { state: 'fresh' };
    const request = { kind: 'task', courseId: Number(scope.courseId), assignmentId: String(scope.assignmentId), trigger: 'page' };
    const following = [running, ...queue].find((e) => e && covers(e, request));
    if (following) return { state: following === running ? 'running' : 'queued', runId: following.runId };
    const r = enqueue(request);
    return { state: r.state, runId: r.runId };
  }
  const ids = scope.kind === 'all' ? coveredCourseIds({ kind: 'all' }) : (scope.courseIds ?? []).map(Number);
  const rows = ids.length ? d.prepare(`SELECT id, archived, course_synced_at, sync_attempted_at FROM courses
    WHERE id IN (SELECT value FROM json_each(?)) AND COALESCE(excluded, 0) = 0`).all(JSON.stringify(ids)) : [];
  const live = rows.filter((c) => !c.archived);
  const following = [running, ...queue].find((e) => e && !e.request.skipSchoology && live.length
    && live.every((c) => e.covered.includes(c.id)));
  if (following) return { state: following === running ? 'running' : 'queued', runId: following.runId };
  const stale = live.filter((c) => !isFresh(c.course_synced_at, c.sync_attempted_at)).map((c) => c.id);
  if (!stale.length) return { state: 'fresh' };
  const r = enqueue({ kind: 'courses', courseIds: stale, trigger: 'page' });
  return { state: r.state, runId: r.runId };
}

// After a sign-in: every held request runs again (same runs, back in the queue).
export function resumeHeld() {
  const back = held;
  held = [];
  for (const e of back) {
    db().prepare(`UPDATE sync_runs SET status = 'queued' WHERE id = ?`).run(e.runId);
    queue.push(e);
  }
  pump();
  return back.length;
}

function pump() {
  if (pumping) return pumping;
  pumping = (async () => {
    try {
      while (queue.length) await runOne(queue.shift());
    } finally {
      pumping = null;
    }
  })();
  return pumping;
}

const hold = (entry) => {
  db().prepare(`UPDATE sync_runs SET status = 'held' WHERE id = ?`).run(entry.runId);
  held.push(entry);
  settle(entry.runId, 'held');
};

async function runOne(entry) {
  const { request, runId } = entry;
  const d = db();
  if (request.trigger !== 'scheduled') {
    let live = 'unknown';
    try { live = (await queueDeps.sessionStatus({ refresh: true }))?.live ?? 'unknown'; } catch { live = 'unknown'; }
    if (live === 'expired' || live === 'none') return hold(entry);
  }
  running = entry;
  d.prepare(`UPDATE sync_runs SET status = 'running', started_at = ? WHERE id = ?`).run(new Date().toISOString(), runId);
  let summary = null;
  let status = 'completed';
  const write = (evt) => {
    if (evt?.type === 'summary') summary = evt;
    let seq = null;
    try { seq = appendEvent(d, runId, evt); } catch (err) { console.error('[sync] Could not log event:', err.message); }
    for (const fn of listeners.get(runId) ?? []) { try { fn(seq == null ? evt : { ...evt, seq }); } catch { /* listener gone */ } }
  };
  try {
    if (request.kind === 'task') await queueDeps.runTaskSync(request, write);
    else await queueDeps.runUnifiedSync(unifiedOptions(request, entry.covered), write);
    if (summary?.fatal) status = 'failed';
  } catch (err) {
    console.error('[sync] Error:', err);
    status = 'failed';
    write({ type: 'error', message: err.message });
  } finally {
    running = null;
  }
  const signInLost = (summary?.mastery ?? []).some((m) => m.errorKind === 'login') || summary?.signIn === true;
  if (signInLost && request.trigger !== 'scheduled') {
    hold(entry);
    return;
  }
  try {
    finishRun(d, runId, { status, summary });
    pruneRuns(d, KEEP_RUNS);
  } catch (err) {
    console.error('[sync] Could not finish the sync run:', err.message);
  }
  listeners.delete(runId);
  settle(runId, d.prepare('SELECT status FROM sync_runs WHERE id = ?').get(runId)?.status ?? status);
}
