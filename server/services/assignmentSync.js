// #58: Sync Assignment. Everything about one task, read from Schoology now: its details (title,
// due date, points, assignees), then its submissions and grades (taskRefresh.js, forced), then its
// submission comment threads (started, not awaited: the page polls them). The route reads the
// mastery scores beside this. A task Schoology answers 404 for was deleted there: it is marked
// removed, as the full sync would, and nothing else is read.
import { getDb } from '../db/index.js';
import { getSectionAssignment } from './schoology.js';
import { writeAssignments } from './taskAssignments.js';
import { refreshTasks } from './taskRefresh.js';
import { refreshAssignment } from './submissionComments.js';

// → { removed: true } | { removed: false, submissions, comments: { queued }, taskSyncedAt }.
export async function syncAssignment(courseId, schoologyAssignmentId, { db = getDb(), deps = {} } = {}) {
  const d = { getSectionAssignment, refreshTasks, refreshComments: refreshAssignment, now: Date.now, ...deps };
  const course = db.prepare('SELECT id, schoology_section_id FROM courses WHERE id = ?').get(Number(courseId));
  const task = course && db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?')
    .get(String(schoologyAssignmentId), course.id);
  if (!task) throw Object.assign(new Error(`Assignment ${schoologyAssignmentId} not found in course ${courseId}`), { code: 'NOT_FOUND' });
  const now = new Date(d.now()).toISOString();

  let record;
  try {
    record = await d.getSectionAssignment(String(course.schoology_section_id), String(schoologyAssignmentId));
  } catch (err) {
    if (err?.status === 404) {
      db.prepare('UPDATE assignments SET removed_at = COALESCE(removed_at, ?) WHERE id = ?').run(now, task.id);
      return { removed: true };
    }
    throw err;
  }
  const enrolmentIdToUid = new Map(db.prepare(`
    SELECT e.schoology_enrolment_id AS eid, s.schoology_uid AS uid FROM enrolments e JOIN students s ON s.id = e.student_id
    WHERE e.course_id = ? AND e.schoology_enrolment_id IS NOT NULL`).all(course.id).map((r) => [String(r.eid), String(r.uid)]));
  writeAssignments(db, { courseId: course.id, assignments: [record], now, enrolmentIdToUid, complete: false });

  const submissions = await d.refreshTasks([task.id], { db, force: true, mastery: false });
  let comments = { queued: 0 };
  try {
    const job = d.refreshComments(db, task.id, { maxAgeSec: 0 });
    job.done?.catch((err) => console.error('[sync assignment] comment refresh failed:', err.message));
    comments = { queued: job.queued ?? 0 };
  } catch (err) {
    comments = { queued: 0, error: err.message };
  }

  const clean = !submissions.error && !(submissions.failed ?? []).length;
  if (clean) db.prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run(now, task.id);
  const taskSyncedAt = db.prepare('SELECT task_synced_at FROM assignments WHERE id = ?').get(task.id).task_synced_at;
  return { removed: false, submissions, comments, taskSyncedAt };
}
