// Pure data handlers for PrisMCP tools. Each takes an open better-sqlite3 db
// and returns plain data; mcp/server.js wraps them in thin registerTool
// callbacks. Kept separate so they unit-test directly against a :memory: DB,
// mirroring the server/**/*.test.js pattern.

import { listRubrics, getRubricByName, saveRubric, findRubricByContentHash } from '../server/services/rubricStore.js';
import { hashRubricContent } from '../server/services/rubricHash.js';
import { attachRubric } from '../server/services/rubricAttach.js';
import { LEVELS } from '../server/lib/proficiencyScale.js';
import { normalizeSubmissionStatus, gradingState, getRoster } from '../server/services/assessmentContext.js';
import { preferredFirstName } from '../server/services/studentNames.js';

// Active courses = not archived, not excluded, not hidden. Mirrors the
// 'current' view in server/routes/courses.js, plus the excluded filter (#56,
// spec §3.1).
export function listCourses(db) {
  return db.prepare(`
    SELECT id, course_name, section_name, course_code, schoology_section_id
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
    SELECT a.id, a.schoology_assignment_id, a.title, a.due_date, a.assignment_type, a.is_lti_submission, a.course_id,
           EXISTS (
             SELECT 1 FROM mastery_alignments ma
             WHERE ma.assignment_schoology_id = a.schoology_assignment_id
               AND ma.course_id = a.course_id
           ) AS has_aligned_topics,
           (SELECT MAX(g.submitted_at) FROM grades g WHERE g.assignment_id = a.id) AS latest_submitted_at
    FROM assignments a
    WHERE a.course_id = ?
    ORDER BY a.due_date, a.id
  `).all(Number(course_id));
  return rows.map(({ latest_submitted_at, course_id: _c, is_lti_submission, ...r }) => ({
    ...r,
    has_aligned_topics: !!r.has_aligned_topics,
    // submitted_at is a Unix-seconds epoch (0 = never submitted);
    // surface the latest as an ISO string, null when nobody has submitted.
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
