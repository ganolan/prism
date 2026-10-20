import { Router } from 'express';
import { getDb } from '../db/index.js';
import { enqueue, currentSync, resumeHeld, ensure } from '../services/syncQueue.js';
import { listRuns, getRun, getEvents, isFinished } from '../services/syncRuns.js';

const router = Router();

// POST /api/sync — a sync started by a button (Sync Courses, Sync Course, a retry), queued behind the
// running one (server/services/syncQueue.js). Body: {
//   courseIds?: number[],       // #58: the courses to sync; absent = every current course
//   masteryCourseIds?: number[],// a mastery-only retry (with skipSchoology)
//   skipSchoology?: boolean,    // a mastery-only or blocks-only retry
//   includeHidden?: boolean,    // with no courseIds: hidden courses too
//   syncBlocks?: boolean,       // #106: the PowerSchool block pass (default: on for every course, off for a list)
// } → { runId, state: 'queued' | 'running', joined }. Every sync reads everything (no recent window).
// The run is a sync_runs row from now on; follow it with GET /api/sync/runs/:id/events?after=<seq>
// (a run left queued, held or running by a restart is marked 'interrupted' at boot).
router.post('/sync', (req, res) => {
  const { courseIds = null, masteryCourseIds, skipSchoology = false, includeHidden = false, syncBlocks } = req.body || {};
  if (Array.isArray(courseIds) && courseIds.length === 0) {
    return res.status(400).json({ error: 'No courses selected' });
  }
  const ids = (list) => list.map(Number).filter(Number.isInteger);
  const listed = Array.isArray(courseIds) ? ids(courseIds) : (skipSchoology && Array.isArray(masteryCourseIds) ? ids(masteryCourseIds) : null);
  const request = {
    kind: listed ? 'courses' : 'all',
    ...(listed ? { courseIds: listed } : {}),
    ...(Array.isArray(masteryCourseIds) ? { masteryCourseIds: ids(masteryCourseIds) } : {}),
    skipSchoology: !!skipSchoology,
    includeHidden: !!includeHidden,
    ...(syncBlocks === undefined ? {} : { syncBlocks: syncBlocks !== false }),
    trigger: 'button',
    force: true,
  };
  try {
    res.json(enqueue(request));
  } catch (err) {
    console.error('[sync] Could not queue a sync run:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/ensure { scope } — a page asks for its scope after it loads (background sync):
// scope { kind: 'all' } (dashboard), { kind: 'courses', courseIds } (course, student page) or
// { kind: 'task', courseId, assignmentId } (assessment page). Synced (or tried) within 10 minutes →
// { state: 'fresh' }; else { state: 'queued' | 'running', runId } to follow.
router.post('/sync/ensure', (req, res) => {
  const scope = req.body?.scope;
  const ok = scope && (scope.kind === 'all'
    || (scope.kind === 'courses' && Array.isArray(scope.courseIds))
    || (scope.kind === 'task' && scope.courseId != null && scope.assignmentId != null));
  if (!ok) return res.status(400).json({ error: 'A scope is required: all, courses or task' });
  try {
    res.json(ensure(scope));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/resume — after a sign-in: the syncs held for it run now. → { resumed }.
router.post('/sync/resume', (req, res) => {
  res.json({ resumed: resumeHeld() });
});

// GET /api/sync/status — last sync info (+ the running sync's runId, if any)
router.get('/sync/status', (req, res) => {
  const db = getDb();
  const last = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get();
  const { running, runId } = currentSync();
  res.json({ syncing: Boolean(running), runId, last: last || null });
});

// GET /api/sync/current — the running run, the queued ones and the held ones, each with its courses.
router.get('/sync/current', (req, res) => {
  res.json(currentSync());
});

// GET /api/sync/runs?limit= — newest sync runs (no events), for Settings.
router.get('/sync/runs', (req, res) => {
  res.json(listRuns(getDb(), { limit: req.query.limit }));
});

// GET /api/sync/runs/:id — one run with its full event log.
router.get('/sync/runs/:id', (req, res) => {
  const run = getRun(getDb(), Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Sync run not found' });
  res.json(run);
});

// GET /api/sync/runs/:id/events?after=<seq> — incremental events for a client
// re-attaching to a run. Status is read BEFORE the events, so once `finished`
// is true the returned events are guaranteed to include the run's last one.
router.get('/sync/runs/:id/events', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const run = db.prepare('SELECT status FROM sync_runs WHERE id = ?').get(id);
  if (!run) return res.status(404).json({ error: 'Sync run not found' });
  const events = getEvents(db, id, { afterSeq: req.query.after ?? 0 });
  res.json({ status: run.status, finished: isFinished(run.status), events });
});

// GET /api/sync/metrics — latest sync_metrics row, with failed_assignment_ids
// parsed back to an array. Returns null if no syncs have completed yet.
router.get('/sync/metrics', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, sync_log_id, started_at, duration_ms,
           submission_calls, rate_limit_hits, transient_failures,
           retries_attempted, retries_succeeded, retries_failed,
           concurrency, rate_per_sec, abandoned, sections_skipped, failed_assignment_ids,
           schoology_ms, blocks_ms, alerts_ms, mastery_ms, comments_ms, quizzes_ms, total_ms
    FROM sync_metrics
    ORDER BY id DESC
    LIMIT 1
  `).get();
  if (!row) return res.json(null);
  row.failed_assignment_ids = row.failed_assignment_ids ? JSON.parse(row.failed_assignment_ids) : [];
  res.json(row);
});

export default router;
