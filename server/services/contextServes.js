// The reads PrisMCP's get_assignment_context handed to grading sessions (#170). Each answer is a
// context_serves row; its id (context_id) comes back on write_student_suggestions, so a suggestion
// records the data time and serve time of the read the grader actually graded from, not of
// whichever read happened last. Rows live in the database, so a server restart between the read
// and the write loses nothing.

// Without a context_id (or with one that no longer exists), a write uses the OLDEST serve of the
// task in this window: the longest-held read is the one a long grading run most likely graded from.
export const CONTEXT_FALLBACK_MS = 3 * 60 * 60 * 1000;
export const CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const iso = (now) => new Date(now ?? Date.now()).toISOString();

// Record that a grading session was given the task's data as of `dataAsOf` ('never' for a task not
// yet synced). assignmentId is the LOCAL assignment id. Returns the context_id.
export function recordServe(db, { assignmentId, dataAsOf, now }) {
  const servedAt = iso(now);
  pruneServes(db, { now: servedAt });
  return Number(db.prepare('INSERT INTO context_serves (assignment_id, data_as_of, served_at) VALUES (?, ?, ?)')
    .run(assignmentId, dataAsOf ?? 'never', servedAt).lastInsertRowid);
}

// The data time and serve time to stamp on a suggestion. A context_id of this task wins
// (source 'context_id'). One of ANOTHER task throws: its times describe different data. An unknown
// or pruned id, or none, takes the oldest serve of the task in the last CONTEXT_FALLBACK_MS
// (source 'fallback'; `unknownId` marks a given id that did not resolve). With no such serve:
// the task's task_synced_at ('never' if unsynced) and now (source 'none').
export function serveFor(db, { assignmentId, contextId, now }) {
  const nowIso = iso(now);
  if (contextId != null) {
    const row = db.prepare('SELECT assignment_id, data_as_of, served_at FROM context_serves WHERE id = ?').get(contextId);
    if (row) {
      if (row.assignment_id !== assignmentId) {
        throw new Error(`context_id ${contextId} belongs to another assignment: pass the context_id from the get_assignment_context answer for this one`);
      }
      return { dataAsOf: row.data_as_of, servedAt: row.served_at, source: 'context_id' };
    }
  }
  const unknown = contextId != null ? { unknownId: true } : {};
  const cutoff = new Date(new Date(nowIso).getTime() - CONTEXT_FALLBACK_MS).toISOString();
  const oldest = db.prepare(
    'SELECT data_as_of, served_at FROM context_serves WHERE assignment_id = ? AND served_at >= ? AND served_at <= ? ORDER BY served_at ASC, id ASC LIMIT 1'
  ).get(assignmentId, cutoff, nowIso);
  if (oldest) return { dataAsOf: oldest.data_as_of, servedAt: oldest.served_at, source: 'fallback', ...unknown };
  const task = db.prepare('SELECT task_synced_at FROM assignments WHERE id = ?').get(assignmentId);
  return { dataAsOf: task?.task_synced_at ?? 'never', servedAt: nowIso, source: 'none', ...unknown };
}

// Delete serves older than CONTEXT_RETENTION_MS.
export function pruneServes(db, { now } = {}) {
  const cutoff = new Date(new Date(iso(now)).getTime() - CONTEXT_RETENTION_MS).toISOString();
  db.prepare('DELETE FROM context_serves WHERE served_at < ?').run(cutoff);
}
