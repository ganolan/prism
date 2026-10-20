// #52: mastery read from Schoology on demand. The pages that show mastery render what Prism holds, then
// ask for a refresh in the background; this decides whether Schoology needs reading. Data read under
// FRESH_MS ago is not read again (navigating between pages does not re-read); a refresh already
// running for the same course or assignment is shared; `force` (the assessment page's Sync Assignment,
// and POST /api/mastery/sync/:courseId) reads regardless. Measured 2026-10-19 over plain HTTP: a course 2.3-5 s, one
// assignment 1.8-2.9 s, about the same for a full year's scores as for October's.
// The nightly sync still reads every active course (syncScheduler.js); this covers the day between.
import { getDb } from '../db/index.js';
import { syncMasteryForCourse, syncMasteryForAssignment } from './masterySync.js';
import { captureFeedbackSnapshots } from './feedbackSnapshots.js';
import { settleResubmissions } from './resubmissions.js';

export const FRESH_MS = 2 * 60 * 1000;

export class RefreshError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Rubric levels are part of the visible-feedback fingerprint, so every mastery pull
// re-snapshots the course (Amendment B fix round 1) — otherwise the next revision is
// judged against stale levels. Best-effort: never fails the pull.
export function snapshotAfterMasteryPull(db, courseId) {
  try {
    captureFeedbackSnapshots(db, { courseId: Number(courseId) });
    settleResubmissions(db, { courseId: Number(courseId) });
  } catch (err) {
    console.error('[mastery] snapshot/settle after pull failed:', err.message);
  }
}

const running = new Map(); // key → Promise of the read
const share = (key, read) => {
  if (!running.has(key)) running.set(key, read().finally(() => running.delete(key)));
  return running.get(key);
};
const isFresh = (stamp, now) => Boolean(stamp) && now - Date.parse(stamp) < FRESH_MS;
// The sign-in message masterySync throws (SIGN_IN_NEEDED): the page offers Settings.
const needsSignIn = (message) => /Log in to Schoology|session has expired/i.test(message);

async function refresh({ key, stamp, read, afterPull, db, courseId, force, now }) {
  if (!force && isFresh(stamp(), now())) return { refreshed: false, syncedAt: stamp() };
  try {
    const result = await share(key, async () => {
      const r = await read();
      afterPull?.(db, courseId);
      return r;
    });
    return { refreshed: true, syncedAt: stamp(), result };
  } catch (err) {
    const error = String(err?.message || err);
    return { refreshed: false, syncedAt: stamp(), error, signIn: needsSignIn(error) };
  }
}

// One course's mastery: categories, topics, scores, alignments, rollups (syncMasteryForCourse).
// → { refreshed, syncedAt, result? , error?, signIn? }. Throws NOT_FOUND for an unknown course.
export function refreshCourseMastery(courseId, {
  db = getDb(), force = false, now = Date.now, syncCourse = syncMasteryForCourse, afterPull = snapshotAfterMasteryPull,
} = {}) {
  const id = Number(courseId);
  const stamp = () => db.prepare('SELECT mastery_synced_at FROM courses WHERE id = ?').get(id)?.mastery_synced_at ?? null;
  if (!db.prepare('SELECT 1 FROM courses WHERE id = ?').get(id)) return Promise.reject(new RefreshError('NOT_FOUND', `Course ${courseId} not found`));
  return refresh({ key: `course:${id}`, stamp, read: () => syncCourse(id), afterPull, db, courseId: id, force, now });
}

// One assignment's scores and grade comments (syncMasteryForAssignment), as the assessment page's
// Sync Assignment does. Fresh by the assignment's own stamp: a course read does not pull its
// comments. syncedAt falls back to the course stamp when the assignment was never read alone.
export function refreshAssignmentMastery(courseId, schoologyAssignmentId, {
  db = getDb(), force = false, now = Date.now, syncAssignment = syncMasteryForAssignment, afterPull = snapshotAfterMasteryPull,
} = {}) {
  const id = Number(courseId);
  const aid = String(schoologyAssignmentId);
  const own = () => db.prepare('SELECT mastery_synced_at FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?').get(aid, id)?.mastery_synced_at ?? null;
  const course = () => db.prepare('SELECT mastery_synced_at FROM courses WHERE id = ?').get(id)?.mastery_synced_at ?? null;
  if (!db.prepare('SELECT 1 FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?').get(aid, id)) {
    return Promise.reject(new RefreshError('NOT_FOUND', `Assignment ${schoologyAssignmentId} not found in course ${courseId}`));
  }
  const shown = () => own() ?? course();
  if (!force && isFresh(own(), now())) return Promise.resolve({ refreshed: false, syncedAt: own() });
  return refresh({ key: `assignment:${id}:${aid}`, stamp: shown, read: () => syncAssignment(id, aid), afterPull, db, courseId: id, force: true, now });
}
