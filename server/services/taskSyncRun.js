// Sync Assignment as a queued run (background sync, 20/10/2026): one task's details, submissions,
// grades and comment threads (assignmentSync.js), then its mastery scores and grade comments
// (masteryRefresh, forced). It reports like a unified run (phase events, then a summary), so the
// queue records it and the progress dialog shows it. The task is "Synced" only when both parts
// succeeded; it always gets an attempt time. A sign-in failure is reported (`signIn`) for the
// queue to hold the run until the teacher signs in.
import { getDb } from '../db/index.js';
import { syncAssignment } from './assignmentSync.js';
import { refreshAssignmentMastery } from './masteryRefresh.js';

export async function runTaskSync(request, emit, { db = getDb(), deps = {} } = {}) {
  const d = { syncAssignment, refreshAssignmentMastery, now: Date.now, ...deps };
  const courseId = Number(request.courseId);
  const aid = String(request.assignmentId);
  const at = new Date(d.now()).toISOString();
  const startedAt = d.now();
  const taskRow = () => db.prepare('SELECT id, title FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?').get(aid, courseId);
  const title = taskRow()?.title ?? aid;

  emit({ phase: 'assignment', status: 'running', title });
  const task = await d.syncAssignment(courseId, aid, { db });
  if (task.removed) {
    emit({ type: 'log', message: `"${title}": Deleted in Schoology` });
    emit({ phase: 'assignment', status: 'done', title, removed: true });
    emit({ type: 'summary', mastery: [], removed: true, elapsedMs: d.now() - startedAt });
    return;
  }
  const submissionsOk = task.submissions?.refreshed > 0 && !task.submissions?.error && !(task.submissions?.failed ?? []).length;
  emit(submissionsOk
    ? { phase: 'assignment', status: 'done', title }
    : { phase: 'assignment', status: 'error', title, message: task.submissions?.error || 'Submissions not read' });

  emit({ phase: 'mastery', courseId, courseName: title, status: 'running' });
  const m = await d.refreshAssignmentMastery(courseId, aid, { db, force: true })
    .catch((err) => ({ error: String(err?.message || err) }));
  const mastery = m?.error
    ? { courseId, courseName: title, status: 'error', message: m.error, ...(m.signIn ? { errorKind: 'login' } : {}) }
    : { courseId, courseName: title, status: 'done' };
  emit({ phase: 'mastery', ...mastery });

  const id = taskRow()?.id;
  if (id) {
    db.prepare('UPDATE assignments SET task_sync_attempted_at = ? WHERE id = ?').run(at, id);
    if (submissionsOk && !m?.error) db.prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run(at, id);
  }
  emit({
    type: 'summary', mastery: [mastery], comments: task.comments ?? null, elapsedMs: d.now() - startedAt,
    ...(m?.signIn ? { signIn: true } : {}),
  });
}
