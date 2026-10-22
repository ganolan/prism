// #108: submissions and scores read from Schoology on demand. The dashboard, course and
// assessment pages render what Prism holds, then ask for the tasks they show to be read
// again in the background. The reads are the full sync's own (taskSubmissions.js,
// taskGrades.js), plus the aligned tasks' mastery read (masteryRefresh.js).
// A task read under FRESH_MS ago is not read again (unless `force`); a task already being
// read is shared, not read twice. A read a page starts never marks an OneDrive or test
// read 'failed' (keepStatusOnFailure): one lapsed session must not empty the make-up list.
// The nightly sync still reads everything.
import { getDb } from '../db/index.js';
import { getAssignmentGrades } from './schoology.js';
import { readTaskSubmissions } from './taskSubmissions.js';
import { writeGrades } from './taskGrades.js';
import { courseSectionIds } from './courseSections.js';
import { createSubmissionFetcher } from './graderSubmissions.js';
import { FRESH_MS, refreshAssignmentMastery } from './masteryRefresh.js';
import { captureFeedbackSnapshots } from './feedbackSnapshots.js';
import { settleResubmissions } from './resubmissions.js';
import { ALIGNED_SQL } from './triageCommon.js';

const COURSE_CONCURRENCY = 4;

// Rubric levels and new revisions are part of the visible-feedback fingerprint, so a
// read re-snapshots the course, then settles resubmissions, as the full sync does.
// Best-effort: never fails the read.
function snapshotAfterRead(db, { courseId, revisionsRead, readSince }) {
  try {
    captureFeedbackSnapshots(db, { courseId, revisionsRead, readSince });
    settleResubmissions(db, { courseId });
  } catch (err) {
    console.error('[refresh] snapshot/settle after read failed:', err.message);
  }
}

const running = new Map(); // task id → Promise of the batch reading it

function loadTasks(db, ids, { includeArchived = false } = {}) {
  return db.prepare(`
    SELECT a.id, a.course_id, a.schoology_assignment_id AS ext, a.title, a.accepts_submissions, a.is_lti_submission,
      a.is_test, a.submissions_read_at, c.schoology_section_id AS section_id, ${ALIGNED_SQL} AS aligned
    FROM assignments a JOIN courses c ON c.id = a.course_id
    WHERE a.id IN (SELECT value FROM json_each(?))
      AND a.removed_at IS NULL AND (COALESCE(c.archived, 0) = 0 OR ?)
  `).all(JSON.stringify(ids.map(Number)), includeArchived ? 1 : 0);
}

const needsSession = (t) => t.is_test === 1 || (t.accepts_submissions === 1 && t.is_lti_submission === 1);

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// Read one course's tasks: submissions, then grades, then aligned tasks' mastery.
// Everything is kept per task, so a caller sharing the batch sees only its own tasks' outcome.
// → { read: Set<task id>, failed: Map<task id, message>, signIn: Set<task id> }.
// #178: a course of linked sections is read section by section, each with its own students (a
// section's read clears the submission state of any student it does not list). A task is read in
// full only when every section read it.
async function readCourse(db, tasks, { reader, nowIso, force, mastery, readSince, deps }) {
  const { course_id: courseId, section_id: ownSection } = tasks[0];
  const out = { read: new Set(), failed: new Map(), signIn: new Set() };
  const students = db.prepare(`
    SELECT e.schoology_enrolment_id AS id, s.schoology_uid AS uid, COALESCE(e.schoology_section_id, ?) AS section
    FROM enrolments e JOIN students s ON s.id = e.student_id
    WHERE e.course_id = ? AND e.dropped_at IS NULL AND e.schoology_enrolment_id IS NOT NULL
  `).all(String(ownSection), courseId);
  const sectionIds = courseSectionIds(db, courseId);
  const fail = (t, err) => { if (!out.failed.has(t.id)) out.failed.set(t.id, String(err?.message || err)); };

  let revisionsRead = new Set();
  try {
    const reads = [];
    for (const sectionId of sectionIds) {
      reads.push(await readTaskSubmissions(db, {
        sectionId, now: nowIso, students: students.filter((x) => x.section === sectionId).map(({ id, uid }) => ({ id, uid })),
        native: tasks.filter((t) => t.accepts_submissions === 1 && t.is_lti_submission !== 1).map((t) => t.ext),
        lti: tasks.filter((t) => t.accepts_submissions === 1 && t.is_lti_submission === 1).map((t) => t.ext),
        tests: tasks.filter((t) => t.is_test === 1).map((t) => t.ext),
        fetchDocuments: reader ? (aid) => reader.fetchDocuments(aid) : undefined,
        fetchTestAttempts: reader ? (sid, uids, items) => reader.fetchTestAttempts(sid, uids, items) : undefined,
        keepStatusOnFailure: true,
        failTaskOnError: true,
      }));
    }
    const inAll = (k) => reads.map((x) => x[k]).reduce((a, b) => new Set([...a].filter((id) => b.has(id))));
    const r = {
      revisionsRead: inAll('revisionsRead'),
      readInFull: inAll('readInFull'),
      failedAssignmentIds: [...new Set(reads.flatMap((x) => x.failedAssignmentIds))],
      taskErrors: new Map(reads.flatMap((x) => [...x.taskErrors])),
    };
    revisionsRead = r.revisionsRead;
    for (const t of tasks) {
      if (r.readInFull.has(t.id)) continue;
      if (needsSession(t) && (!reader || reader.expired)) { out.signIn.add(t.id); continue; } // left as it is
      if (r.failedAssignmentIds.includes(t.ext) || t.accepts_submissions === 1 || t.is_test === 1) {
        fail(t, new Error(r.taskErrors.get(t.ext) ?? `Could not read the submissions of "${t.title || t.ext}"`));
      }
    }
  } catch (err) {
    for (const t of tasks) fail(t, err);
    return out;
  }

  const enrollIdToUid = Object.fromEntries(students.map((s) => [String(s.id), String(s.uid)]));
  const stamp = db.prepare('UPDATE assignments SET submissions_read_at = ? WHERE id = ?');
  for (const t of tasks) {
    try {
      for (const sectionId of sectionIds) {
        writeGrades(db, { courseId, grades: await getAssignmentGrades(sectionId, t.ext), now: nowIso, enrollIdToUid });
      }
      // A task with no submission channel has nothing else to read.
      if (t.accepts_submissions !== 1 && t.is_test !== 1) stamp.run(nowIso, t.id);
    } catch (err) {
      fail(t, err);
    }
  }

  if (mastery) {
    for (const t of tasks.filter((x) => x.aligned && (mastery === true || mastery.has(x.id)))) {
      const m = await deps.refreshMastery(courseId, t.ext, { force }).catch((err) => ({ error: String(err?.message || err) }));
      if (m?.error) {
        fail(t, m.error);
        if (m.signIn) out.signIn.add(t.id);
      }
    }
  }

  // Read: every step that ran answered (a task left for a sign-in still had its grades read).
  for (const t of tasks) if (!out.failed.has(t.id)) out.read.add(t.id);
  deps.afterRead(db, { courseId, revisionsRead, readSince });
  return out;
}

async function readBatch(db, tasks, opts) {
  const total = { read: new Set(), failed: new Map(), signIn: new Set() };
  let reader = null;
  if (tasks.some(needsSession)) {
    try { reader = await opts.openReader(); } catch { reader = null; }
  }
  try {
    const byCourse = new Map();
    for (const t of tasks) byCourse.set(t.course_id, [...(byCourse.get(t.course_id) || []), t]);
    await mapLimit([...byCourse.values()], COURSE_CONCURRENCY, async (courseTasks) => {
      const r = await readCourse(db, courseTasks, { ...opts, reader });
      r.read.forEach((id) => total.read.add(id));
      r.failed.forEach((msg, id) => total.failed.set(id, msg));
      r.signIn.forEach((id) => total.signIn.add(id));
    });
  } finally {
    await reader?.close?.().catch(() => {});
  }
  return total;
}

// Read these tasks' submissions and scores from Schoology. `assignmentIds`: local
// assignments.id values; unknown, removed and archived-course tasks are skipped.
// `mastery`: true (every aligned task), false, or a list of task ids (only those; the course page
// passes its triage panel's tasks, since it reads the course's mastery itself).
// → { refreshed, readAt, failed, error?, signIn? }. `refreshed`: tasks read by this call
// (or by a read it joined), grades included; `readAt`: the oldest submissions_read_at among the
// tasks that have one, so a page never claims a fresher read than its stalest task read.
export async function refreshTasks(assignmentIds, {
  db = getDb(), force = false, mastery = true, now = Date.now, openReader = createSubmissionFetcher, deps = {}, includeArchived = false,
} = {}) {
  const d = {
    refreshMastery: (courseId, ext, o) => refreshAssignmentMastery(courseId, ext, { db, ...o }),
    afterRead: snapshotAfterRead,
    ...deps,
  };
  const tasks = loadTasks(db, [...new Set(assignmentIds)], { includeArchived });
  const masteryFor = Array.isArray(mastery) ? new Set(mastery.map(Number)) : Boolean(mastery);
  const t0 = now();
  const stale = tasks.filter((t) => force || !t.submissions_read_at || t0 - Date.parse(t.submissions_read_at) >= FRESH_MS);

  const joined = stale.filter((t) => running.has(t.id));
  const mine = stale.filter((t) => !running.has(t.id));
  const waits = [...new Set(joined.map((t) => running.get(t.id)))];
  if (mine.length) {
    const batch = readBatch(db, mine, {
      openReader, nowIso: new Date(t0).toISOString(), force, mastery: masteryFor, readSince: Math.floor(t0 / 1000), deps: d,
    }).finally(() => { for (const t of mine) if (running.get(t.id) === batch) running.delete(t.id); });
    for (const t of mine) running.set(t.id, batch);
    waits.push(batch);
  }
  const results = await Promise.all(waits);

  const wanted = new Set(stale.map((t) => t.id));
  const read = new Set();
  const failed = new Map();
  let signIn = false;
  for (const r of results) {
    r.read.forEach((id) => { if (wanted.has(id)) read.add(id); });
    r.failed.forEach((msg, id) => { if (wanted.has(id)) failed.set(id, msg); });
    r.signIn.forEach((id) => { if (wanted.has(id)) signIn = true; });
  }
  const errors = [...failed.values()];

  const stamp = db.prepare('SELECT submissions_read_at FROM assignments WHERE id = ?');
  const stamps = tasks.map((t) => stamp.get(t.id)?.submissions_read_at).filter(Boolean);
  const readAt = stamps.length ? stamps.reduce((a, b) => (a < b ? a : b)) : null;
  const out = { refreshed: read.size, readAt, failed: [...failed.keys()] };
  if (errors.length) out.error = failed.size > 1 ? `${failed.size} tasks not read from Schoology: ${errors[0]}` : errors[0];
  if (signIn) {
    out.signIn = true;
    out.error ??= 'Log in to Schoology to read OneDrive work and test attempts.';
  }
  return out;
}
