// One queue for every sync (background sync, 20/10/2026): the nightly run, Sync Courses, Sync
// Course, Sync Assignment and the pages' background syncs are all requests here, and one runs at
// a time. Each request is a sync_runs row from the moment it is queued ('queued' → 'running' →
// finished, or 'held' while the Schoology session is down), so a page or the progress dialog can
// follow it by its runId at once.
//
//   request = { kind: 'all' | 'courses' | 'task', courseIds?, masteryCourseIds?, courseId?,
//               assignmentId?, grading?, includeHidden?, syncBlocks?, skipSchoology?,
//               refreshQuizzes?, trigger: 'page' | 'button' | 'scheduled', force?,
//               sessionCheckedAt?, sessionLive? }
//             | { kind: 'quiz', groupId, trigger: 'button', noHold: true }   (quizLoadRun.js)
//             | { kind: 'import', sectionId, trigger: 'page' }   (archivedImportRun.js, #171)
//
// Joining: a request whose courses (and options: PowerSchool, quizzes, hidden courses) a queued,
// running or held request already covers joins it instead of queueing twice. A forced request (a
// button) never joins a running one: it may have read the course before the teacher's change. A
// button goes ahead of queued page requests, and lifts a queued page run it joins there too. A
// mastery-only or blocks-only retry (skipSchoology) covers nothing. A grading sync (kind 'task',
// grading: true; PrisMCP's get_assignment_context, #131) also waits for the task's comment threads
// and reads its files, which a course run does not: it joins only a grading run of the same task,
// while a plain task request may join a grading run (it reads more). A grading request that finds
// a QUEUED plain run of its task upgrades it to a grading run and joins it (lifted as a button); a
// running plain run may have read the task already, so it is never joined (#170). A quiz load (kind 'quiz',
// #131: loading a linked quiz's attempts, from PrisMCP or the page's Load button) joins only a
// queued or running load of the same group, and covers no course or task. It records no attempt
// stamp. `noHold`: a caller is waiting on it, so a lapsed session ends it failed (a NO_SESSION
// summary) instead of holding it.
// A past course's import (kind 'import', #171: pastImport.js queues one per archived section, one
// at a time, so page syncs interleave) likewise covers no course: it joins only an import of the
// same section, and nothing else joins it. It records no attempt stamp. A held one (the session
// lapsed) runs again after a sign-in like any held run.
//
// onRunFinished(listener) hears every run that finished (not one held for a sign-in) with its
// request and final status; pastImport.js uses it to queue the next section. A listener never
// breaks the queue: what it throws (or rejects with) is logged.
//
// Everything or nothing (Graham, 20/10/2026): before a request that reads Schoology starts, the
// session is checked (renewed when possible). 'expired' or 'none' holds it until a sign-in
// (resumeHeld); 'unknown' (Schoology not reached) runs it, and it fails visibly. The nightly run is
// never held: nobody can sign in at 03:00. A run whose mastery hit a sign-in error is held too.
// A caller that checked the session itself (gradingSync) passes when (`sessionCheckedAt`, ms) and
// what it found (`sessionLive`): a check under SESSION_CHECK_MS old is not made again (#170).
import { getDb } from '../db/index.js';
import { runUnifiedSync, currentCourseIds } from './syncOrchestrator.js';
import { appendEvent, finishRun, pruneRuns, KEEP_RUNS } from './syncRuns.js';
import { sessionStatus } from './schoologySession.js';
import { runTaskSync } from './taskSyncRun.js';
import { runQuizLoad } from './quizLoadRun.js';
import { runPastImport } from './archivedImportRun.js';
import { markPastImportDue } from './pastImportState.js';

export const SYNC_FRESH_MS = 10 * 60 * 1000;
// A session check this recent (a caller's own, carried on the request) is not made again.
export const SESSION_CHECK_MS = 60_000;

export const queueDeps = { sessionStatus, runUnifiedSync, runTaskSync, runQuizLoad, runPastImport, getDb };

let running = null; // { runId, request, covered }
let queue = []; // [{ runId, request, covered }]
let held = []; // [{ runId, request, covered }]
let pumping = null; // the promise of the current pump loop
const waiters = new Map(); // runId → [resolve(finalStatus)]
const finishedListeners = new Set(); // (request, status) => void

// Also drops the onRunFinished listeners, so a test never leaks one into the next.
export function resetQueue() {
  running = null; queue = []; held = []; pumping = null; waiters.clear(); finishedListeners.clear();
}

// Hear every run that finished (not one held for a sign-in): listener(request, finalStatus).
// → unsubscribe.
export function onRunFinished(listener) {
  finishedListeners.add(listener);
  return () => finishedListeners.delete(listener);
}

function announceFinished(request, status) {
  for (const listener of [...finishedListeners]) {
    try {
      const result = listener(request, status);
      if (typeof result?.catch === 'function') {
        result.catch((err) => console.error('[sync] A finished-run listener failed:', err?.message ?? err));
      }
    } catch (err) {
      console.error('[sync] A finished-run listener failed:', err?.message ?? err);
    }
  }
}

// Resolves with the run's final status once it finishes (or 'held'). A caller that stops waiting
// (a tool's wait ran out) calls the promise's cancel(), so waiters do not pile up on a long run.
export function whenDone(runId) {
  let mine;
  const done = new Promise((resolve) => { mine = resolve; waiters.set(runId, [...(waiters.get(runId) ?? []), resolve]); });
  done.cancel = () => {
    const left = (waiters.get(runId) ?? []).filter((r) => r !== mine);
    if (left.length) waiters.set(runId, left); else waiters.delete(runId);
  };
  return done;
}

// How many callers wait on a run (tests).
export const waiterCount = (runId) => (waiters.get(runId) ?? []).length;

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
  if (request.kind === 'task' || request.kind === 'quiz' || request.kind === 'import') return [];
  return currentCourseIds(db(), { includeHidden: !!request.includeHidden });
}

// The PowerSchool pass and the quizzes phase a request asks for (they are part of what it reads).
const extras = (request) => ({
  syncBlocks: request.syncBlocks ?? (request.kind === 'all'),
  refreshQuizzes: !!request.refreshQuizzes,
});

// A queued plain task run (not started yet; runOne reads its request after the session check)
// can become a grading run.
const upgradable = (entry) => queue.includes(entry);

function covers(entry, request) {
  if (entry.request.skipSchoology) return false;
  if (request.kind === 'quiz' || entry.request.kind === 'quiz') {
    return request.kind === entry.request.kind && String(request.groupId) === String(entry.request.groupId);
  }
  if (request.kind === 'import' || entry.request.kind === 'import') {
    return request.kind === entry.request.kind && String(request.sectionId) === String(entry.request.sectionId);
  }
  const have = extras(entry.request);
  const want = extras(request);
  if ((want.syncBlocks && !have.syncBlocks) || (want.refreshQuizzes && !have.refreshQuizzes)) return false;
  const ids = new Set(entry.covered);
  if (request.kind === 'task') {
    const same = entry.request.kind === 'task' && Number(entry.request.courseId) === Number(request.courseId)
      && String(entry.request.assignmentId) === String(request.assignmentId);
    if (request.grading) return same && (!!entry.request.grading || upgradable(entry));
    return same || ids.has(Number(request.courseId));
  }
  const need = coveredCourseIds(request);
  return need.length > 0 && need.every((id) => ids.has(id));
}

// The options runUnifiedSync takes, from a request. Everything is read: mastery for every course.
// A PowerSchool-only or mastery-only retry (skipSchoology) runs over every course (courseIds null).
// #171: a `kind: 'all'` run takes its mastery list after its section phase (masteryCourseIds null),
// not the list fixed when it was queued, so the courses it discovers get their mastery too. A
// `kind: 'all'` PowerSchool-only retry (skipSchoology) reads no mastery.
function unifiedOptions(request, covered) {
  return {
    courseIds: request.kind === 'courses' && !request.skipSchoology ? covered : null,
    masteryCourseIds: request.masteryCourseIds ?? (request.kind === 'all' && !request.skipSchoology ? null : covered),
    skipSchoology: !!request.skipSchoology,
    includeHidden: !!request.includeHidden,
    ...extras(request),
    trigger: request.trigger,
  };
}

const view = (e) => e && { runId: e.runId, kind: e.request.kind, courseIds: e.covered, trigger: e.request.trigger,
  ...(e.request.kind === 'task' ? { courseId: Number(e.request.courseId), assignmentId: String(e.request.assignmentId) } : {}),
  ...(e.request.kind === 'quiz' ? { groupId: Number(e.request.groupId) } : {}),
  ...(e.request.kind === 'import' ? { sectionId: String(e.request.sectionId) } : {}) };

// What is syncing now, what waits, and what waits for a sign-in. `running`/`runId` stay for older callers.
export function currentSync() {
  return {
    running: view(running), runId: running?.runId ?? null,
    queued: queue.map(view), held: held.map(view),
  };
}

// Buttons go ahead of queued page requests (behind other button and scheduled ones).
function place(entry) {
  const firstPage = entry.request.trigger === 'button' ? queue.findIndex((e) => e.request.trigger === 'page') : -1;
  if (firstPage >= 0) queue.splice(firstPage, 0, entry); else queue.push(entry);
}

// A request as its sync_runs row records it: the session check a caller passed
// (sessionCheckedAt, sessionLive) stays on the in-memory request only (#170).
const recorded = ({ sessionCheckedAt, sessionLive, ...request }, covered) => JSON.stringify({ ...request, coveredCourseIds: covered });

// What a joining request adds to the run it joins: a grading request upgrades a plain task run, a
// lifted page run becomes a button run, and a newer session check (gradingSync's) replaces an older
// one. The row records the grading upgrade and the lift (not the check).
function absorb(entry, request, { lift = false } = {}) {
  const was = entry.request;
  const next = { ...was };
  if (request.grading && !next.grading) next.grading = true;
  if (lift) next.trigger = 'button';
  if (request.sessionCheckedAt && !(next.sessionCheckedAt >= request.sessionCheckedAt)) {
    next.sessionCheckedAt = request.sessionCheckedAt;
    next.sessionLive = request.sessionLive;
  }
  entry.request = next;
  if (next.grading === was.grading && next.trigger === was.trigger) return;
  try {
    db().prepare('UPDATE sync_runs SET options_json = ? WHERE id = ?')
      .run(recorded(next, next.kind === 'task' ? [Number(next.courseId)] : entry.covered), entry.runId);
  } catch (err) {
    console.error('[sync] Could not record the joined request:', err.message);
  }
}

// Queue a request (or join one that covers it). → { runId, state: 'queued' | 'running' | 'held', joined }.
export function enqueue(request) {
  if (!request.force && running && covers(running, request)) return { runId: running.runId, state: 'running', joined: true };
  const queuedCover = queue.find((e) => covers(e, request));
  if (queuedCover) {
    // A button lifts the page run it joins ahead of the other page runs (not the head being checked).
    const lift = request.trigger === 'button' && queuedCover.request.trigger === 'page' && queuedCover !== queue[0];
    absorb(queuedCover, request, { lift });
    if (lift) {
      queue.splice(queue.indexOf(queuedCover), 1);
      place(queuedCover);
    }
    return { runId: queuedCover.runId, state: 'queued', joined: true };
  }
  const heldCover = held.find((e) => covers(e, request));
  if (heldCover) {
    absorb(heldCover, request);
    return { runId: heldCover.runId, state: 'held', joined: true };
  }

  const covered = request.kind === 'task' ? [Number(request.courseId)] : coveredCourseIds(request);
  const runId = Number(db().prepare(
    `INSERT INTO sync_runs (started_at, status, options_json) VALUES (?, 'queued', ?)`,
  ).run(new Date().toISOString(), recorded(request, covered)).lastInsertRowid);
  place({ runId, request, covered: request.kind === 'task' ? [] : covered });
  pump();
  return { runId, state: 'queued', joined: false };
}

// The newest finished run of a scope that did not complete cleanly, for the "Last sync failed" chip.
function lastFailedRun(d, { courseIds = [], task = null }) {
  const rows = d.prepare(`SELECT id, options_json FROM sync_runs WHERE status IN ('failed', 'completed_with_errors', 'interrupted')
    ORDER BY id DESC LIMIT 50`).all();
  for (const r of rows) {
    let o = {};
    try { o = JSON.parse(r.options_json || '{}'); } catch { o = {}; }
    if (task && o.kind === 'task' && String(o.assignmentId) === String(task.assignmentId)) return r.id;
    // A task, quiz or import run is not a course's sync: its failure is not the course's (#170, #171).
    if (o.kind === 'task' || o.kind === 'quiz' || o.kind === 'import') continue;
    const ids = (o.coveredCourseIds ?? o.courseIds ?? []).map(Number);
    if (courseIds.some((id) => ids.includes(id))) return r.id;
  }
  return null;
}

// A page asks for its scope after it loads (POST /api/sync/ensure). A scope a running, queued or
// held request covers follows that run. Fresh = every course in it (or the task) was synced, or
// tried, within SYNC_FRESH_MS; a scope whose latest try failed answers 'failed' with that run (the
// chip). Archived courses are only re-read by a button. Otherwise the stale part not already
// syncing is queued as a page request. The dashboard on a database with no course starts the
// first run (firstRun, #171).
// → { state: 'fresh' | 'failed' | 'queued' | 'running' | 'held', runId? }.
//   scope = { kind: 'all' } | { kind: 'courses', courseIds } | { kind: 'task', courseId, assignmentId }
export function ensure(scope, { now = Date.now() } = {}) {
  const d = db();
  const within = (stamp) => Boolean(stamp) && now - Date.parse(stamp) < SYNC_FRESH_MS;
  const later = (a, b) => Boolean(a) && (!b || Date.parse(a) > Date.parse(b));
  const stateOf = (e) => (e === running ? 'running' : held.includes(e) ? 'held' : 'queued');
  const active = () => [running, ...queue, ...held].filter((e) => e && !e.request.skipSchoology);
  if (scope.kind === 'task') {
    const t = d.prepare(`SELECT a.task_synced_at, a.task_sync_attempted_at, c.archived FROM assignments a
      JOIN courses c ON c.id = a.course_id WHERE a.schoology_assignment_id = ? AND a.course_id = ?`).get(String(scope.assignmentId), Number(scope.courseId));
    if (!t || t.archived) return { state: 'fresh' };
    const request = { kind: 'task', courseId: Number(scope.courseId), assignmentId: String(scope.assignmentId), trigger: 'page' };
    const following = active().find((e) => covers(e, request));
    if (following) return { state: stateOf(following), runId: following.runId };
    if (within(t.task_synced_at) && !later(t.task_sync_attempted_at, t.task_synced_at)) return { state: 'fresh' };
    if (within(t.task_sync_attempted_at)) {
      return { state: 'failed', runId: lastFailedRun(d, { courseIds: [Number(scope.courseId)], task: scope }) };
    }
    const r = enqueue(request);
    return { state: r.state, runId: r.runId };
  }
  if (scope.kind === 'all' && !d.prepare('SELECT 1 FROM courses LIMIT 1').get()) return firstRun(d, { within, stateOf, active });
  const ids = scope.kind === 'all' ? coveredCourseIds({ kind: 'all' }) : (scope.courseIds ?? []).map(Number);
  const rows = ids.length ? d.prepare(`SELECT id, archived, course_synced_at, sync_attempted_at FROM courses
    WHERE id IN (SELECT value FROM json_each(?)) AND COALESCE(excluded, 0) = 0`).all(JSON.stringify(ids)) : [];
  const live = rows.filter((c) => !c.archived);
  if (!live.length) return { state: 'fresh' };
  // A kind 'all' run covers the current courses as they are now, not its queued list: a first run
  // was queued with none, and the courses it inserts follow it (#171). It can over-claim a course
  // unhidden while it runs (its section phase skipped that course as hidden).
  const coverage = new Map(active().map((e) => [e, e.request.kind === 'all' ? coveredCourseIds(e.request) : e.covered]));
  const following = active().find((e) => live.every((c) => coverage.get(e).includes(c.id)));
  if (following) return { state: stateOf(following), runId: following.runId };
  const failed = live.filter((c) => within(c.sync_attempted_at) && later(c.sync_attempted_at, c.course_synced_at));
  const stale = live.filter((c) => !within(c.course_synced_at) && !within(c.sync_attempted_at)).map((c) => c.id);
  // A course already syncing (or waiting for a sign-in) is not queued a second time.
  const busy = new Set(active().flatMap((e) => coverage.get(e)));
  const toQueue = stale.filter((id) => !busy.has(id));
  if (toQueue.length) {
    const r = enqueue({ kind: 'courses', courseIds: toQueue, trigger: 'page' });
    return { state: r.state, runId: r.runId };
  }
  const partly = active().find((e) => stale.some((id) => coverage.get(e).includes(id)));
  if (partly) return { state: stateOf(partly), runId: partly.runId };
  if (failed.length) return { state: 'failed', runId: lastFailedRun(d, { courseIds: failed.map((c) => c.id) }) };
  return { state: 'fresh' };
}

// The first run (#171): the dashboard on a database with no course at all. It follows a kind 'all'
// run already queued, running or held; a kind 'all' run that finished within SYNC_FRESH_MS (the
// teacher has no courses, or Schoology failed) answers fresh or failed, so a visit does not queue
// another. Otherwise the past-course import is marked due and a kind 'all' page run is queued (it
// reads blocks, calendar and alerts too).
function firstRun(d, { within, stateOf, active }) {
  const following = active().find((e) => e.request.kind === 'all');
  if (following) return { state: stateOf(following), runId: following.runId };
  const last = d.prepare(`SELECT id, status, started_at FROM sync_runs
    WHERE json_extract(options_json, '$.kind') = 'all' AND COALESCE(json_extract(options_json, '$.skipSchoology'), 0) = 0
      AND status NOT IN ('queued', 'running', 'held')
    ORDER BY id DESC LIMIT 1`).get();
  if (last && within(last.started_at)) {
    return last.status === 'completed' ? { state: 'fresh' } : { state: 'failed', runId: last.id };
  }
  markPastImportDue(d);
  const r = enqueue({ kind: 'all', trigger: 'page' });
  return { state: r.state, runId: r.runId };
}

// After a sign-in (or a run whose session check passed): every held request runs again, as the
// same run, its earlier attempt's error and warning counts cleared and a line in its log. With
// `runId`, only that run: a caller waiting on it whose session check did not reach Schoology
// ('unknown') runs it, so it fails visibly instead of staying held (#170).
export function resumeHeld({ runId = null } = {}) {
  const back = runId == null ? held : held.filter((e) => e.runId === runId);
  held = held.filter((e) => !back.includes(e));
  const d = db();
  const message = runId == null ? 'Signed in to Schoology: running again.' : 'Asked for again: running again.';
  for (const e of back) {
    d.prepare(`UPDATE sync_runs SET status = 'queued', error_count = 0, warning_count = 0 WHERE id = ?`).run(e.runId);
    try { appendEvent(d, e.runId, { type: 'log', message, restart: true }); } catch { /* the log is best effort */ }
    queue.push(e);
  }
  pump();
  return back.length;
}

function pump() {
  if (pumping) return pumping;
  pumping = (async () => {
    try {
      // The head stays in `queue` (so it shows as queued) until it starts or is held.
      while (queue.length) await runOne(queue[0]);
    } finally {
      pumping = null;
    }
  })();
  return pumping;
}

const leaveQueue = (entry) => {
  const i = queue.indexOf(entry);
  if (i >= 0) queue.splice(i, 1);
};

const hold = (entry) => {
  leaveQueue(entry);
  db().prepare(`UPDATE sync_runs SET status = 'held' WHERE id = ?`).run(entry.runId);
  held.push(entry);
  settle(entry.runId, 'held');
};

// A run with a caller waiting on it (`noHold`) is not held for a sign-in: it finishes failed with a
// NO_SESSION answer, which the caller turns into its error.
function failNoSession(d, entry, live) {
  const message = live === 'none' ? 'No saved Schoology session: reconnect in Settings' : 'Schoology connection expired: reconnect in Settings';
  leaveQueue(entry);
  const summary = { type: 'summary', fatal: true, quizError: { code: 'NO_SESSION', message } };
  try {
    appendEvent(d, entry.runId, summary);
    finishRun(d, entry.runId, { status: 'failed', summary });
    pruneRuns(d, KEEP_RUNS);
  } catch (err) {
    console.error('[sync] Could not finish the sync run:', err.message);
  }
  settle(entry.runId, 'failed');
  announceFinished(entry.request, 'failed');
}

// Every run records when its scope was last tried, whatever the outcome (a run that threw too), so
// a failing scope waits out the background window instead of re-running on every visit. The attempt is
// the run's START time and never moves a stamp the run wrote itself: the run stamps synced and attempted
// with its own start time, and an end time here read as a failed attempt after every successful run, so
// pages showed "Sync failed" for 10 minutes after each sync (fixed 25 Oct 2026).
function recordAttempt(d, entry) {
  const at = entry.startedAt ?? new Date().toISOString();
  try {
    if (entry.request.kind === 'task') {
      d.prepare(`UPDATE assignments SET task_sync_attempted_at = ? WHERE schoology_assignment_id = ? AND course_id = ?
        AND (task_sync_attempted_at IS NULL OR task_sync_attempted_at < ?)`)
        .run(at, String(entry.request.assignmentId), Number(entry.request.courseId), at);
    } else if (entry.covered.length) {
      d.prepare(`UPDATE courses SET sync_attempted_at = ? WHERE id IN (SELECT value FROM json_each(?))
        AND (sync_attempted_at IS NULL OR sync_attempted_at < ?)`).run(at, JSON.stringify(entry.covered), at);
    }
  } catch (err) {
    console.error('[sync] Could not record the attempt:', err.message);
  }
}

async function runOne(entry) {
  const { runId } = entry;
  const d = db();
  if (entry.request.trigger !== 'scheduled') {
    const asked = entry.request;
    // The caller's own check, under a minute old, stands (one check per call, #170).
    const recent = asked.sessionCheckedAt && Date.now() - asked.sessionCheckedAt < SESSION_CHECK_MS;
    let live = recent ? (asked.sessionLive ?? 'unknown') : 'unknown';
    if (!recent) {
      try { live = (await queueDeps.sessionStatus({ refresh: true }))?.live ?? 'unknown'; } catch { live = 'unknown'; }
    }
    if (live === 'expired' || live === 'none') return entry.request.noHold ? failNoSession(d, entry, live) : hold(entry);
    // The session works again: what waited for a sign-in runs after this.
    if (live === 'connected' && held.length) resumeHeld();
  }
  // Read after the check: a grading request may have upgraded this run while it waited (#170).
  const request = entry.request;
  // A kind 'all' run that fills an empty install (the nightly run, or Sync Courses, before any page
  // asked for the first run) makes the past-course import due too (#171).
  if (request.kind === 'all' && !request.skipSchoology) {
    try {
      if (!d.prepare('SELECT 1 FROM courses LIMIT 1').get()) markPastImportDue(d);
    } catch (err) {
      console.error('[sync] Could not mark the past-course import due:', err.message);
    }
  }
  leaveQueue(entry);
  running = entry;
  entry.startedAt = new Date().toISOString();
  d.prepare(`UPDATE sync_runs SET status = 'running', started_at = ? WHERE id = ?`).run(entry.startedAt, runId);
  let summary = null;
  let status = 'completed';
  const write = (evt) => {
    if (evt?.type === 'summary') summary = evt;
    try { appendEvent(d, runId, evt); } catch (err) { console.error('[sync] Could not log event:', err.message); }
  };
  try {
    if (request.kind === 'task') await queueDeps.runTaskSync(request, write);
    else if (request.kind === 'quiz') await queueDeps.runQuizLoad(request, write);
    else if (request.kind === 'import') await queueDeps.runPastImport(request, write);
    else await queueDeps.runUnifiedSync(unifiedOptions(request, entry.covered), write);
    if (summary?.fatal) status = 'failed';
  } catch (err) {
    console.error('[sync] Error:', err);
    status = 'failed';
    write({ type: 'error', message: err.message });
  } finally {
    running = null;
  }
  if (!request.skipSchoology && request.kind !== 'quiz' && request.kind !== 'import') recordAttempt(d, entry);
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
  const final = d.prepare('SELECT status FROM sync_runs WHERE id = ?').get(runId)?.status ?? status;
  settle(runId, final);
  announceFinished(request, final);
}
