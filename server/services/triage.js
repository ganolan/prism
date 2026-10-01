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

// Published assignments whose due date has passed (due date before today).
function pastDueAssignments(db, courseId, today) {
  return db.prepare(`
    SELECT a.id, a.course_id, a.schoology_assignment_id, a.title, a.due_date, a.is_lti_submission, a.num_assignees,
      a.accepts_submissions,
      CASE WHEN EXISTS (
        SELECT 1 FROM mastery_alignments ma WHERE ma.assignment_schoology_id = a.schoology_assignment_id
        UNION
        SELECT 1 FROM mastery_scores ms WHERE ms.assignment_schoology_id = a.schoology_assignment_id
      ) THEN 1 ELSE 0 END AS aligned
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

  const lateWork = [];
  const feedbackOwed = [];
  const courses = currentCourses(db, courseId);
  for (const c of courses) {
    const students = roster(db, c.id).filter((st) => studentId == null || st.id === Number(studentId));
    for (const a of pastDueAssignments(db, c.id, today)) {
      if (!a.aligned && !formative) continue; // nothing to report for formative work
      const facts = assignmentFacts(db, a);
      const due = a.due_date.slice(0, 10);
      const states = students
        .filter((st) => !facts.assignees || facts.assignees.has(st.schoology_uid))
        .map((st) => ({ st, s: studentState(a, facts, st) }))
        .filter(({ s }) => !s.excused);
      const tracked = tracksSubmissions(a, states);
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
          let row = null;
          if (!s.submitted && !s.scored) {
            const { days, approx } = cal.between(due, today);
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
            const { days, approx } = cal.between(due, s.firstSubmittedOn);
            if (days >= referralLimitDays) row = { kind: 'submitted_late', daysLate: days, submittedOn: s.firstSubmittedOn, approx };
          }
          if (row) {
            lateWork.push({
              ...row,
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

  const courseIds = courses.map((c) => c.id);
  const referralCount = courseIds.length
    ? db.prepare(`SELECT COUNT(*) AS n FROM referrals WHERE course_id IN (${courseIds.map(() => '?').join(',')})`).get(...courseIds).n
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
    referralCount,
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

export function recordReferral(db, { studentId, assignmentId, action, note = null, source = 'app', today = todayLocal() } = {}) {
  if (action !== 'referred' && action !== 'exempt') {
    throw new TriageError('BAD_ACTION', `action must be 'referred' or 'exempt'`);
  }
  const sid = Number(studentId);
  if (!Number.isInteger(sid) || sid <= 0 || !db.prepare('SELECT id FROM students WHERE id = ?').get(sid)) {
    throw new TriageError('NOT_FOUND', `No student with id ${studentId}`);
  }
  const a = db.prepare('SELECT id, course_id FROM assignments WHERE id = ?').get(Number(assignmentId));
  if (!a) throw new TriageError('NOT_FOUND', `No assignment with id ${assignmentId}`);
  const row = getTriage(db, { courseId: a.course_id, studentId: sid, includeFormative: false, today })
    .lateWork.find((r) => r.studentId === sid && r.assignmentId === a.id);
  if (!row) throw new TriageError('NOT_ON_LIST', 'That student and assignment are not on the late-work list');
  // Referral is the at-limit action; an exemption (e.g. an agreed extension) can be recorded early.
  if (action === 'referred' && row.tone !== 'red') {
    throw new TriageError('NOT_AT_LIMIT', `Not at the referral limit yet (${row.daysLate} school days late) — record 'exempt' instead, or wait`);
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
