// Pure data handlers for PrisMCP tools. Each takes an open better-sqlite3 db
// and returns plain data; mcp/server.js wraps them in thin registerTool
// callbacks. Kept separate so they unit-test directly against a :memory: DB,
// mirroring the server/**/*.test.js pattern.

import { readSupportSummary } from '../server/services/psSupportSummary.js';
import { listRubrics, getRubricByName, saveRubric, findRubricByContentHash } from '../server/services/rubricStore.js';
import { hashRubricContent } from '../server/services/rubricHash.js';
import { attachRubric } from '../server/services/rubricAttach.js';
import { resolveAssignmentId } from '../server/services/idResolvers.js';
import { LEVELS } from '../server/lib/proficiencyScale.js';
import { getFeedbackRows } from '../server/services/feedbackRows.js';
import { normalizeSubmissionStatus, gradingState, getRoster, scoreScaleFor, getAlignedTopics, getAssessmentContext } from '../server/services/assessmentContext.js';
import { gradingSync, GradingSyncError } from '../server/services/gradingSync.js';
import { getFeatures } from '../server/middleware/featureGate.js';
import { psAlertFieldsForAgents } from '../server/services/psAlertStore.js';
import { preferredFirstName } from '../server/services/studentNames.js';
import { findStudents, getStudentHistory, resolveStudent } from '../server/services/studentHistory.js';
import { schoolYearOf } from '../server/lib/schoolYear.js';
import {
  getTriage, listReferrals, recordReferral, undoReferral, listExtensions, recordExtension, undoExtension, setMakeUpIgnored,
  assertCanExtend, TriageError,
} from '../server/services/triage.js';
import { getSubmissionStatus } from '../server/services/submissionStatus.js';
import { getUnfinishedGrading } from '../server/services/unfinishedGrading.js';
import {
  extendResubmission, gradeStands, listResubmissions,
  assertCanExtendRequest, assertCanGradeStand,
} from '../server/services/resubmissions.js';
import {
  previewStatusLine, publishStatusLine, removeStatusLine, setStatusLineSource,
} from '../server/services/statusLinePublisher.js';
import { act, askResubmission, hasLine, pairOf } from '../server/services/triageActions.js';
import { unsubmitAvailable } from '../server/services/ltiUnsubmit.js';
import { askLine, extendResubmissionLine, gradeStandsLine, extensionLine, makeUpLine, teacherText } from '../server/lib/statusLines.js';
import { loadCalendar } from '../server/services/schoolCalendar.js';
import { todayLocal } from '../server/lib/schoolDays.js';
import { statusLineUntil } from '../server/services/statusLineDue.js';
import { listGroups, setQuestionTags } from '../server/services/quizGroups.js';
import { courseTagResults } from '../server/services/quizTagResults.js';
import { loadQuizQueued } from '../server/services/quizRun.js';
import { frqResponses, listWritebacks, levelsOf } from '../server/services/frqResponses.js';
import { writeFrqSuggestions, recordWriteback } from '../server/services/frqMarks.js';
import { plainTextLines } from '../server/lib/quizText.js';
import { quizResults } from '../server/services/quizResults.js';
import { writeOverallSuggestions } from '../server/services/quizOverall.js';
import { recordServe } from '../server/services/contextServes.js';

// Active courses = not archived, not excluded, not hidden. Mirrors the
// 'current' view in server/routes/courses.js, plus the excluded filter (#56,
// spec §3.1). include_archived adds archived (past) courses, each labelled with
// its school year and term, oldest first after the current ones; the default
// output is unchanged.
export function listCourses(db, { include_archived = false } = {}) {
  if (!include_archived) {
    return db.prepare(`
      SELECT id, course_name, section_name, course_code, schoology_section_id, block_number
      FROM courses
      WHERE archived = 0 AND excluded = 0 AND hidden = 0
      ORDER BY course_name
    `).all();
  }
  return db.prepare(`
    SELECT id, course_name, section_name, course_code, schoology_section_id, block_number, grading_period, archived
    FROM courses
    WHERE excluded = 0 AND (hidden = 0 OR archived = 1)
  `).all()
    .map(({ grading_period, archived, ...c }) => ({ ...c, ...schoolYearOf(grading_period), archived: archived === 1 }))
    .sort((a, b) => Number(a.archived) - Number(b.archived)
      || String(b.school_year ?? '').localeCompare(String(a.school_year ?? ''))
      || a.course_name.localeCompare(b.course_name));
}

// Per-assignment readiness rollup. Submission: LTI uses lti_submission_state,
// non-LTI collapses to submitted/not_started. Grading: all aligned topics
// levelled + a comment => complete; nothing => ungraded; otherwise partial
// (excepted => complete). Computed in JS over the grade rows for clarity.
function assignmentCounts(db, assignmentRow) {
  // Mirrors getAssessmentContext: aligned topics (with the scored-topics
  // fallback when alignments haven't synced), and only scores on those topics
  // count towards "complete" (#123) so this rollup can't disagree with the
  // per-student grading_state.
  const topics = getAlignedTopics(db, assignmentRow.course_id, assignmentRow.schoology_assignment_id);
  const topicsCount = topics.length;
  const topicIds = new Set(topics.map((t) => t.id));
  const scoredByUid = {};
  for (const r of db.prepare(`SELECT student_uid, topic_id FROM mastery_scores WHERE assignment_schoology_id = ?`).all(assignmentRow.schoology_assignment_id)) {
    if (!topicIds.has(r.topic_id)) continue;
    scoredByUid[r.student_uid] = (scoredByUid[r.student_uid] || 0) + 1;
  }
  const rows = db.prepare(`
    SELECT s.schoology_uid, g.lti_submission_state, g.submission_type, g.test_attempt,
           g.grade_comment, g.exception, sl.line AS stored_line
    FROM grades g JOIN students s ON s.id = g.student_id
    LEFT JOIN status_lines sl ON sl.student_id = g.student_id AND sl.assignment_id = g.assignment_id
    WHERE g.assignment_id = ?
  `).all(assignmentRow.id);
  const submission = { submitted: 0, in_progress: 0, not_started: 0, unknown: 0, not_tracked: 0, total: rows.length };
  const grading = { ungraded: 0, partial: 0, complete: 0 };
  for (const r of rows) {
    const ss = normalizeSubmissionStatus({
      is_lti_submission: assignmentRow.is_lti_submission,
      accepts_submissions: assignmentRow.accepts_submissions,
      is_test: assignmentRow.is_test,
      lti_submission_state: r.lti_submission_state,
      submission_type: r.submission_type,
      test_attempt: r.test_attempt,
    });
    submission[ss] = (submission[ss] ?? 0) + 1;
    const gs = gradingState({
      scoredCount: scoredByUid[r.schoology_uid] || 0,
      topicsCount,
      hasComment: teacherText(r.grade_comment, r.stored_line).length > 0, // Prism's status line is not feedback (M3)
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
           a.accepts_submissions, a.is_test,
           EXISTS (
             SELECT 1 FROM mastery_alignments ma
             WHERE ma.assignment_schoology_id = a.schoology_assignment_id
               AND ma.course_id = a.course_id
           ) AS has_aligned_topics,
           -- The latest real submission: only students whose work IS submitted (OneDrive
           -- state, or a dropbox revision), never the grade time (2026-10-19).
           (SELECT MAX(g.latest_revision_at) FROM grades g WHERE g.assignment_id = a.id
              AND (CASE WHEN a.is_lti_submission = 1
                        THEN COALESCE(g.lti_submission_state, CASE WHEN g.submission_type IS NOT NULL THEN 'submitted' END) = 'submitted'
                        ELSE g.submission_type IS NOT NULL END)) AS latest_submitted_at
    FROM assignments a
    WHERE a.course_id = ? AND a.removed_at IS NULL
    ORDER BY a.due_date, a.id
  `).all(Number(course_id));
  return rows.map(({ latest_submitted_at, course_id: _c, is_lti_submission, grading_scale_id, accepts_submissions, is_test, ...r }) => {
    const scale = scoreScaleFor({ grading_scale_id }, r.has_aligned_topics ? 1 : 0);
    return {
      ...r,
      has_aligned_topics: !!r.has_aligned_topics,
      // Scale an unaligned assignment is graded on (#41) — grade those by
      // write_student_suggestions `scale_level`. null for rubric/other assignments.
      score_scale: scale?.name ?? null,
      // The rubric attached as feedback rows (spec 2026-10-13), or null.
      feedback_rubric: getFeedbackRows(db, r.schoology_assignment_id, scale)?.rubric?.name ?? null,
      // submitted_at/latest_revision_at are Unix-seconds epochs (0 = never submitted).
      // Native: submitted_at (the REST grade time) is the submission signal. LTI:
      // submitted_at is the REST grade time, not the submission — the grader's
      // submission time lives in latest_revision_at (triage resubmissions,
      // 2026-10-03), so the query above reads that column for LTI assignments.
      // Surface the latest as an ISO string, null when nobody has submitted.
      latest_submission_at: latest_submitted_at > 0 ? new Date(latest_submitted_at * 1000).toISOString() : null,
      ...assignmentCounts(db, { id: r.id, schoology_assignment_id: r.schoology_assignment_id, course_id: _c, is_lti_submission, accepts_submissions, is_test }),
    };
  });
}

// Course roster (current, non-dropped enrolments), independent of any
// assignment — so a class-list check (e.g. against a meeting attendance log)
// doesn't require resolving an assignment first. Reuses the same getRoster
// query get_assignment_context composes into its per-assignment roster. Works
// for an archived course id too (from list_courses include_archived).
// include_dropped appends students who left, each with dropped_at.
export function listStudents(db, { course_id, include_dropped = false }) {
  const shape = (st) => ({
    id: st.id,
    schoology_uid: st.schoology_uid,
    first_name: st.first_name,
    last_name: st.last_name,
    preferred_name: st.preferred_name,
    preferred_first_name: preferredFirstName(st),
    email: st.email ?? null,
    grad_year: st.grad_year ?? null,
  });
  const gradYears = new Map(db.prepare(`
    SELECT s.id, s.grad_year FROM students s JOIN enrolments e ON e.student_id = s.id WHERE e.course_id = ?
  `).all(Number(course_id)).map((r) => [r.id, r.grad_year]));
  const current = getRoster(db, Number(course_id)).map((st) => shape({ ...st, grad_year: gradYears.get(st.id) }));
  const dropped = !include_dropped ? [] : db.prepare(`
    SELECT s.*, e.dropped_at FROM students s JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ? AND e.dropped_at IS NOT NULL
    ORDER BY s.last_name, s.first_name
  `).all(Number(course_id)).map((st) => ({ ...shape(st), dropped_at: st.dropped_at }));
  const all = [...current, ...dropped];
  // #117: PowerSchool alerts (labels only, never the guardian-contact fields).
  if (!getFeatures().powerschool_alerts) return all;
  const alerts = psAlertFieldsForAgents(db, all.map((st) => st.id));
  return all.map((st) => ({ ...st, ...alerts.get(st.id) }));
}

// ── Student history (reference letters) ─────────────────────────────────────
// Read-only. Same service a future UI would use (server/services/studentHistory.js).

export function findStudentTool(db, { query, include_archived, limit } = {}) {
  return findStudents(db, { query, include_archived, limit });
}

export function getStudentHistoryTool(db, args = {}) {
  return getStudentHistory(db, args);
}

// #163: the PowerSchool Student Support Summary, read live (server/services/
// psSupportSummary.js, the same read as the student page's "Show alerts").
export async function getSupportSummaryTool(db, { student } = {}, { read = readSupportSummary, features = getFeatures() } = {}) {
  if (!features.powerschool_alerts) throw new Error('PowerSchool alerts are off in config.yaml');
  const s = resolveStudent(db, student);
  const { rows, readAt } = await read(db, s.id);
  return {
    student_id: s.id,
    rows,
    read_at: readAt,
    note: 'For the teacher only: never put it in student-facing text or on a roster. Rows are PowerSchool\'s, verbatim; the extra time, when there is one, is in Support Notes in PowerSchool\'s own words.',
  };
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

// Bind a library rubric (by name) to an assignment. On an aligned task the
// criteria are auto-matched to measurement topics; unmatched ones are finished
// in Prism's Map-criteria tab. On an unaligned score-scale task every criterion
// becomes a feedback row (Prism-only; only the overall level is published).
export function attachRubricTool(db, { rubric_name, assignment_id }) {
  const rubric = getRubricByName(db, rubric_name);
  if (!rubric) return { error: `rubric "${rubric_name}" not found` };
  const localId = resolveAssignmentId(db, assignment_id);
  const asg = localId ? db.prepare(`SELECT schoology_assignment_id, course_id FROM assignments WHERE id = ?`).get(localId) : null;
  if (!asg) return { error: `assignment ${assignment_id} not found` };
  const res = attachRubric(db, { rubricId: rubric.id, courseId: asg.course_id, assignmentId: asg.schoology_assignment_id });
  if (res.mode === 'feedback_rows') {
    return { attached_to: localId, rubric: rubric_name, mode: 'feedback_rows', score_scale: res.scaleName, rows: res.rows, hidden_row_levels: res.hiddenRowLevels };
  }
  const nameById = Object.fromEntries(rubric.criteria.map((c) => [c.id, c.criterion_name]));
  return { attached_to: localId, rubric: rubric_name, unmatched_criteria: res.unmatched.map((id) => nameById[id] ?? `<criterion id=${id}>`) };
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
  if (hits.length === 0) throw new Error(`No active course matches "${ref}" (current: ${courses.map(courseCandidate).join(', ')}): pass a course id`);
  throw new Error(`"${ref}" matches several courses (${hits.map(courseCandidate).join(', ')}): pass a course id`);
}

// A student reference: a local id, or a case-insensitive name fragment.
const matchesStudent = (r, student) =>
  String(r.studentId) === String(student) || r.studentName.toLowerCase().includes(String(student).toLowerCase());

export function getTriageTool(db, { course, student, include_formative } = {}) {
  const courseId = resolveCourseRef(db, course);
  const t = { ...getTriage(db, { courseId, includeFormative: include_formative }), unfinishedGrading: getUnfinishedGrading(db, { courseId }) };
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
    t.flags = t.flags.filter((r) => matchesStudent(r, student));
    t.counts.flagsOverdue = t.flags.filter((r) => r.tone === 'red').length;
    // Unfinished grading: keep that student's entries, recounted.
    t.unfinishedGrading = t.unfinishedGrading.map((r) => {
      const students = r.students.filter((s) => matchesStudent(s, student));
      const count = (x) => students.filter((s) => s.reasons.includes(x)).length;
      return { ...r, students, drafts: count('draft'), feedbackHidden: count('feedback_hidden'), unreadComments: count('unread_comment') };
    }).filter((r) => r.students.length > 0);
    t.studentFilter = String(student);
  }
  return t;
}

// Roster-wide submission state (issue #119): "who still hasn't submitted X?"
// / "give me an email list of everyone with unsubmitted summative work?".
// Same service a teacher's dashboard would use, so an agent sees the same
// answer the triage panels do.
export function getSubmissionStatusTool(db, { course, assignment_id, student, summative_only, past_due_only, status } = {}) {
  return getSubmissionStatus(db, {
    courseId: resolveCourseRef(db, course), assignmentId: assignment_id, student,
    summativeOnly: summative_only, pastDueOnly: past_due_only, status,
  });
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

// The schoology client reads its credentials from the environment at import. The Prism server
// loads .env first (server/index.js) and hosts these tools at /mcp, so the credentials come from
// the server's .env. A tool that reads or writes the student's Schoology comment
// (preview_status_line, comment_line, remove_line) needs them, checked at call time so a missing
// one is named plainly (final review I3) instead of surfacing as a failed read.
const SCHOOLOGY_ENV = ['SCHOOLOGY_BASE_URL', 'SCHOOLOGY_CONSUMER_KEY', 'SCHOOLOGY_CONSUMER_SECRET'];
export function assertSchoologyConfigured(env = process.env) {
  const missing = SCHOOLOGY_ENV.filter((k) => !String(env[k] ?? '').trim());
  if (missing.length === 0) return;
  throw new TriageError('SCHOOLOGY_NOT_CONFIGURED',
    `Prism cannot reach Schoology: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from the server's .env: nothing was read, published or recorded. ` +
    'Tell the teacher to add SCHOOLOGY_BASE_URL, SCHOOLOGY_CONSUMER_KEY and SCHOOLOGY_CONSUMER_SECRET to the Prism server\'s .env ' +
    '(docs/deploy.md) and restart it, or leave out comment_line / remove_line to keep the action Prism-only.');
}

// A write to Schoology (a status line, an LTI unsubmit): refused on a dev copy of Prism, whose
// students and database are not the ones Schoology holds (prod's copy would never learn of the
// write), else the credentials check. A refusal records nothing.
export function assertSchoologyWritable({ devCopy = false, env = process.env } = {}) {
  if (devCopy) {
    throw new TriageError('DEV_COPY',
      'This is a dev copy of Prism, so it refuses Schoology writes: nothing was published, unsubmitted or recorded. ' +
      'Call again without comment_line / remove_line, and with unsubmit: false, to keep the action Prism-only.');
  }
  assertSchoologyConfigured(env);
}

// get_assignment_context forces a grading sync of the task first (gradingSync.js: the queue reads
// its details, submissions, grades, mastery, comment threads and files), then composes the context
// from the database; unless the task fully synced under 5 minutes ago (`state: 'fresh'`). With
// `use_stored_data` it skips the sync and answers `stale_data` first (the teacher's choice when the
// Schoology sign-in has lapsed). A GradingSyncError (NOT_FOUND, SESSION_LAPSED, SYNC_FAILED,
// SYNC_PENDING) is thrown for the tool wrapper to answer with its code.
// The `*_source` fields say what the sync read (the run's summary), or that the answer is as last
// read: a source switched off in config.yaml (submission_comments, submission_files) is never read,
// and says so first (before the OneDrive note: switched off, nothing is read on any task). A
// `course_id` that does not own the assignment is NOT_FOUND before any sync (#170).
const STORED_NOTE = (at) => `Data as of ${at ?? 'never (this task has not been fully synced)'}. Sign in to Schoology for a fresh sync.`;

// `task` is the assignment row gradingSync resolved (r.task), else read here.
function contextSources(db, { assignment_id }, r) {
  const features = getFeatures();
  const task = r.task ?? db.prepare('SELECT is_lti_submission, grading_synced_at FROM assignments WHERE id = ?')
    .get(resolveAssignmentId(db, assignment_id));
  const run = r.summary ?? {};
  const kept = r.state === 'stored';
  // A fresh answer ran no sync of its own, so its counts are 0: say the earlier grading sync read them.
  const note = kept ? { note: STORED_NOTE(r.dataAsOf) }
    : r.state === 'fresh' ? { note: `read by the grading sync at ${task?.grading_synced_at ?? r.dataAsOf}, under 5 minutes ago` } : {};
  const off = (feature, part) => !features[feature] || part?.disabled;
  const asRead = (feature, part) => {
    if (off(feature, part)) return { refreshed: 0, failed: 0, cached_only: true, note: `${feature} is off in config.yaml` };
    if (kept) return { refreshed: 0, failed: 0, cached_only: true, ...note };
    return { refreshed: part?.refreshed ?? 0, failed: part?.failed ?? 0, cached_only: false, ...note };
  };
  const files = !off('submission_files', run.files) && (task?.is_lti_submission || run.files?.notNative)
    ? { refreshed: 0, failed: 0, cached_only: true, note: 'this task takes OneDrive or Google Drive work, not Schoology uploads: submission_files is empty' }
    : asRead('submission_files', run.files);
  return {
    submission_comments_source: asRead('submission_comments', run.comments),
    submission_files_source: files,
    mastery_source: { refreshed: r.state === 'synced', synced_at: r.dataAsOf, cached_only: kept, ...note },
  };
}

export async function getAssignmentContextTool(db, { course_id, assignment_id, use_stored_data } = {}, { sync = gradingSync, syncOptions = {} } = {}) {
  if (course_id != null && course_id !== '') {
    const localId = resolveAssignmentId(db, assignment_id);
    const owner = localId && db.prepare('SELECT course_id FROM assignments WHERE id = ?').get(localId)?.course_id;
    if (owner != null && String(owner) !== String(course_id)) {
      throw new GradingSyncError('NOT_FOUND', `Assignment ${assignment_id} is not in course ${course_id} (it is in course ${owner}): nothing was synced.`);
    }
  }
  const r = await sync(db, assignment_id, { useStoredData: use_stored_data === true, ...syncOptions });
  const ctx = getAssessmentContext(db, { courseId: course_id, assignmentId: assignment_id });
  if (!ctx) return ctx;
  // What this grading session was given, and when: recorded as a serve whose id (context_id) the
  // grader passes back on write, so the suggestions it writes later (possibly after a long run) are
  // judged stale by the age of THIS data, not by what a sync stamped by then.
  const contextId = recordServe(db, { assignmentId: r.task?.id ?? resolveAssignmentId(db, assignment_id), dataAsOf: r.dataAsOf ?? 'never' });
  return {
    ...(r.state === 'stored' ? { stale_data: STORED_NOTE(r.dataAsOf) } : {}),
    ...ctx, ...contextSources(db, { assignment_id }, r), data_as_of: r.dataAsOf, context_id: contextId,
  };
}

// extend_deadline, both paths, gain comment_line? (published via the shared
// lock → validate → publish → record orchestration in triageActions.js, same
// as the HTTP routes). With resubmission_id: kind 'extend_resubmission'.
// Otherwise: kind 'make_up' for a Schoology test, else 'extension'.
export async function extendDeadlineTool(db, { student_id, assignment_id, lessons, note, resubmission_id, comment_line } = {}, { devCopy = false } = {}) {
  if (hasLine(comment_line)) assertSchoologyWritable({ devCopy });
  if (resubmission_id != null) {
    return act(db, {
      pair: () => pairOf(db, 'resubmissions', resubmission_id),
      validate: () => assertCanExtendRequest(db, resubmission_id, lessons),
      publish: hasLine(comment_line) ? (({ request }) => publishStatusLine(db, {
        studentId: request.student_id, assignmentId: request.assignment_id, line: comment_line, kind: 'extend_resubmission',
      })) : null,
      record: ({ request }, published) => {
        const r = extendResubmission(db, resubmission_id, lessons);
        if (published) setStatusLineSource(db, { studentId: request.student_id, assignmentId: request.assignment_id, type: 'resubmission', id: request.id });
        return r;
      },
    });
  }
  return act(db, {
    pair: () => [student_id, assignment_id],
    validate: () => assertCanExtend(db, { studentId: student_id, assignmentId: assignment_id, lessons }),
    publish: hasLine(comment_line) ? ((ctx) => publishStatusLine(db, {
      studentId: ctx.student.id, assignmentId: ctx.assignment.id, line: comment_line,
      kind: ctx.assignment.is_test === 1 ? 'make_up' : 'extension',
    })) : null,
    record: (ctx, published) => {
      const x = recordExtension(db, { studentId: student_id, assignmentId: assignment_id, lessons, note, source: 'mcp' });
      if (published) setStatusLineSource(db, { studentId: ctx.student.id, assignmentId: ctx.assignment.id, type: 'extension', id: x.id });
      return x;
    },
  });
}

// undo_extension gains remove_line?: first removes the line THIS extension
// published (if it is still the stored line) before deleting the record.
export async function undoExtensionTool(db, { id, remove_line } = {}, { devCopy = false } = {}) {
  if (remove_line) assertSchoologyWritable({ devCopy });
  return act(db, {
    pair: () => pairOf(db, 'extensions', id),
    validate: () => pairOf(db, 'extensions', id),
    publish: remove_line ? ((p) => (p
      ? removeStatusLine(db, { studentId: p[0], assignmentId: p[1], source: { type: 'extension', id } })
      : null)) : null,
    record: () => undoExtension(db, id),
  });
}

// ── Resubmissions (asks to redo graded/comment-only/ungraded work) ──────────
// Same service as the dashboard (server/services/resubmissions.js).

// unsubmit (Phase 2): unsubmit the student's OneDrive (LTI) work in Schoology so they
// can edit it. Default: true when the work is LTI and Prism last saw it submitted, else
// false. Never re-submits. A failed unsubmit still records the ask; the result's
// `unsubmit` says what happened and links Schoology's own Unsubmit button.
export async function requestResubmissionTool(db, { student_id, assignment_id, lessons, note, comment_line, unsubmit } = {}, { unsubmitOpts, devCopy = false } = {}) {
  const doUnsubmit = unsubmit ?? unsubmitAvailable(db, { studentId: student_id, assignmentId: assignment_id });
  // The LTI unsubmit rides the saved web session, not the API keys: only a comment_line needs those.
  if (hasLine(comment_line)) assertSchoologyWritable({ devCopy });
  else if (devCopy && doUnsubmit === true) assertSchoologyWritable({ devCopy });
  const r = await askResubmission(db, {
    studentId: student_id, assignmentId: assignment_id, lessons: lessons ?? null, note, commentLine: comment_line,
    unsubmit: doUnsubmit === true, source: 'mcp', unsubmitOpts,
  });
  if (!r.unsubmit) return r;
  const unsubmitReport = r.unsubmit.ok
    ? { ok: true, message: 'Unsubmitted their OneDrive work in Schoology: they can edit it and submit again.' }
    : {
      ...r.unsubmit,
      message: r.unsubmit.uncertain
        ? `The ask was recorded, but Schoology didn't confirm the unsubmit. Their work may still be submitted (${r.unsubmit.error}). Tell the teacher to check and unsubmit it in Schoology: ${r.unsubmit.url}`
        : `The ask was recorded, but unsubmitting in Schoology failed: their work is still submitted (${r.unsubmit.error}). Tell the teacher to unsubmit it in Schoology: ${r.unsubmit.url}`,
    };
  return { ...r, unsubmit: unsubmitReport };
}

// Only once the request's deadline has passed (NOT_AT_DEADLINE before). `today`
// is computed once and shared between the validate and record steps, so a
// clock tick between them (e.g. a request that straddles midnight) can't make
// the two disagree about whether the deadline has passed.
export async function gradeStandsTool(db, { id, comment_line } = {}, { devCopy = false } = {}) {
  if (hasLine(comment_line)) assertSchoologyWritable({ devCopy });
  const today = todayLocal();
  return act(db, {
    pair: () => pairOf(db, 'resubmissions', id),
    validate: () => assertCanGradeStand(db, id, today),
    publish: hasLine(comment_line) ? (({ request }) => publishStatusLine(db, {
      studentId: request.student_id, assignmentId: request.assignment_id, line: comment_line, kind: 'grade_stands',
    })) : null,
    record: ({ request }, published) => {
      const r = gradeStands(db, id, { today });
      if (published) setStatusLineSource(db, { studentId: request.student_id, assignmentId: request.assignment_id, type: 'resubmission', id: request.id });
      return r;
    },
  });
}

const RENDERABLE_KINDS = ['ask', 'extend_resubmission', 'grade_stands', 'extension', 'make_up'];

// Server-rendered preview for the confirm step before any comment_line publish.
// The agent cannot reliably compute the school-day date a template embeds, so
// this computes `until` with the SAME calendar logic the corresponding record
// step uses (server/services/statusLineDue.js, shared with the web confirm
// modal's GET /api/triage/status-line/until), renders the line with
// server/lib/statusLines.js, and previews it with a fresh Schoology read
// (server/services/statusLinePublisher.js previewStatusLine). Always returns
// the rendered suggestion in `line`; if the caller already has a candidate
// `line` (e.g. the teacher edited Prism's suggestion), resultingComment
// previews THAT text instead, while `line` in the response still carries the
// original suggestion for comparison.
export async function previewStatusLineTool(db, { student_id, assignment_id, kind, lessons, note, resubmission_id, line } = {}) {
  if (!RENDERABLE_KINDS.includes(kind)) {
    throw new TriageError('BAD_VALUE', `kind must be one of ${RENDERABLE_KINDS.join(', ')}`);
  }
  assertSchoologyConfigured(); // the preview is a fresh Schoology read
  const { until } = statusLineUntil(db, {
    kind, studentId: student_id, assignmentId: assignment_id, lessons, resubmissionId: resubmission_id,
  });
  const rendered = {
    ask: () => askLine({ until, note }),
    extend_resubmission: () => extendResubmissionLine({ until, note }),
    grade_stands: () => gradeStandsLine({ until }),
    extension: () => extensionLine({ until, lessons, note }),
    make_up: () => makeUpLine({ until, note }),
  }[kind]();
  const preview = await previewStatusLine(db, { studentId: student_id, assignmentId: assignment_id, line: hasLine(line) ? line : rendered });
  return { line: rendered, until, ...preview };
}

// state: 'asked' (open) | 'grade_stands' | 'done' | 'undone' | 'closed'
export function listResubmissionsTool(db, { course, student, since, state } = {}) {
  const rows = listResubmissions(db, { courseId: resolveCourseRef(db, course), since: since || null });
  return rows.filter((r) => (state ? r.outcome === state : true))
    .filter((r) => (student != null && student !== '' ? matchesStudent(r, student) : true));
}

// Linked quizzes (spec 2026-10-12). Combining and linking stay in Prism's UI in v1.
export function listQuizGroupsTool(db, { course }) {
  return listGroups(db, { courseId: resolveCourseRef(db, course) });
}

// A queue run (quizRun.js): never beside a sync. PENDING (the wait passed) carries the run id.
export async function loadQuizResultsTool(db, { group_id }, deps = { loadQuizQueued }) {
  return { summary: await deps.loadQuizQueued(db, group_id) };
}

export function setQuestionTagsTool(db, { group_id, tags, texts }) {
  return setQuestionTags(db, { groupId: group_id, tags, texts });
}

// #139: one tag across every quiz group in a course, MCQs only (the Questions tab's tag drawer).
export function getTagResultsTool(db, { course, tag }) {
  return courseTagResults(db, { courseId: resolveCourseRef(db, course), tag });
}

// Phase 2 (spec §12): FRQ marking. Answers go out as plain text; levels by name.
const describeLevel = (l) => l.descriptionHtml.replace(/^[^:]*:\s*/, '').trim();

export function getFrqResponsesTool(db, { group_id, question }) {
  const data = frqResponses(db, { groupId: group_id, position: question ?? null });
  const layer = (rubric, m) => (m ? { levels: levelsOf(rubric, m.cells), comment: m.comment } : null);
  return {
    questions: data.questions.map(q => ({
      position: q.position, stem: plainTextLines(q.stem_html), max_points: q.max_points,
      rubric: q.rubric ? q.rubric.rows.map(r => ({ row: r.title, levels: r.levels.map(l => ({ name: l.name, points: l.points, description: plainTextLines(describeLevel(l)) })) })) : null,
    })),
    students: data.students.map(s => ({
      student: s.name, student_id: s.student_id, schoology_uid: s.schoology_uid, attempt_url: s.attempt_url, mcq: s.mcq,
      answers: data.questions.map(q => {
        const r = s.responses[q.position];
        const m = r.mark;
        return {
          question: q.position,
          answer_text: plainTextLines(r.answer_html),
          schoology: layer(q.rubric, r.schoology),
          prism: m ? {
            state: m.state, suggestion: layer(q.rubric, m.suggested), final: layer(q.rubric, m.final),
            suggestion_revised: m.suggestion_revised, writeback: m.writeback.status, changed_in_schoology: m.changed_in_schoology,
          } : null,
        };
      }),
    })),
  };
}

export function writeFrqSuggestionsTool(db, { group_id, question, students }) {
  return writeFrqSuggestions(db, { groupId: group_id, position: question, students });
}

export function listFrqWritebacksTool(db, { group_id }) {
  return listWritebacks(db, { groupId: group_id });
}

export function markFrqWritebackTool(db, { group_id, student, question, status, error }) {
  return recordWriteback(db, { groupId: group_id, student, position: question, status, error });
}

// Phase 3 (spec §13): the overall result on the linked result task.
// The read is recorded as a serve of the group's result task, dated by when the results were
// loaded (`loaded_at` is SQLite UTC time; 'never' when they never were), so
// write_quiz_overall_suggestions, which has no context_id and takes the oldest serve of the last
// 3 hours, stamps the suggestion with the data it was graded from (#170).
export function getQuizResultsTool(db, { group_id }) {
  const data = quizResults(db, { groupId: group_id });
  if (data.group.result) {
    const loaded = data.group.loaded_at;
    const loadedIso = loaded ? new Date(/[TZ]/.test(loaded) ? loaded : `${loaded.replace(' ', 'T')}Z`).toISOString() : 'never';
    recordServe(db, { assignmentId: data.group.result.id, dataAsOf: loadedIso });
  }
  return {
    ...data,
    students: data.students.map(({ name, student_id, overall, ...rest }) => ({
      student: name, student_id, ...rest,
      overall: overall ? { rubric_scores: overall.rubric_scores, impression: overall.impression, status: overall.status, suggestion_state: overall.suggestion_state, stale: overall.stale } : null,
    })),
  };
}

export function writeQuizOverallSuggestionsTool(db, { group_id, students }) {
  return writeOverallSuggestions(db, { groupId: group_id, students });
}
