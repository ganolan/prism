// Triage resubmissions (docs/superpowers/specs/2026-10-03-triage-resubmissions-design.md).
// Persistence + actions for asks ('request' rows), and the per-pair lookups the
// gradebook / assessment page / PrisMCP read. State comes from visible-feedback
// snapshots (Amendment B; server/services/feedbackSnapshots.js) via
// resubmissionStateFromSnapshot in server/lib/resubmission.js; the triage list rows
// in resubmissionRows(). "Reviewed" marks were removed in Amendment B — an arrival
// only clears when the visible feedback changes.
import { loadCalendar } from './schoolCalendar.js';
import { getTriageSettings } from './settings.js';
import { preferredFirstName } from './studentNames.js';
import { TriageError, MAX_EXTENSION_LESSONS, toneFor, ALIGNED_SQL, fullName } from './triageCommon.js';
import { resubmissionStateFromSnapshot, sqliteUtcToEpoch } from '../lib/resubmission.js';
import { epochToLocalDate, todayLocal } from '../lib/schoolDays.js';
import { currentFingerprints, snapshotMap, EMPTY_FINGERPRINT } from './feedbackSnapshots.js';

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

// The grade row, open request, feedback snapshot and current visible-feedback
// fingerprint for one pair.
export function pairContext(db, studentId, assignmentId) {
  const sid = Number(studentId);
  const aid = Number(assignmentId);
  const key = `${sid}:${aid}`;
  const current = currentFingerprints(db, { studentId: sid, assignmentId: aid }).get(key);
  const request = db.prepare(`SELECT * FROM resubmissions WHERE student_id = ? AND assignment_id = ? AND ${OPEN_REQUEST}`).get(sid, aid) || null;
  const snapshot = snapshotMap(db, { studentId: sid, assignmentId: aid }).get(key) || null;
  return { grade: current?.grade || {}, request, snapshot, currentFingerprint: current?.fingerprint ?? EMPTY_FINGERPRINT };
}

// 'arrived' | 'waiting' | 'fulfilled' | null — see resubmissionStateFromSnapshot.
const stateOf = ({ request, snapshot, currentFingerprint }) => resubmissionStateFromSnapshot({
  snapshot, currentFingerprint: currentFingerprint ?? EMPTY_FINGERPRINT,
  requestedAt: request ? sqliteUtcToEpoch(request.requested_at) : 0,
});

// closed: 'grade_stands' (gradeStands), 'undone' (an auto-added request undone),
// 'closed' (anything else, e.g. archived-course migration). Legacy 'review' rows
// (pre-Amendment B dev DBs) have status 'done' → 'done'.
function outcomeOf(r) {
  if (r.status === 'closed') {
    if (r.close_note === 'grade stands') return 'grade_stands';
    return r.close_note === 'Undone' ? 'undone' : 'closed';
  }
  return { open: 'asked', done: 'done' }[r.status];
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

// "Grade stands": ends an open request that is still Waiting after its deadline
// (the row is red — today after `until`). Before that → NOT_AT_DEADLINE (extend
// instead); once a resubmission has arrived → NOT_ELIGIBLE (give feedback instead).
export function gradeStands(db, id, { today = todayLocal() } = {}) {
  const r = openRequest(db, id);
  if (stateOf(pairContext(db, r.student_id, r.assignment_id)) !== 'waiting') {
    throw new TriageError('NOT_ELIGIBLE', 'A resubmission has arrived — give feedback instead');
  }
  const until = listResubmissions(db, { id: r.id })[0].until;
  if (!until || !(today > until)) {
    throw new TriageError('NOT_AT_DEADLINE', `The resubmission deadline (${until}) has not passed yet`);
  }
  db.prepare(`UPDATE resubmissions SET status = 'closed', closed_at = datetime('now'), close_note = 'grade stands', updated_at = datetime('now') WHERE id = ?`)
    .run(r.id);
  return listResubmissions(db, { id: r.id })[0];
}

// Undo one history record.
// - A request the sync auto-added from a Schoology unsubmit is closed ("Undone"),
//   never deleted: the closed row is what stops recordSchoologyUnsubmit re-adding
//   it on the next sync while the work still sits "in progress".
// - Anything else is deleted.
export function undoResubmission(db, id) {
  const r = db.prepare('SELECT * FROM resubmissions WHERE id = ?').get(Number(id));
  if (!r) return { deleted: false };
  if (r.kind === 'request' && r.source === 'schoology_unsubmit') {
    if (r.status === 'open') {
      db.prepare(`UPDATE resubmissions SET status = 'closed', close_note = 'Undone', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(r.id);
    }
    return { deleted: false, closed: true };
  }
  db.prepare('DELETE FROM resubmissions WHERE id = ?').run(r.id);
  return { deleted: true };
}

// Sync (LTI pass): graded work Prism saw submitted that is back "in progress" was
// unsubmitted in Schoology → an open request (deadline = the default lessons from
// now). Students graded without ever submitting are skipped (first_submitted_at = 0).
export function recordSchoologyUnsubmit(db, { studentId, assignmentId, requestedAt = null }) {
  const live = db.prepare(`
    SELECT 1 FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ? AND c.archived = 0 AND c.excluded = 0
  `).get(assignmentId);
  if (!live) return false;
  const { grade, request } = pairContext(db, studentId, assignmentId);
  if (request) return false;
  if (grade.lti_submission_state !== 'in_progress') return false;
  if (grade.score == null || (Number(grade.exception) || 0) !== 0) return false;
  if (!(Number(grade.first_submitted_at) > 0)) return false;
  // One auto-add per unsubmit episode: if any request for this pair (open or
  // closed) was already made at/after the current latest submission, a newer
  // submission hasn't arrived since — don't re-add on the next sync just
  // because the no-show is still sitting "in progress" (review finding: closing
  // the request must not have it reappear).
  const latestRevisionAt = Number(grade.latest_revision_at) || 0;
  const priorRequests = db.prepare(`
    SELECT requested_at FROM resubmissions WHERE student_id = ? AND assignment_id = ? AND kind = 'request'
  `).all(studentId, assignmentId);
  if (priorRequests.some((r) => sqliteUtcToEpoch(r.requested_at) >= latestRevisionAt)) return false;
  const courseId = db.prepare('SELECT course_id FROM assignments WHERE id = ?').get(assignmentId).course_id;
  db.prepare(`
    INSERT OR IGNORE INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons, source)
    VALUES (?, ?, ?, 'request', 'open', COALESCE(?, datetime('now')), ?, 'schoology_unsubmit')
  `).run(studentId, assignmentId, courseId, requestedAt, getTriageSettings(db).resubmitLessonsDefault);
  return true;
}

// Mark open requests whose post-ask resubmission has new visible feedback as done.
export function settleResubmissions(db, { assignmentId = null, courseId = null } = {}) {
  const done = db.prepare(`UPDATE resubmissions SET status = 'done', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`);
  let n = 0;
  for (const { state, request } of statesInScope(db, { assignmentId, courseId }).values()) {
    if (request && state === 'fulfilled') { done.run(request.id); n++; }
  }
  return n;
}

// Per-pair state for every pair in scope that could be on a list: an open request
// or a recorded arrival. 'sid:aid' → { state, request (raw row | null), snapshot }.
function statesInScope(db, scope) {
  const { courseId = null, studentId = null, assignmentId = null } = scope;
  const current = currentFingerprints(db, scope);
  const snapshots = snapshotMap(db, scope);
  const requests = new Map(db.prepare(`
    SELECT * FROM resubmissions
    WHERE ${OPEN_REQUEST} AND (? IS NULL OR course_id = ?) AND (? IS NULL OR student_id = ?) AND (? IS NULL OR assignment_id = ?)
  `).all(courseId, courseId, studentId, studentId, assignmentId, assignmentId).map((r) => [`${r.student_id}:${r.assignment_id}`, r]));
  const keys = new Set([...requests.keys()]);
  for (const [k, snap] of snapshots) if (snap.arrival_revision_at > 0) keys.add(k);
  const out = new Map();
  for (const k of keys) {
    const ctx = { request: requests.get(k) || null, snapshot: snapshots.get(k) || null, currentFingerprint: current.get(k)?.fingerprint };
    out.set(k, { state: stateOf(ctx), request: ctx.request, snapshot: ctx.snapshot, grade: current.get(k)?.grade || null });
  }
  return out;
}

// student id → { state, request } for one assessment (local id) — the assessment
// page, get_assignment_context. Students with nothing to show are absent.
export function resubmissionByStudent(db, assignmentId) {
  const out = new Map();
  for (const [k, { state, request }] of statesInScope(db, { assignmentId: Number(assignmentId) })) {
    if (state === null || state === 'fulfilled') continue;
    out.set(Number(k.split(':')[0]), { state, request: request ? listResubmissions(db, { id: request.id })[0] : null });
  }
  return out;
}

// 'studentId:assignmentId' pairs whose state is 'arrived' (requested or not) — the
// ↩/⚠ "resubmitted" badge on the gradebook, assessment card and student page.
// Scope by whichever of courseId / studentId / assignmentId the caller has.
export function arrivedKeys(db, { courseId = null, studentId = null, assignmentId = null } = {}) {
  const out = new Set();
  for (const [k, { state }] of statesInScope(db, { courseId, studentId, assignmentId })) if (state === 'arrived') out.add(k);
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
  const states = statesInScope(db, { courseId: course.id });
  const assigneesOf = (a) => (a.num_assignees > 0
    ? new Set(db.prepare('SELECT schoology_uid FROM assignment_assignees WHERE assignment_id = ?').all(a.id).map((r) => r.schoology_uid))
    : null);
  const assigneeCache = new Map();

  const rows = [];
  for (const st of students) {
    if (studentId != null && st.id !== Number(studentId)) continue;
    for (const a of assignments.values()) {
      const pair = states.get(`${st.id}:${a.id}`);
      if (!pair) continue;
      const { state, request, snapshot, grade } = pair;
      if (state !== 'waiting' && state !== 'arrived') continue;
      if (Number(grade?.exception) === 1) continue; // excused
      if (!request && !a.aligned && !formative) continue;
      if (!assigneeCache.has(a.id)) assigneeCache.set(a.id, assigneesOf(a));
      const assignees = assigneeCache.get(a.id);
      if (assignees && !assignees.has(st.schoology_uid)) continue;
      const requestedOn = request ? epochToLocalDate(sqliteUtcToEpoch(request.requested_at)) : null;
      const until = request ? cal.addSchoolDays(requestedOn, request.lessons) : null;
      const arrivedOn = state === 'arrived' ? epochToLocalDate(snapshot.arrival_revision_at) : null;
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
