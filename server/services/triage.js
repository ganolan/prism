// Triage: late-work referral watch + feedback owed
// (docs/superpowers/specs/2026-10-01-triage-late-work-and-feedback-owed-design.md).
// The single source of truth for the web API (server/routes/triage.js) and
// PrisMCP (mcp/handlers.js), so the agent sees exactly the dashboard's numbers.
// All day counts are school days (server/lib/schoolDays.js).

import { todayLocal, epochToLocalDate } from '../lib/schoolDays.js';
import { loadCalendar } from './schoolCalendar.js';
import { getTriageSettings } from './settings.js';
import { gradingState } from './assessmentContext.js';
import { preferredFirstName } from './studentNames.js';

export class TriageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function toneFor(days, limit, warnLead) {
  if (days >= limit) return 'red';
  if (days >= limit - warnLead) return 'amber';
  return 'green';
}

// Current courses. The all-courses view (Dashboard, PrisMCP) also drops hidden
// ones; a specific course (its own page) is shown even when hidden.
function currentCourses(db, courseId) {
  if (courseId != null) {
    return db.prepare(`SELECT id, course_name, block_number FROM courses WHERE id = ? AND archived = 0 AND excluded = 0`).all(Number(courseId));
  }
  return db.prepare(`
    SELECT id, course_name, block_number FROM courses WHERE archived = 0 AND excluded = 0 AND hidden = 0 ORDER BY course_name
  `).all();
}

function roster(db, courseId) {
  return db.prepare(`
    SELECT s.id, s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher
    FROM students s JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ? AND e.dropped_at IS NULL
    ORDER BY s.last_name, s.first_name
  `).all(courseId);
}

// Summative = aligned to measurement topics (or scored against them).
const ALIGNED_SQL = `CASE WHEN EXISTS (
        SELECT 1 FROM mastery_alignments ma WHERE ma.assignment_schoology_id = a.schoology_assignment_id
        UNION
        SELECT 1 FROM mastery_scores ms WHERE ms.assignment_schoology_id = a.schoology_assignment_id
      ) THEN 1 ELSE 0 END`;

// Published assignments whose due date has passed (due date before today).
function pastDueAssignments(db, courseId, today) {
  return db.prepare(`
    SELECT a.id, a.course_id, a.schoology_assignment_id, a.title, a.due_date, a.is_lti_submission, a.num_assignees,
      a.accepts_submissions, ${ALIGNED_SQL} AS aligned
    FROM assignments a
    WHERE a.course_id = ? AND a.published = 1
      AND a.due_date IS NOT NULL AND a.due_date != '' AND substr(a.due_date, 1, 10) < ?
  `).all(courseId, today);
}

function assignmentFacts(db, a) {
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
    SELECT student_id, score, grade_comment, exception, late, submitted_at, first_submitted_at,
           submission_type, lti_submission_state
    FROM grades WHERE assignment_id = ?
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
function isSubmitted(a, g) {
  if (a.is_lti_submission && g.lti_submission_state) return g.lti_submission_state === 'submitted';
  return !!g.submission_type;
}

function studentState(a, facts, st) {
  const g = facts.gradeByStudent.get(st.id) || {};
  const topicScored = facts.scoredByUid.get(st.schoology_uid) || 0;
  const grading = gradingState({
    // No rubric topics: the plain score is the grade (client gradingStateOf parity).
    scoredCount: facts.topicsCount === 0 ? (g.score != null ? 1 : 0) : topicScored,
    topicsCount: facts.topicsCount,
    hasComment: (g.grade_comment || '').trim().length > 0,
    exception: g.exception ?? 0,
  });
  return {
    excused: Number(g.exception) === 1,
    // Schoology's own on-time/late call for the submission (0 = on time).
    late: g.late,
    submitted: isSubmitted(a, g),
    // Missing (3) rows carry score 0.0 in real data (a grade-entry artifact,
    // not a mark) — exception 3 is never "scored".
    scored: Number(g.exception) !== 3 && (g.score != null || topicScored > 0),
    grading,
    firstSubmittedOn: epochToLocalDate(g.first_submitted_at),
  };
}

const fullName = (st) => `${preferredFirstName(st)} ${st.last_name}`;

// Can this assignment make a student "outstanding"? Only when it takes
// submissions in Schoology (allow_dropbox, synced as accepts_submissions = 1).
// Paper/in-class/gradebook-only work (0) — incl. Schoology tests/quizzes — has
// no submission signal, so every student would look outstanding until graded.
// NULL = not synced since the column was added: fall back to "someone has
// actually submitted", which proves a submission channel.
function tracksSubmissions(a, states) {
  if (a.accepts_submissions === 1) return true;
  if (a.accepts_submissions == null) return states.some(({ s }) => s.submitted);
  return false;
}

export function getTriage(db, { courseId = null, studentId = null, includeFormative, today = todayLocal() } = {}) {
  const settings = getTriageSettings(db);
  const formative = includeFormative ?? settings.showFormativeDefault;
  const { referralLimitDays, feedbackLimitDays, warnLeadDays } = settings;
  const cal = loadCalendar(db);
  const handled = new Set(db.prepare('SELECT student_id, assignment_id FROM referrals').all()
    .map((r) => `${r.student_id}:${r.assignment_id}`));
  const extensions = new Map(db.prepare('SELECT id, student_id, assignment_id, lessons, note FROM extensions').all()
    .map((e) => [`${e.student_id}:${e.assignment_id}`, e]));

  const lateWork = [];
  const feedbackOwed = [];
  const courses = currentCourses(db, courseId);
  for (const c of courses) {
    const students = roster(db, c.id);
    for (const a of pastDueAssignments(db, c.id, today)) {
      if (!a.aligned && !formative) continue; // nothing to report for formative work
      const facts = assignmentFacts(db, a);
      const due = a.due_date.slice(0, 10);
      const targeted = students
        .filter((st) => !facts.assignees || facts.assignees.has(st.schoology_uid))
        .map((st) => ({ st, s: studentState(a, facts, st) }))
        .filter(({ s }) => !s.excused);
      // Decided over the whole targeted roster BEFORE the student filter, so a
      // one-student view (recordReferral, get_triage student) matches the dashboard.
      const tracked = tracksSubmissions(a, targeted);
      const states = studentId == null ? targeted : targeted.filter(({ st }) => st.id === Number(studentId));
      // No submission channel: everyone targeted handed it in on the due date
      // (paper / in class), so the grading backlog still shows.
      const handedInAtDue = a.accepts_submissions === 0;
      let owed = 0;
      let submittedTotal = 0;
      let oldestWaitDays = 0;
      let waitApprox = false;

      for (const { st, s } of states) {
        // Late work (summative only, and only work that takes submissions).
        if (a.aligned && tracked && !handled.has(`${st.id}:${a.id}`)) {
          // An extension moves this student's due date to the N-th school day
          // after it: hidden until then, late from then. dueDate stays original.
          const ext = extensions.get(`${st.id}:${a.id}`);
          const moved = ext ? cal.addSchoolDays(due, ext.lessons) : { date: due, approx: false };
          const effDue = moved.date;
          let row = null;
          if (!s.submitted && !s.scored) {
            const { days, approx } = cal.between(effDue, today);
            if (days >= 1) row = { kind: 'outstanding', daysLate: days, submittedOn: null, approx };
          } else if (s.firstSubmittedOn && s.late !== 0) {
            // Known limit: a submitted/scored pair with no first_submitted_at
            // (e.g. a paper assessment scored straight into mastery_scores,
            // no grades row) is never flagged late here — there is no
            // submission time to measure against, so it is treated as handed
            // in on time rather than falling back to a grade timestamp (which
            // would misflag every paper assessment graded >8 school days
            // after its due date). Schoology's late = 0 (on time, e.g. a
            // per-student extension) also clears it.
            const { days, approx } = cal.between(effDue, s.firstSubmittedOn);
            if (days >= referralLimitDays) row = { kind: 'submitted_late', daysLate: days, submittedOn: s.firstSubmittedOn, approx };
          }
          if (row) {
            lateWork.push({
              ...row,
              approx: row.approx || moved.approx,
              extension: ext ? { id: ext.id, lessons: ext.lessons, until: effDue, note: ext.note } : null,
              studentId: st.id, studentUid: st.schoology_uid, studentName: fullName(st),
              courseId: c.id, courseName: c.course_name, blockNumber: c.block_number ?? null,
              assignmentId: a.id, schoologyAssignmentId: a.schoology_assignment_id, title: a.title, dueDate: due,
              tone: toneFor(row.daysLate, referralLimitDays, warnLeadDays),
            });
          }
        }

        // Feedback owed.
        if (!handedInAtDue && !s.submitted && !s.scored) continue;
        submittedTotal++;
        if (s.grading === 'complete') continue;
        owed++;
        const start = !handedInAtDue && s.firstSubmittedOn && s.firstSubmittedOn > due ? s.firstSubmittedOn : due;
        const w = cal.between(start, today);
        oldestWaitDays = Math.max(oldestWaitDays, w.days);
        waitApprox = waitApprox || w.approx;
      }

      if (owed > 0) {
        feedbackOwed.push({
          assignmentId: a.id, schoologyAssignmentId: a.schoology_assignment_id,
          courseId: c.id, courseName: c.course_name, blockNumber: c.block_number ?? null, title: a.title, dueDate: due, aligned: !!a.aligned,
          owed, submittedTotal, oldestWaitDays,
          tone: toneFor(oldestWaitDays, feedbackLimitDays, warnLeadDays), approx: waitApprox,
        });
      }
    }
  }

  lateWork.sort((x, y) => y.daysLate - x.daysLate || x.studentName.localeCompare(y.studentName));
  feedbackOwed.sort((x, y) => y.oldestWaitDays - x.oldestWaitDays || x.title.localeCompare(y.title));

  // Referrals + extensions recorded in scope (the panel's history link).
  const courseIds = courses.map((c) => c.id);
  const inScope = courseIds.map(() => '?').join(',');
  const historyCount = courseIds.length
    ? db.prepare(`
        SELECT (SELECT COUNT(*) FROM referrals WHERE course_id IN (${inScope}))
             + (SELECT COUNT(*) FROM extensions WHERE course_id IN (${inScope})) AS n
      `).get(...courseIds, ...courseIds).n
    : 0;
  const last = db.prepare(`
    SELECT COALESCE(completed_at, started_at) AS at FROM sync_log
    WHERE status = 'completed' ORDER BY at DESC, id DESC LIMIT 1
  `).get();

  return {
    today,
    includeFormative: formative,
    settings,
    lastSyncAt: last?.at ?? null,
    historyCount,
    calendar: { source: cal.source, totalSchoolDays: cal.totalSchoolDays, syncedAt: cal.syncedAt, today: cal.info(today) },
    counts: {
      atReferralLimit: lateWork.filter((r) => r.tone === 'red').length,
      feedbackOverdue: feedbackOwed.filter((r) => r.tone === 'red').length,
    },
    approx: lateWork.some((r) => r.approx) || feedbackOwed.some((r) => r.approx),
    lateWork,
    feedbackOwed,
  };
}

export function listReferrals(db, { courseId = null, studentId = null, since = null, id = null } = {}) {
  return db.prepare(`
    SELECT r.id, r.action, r.note, r.days_late AS daysLate, r.source, r.created_at AS createdAt,
           r.student_id AS studentId, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
           r.assignment_id AS assignmentId, a.schoology_assignment_id AS schoologyAssignmentId, a.title,
           substr(a.due_date, 1, 10) AS dueDate, r.course_id AS courseId, c.course_name AS courseName,
           c.block_number AS blockNumber
    FROM referrals r
    JOIN students s ON s.id = r.student_id
    JOIN assignments a ON a.id = r.assignment_id
    JOIN courses c ON c.id = r.course_id
    WHERE (? IS NULL OR r.id = ?) AND (? IS NULL OR r.course_id = ?)
      AND (? IS NULL OR r.student_id = ?) AND (? IS NULL OR date(r.created_at, 'localtime') >= ?)
    ORDER BY r.created_at DESC, r.id DESC
  `).all(id, id, courseId, courseId, studentId, studentId, since, since)
    .map(({ first_name, last_name, preferred_name, preferred_name_teacher, ...r }) => ({
      ...r,
      studentName: `${preferredFirstName({ first_name, preferred_name, preferred_name_teacher })} ${last_name}`,
    }));
}

function requireStudent(db, studentId) {
  const sid = Number(studentId);
  const st = Number.isInteger(sid) && sid > 0
    ? db.prepare('SELECT id, schoology_uid FROM students WHERE id = ?').get(sid)
    : null;
  if (!st) throw new TriageError('NOT_FOUND', `No student with id ${studentId}`);
  return st;
}

// Referral = the at-limit action ('referred' only; a per-student extension is
// recordExtension, a true exemption is Schoology's Excused flag).
export function recordReferral(db, { studentId, assignmentId, action, note = null, source = 'app', today = todayLocal() } = {}) {
  if (action !== 'referred') {
    throw new TriageError('BAD_ACTION', `action must be 'referred' (to extend a deadline, record an extension)`);
  }
  const sid = requireStudent(db, studentId).id;
  const a = db.prepare('SELECT id, course_id FROM assignments WHERE id = ?').get(Number(assignmentId));
  if (!a) throw new TriageError('NOT_FOUND', `No assignment with id ${assignmentId}`);
  const row = getTriage(db, { courseId: a.course_id, studentId: sid, includeFormative: false, today })
    .lateWork.find((r) => r.studentId === sid && r.assignmentId === a.id);
  if (!row) throw new TriageError('NOT_ON_LIST', 'That student and assignment are not on the late-work list');
  if (row.tone !== 'red') {
    throw new TriageError('NOT_AT_LIMIT', `Not at the referral limit yet (${row.daysLate} school days late) — extend the deadline instead, or wait`);
  }
  let id;
  try {
    id = db.prepare(`
      INSERT INTO referrals (student_id, assignment_id, course_id, action, note, days_late, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sid, a.id, a.course_id, action, note || null, row.daysLate, source).lastInsertRowid;
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT') {
      throw new TriageError('NOT_ON_LIST', 'That student and assignment already has a referral record');
    }
    throw err;
  }
  return listReferrals(db, { id })[0];
}

export function undoReferral(db, id) {
  return { deleted: db.prepare('DELETE FROM referrals WHERE id = ?').run(Number(id)).changes > 0 };
}

export const MAX_EXTENSION_LESSONS = 60;

export function listExtensions(db, { courseId = null, studentId = null, since = null, id = null } = {}) {
  const cal = loadCalendar(db);
  return db.prepare(`
    SELECT x.id, x.lessons, x.note, x.source, x.created_at AS createdAt,
           x.student_id AS studentId, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
           x.assignment_id AS assignmentId, a.schoology_assignment_id AS schoologyAssignmentId, a.title,
           substr(a.due_date, 1, 10) AS dueDate, x.course_id AS courseId, c.course_name AS courseName,
           c.block_number AS blockNumber
    FROM extensions x
    JOIN students s ON s.id = x.student_id
    JOIN assignments a ON a.id = x.assignment_id
    JOIN courses c ON c.id = x.course_id
    WHERE (? IS NULL OR x.id = ?) AND (? IS NULL OR x.course_id = ?)
      AND (? IS NULL OR x.student_id = ?) AND (? IS NULL OR date(x.created_at, 'localtime') >= ?)
    ORDER BY x.created_at DESC, x.id DESC
  `).all(id, id, courseId, courseId, studentId, studentId, since, since)
    .map(({ first_name, last_name, preferred_name, preferred_name_teacher, ...x }) => ({
      ...x,
      studentName: `${preferredFirstName({ first_name, preferred_name, preferred_name_teacher })} ${last_name}`,
      until: cal.addSchoolDays(x.dueDate, x.lessons).date,
    }));
}

// Extend one student's deadline by N lessons (school days). Any time — before
// or after the due date, at any tone — for a summative assignment in a current
// course that targets the student. Re-extending the pair replaces lessons/note.
export function recordExtension(db, { studentId, assignmentId, lessons, note = null, source = 'app' } = {}) {
  const st = requireStudent(db, studentId);
  const n = Number(lessons);
  if (lessons == null || lessons === '' || !Number.isInteger(n) || n < 1 || n > MAX_EXTENSION_LESSONS) {
    throw new TriageError('BAD_LESSONS', `lessons must be a whole number from 1 to ${MAX_EXTENSION_LESSONS}`);
  }
  const a = db.prepare(`
    SELECT a.id, a.course_id, a.due_date, a.num_assignees, c.archived, c.excluded, ${ALIGNED_SQL} AS aligned
    FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ?
  `).get(Number(assignmentId));
  if (!a) throw new TriageError('NOT_FOUND', `No assignment with id ${assignmentId}`);
  if (a.archived || a.excluded) throw new TriageError('NOT_ELIGIBLE', 'That assignment is not in a current course');
  if (!a.aligned) throw new TriageError('NOT_ELIGIBLE', 'Only summative work can be extended');
  if (!a.due_date) throw new TriageError('NOT_ELIGIBLE', 'That assignment has no due date to extend');
  const enrolled = db.prepare('SELECT 1 FROM enrolments WHERE student_id = ? AND course_id = ? AND dropped_at IS NULL').get(st.id, a.course_id);
  const assigned = !(a.num_assignees > 0)
    || db.prepare('SELECT 1 FROM assignment_assignees WHERE assignment_id = ? AND schoology_uid = ?').get(a.id, st.schoology_uid);
  if (!enrolled || !assigned) throw new TriageError('NOT_ELIGIBLE', 'That assignment does not target that student');
  db.prepare(`
    INSERT INTO extensions (student_id, assignment_id, course_id, lessons, note, source) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (student_id, assignment_id) DO UPDATE SET lessons = excluded.lessons, note = excluded.note
  `).run(st.id, a.id, a.course_id, n, note || null, source);
  const { id } = db.prepare('SELECT id FROM extensions WHERE student_id = ? AND assignment_id = ?').get(st.id, a.id);
  return listExtensions(db, { id })[0];
}

export function undoExtension(db, id) {
  return { deleted: db.prepare('DELETE FROM extensions WHERE id = ?').run(Number(id)).changes > 0 };
}
