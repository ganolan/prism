// Sync Assignment as a queued run (background sync, 20/10/2026): one task's details, submissions,
// grades and comment threads (assignmentSync.js), then its mastery scores and grade comments
// (masteryRefresh, forced). It reports like a unified run (phase events, then a summary), so the
// queue records it and the progress dialog shows it. The task is "Synced" only when both parts
// succeeded; it always gets an attempt time. A sign-in failure is reported (`signIn`) for the
// queue to hold the run until the teacher signs in.
//
// A grading sync (request.grading, #131; PrisMCP's get_assignment_context) also waits for the
// comment threads and reads the files of every student who uploaded, and reports both in the
// summary. It is "Synced" (and stamps `grading_synced_at`, which PrisMCP's 5 minute skip counts: a
// plain run is not a full read for grading) only when those read in full too: a OneDrive task has no Schoology
// files, which is not a failure (`files.notNative`), and a source switched off in config.yaml
// (`submission_comments`, `submission_files`) is skipped, reported as `disabled`, not a failure. A
// plain run starts the threads and moves on. A grading run whose submissions read failed or lost the
// sign-in is already failing: it reads no threads or files (`skipped`), and a thread job that
// brings no `done` to wait on is an error, never a success (#170).
import { getDb } from '../db/index.js';
import { syncAssignment, submissionsRead } from './assignmentSync.js';
import { refreshAssignmentMastery } from './masteryRefresh.js';
import { refreshAssignmentFiles } from './submissionFiles.js';
import { getFeatures } from '../middleware/featureGate.js';

const message = (err) => String(err?.message || err);

// Wait for a read job's tally → { refreshed, failed } or { refreshed: 0, failed: 0, error }.
async function tally(done) {
  try { return await done; } catch (err) { return { refreshed: 0, failed: 0, error: message(err) }; }
}

export async function runTaskSync(request, emit, { db = getDb(), deps = {} } = {}) {
  const d = { syncAssignment, refreshAssignmentMastery, refreshFiles: refreshAssignmentFiles, getFeatures, now: Date.now, ...deps };
  const courseId = Number(request.courseId);
  const aid = String(request.assignmentId);
  const at = new Date(d.now()).toISOString();
  const startedAt = d.now();
  const taskRow = () => db.prepare('SELECT id, title FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?').get(aid, courseId);
  const title = taskRow()?.title ?? aid;

  emit({ phase: 'assignment', status: 'running', title });
  const task = await d.syncAssignment(courseId, aid, { db, ...(request.grading ? { grading: true } : {}) });
  if (task.removed) {
    emit({ type: 'log', message: `"${title}": Deleted in Schoology` });
    emit({ phase: 'assignment', status: 'done', title, removed: true });
    emit({ type: 'summary', mastery: [], removed: true, elapsedMs: d.now() - startedAt });
    return;
  }
  const id = taskRow()?.id;
  const { done: threadsDone, ...commentsInfo } = task.comments ?? {};
  let comments = task.comments ? commentsInfo : null;
  let files = null;
  let gradingError = null;
  const submissionsOk = submissionsRead(task.submissions);
  if (request.grading && !submissionsOk) {
    comments = { refreshed: 0, failed: 0, skipped: true };
    files = { refreshed: 0, failed: 0, skipped: true };
  } else if (request.grading) {
    const features = d.getFeatures();
    if (!features.submission_comments) comments = { refreshed: 0, failed: 0, disabled: true };
    else if (commentsInfo.error) comments = { refreshed: 0, failed: 0, error: commentsInfo.error };
    else if (!threadsDone) comments = { refreshed: 0, failed: 0, error: 'The comment threads were not read (no read job started)' };
    else comments = await tally(threadsDone);
    if (comments.error || comments.failed) gradingError = comments.error || `${comments.failed} comment thread(s) not read`;
    else if (!features.submission_files) files = { refreshed: 0, failed: 0, disabled: true };
    else {
      try {
        files = await tally(d.refreshFiles(db, id, { maxAgeSec: 0 }).done);
      } catch (err) {
        files = err?.code === 'NOT_NATIVE' ? { notNative: true } : { refreshed: 0, failed: 0, error: message(err) };
      }
      if (files.error || files.failed) gradingError = files.error || `${files.failed} file read(s) failed`;
    }
  }

  emit(submissionsOk && !gradingError
    ? { phase: 'assignment', status: 'done', title }
    : { phase: 'assignment', status: 'error', title, message: task.submissions?.error || gradingError || 'Submissions not read' });

  emit({ phase: 'mastery', courseId, courseName: title, status: 'running' });
  const m = await d.refreshAssignmentMastery(courseId, aid, { db, force: true })
    .catch((err) => ({ error: String(err?.message || err) }));
  const mastery = m?.error
    ? { courseId, courseName: title, status: 'error', message: m.error, ...(m.signIn ? { errorKind: 'login' } : {}) }
    : { courseId, courseName: title, status: 'done' };
  emit({ phase: 'mastery', ...mastery });

  if (id) {
    db.prepare('UPDATE assignments SET task_sync_attempted_at = ? WHERE id = ?').run(at, id);
    if (submissionsOk && !gradingError && !m?.error) {
      db.prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?').run(at, id);
      if (request.grading) db.prepare('UPDATE assignments SET grading_synced_at = ? WHERE id = ?').run(at, id);
    }
  }
  emit({
    type: 'summary', mastery: [mastery], comments, ...(files ? { files } : {}), elapsedMs: d.now() - startedAt,
    ...(m?.signIn || task.submissions?.signIn ? { signIn: true } : {}),
  });
}
