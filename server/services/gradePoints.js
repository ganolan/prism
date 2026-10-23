// The score Prism may write as a task's grade, in the same PUT as its comment: a level of the
// task's score scale (#41), or plain points on a points-only task (#181).
import { getAlignedTopics } from './assessmentContext.js';
import { findScoreScale, isScalePoints } from '../lib/scoreScales.js';
import { canEditPoints, hasNoScale, isTestTask } from '../lib/pointsTask.js';

// The card's pending key for typed points (StudentRubricCard POINTS): drafts and restores use it.
export const POINTS_KEY = '__points__';

// A points-only task (#181): no scale, no measurement topics, and not a test or quiz (the card's
// rule, lib/pointsTask.js). A task on a configured score scale is never one (hasNoScale).
export function isPointsTask(db, courseId, row) {
  if (!row || isTestTask(row) || !hasNoScale(row.grading_scale_id)) return false;
  return canEditPoints(row, getAlignedTopics(db, courseId, String(row.schoology_assignment_id)), null);
}

// Whether two scores are the same: null and '' are no score; otherwise compared as numbers
// (Schoology returns "45" or "45.00" for a score Prism sent as 45).
export function sameScore(a, b) {
  const none = (v) => v == null || v === '';
  if (none(a) || none(b)) return none(a) && none(b);
  return Number(a) === Number(b);
}

// Why `points` can't be written as this task's grade, or null when it can, with the task row and
// whether it is a points-only task. → { error, row, pointsTask }.
export function gradePointsCheck(db, courseId, assignmentId, points, scales) {
  const row = db.prepare('SELECT * FROM assignments WHERE schoology_assignment_id = ? AND course_id = ?')
    .get(String(assignmentId), courseId) || null;
  const scale = row ? findScoreScale(scales, row.grading_scale_id) : null;
  if (scale) {
    return { row, pointsTask: false, error: isScalePoints(scale, points) ? null : `${points} is not a level of ${scale.name}` };
  }
  if (!row || !isPointsTask(db, courseId, row)) {
    const error = isTestTask(row)
      ? 'Schoology scores tests and quizzes: Prism writes no points to them'
      : `Assignment ${assignmentId} is not on a scale Prism can grade`;
    return { row, pointsTask: false, error };
  }
  const n = typeof points === 'string' && points.trim() !== '' ? Number(points) : points;
  const ok = typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return { row, pointsTask: true, error: ok ? null : `${points} is not a score of 0 or more` };
}

// After a points write (#181), read the pair back and compare. `read` is the task's grades read
// (getAssignmentGrades). → { score: what Prism should mirror, exception, warning? }. A read that
// fails keeps the sent score (Schoology accepted the PUT) and says it was not checked.
export async function readBackPoints({ read, enrollmentId, points, sentException }) {
  let record;
  try {
    record = ((await read()) || []).find((g) => String(g.enrollment_id) === String(enrollmentId)) || null;
  } catch (err) {
    return { score: Number(points), exception: sentException, warning: `Published, but Prism could not read the score back from Schoology (${err.message}): sync to check it` };
  }
  if (!record) {
    return { score: Number(points), exception: sentException, warning: 'Published, but the student was missing from Schoology\'s grades read: sync to check the score' };
  }
  if (sameScore(record.grade, points)) return { score: Number(points), exception: Number(record.exception) || 0 };
  const held = record.grade == null || record.grade === '' ? 'no score' : record.grade;
  return {
    score: held === 'no score' ? null : Number(record.grade),
    exception: Number(record.exception) || 0,
    warning: `Schoology holds ${held}, not the ${Number(points)} sent: check the grade in Schoology`,
  };
}
