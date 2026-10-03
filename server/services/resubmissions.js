// Triage resubmissions (docs/superpowers/specs/2026-10-03-triage-resubmissions-design.md).
// Persistence + actions for asks ('request') and "Reviewed" marks ('review'), and
// the per-pair lookups the gradebook / assessment page / PrisMCP read. State rules
// live in server/lib/resubmission.js; the triage list rows in resubmissionRows().
import { loadCalendar } from './schoolCalendar.js';
import { getTriageSettings } from './settings.js';
import { preferredFirstName } from './studentNames.js';
import { TriageError, MAX_EXTENSION_LESSONS, toneFor, ALIGNED_SQL, fullName } from './triageCommon.js';
import { resubmissionState, sqliteUtcToEpoch } from '../lib/resubmission.js';
import { epochToLocalDate } from '../lib/schoolDays.js';

const OPEN_REQUEST = `kind = 'request' AND status = 'open'`;

function checkLessons(lessons) {
  const n = Number(lessons);
  if (!Number.isInteger(n) || n < 1 || n > MAX_EXTENSION_LESSONS) {
    throw new TriageError('BAD_LESSONS', `lessons must be a whole number from 1 to ${MAX_EXTENSION_LESSONS}`);
  }
  return n;
}

// A current-course assignment that targets an enrolled student.
function eligiblePair(db, studentId, assignmentId) {
  const st = db.prepare('SELECT id, schoology_uid FROM students WHERE id = ?').get(Number(studentId));
  if (!st) throw new TriageError('NOT_FOUND', `No student with id ${studentId}`);
  const a = db.prepare(`
    SELECT a.id, a.course_id, a.num_assignees, c.archived, c.excluded
    FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ?
  `).get(Number(assignmentId));
  if (!a) throw new TriageError('NOT_FOUND', `No assignment with id ${assignmentId}`);
  if (a.archived || a.excluded) throw new TriageError('NOT_ELIGIBLE', 'That assignment is not in a current course');
  const enrolled = db.prepare('SELECT 1 FROM enrolments WHERE student_id = ? AND course_id = ? AND dropped_at IS NULL').get(st.id, a.course_id);
  const assigned = !(a.num_assignees > 0)
    || db.prepare('SELECT 1 FROM assignment_assignees WHERE assignment_id = ? AND schoology_uid = ?').get(a.id, st.schoology_uid);
  if (!enrolled || !assigned) throw new TriageError('NOT_ELIGIBLE', 'That assignment does not target that student');
  return { student: st, assignment: a };
}

// The grade row, open request and newest review for one pair.
export function pairContext(db, studentId, assignmentId) {
  const grade = db.prepare(`
    SELECT score, exception, grade_comment, submitted_at, latest_revision_at, first_submitted_at, lti_submission_state
    FROM grades WHERE student_id = ? AND assignment_id = ?
  `).get(studentId, assignmentId) || {};
  const request = db.prepare(`SELECT * FROM resubmissions WHERE student_id = ? AND assignment_id = ? AND ${OPEN_REQUEST}`).get(studentId, assignmentId) || null;
  const reviewedThrough = db.prepare(`
    SELECT COALESCE(MAX(revision_at), 0) AS t FROM resubmissions WHERE student_id = ? AND assignment_id = ? AND kind = 'review'
  `).get(studentId, assignmentId).t;
  return { grade, request, reviewedThrough };
}

const stateOf = ({ grade, request, reviewedThrough }) =>
  resubmissionState(grade, { requestedAt: request ? sqliteUtcToEpoch(request.requested_at) : 0, reviewedThrough });

function outcomeOf(r) {
  if (r.kind === 'review') return 'reviewed';
  return { open: 'asked', closed: 'closed', done: 'done' }[r.status];
}

export function listResubmissions(db, { courseId = null, studentId = null, since = null, id = null } = {}) {
  const cal = loadCalendar(db);
  return db.prepare(`
    SELECT r.*, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
           a.schoology_assignment_id, a.title, substr(a.due_date, 1, 10) AS due_date_only,
           c.course_name, c.block_number
    FROM resubmissions r
    JOIN students s ON s.id = r.student_id
    JOIN assignments a ON a.id = r.assignment_id
    JOIN courses c ON c.id = r.course_id
    WHERE (? IS NULL OR r.id = ?) AND (? IS NULL OR r.course_id = ?) AND (? IS NULL OR r.student_id = ?)
      AND (? IS NULL OR date(COALESCE(r.updated_at, r.closed_at, r.created_at), 'localtime') >= ?)
    ORDER BY COALESCE(r.updated_at, r.closed_at, r.created_at) DESC, r.id DESC
  `).all(id, id, courseId, courseId, studentId, studentId, since, since).map((r) => {
    const requestedOn = r.requested_at ? epochToLocalDate(sqliteUtcToEpoch(r.requested_at)) : null;
    return {
      id: r.id, kind: r.kind, status: r.status, outcome: outcomeOf(r),
      studentId: r.student_id,
      studentName: `${preferredFirstName(r)} ${r.last_name}`,
      assignmentId: r.assignment_id, schoologyAssignmentId: r.schoology_assignment_id, title: r.title,
      dueDate: r.due_date_only, courseId: r.course_id, courseName: r.course_name, blockNumber: r.block_number ?? null,
      requestedAt: r.requested_at, requestedOn, lessons: r.lessons,
      until: requestedOn && r.lessons ? cal.addSchoolDays(requestedOn, r.lessons).date : null,
      note: r.note, source: r.source, revisionAt: r.revision_at,
      closedAt: r.closed_at, closeNote: r.close_note, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  });
}

export function requestResubmission(db, { studentId, assignmentId, lessons = null, note = null, source = 'app', requestedAt = null } = {}) {
  const { student, assignment } = eligiblePair(db, studentId, assignmentId);
  const n = lessons == null || lessons === '' ? getTriageSettings(db).resubmitLessonsDefault : checkLessons(lessons);
  try {
    const id = db.prepare(`
      INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons, note, source)
      VALUES (?, ?, ?, 'request', 'open', COALESCE(?, datetime('now')), ?, ?, ?)
    `).run(student.id, assignment.id, assignment.course_id, requestedAt, n, note || null, source).lastInsertRowid;
    return listResubmissions(db, { id })[0];
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      throw new TriageError('ALREADY_OPEN', 'That student already has an open resubmission request for this assessment');
    }
    throw err;
  }
}

function openRequest(db, id) {
  const r = db.prepare('SELECT * FROM resubmissions WHERE id = ?').get(Number(id));
  if (!r) throw new TriageError('NOT_FOUND', `No resubmission record with id ${id}`);
  if (r.kind !== 'request' || r.status !== 'open') throw new TriageError('NOT_ELIGIBLE', 'Only an open request can be changed');
  return r;
}

export function extendResubmission(db, id, lessons) {
  const r = openRequest(db, id);
  db.prepare(`UPDATE resubmissions SET lessons = ?, updated_at = datetime('now') WHERE id = ?`).run(checkLessons(lessons), r.id);
  return listResubmissions(db, { id: r.id })[0];
}

export function closeResubmission(db, id, note = null) {
  const r = openRequest(db, id);
  db.prepare(`UPDATE resubmissions SET status = 'closed', closed_at = datetime('now'), close_note = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(note || null, r.id);
  return listResubmissions(db, { id: r.id })[0];
}

export function markResubmissionReviewed(db, { studentId, assignmentId, source = 'app' } = {}) {
  const { student, assignment } = eligiblePair(db, studentId, assignmentId);
  const ctx = pairContext(db, student.id, assignment.id);
  if (stateOf(ctx) !== 'arrived') throw new TriageError('NOT_ON_LIST', 'No resubmission has arrived for that student and assessment');
  const revisionAt = Number(ctx.grade.latest_revision_at) || 0;
  const id = db.transaction(() => {
    const newId = db.prepare(`
      INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, revision_at, source, closed_at)
      VALUES (?, ?, ?, 'review', 'done', ?, ?, datetime('now'))
    `).run(student.id, assignment.id, assignment.course_id, revisionAt, source).lastInsertRowid;
    // The arrival answered the ask only if it came in after the ask.
    if (ctx.request && revisionAt > sqliteUtcToEpoch(ctx.request.requested_at)) {
      db.prepare(`UPDATE resubmissions SET status = 'done', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(ctx.request.id);
    }
    return newId;
  })();
  return listResubmissions(db, { id })[0];
}

export function undoResubmission(db, id) {
  return { deleted: db.prepare('DELETE FROM resubmissions WHERE id = ?').run(Number(id)).changes > 0 };
}

// Mark open requests whose resubmission has been regraded/reviewed as done.
export function settleResubmissions(db, { assignmentId = null } = {}) {
  const open = db.prepare(`SELECT id, student_id, assignment_id FROM resubmissions WHERE ${OPEN_REQUEST} AND (? IS NULL OR assignment_id = ?)`)
    .all(assignmentId, assignmentId);
  const done = db.prepare(`UPDATE resubmissions SET status = 'done', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`);
  let n = 0;
  for (const r of open) {
    if (stateOf(pairContext(db, r.student_id, r.assignment_id)) === 'fulfilled') { done.run(r.id); n++; }
  }
  return n;
}

// student id → { state, request } for one assessment (local id) — the assessment
// page, get_assignment_context. Students with nothing to show are absent.
export function resubmissionByStudent(db, assignmentId) {
  const ids = db.prepare(`
    SELECT student_id FROM grades WHERE assignment_id = ? AND latest_revision_at > 0
    UNION SELECT student_id FROM resubmissions WHERE assignment_id = ?
  `).all(assignmentId, assignmentId).map((r) => r.student_id);
  const out = new Map();
  for (const sid of ids) {
    const ctx = pairContext(db, sid, assignmentId);
    const state = stateOf(ctx);
    if (state === null || state === 'fulfilled') continue;
    out.set(sid, { state, request: ctx.request ? listResubmissions(db, { id: ctx.request.id })[0] : null });
  }
  return out;
}

// 'studentId:assignmentId' pairs with an open request in a course — the gradebook tint.
export function openRequestKeys(db, courseId) {
  return new Set(db.prepare(`SELECT student_id, assignment_id FROM resubmissions WHERE course_id = ? AND ${OPEN_REQUEST}`)
    .all(courseId).map((r) => `${r.student_id}:${r.assignment_id}`));
}

// Triage rows for one current course. Requests show whatever the alignment;
// unrequested arrivals follow Feedback owed (summative, or formative when shown).
export function resubmissionRows(db, { course, students, cal, today, settings, formative, studentId = null }) {
  const { feedbackLimitDays, warnLeadDays } = settings;
  const assignments = new Map(db.prepare(`
    SELECT a.id, a.schoology_assignment_id, a.title, a.num_assignees, ${ALIGNED_SQL} AS aligned
    FROM assignments a WHERE a.course_id = ? AND a.published = 1
  `).all(course.id).map((a) => [a.id, a]));
  const grades = new Map(db.prepare(`
    SELECT g.student_id, g.assignment_id, g.score, g.exception, g.grade_comment, g.submitted_at, g.latest_revision_at
    FROM grades g JOIN assignments a ON a.id = g.assignment_id WHERE a.course_id = ?
  `).all(course.id).map((g) => [`${g.student_id}:${g.assignment_id}`, g]));
  const requests = new Map(db.prepare(`SELECT * FROM resubmissions WHERE course_id = ? AND ${OPEN_REQUEST}`)
    .all(course.id).map((r) => [`${r.student_id}:${r.assignment_id}`, r]));
  const reviewed = new Map(db.prepare(`
    SELECT student_id, assignment_id, MAX(revision_at) AS t FROM resubmissions WHERE course_id = ? AND kind = 'review' GROUP BY 1, 2
  `).all(course.id).map((r) => [`${r.student_id}:${r.assignment_id}`, r.t]));
  const assigneesOf = (a) => (a.num_assignees > 0
    ? new Set(db.prepare('SELECT schoology_uid FROM assignment_assignees WHERE assignment_id = ?').all(a.id).map((r) => r.schoology_uid))
    : null);
  const assigneeCache = new Map();

  const rows = [];
  for (const st of students) {
    if (studentId != null && st.id !== Number(studentId)) continue;
    for (const a of assignments.values()) {
      const key = `${st.id}:${a.id}`;
      const grade = grades.get(key);
      const request = requests.get(key) || null;
      if (!request && !(grade?.latest_revision_at > 0)) continue;
      if (Number(grade?.exception) === 1) continue; // excused
      if (!request && !a.aligned && !formative) continue;
      if (!assigneeCache.has(a.id)) assigneeCache.set(a.id, assigneesOf(a));
      const assignees = assigneeCache.get(a.id);
      if (assignees && !assignees.has(st.schoology_uid)) continue;
      const requestedAt = request ? sqliteUtcToEpoch(request.requested_at) : 0;
      const state = resubmissionState(grade, { requestedAt, reviewedThrough: reviewed.get(key) || 0 });
      if (state !== 'waiting' && state !== 'arrived') continue;

      const requestedOn = request ? epochToLocalDate(requestedAt) : null;
      const until = request ? cal.addSchoolDays(requestedOn, request.lessons) : null;
      const arrivedOn = state === 'arrived' ? epochToLocalDate(grade.latest_revision_at) : null;
      const start = state === 'arrived' ? arrivedOn : requestedOn;
      const { days, approx } = cal.between(start, today);
      // Waiting: the deadline `until` is the last allowed date → last allowed day = lessons + 1.
      const limit = state === 'arrived' ? feedbackLimitDays : request.lessons + 1;
      rows.push({
        id: request?.id ?? null, state,
        studentId: st.id, studentUid: st.schoology_uid, studentName: fullName(st),
        courseId: course.id, courseName: course.course_name, blockNumber: course.block_number ?? null,
        assignmentId: a.id, schoologyAssignmentId: a.schoology_assignment_id, title: a.title, aligned: !!a.aligned,
        day: days + 1, limit, tone: toneFor(days, limit, warnLeadDays), approx: approx || !!until?.approx,
        lessons: request?.lessons ?? null, until: until?.date ?? null, requestedOn, arrivedOn,
        source: request?.source ?? null, note: request?.note ?? null,
        afterDeadline: !!(request && arrivedOn && arrivedOn > until.date),
      });
    }
  }
  return rows;
}
