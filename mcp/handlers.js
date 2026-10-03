// Pure data handlers for PrisMCP tools. Each takes an open better-sqlite3 db
// and returns plain data; mcp/server.js wraps them in thin registerTool
// callbacks. Kept separate so they unit-test directly against a :memory: DB,
// mirroring the server/**/*.test.js pattern.

import { listRubrics, getRubricByName, saveRubric, findRubricByContentHash } from '../server/services/rubricStore.js';
import { hashRubricContent } from '../server/services/rubricHash.js';
import { attachRubric } from '../server/services/rubricAttach.js';
import { LEVELS } from '../server/lib/proficiencyScale.js';
import { normalizeSubmissionStatus, gradingState, getRoster, scoreScaleFor } from '../server/services/assessmentContext.js';
import { preferredFirstName } from '../server/services/studentNames.js';
import {
  getTriage, listReferrals, recordReferral, undoReferral, listExtensions, recordExtension, undoExtension, setMakeUpIgnored,
} from '../server/services/triage.js';
import {
  requestResubmission, extendResubmission, closeResubmission, markResubmissionReviewed, listResubmissions,
} from '../server/services/resubmissions.js';
import { loadCalendar } from '../server/services/schoolCalendar.js';
import { todayLocal } from '../server/lib/schoolDays.js';

// Active courses = not archived, not excluded, not hidden. Mirrors the
// 'current' view in server/routes/courses.js, plus the excluded filter (#56,
// spec §3.1).
export function listCourses(db) {
  return db.prepare(`
    SELECT id, course_name, section_name, course_code, schoology_section_id, block_number
    FROM courses
    WHERE archived = 0 AND excluded = 0 AND hidden = 0
    ORDER BY course_name
  `).all();
}

// Per-assignment readiness rollup. Submission: LTI uses lti_submission_state,
// non-LTI collapses to submitted/not_started. Grading: all aligned topics
// levelled + a comment => complete; nothing => ungraded; otherwise partial
// (excepted => complete). Computed in JS over the grade rows for clarity.
function assignmentCounts(db, assignmentRow) {
  const topicsCount = db.prepare(`
    SELECT COUNT(*) AS n FROM mastery_alignments WHERE assignment_schoology_id = ? AND course_id = ?
  `).get(assignmentRow.schoology_assignment_id, assignmentRow.course_id).n;
  const scoredByUid = {};
  for (const r of db.prepare(`SELECT student_uid, COUNT(*) AS n FROM mastery_scores WHERE assignment_schoology_id = ? GROUP BY student_uid`).all(assignmentRow.schoology_assignment_id)) {
    scoredByUid[r.student_uid] = r.n;
  }
  const rows = db.prepare(`
    SELECT s.schoology_uid, g.lti_submission_state, g.submission_type, g.submitted_at,
           g.grade_comment, g.exception
    FROM grades g JOIN students s ON s.id = g.student_id
    WHERE g.assignment_id = ?
  `).all(assignmentRow.id);
  const submission = { submitted: 0, in_progress: 0, not_started: 0, unknown: 0, total: rows.length };
  const grading = { ungraded: 0, partial: 0, complete: 0 };
  for (const r of rows) {
    const ss = normalizeSubmissionStatus({
      is_lti_submission: assignmentRow.is_lti_submission,
      lti_submission_state: r.lti_submission_state,
      submission_type: r.submission_type,
      submitted_at: r.submitted_at,
    });
    submission[ss] = (submission[ss] ?? 0) + 1;
    const gs = gradingState({
      scoredCount: scoredByUid[r.schoology_uid] || 0,
      topicsCount,
      hasComment: (r.grade_comment || '').trim().length > 0,
      exception: r.exception ?? 0,
    });
    grading[gs] += 1; // gradingState returns exactly 'ungraded' | 'partial' | 'complete'
  }
  return { submission_counts: submission, grading_counts: grading };
}

// Assignments for a course (local course id), so a phrase like "the MAD
// project I just collected" can resolve to a concrete assignment (spec §3.1).
export function listAssignments(db, { course_id }) {
  const rows = db.prepare(`
    SELECT a.id, a.schoology_assignment_id, a.title, a.due_date, a.assignment_type, a.is_lti_submission, a.course_id, a.grading_scale_id,
           EXISTS (
             SELECT 1 FROM mastery_alignments ma
             WHERE ma.assignment_schoology_id = a.schoology_assignment_id
               AND ma.course_id = a.course_id
           ) AS has_aligned_topics,
           (SELECT MAX(CASE WHEN a.is_lti_submission = 1 THEN g.latest_revision_at ELSE g.submitted_at END)
              FROM grades g WHERE g.assignment_id = a.id) AS latest_submitted_at
    FROM assignments a
    WHERE a.course_id = ?
    ORDER BY a.due_date, a.id
  `).all(Number(course_id));
  return rows.map(({ latest_submitted_at, course_id: _c, is_lti_submission, grading_scale_id, ...r }) => ({
    ...r,
    has_aligned_topics: !!r.has_aligned_topics,
    // Scale an unaligned assignment is graded on (#41) — grade those by
    // write_student_suggestions `scale_level`. null for rubric/other assignments.
    score_scale: scoreScaleFor({ grading_scale_id }, r.has_aligned_topics ? 1 : 0)?.name ?? null,
    // submitted_at/latest_revision_at are Unix-seconds epochs (0 = never submitted).
    // Native: submitted_at (the REST grade time) is the submission signal. LTI:
    // submitted_at is the REST grade time, not the submission — the grader's
    // submission time lives in latest_revision_at (triage resubmissions,
    // 2026-10-03), so the query above reads that column for LTI assignments.
    // Surface the latest as an ISO string, null when nobody has submitted.
    latest_submission_at: latest_submitted_at > 0 ? new Date(latest_submitted_at * 1000).toISOString() : null,
    ...assignmentCounts(db, { id: r.id, schoology_assignment_id: r.schoology_assignment_id, course_id: _c, is_lti_submission }),
  }));
}

// Course roster (current, non-dropped enrolments), independent of any
// assignment — so a class-list check (e.g. against a meeting attendance log)
// doesn't require resolving an assignment first. Reuses the same getRoster
// query get_assignment_context composes into its per-assignment roster.
export function listStudents(db, { course_id }) {
  return getRoster(db, Number(course_id)).map((st) => ({
    id: st.id,
    schoology_uid: st.schoology_uid,
    first_name: st.first_name,
    last_name: st.last_name,
    preferred_name: st.preferred_name,
    preferred_first_name: preferredFirstName(st),
    email: st.email ?? null,
  }));
}

// Portable rubric shape — ordered criteria, per-level descriptors, NO Prism ids
// (the JSON twin of exportRubricCsv; spec §6).
function toPortable(rubric) {
  return {
    name: rubric.name,
    criteria: rubric.criteria.map((c) => ({
      criterion_name: c.criterion_name,
      standard_title: c.standard_title,
      reporting_category: c.reporting_category,
      descriptors: Object.fromEntries(
        LEVELS.map((l) => [l, c.descriptors?.[l] ?? (l === 'IE' ? 'Insufficient Evidence' : null)])
      ),
    })),
  };
}

export function listRubricsTool(db) {
  // Name is the agent's handle — drop the local id.
  return listRubrics(db).map(({ name, source, criteria_count, updated_at }) =>
    ({ name, source, criteria_count, updated_at }));
}

export function readRubric(db, { name }) {
  const r = getRubricByName(db, name);
  return r ? toPortable(r) : null;
}

export function writeRubric(db, { name, criteria, on_name_conflict = 'prompt' }) {
  const content = { name, source: 'mcp', criteria: criteria.map((c, i) => ({ ...c, position: i + 1 })) };
  const criteria_count = criteria.length;

  const exact = findRubricByContentHash(db, hashRubricContent(content));
  if (exact) return { reused_existing: exact.name, match: 'exact', criteria_count };

  const named = getRubricByName(db, name);
  if (named) {
    if (on_name_conflict === 'update') { saveRubric(db, content, named.id); return { name, match: 'updated', criteria_count }; }
    if (on_name_conflict === 'new')    { saveRubric(db, content);          return { name, match: 'created_new', criteria_count }; }
    return {
      conflict: 'name',
      existing: name,
      existing_criteria_count: named.criteria.length,
      message: `A different rubric named "${name}" already exists. Re-call with on_name_conflict:"update" to replace it, or "new" to save a separate copy.`,
    };
  }

  saveRubric(db, content);
  return { name, match: 'created', criteria_count };
}

// Bind a library rubric (by name) to an assignment, auto-matching criteria to the
// assignment's measurement topics (the same path the modal uses). Reports the
// criteria that still need a topic so the agent can point the teacher at the
// Map-criteria tab (there is no topic-mapping MCP tool).
export function attachRubricTool(db, { rubric_name, assignment_id }) {
  const rubric = getRubricByName(db, rubric_name);
  if (!rubric) return { error: `rubric "${rubric_name}" not found` };
  const asg = db.prepare(`SELECT schoology_assignment_id, course_id FROM assignments WHERE id = ?`).get(Number(assignment_id));
  if (!asg) return { error: `assignment ${assignment_id} not found` };
  const { unmatched } = attachRubric(db, { rubricId: rubric.id, courseId: asg.course_id, assignmentId: asg.schoology_assignment_id });
  const nameById = Object.fromEntries(rubric.criteria.map((c) => [c.id, c.criterion_name]));
  return { attached_to: Number(assignment_id), rubric: rubric_name, unmatched_criteria: unmatched.map((id) => nameById[id] ?? `<criterion id=${id}>`) };
}

// ── Triage (late-work referral watch + feedback owed) ────────────────────────
// Same service as the dashboard (server/services/triage.js), so numbers match.

// A course reference: a local id, or a case-insensitive fragment of the course
// name or code, among current courses. null/'' → all courses. Sections of one
// course share a name, so errors list each candidate's id and block.
const courseCandidate = (c) => `${c.id} ${c.course_name}${c.block_number ? ` (Block ${c.block_number})` : ''}`;

export function resolveCourseRef(db, ref) {
  if (ref == null || ref === '') return null;
  const courses = db.prepare(`
    SELECT id, course_name, course_code, block_number FROM courses WHERE archived = 0 AND excluded = 0
    ORDER BY course_name, block_number, id
  `).all();
  if (/^\d+$/.test(String(ref))) {
    const hit = courses.find((c) => c.id === Number(ref));
    if (hit) return hit.id;
  }
  const q = String(ref).toLowerCase();
  const hits = courses.filter((c) => c.course_name.toLowerCase().includes(q) || (c.course_code || '').toLowerCase().includes(q));
  if (hits.length === 1) return hits[0].id;
  if (hits.length === 0) throw new Error(`No active course matches "${ref}" (current: ${courses.map(courseCandidate).join(', ')}) — pass a course id`);
  throw new Error(`"${ref}" matches several courses (${hits.map(courseCandidate).join(', ')}) — pass a course id`);
}

// A student reference: a local id, or a case-insensitive name fragment.
const matchesStudent = (r, student) =>
  String(r.studentId) === String(student) || r.studentName.toLowerCase().includes(String(student).toLowerCase());

export function getTriageTool(db, { course, student, include_formative } = {}) {
  const t = getTriage(db, { courseId: resolveCourseRef(db, course), includeFormative: include_formative });
  if (student != null && student !== '') {
    t.lateWork = t.lateWork.filter((r) => matchesStudent(r, student));
    t.makeUps = t.makeUps.filter((r) => matchesStudent(r, student));
    // Recompute the per-student counts over the filtered lists, not the whole
    // class — otherwise an agent asking about one student sees everyone's count.
    // feedbackOwed/historyCount/makeUpsUnchecked stay class-wide: they're
    // per-assessment/class data.
    t.counts.atReferralLimit = t.lateWork.filter((r) => r.tone === 'red').length;
    t.counts.makeUpsOverdue = t.makeUps.filter((r) => r.tone === 'red').length;
    t.resubmissions = t.resubmissions.filter((r) => matchesStudent(r, student));
    t.counts.resubmissionsOverdue = t.resubmissions.filter((r) => r.tone === 'red').length;
    t.studentFilter = String(student);
  }
  return t;
}

// Triage history: referrals and per-student deadline extensions.
export function listReferralsTool(db, { course, student, since } = {}) {
  const filters = { courseId: resolveCourseRef(db, course), since: since || null };
  const only = (rows) => (student != null && student !== '' ? rows.filter((r) => matchesStudent(r, student)) : rows);
  return { referrals: only(listReferrals(db, filters)), extensions: only(listExtensions(db, filters)) };
}

export function schoolCalendarTool(db, { date, to } = {}) {
  const cal = loadCalendar(db);
  const today = todayLocal();
  const from = date || today;
  return {
    source: cal.source,
    totalSchoolDays: cal.totalSchoolDays,
    syncedAt: cal.syncedAt,
    today: cal.info(today),
    date: cal.info(from),
    ...(to ? { between: { from, to, ...cal.between(from, to), rule: 'school days d with from < d <= to' } } : {}),
  };
}

export function recordReferralTool(db, { student_id, assignment_id, action, note } = {}) {
  return recordReferral(db, { studentId: student_id, assignmentId: assignment_id, action, note, source: 'mcp' });
}

export function undoReferralTool(db, { id } = {}) {
  return undoReferral(db, id);
}

// Make-up tracking for one Schoology test/quiz (all students): tracked false = ignore.
export function setMakeupTrackingTool(db, { assignment_id, tracked } = {}) {
  return setMakeUpIgnored(db, assignment_id, typeof tracked === 'boolean' ? !tracked : tracked);
}

export function extendDeadlineTool(db, { student_id, assignment_id, lessons, note, resubmission_id } = {}) {
  if (resubmission_id != null) return extendResubmission(db, resubmission_id, lessons);
  return recordExtension(db, { studentId: student_id, assignmentId: assignment_id, lessons, note, source: 'mcp' });
}

export function undoExtensionTool(db, { id } = {}) {
  return undoExtension(db, id);
}

// ── Resubmissions (asks to redo graded/comment-only/ungraded work) ──────────
// Same service as the dashboard (server/services/resubmissions.js).

export function requestResubmissionTool(db, { student_id, assignment_id, lessons, note } = {}) {
  return requestResubmission(db, { studentId: student_id, assignmentId: assignment_id, lessons: lessons ?? null, note, source: 'mcp' });
}

export function closeResubmissionTool(db, { id, note } = {}) {
  return closeResubmission(db, id, note);
}

export function markResubmissionReviewedTool(db, { student_id, assignment_id } = {}) {
  return markResubmissionReviewed(db, { studentId: student_id, assignmentId: assignment_id, source: 'mcp' });
}

// state: 'asked' (open) | 'closed' | 'done' | 'reviewed'
export function listResubmissionsTool(db, { course, student, since, state } = {}) {
  const rows = listResubmissions(db, { courseId: resolveCourseRef(db, course), since: since || null });
  return rows.filter((r) => (state ? r.outcome === state : true))
    .filter((r) => (student != null && student !== '' ? matchesStudent(r, student) : true));
}
