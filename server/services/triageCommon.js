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

// A deadline N school days from its start date, or from today once that date has
// passed: extending a lapsed resubmission ask (or, with countFrom 'today', overdue work
// or a missed test) gives time from now, not from the past. Before the start date it
// counts from it.
export const laterOf = (a, b) => (a > b ? a : b);
export function deadlineFrom(cal, start, n, today) {
  return cal.addSchoolDays(laterOf(start, today), n);
}

// What an extension's N school days count from (27 Oct 2026). 'due_date' (the default): N
// school days after the original due date, even when that date has already passed, so 3
// days on work 5 school days overdue leaves it 2 school days overdue. 'today': from the
// later of the due date and today (deadlineFrom), a fresh N days from now. Before the due
// date the two give the same deadline.
export const COUNT_FROM = ['due_date', 'today'];
export function assertCountFrom(countFrom) {
  const v = countFrom == null || countFrom === '' ? 'due_date' : countFrom;
  if (!COUNT_FROM.includes(v)) throw new TriageError('BAD_VALUE', `countFrom must be one of ${COUNT_FROM.join(', ')}`);
  return v;
}
export function extensionDeadline(cal, due, n, today, countFrom = 'due_date') {
  return assertCountFrom(countFrom) === 'today' ? deadlineFrom(cal, due, n, today) : cal.addSchoolDays(due, n);
}

// Per-task facts and the submission test, shared by triage.js and flagRows.js (here, not in
// triage.js, so flagRows.js needs no import of triage.js, which imports it; #174).
export function assignmentFacts(db, a) {
  let topicsCount = db.prepare(
    `SELECT COUNT(*) AS n FROM mastery_alignments WHERE assignment_schoology_id = ? AND course_id = ?`,
  ).get(a.schoology_assignment_id, a.course_id).n;
  if (topicsCount === 0 && a.aligned) {
    // Alignments not synced yet: fall back to the topics that have scores (mirrors getAlignedTopics).
    topicsCount = db.prepare(
      `SELECT COUNT(DISTINCT topic_id) AS n FROM mastery_scores WHERE assignment_schoology_id = ?`,
    ).get(a.schoology_assignment_id).n;
  }
  const scoredByUid = new Map(db.prepare(`
    SELECT student_uid, COUNT(*) AS n FROM mastery_scores WHERE assignment_schoology_id = ? GROUP BY student_uid
  `).all(a.schoology_assignment_id).map((r) => [r.student_uid, r.n]));
  const gradeByStudent = new Map(db.prepare(`
    SELECT g.student_id, g.score, g.grade_comment, g.exception, g.late, g.submitted_at, g.first_submitted_at,
           g.flag_seen_at, g.latest_revision_at,
           g.submission_type, g.lti_submission_state, g.test_attempt, sl.line AS stored_line
    FROM grades g
    LEFT JOIN status_lines sl ON sl.student_id = g.student_id AND sl.assignment_id = g.assignment_id
    WHERE g.assignment_id = ?
  `).all(a.id).map((g) => [g.student_id, g]));
  const assignees = a.num_assignees > 0
    ? new Set(db.prepare(`SELECT schoology_uid FROM assignment_assignees WHERE assignment_id = ?`).all(a.id).map((r) => r.schoology_uid))
    : null;
  return { topicsCount, scoredByUid, gradeByStudent, assignees };
}

// Submitted = a real submission signal. submission_type (set by the native
// dropbox revisions sync) is the only corroborating signal for non-LTI work —
// grades.submitted_at also follows a plain teacher grade-entry event (e.g. a
// comment like "please submit" with no file, or a Missing (3) exception), so
// it is NOT treated as a submission here. LTI tracks its own
// submitted/in_progress/not_started state, which is authoritative when present
// (a stale submission_type must not override an in-progress copy).
export function isSubmitted(a, g) {
  if (a.is_lti_submission && g.lti_submission_state) return g.lti_submission_state === 'submitted';
  return !!g.submission_type || g.test_attempt === 'took';
}
