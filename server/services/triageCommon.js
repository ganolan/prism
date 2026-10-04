// Shared helpers for server/services/triage.js and server/services/resubmissions.js
// (moved out 2026-10-03 so resubmissions.js doesn't import the whole triage module).
import { preferredFirstName } from './studentNames.js';

export class TriageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// `days` is the internal count (day − 1): red after day `limit`, amber over the
// last `warnLead` allowed days.
export function toneFor(days, limit, warnLead) {
  if (days >= limit) return 'red';
  if (days >= limit - warnLead) return 'amber';
  return 'green';
}

// Make-up clock on day numbers (test day = day 1): amber from day amberDay, red from day redDay.
export function makeUpTone(day, amberDay, redDay) {
  if (day >= redDay) return 'red';
  if (day >= amberDay) return 'amber';
  return 'green';
}

// Current courses. The all-courses view (Dashboard, PrisMCP) also drops hidden
// ones; a specific course (its own page) is shown even when hidden.
export function currentCourses(db, courseId) {
  if (courseId != null) {
    return db.prepare(`SELECT id, course_name, block_number FROM courses WHERE id = ? AND archived = 0 AND excluded = 0`).all(Number(courseId));
  }
  return db.prepare(`
    SELECT id, course_name, block_number FROM courses WHERE archived = 0 AND excluded = 0 AND hidden = 0 ORDER BY course_name
  `).all();
}

export function roster(db, courseId) {
  return db.prepare(`
    SELECT s.id, s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher, s.email
    FROM students s JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ? AND e.dropped_at IS NULL
    ORDER BY s.last_name, s.first_name
  `).all(courseId);
}

// Summative = aligned to measurement topics (or scored against them).
export const ALIGNED_SQL = `CASE WHEN EXISTS (
        SELECT 1 FROM mastery_alignments ma WHERE ma.assignment_schoology_id = a.schoology_assignment_id
        UNION
        SELECT 1 FROM mastery_scores ms WHERE ms.assignment_schoology_id = a.schoology_assignment_id
      ) THEN 1 ELSE 0 END`;

export const fullName = (st) => `${preferredFirstName(st)} ${st.last_name}`;

export const MAX_EXTENSION_LESSONS = 60;
