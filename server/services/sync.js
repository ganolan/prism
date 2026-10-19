import { getDb } from '../db/index.js';
import {
  getMyUserId,
  getMySections,
  getSectionEnrollments,
  getSectionAssignments,
  getSectionGrades,
  getSectionGradingPeriods,
  getSectionFolders,
  getSectionGradingCategories,
  getSectionGradingScales,
  getUserProfilesBatch,
  getAssignmentSubmissions,
  getSection,
} from './schoology.js';
import { filterRecentAssignments } from './recentWindow.js';
import { groupRevisionsByUid, deriveNativeSubmission } from '../lib/submissionRevisions.js';
import { droppedAtFor } from '../lib/enrolmentStatus.js';
import { createSubmissionFetcher } from './graderSubmissions.js';
import { getSyncConfig } from '../middleware/featureGate.js';
import { syncMasteryForCourse, hasMasterySession } from './masterySync.js';
import { settleResubmissions } from './resubmissions.js';
import { captureFeedbackSnapshots } from './feedbackSnapshots.js';
import { readTaskSubmissions, KEEP_EARLIEST_FIRST_SUBMITTED } from './taskSubmissions.js';

// Issue #56: flip newly-discovered template sections to excluded=1. Same
// predicate as the boot-time backfill in db/index.js but called every sync
// so new template sections appearing in subsequent syncs also get caught.
// Idempotent.
function markExcludedCourses(db) {
  db.exec(`
    UPDATE courses SET excluded = 1
    WHERE excluded = 0
      AND (course_code IS NULL OR course_code = '')
      AND (section_school_code IS NULL OR section_school_code = '')
  `);
}

// Schoology returns `assignees` as a JSON-encoded string on the REST
// assignment endpoint (e.g. `"[1234,5678]"`), but other shapes are
// possible (plain array, `{assignee: [...]}` envelope). The values inside
// are **enrollment IDs**, not user UIDs — callers must map through the
// section's enrollments to recover the actual student UID. Normalize to a
// flat array of id strings; empty/missing → []. See #54.
function parseAssignees(raw) {
  if (raw == null || raw === '') return [];
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return []; }
  }
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'object' && Array.isArray(v.assignee)) return v.assignee.map(String);
  return [];
}

// Sync enrollments, assignments, and grades for one section.
// Returns counts of records written.
export async function syncSectionData(db, sectionId, courseId, now, opts = {}) {
  const enrollments = await getSectionEnrollments(sectionId);
  const studentEnrollments = enrollments.filter(e => e.admin !== '1' && e.admin !== 1);

  const {
    // submissionConcurrency/submissionRatePerSec retained for config compat; the
    // #55 bulk path no longer rate-limits per cell.
    submissionConcurrency = 2,
    submissionRatePerSec = 4,
    submissionAbandonAfter = 5,
    skipSubmissions = false,
    // An archived section reports every enrolment as status "2" (section ended).
    archivedSection = false,
    recentOnly = false,
    recentDays = 30,
  } = opts;

  const upsertStudent = db.prepare(`
    INSERT INTO students (schoology_uid, first_name, last_name, email, picture_url, school_uid, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(schoology_uid) DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      email = COALESCE(excluded.email, students.email),
      picture_url = COALESCE(excluded.picture_url, students.picture_url),
      school_uid = COALESCE(excluded.school_uid, students.school_uid),
      updated_at = excluded.updated_at
  `);
  const upsertEnrolment = db.prepare(`
    INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id, status, dropped_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(student_id, course_id) DO UPDATE SET
      schoology_enrolment_id = excluded.schoology_enrolment_id,
      status = excluded.status,
      -- Keep the FIRST drop date once set, so the roster shows when they
      -- actually left rather than the most recent sync. Clears on re-enrol.
      dropped_at = CASE
        WHEN excluded.dropped_at IS NULL THEN NULL
        ELSE COALESCE(enrolments.dropped_at, excluded.dropped_at)
      END
  `);
  // Defensive: Schoology retains dropped rows (status 5) today, but a row that
  // disappears from the response outright must not linger on the roster either.
  const markMissingDropped = db.prepare(`
    UPDATE enrolments SET dropped_at = COALESCE(dropped_at, ?)
    WHERE course_id = ? AND dropped_at IS NULL
      AND schoology_enrolment_id NOT IN (SELECT value FROM json_each(?))
  `);

  const selectStudent = db.prepare('SELECT id FROM students WHERE schoology_uid = ?');
  const selectDroppedAt = db.prepare('SELECT dropped_at FROM enrolments WHERE student_id = ? AND course_id = ?');
  const writeEnrollments = db.transaction((rows) => {
    for (const e of rows) {
      upsertStudent.run(String(e.uid), e.name_first, e.name_last, e.primary_email || null, e.picture_url || null, e.school_uid ? String(e.school_uid) : null, now);
      const studentRow = selectStudent.get(String(e.uid));
      if (studentRow) {
        upsertEnrolment.run(
          studentRow.id, courseId, String(e.id),
          e.status == null ? null : String(e.status),
          droppedAtFor(e, { archivedSection, previousDroppedAt: selectDroppedAt.get(studentRow.id, courseId)?.dropped_at, now })
        );
      }
    }
    markMissingDropped.run(now, courseId, JSON.stringify(rows.map(e => String(e.id))));
  });
  writeEnrollments(studentEnrollments);

  const assignments = await getSectionAssignments(sectionId);
  const upsertAssignment = db.prepare(`
    INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, max_points, assignment_type, is_lti_submission, grading_category_id, grading_scale_id, folder_id, count_in_grade, published, display_weight, num_assignees, web_url, accepts_submissions, is_test, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(schoology_assignment_id) DO UPDATE SET
      title = excluded.title,
      due_date = excluded.due_date,
      max_points = excluded.max_points,
      assignment_type = excluded.assignment_type,
      is_lti_submission = excluded.is_lti_submission,
      grading_category_id = excluded.grading_category_id,
      grading_scale_id = excluded.grading_scale_id,
      folder_id = excluded.folder_id,
      count_in_grade = excluded.count_in_grade,
      published = excluded.published,
      display_weight = excluded.display_weight,
      num_assignees = excluded.num_assignees,
      web_url = excluded.web_url,
      accepts_submissions = excluded.accepts_submissions,
      is_test = excluded.is_test,
      removed_at = NULL,
      synced_at = excluded.synced_at
  `);
  // Schoology's section list is authoritative: an assignment missing from it was
  // deleted there (direct GET 404s). Soft-remove it so listings hide it while its
  // grades/notes/flags survive. Keeps the first removal date, like dropped_at.
  const markMissingRemoved = db.prepare(`
    UPDATE assignments SET removed_at = ?
    WHERE course_id = ? AND removed_at IS NULL
      AND schoology_assignment_id NOT IN (SELECT value FROM json_each(?))
  `);
  const deleteAssignees = db.prepare(`DELETE FROM assignment_assignees WHERE assignment_id = ?`);
  const insertAssignee = db.prepare(`INSERT OR IGNORE INTO assignment_assignees (assignment_id, schoology_uid) VALUES (?, ?)`);
  // Schoology's assignees[] field stores enrollment IDs; downstream queries
  // join on user UID. Build the per-section enrolment_id → uid map once.
  const enrolmentIdToUid = new Map(studentEnrollments.map(e => [String(e.id), String(e.uid)]));
  const selectAssignment = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?');
  const writeAssignments = db.transaction((rows) => {
    for (const a of rows) {
      upsertAssignment.run(
        courseId, String(a.id), a.title, a.due || null, a.max_points ?? null,
        a.type || 'assignment',
        a.assignment_type === 'lti_submission' ? 1 : 0,
        a.grading_category ? String(a.grading_category) : null,
        a.grading_scale ? String(a.grading_scale) : null,
        a.folder_id ? String(a.folder_id) : null,
        a.count_in_grade ?? 1,
        a.published ?? 1,
        a.display_weight ?? 0,
        Number.isFinite(Number(a.num_assignees)) ? Number(a.num_assignees) : null,
        a.web_url || null,
        // Triage: allow_dropbox covers native dropbox AND OneDrive/GDrive LTI.
        (a.allow_dropbox === '1' || a.allow_dropbox === 1) ? 1 : 0,
        // Make-up tests: a Schoology test/quiz (assignment_type is not reliable —
        // masterySync overwrites it).
        isTest(a) ? 1 : 0,
        now
      );
      const row = selectAssignment.get(String(a.id));
      if (row) {
        deleteAssignees.run(row.id);
        for (const enrolmentId of parseAssignees(a.assignees)) {
          const uid = enrolmentIdToUid.get(String(enrolmentId));
          if (uid) insertAssignee.run(row.id, uid);
        }
      }
    }
    // An empty list is more likely a bad read than a teacher deleting everything.
    if (rows.length > 0) {
      markMissingRemoved.run(now, courseId, JSON.stringify(rows.map(a => String(a.id))));
    }
  });
  writeAssignments(assignments);

  const grades = await getSectionGrades(sectionId);
  // Note: late/draft are owned by the submission-status sync (below) and are
  // intentionally NOT updated on conflict here. Grade sync seeds them to 0
  // on initial insert; submission sync overwrites them with authoritative
  // values from /sections/{id}/submissions/{aid}/{uid}.
  const upsertGrade = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, grade_comment, comment_status, exception, submitted_at, late, draft, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      score = excluded.score,
      max_score = excluded.max_score,
      grade_comment = excluded.grade_comment,
      comment_status = excluded.comment_status,
      exception = excluded.exception,
      submitted_at = excluded.submitted_at,
      synced_at = excluded.synced_at
  `);

  const enrolmentMap = {};
  const allEnrolments = db.prepare('SELECT id, student_id, schoology_enrolment_id FROM enrolments WHERE course_id = ?').all(courseId);
  for (const en of allEnrolments) enrolmentMap[en.schoology_enrolment_id] = en.student_id;

  const enrollIdToUid = {};
  for (const e of enrollments) enrollIdToUid[String(e.id)] = String(e.uid);

  const selectStudentByUid = db.prepare('SELECT id FROM students WHERE schoology_uid = ?');
  const selectAssignmentByExt = db.prepare('SELECT id, max_points FROM assignments WHERE schoology_assignment_id = ?');
  let gradesCount = 0;
  const writeGrades = db.transaction((rows) => {
    for (const g of rows) {
      const enrollmentId = String(g.enrollment_id);
      let studentId = enrolmentMap[enrollmentId];
      if (!studentId) {
        const uid = enrollIdToUid[enrollmentId];
        if (uid) {
          const row = selectStudentByUid.get(uid);
          studentId = row?.id;
        }
      }
      if (!studentId) continue;
      const assignRow = selectAssignmentByExt.get(String(g.assignment_id));
      if (!assignRow) continue;
      upsertGrade.run(studentId, assignRow.id, enrollmentId, g.grade ?? null, g.max_points ?? assignRow.max_points ?? null, g.comment || null, g.comment_status ?? null, g.exception ?? 0, Number(g.timestamp) || 0, now);
      gradesCount++;
    }
  });
  writeGrades(grades);

  // Submission status sync (native dropbox): authoritative late/draft/timing from
  // ONE bulk GET /sections/{id}/submissions/{aid} per assignment (#55), grouped by
  // uid. A non-draft revision means the student submitted a file → submission_type
  // "drop" (synthesized from the revision; native dropbox is always a file drop).
  // A draft-only revision is "opened, in progress, not submitted". No revision =
  // no engagement → the cell is cleared (never inserted). The public revisions API
  // is authoritative for native dropbox, so no browser-session/grader lookup is
  // needed here (lti_submission is the blind case — handled separately below via
  // the per-assignment document endpoints, #62).
  // #72: archived finalisation freezes submission state — an empty list makes this
  // phase a clean no-op (the loop doesn't iterate, writeSubmissions([]) is a no-op).
  const dropboxAll = skipSubmissions
    ? []
    : assignments.filter(a => a.allow_dropbox === '1' || a.allow_dropbox === 1);
  // #55: when recentOnly, restrict the submission check to assignments due within
  // recentDays or in the future; skip undated + clearly-old work. An assignment
  // with an open resubmission request is always checked — however old, its new
  // submission is what the request is waiting for.
  const openResubmissionIds = recentOnly
    ? new Set(db.prepare(`
        SELECT DISTINCT a.schoology_assignment_id AS id FROM resubmissions r JOIN assignments a ON a.id = r.assignment_id
        WHERE r.course_id = ? AND r.kind = 'request' AND r.status = 'open'
      `).all(courseId).map((r) => String(r.id)))
    : null;
  const { target: dropboxAssignments, windowSkipped } =
    filterRecentAssignments(dropboxAll, recentOnly, recentDays, now, openResubmissionIds);

  // #62: lti_submission assignments use the per-assignment document endpoints
  // (true state, whole roster in 2 calls); native dropbox uses the bulk
  // submissions endpoint below.
  const ltiAssignments = dropboxAssignments.filter(a => a.assignment_type === 'lti_submission');
  const nativeDropboxAssignments = dropboxAssignments.filter(a => a.assignment_type !== 'lti_submission');

  const result = await readTaskSubmissions(db, {
    sectionId,
    now,
    students: studentEnrollments.map((e) => ({ id: String(e.id), uid: String(e.uid) })),
    native: nativeDropboxAssignments.map((a) => String(a.id)),
    lti: ltiAssignments.map((a) => String(a.id)),
    // Make-up tests: who has an attempt on each Schoology test in the sync window.
    tests: filterRecentAssignments(skipSubmissions ? [] : assignments.filter(isTest), recentOnly, recentDays, now).target.map((a) => String(a.id)),
    fetchDocuments: opts.fetchDocuments,
    fetchTestAttempts: opts.fetchTestAttempts,
    backoffMs: opts.ltiFetchBackoffMs ?? 750,
    abandonAfter: submissionAbandonAfter,
  });

  return {
    studentsCount: studentEnrollments.length,
    assignmentsCount: assignments.length,
    gradesCount,
    submissionCount: result.submissionCount,
    failedAssignmentIds: result.failedAssignmentIds,
    submissionAbandoned: result.submissionAbandoned,
    submissionAttempts: result.submissionAttempts,
    windowSkipped,
    rateLimitHits: result.rateLimitHits,
    transientFailures: result.transientFailures,
    revisionsReadAssignmentIds: [...result.revisionsRead],
  };
}

// Schoology REST type 'assessment' = a test or quiz.
const isTest = (a) => a.type === 'assessment';

// End-of-sync serial retry pass for assignments that hit transient submission
// errors during the main sync. One pass, no rate limiter, no Retry-After
// honoring, no further retries on failure. Per-assignment atomicity preserved:
// any new transient error in any cell discards that assignment's partial
// results. Mutates `metrics.retries_succeeded`, `metrics.retries_failed`,
// `metrics.submission_calls`, `metrics.rate_limit_hits`, and
// `metrics.transient_failures`. Returns the list of entries that still failed.
// revisionsRead (optional Set): gains the local id of each assignment re-read in full.
export async function retrySubmissions(db, failedEntries, now, metrics, revisionsRead = null) {
  const stillFailing = [];

  // Mirror the main native path: synthesize submission_type from the revision.
  const upsertSubmissionWithType = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, exception, late, draft, latest_revision_at, first_submitted_at, submission_type, synced_at)
    VALUES (?, ?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      late = excluded.late,
      draft = excluded.draft,
      latest_revision_at = excluded.latest_revision_at,
      submission_type = excluded.submission_type,
      synced_at = excluded.synced_at,${KEEP_EARLIEST_FIRST_SUBMITTED}
  `);
  // A Schoology test attempt ('assessment') is owned by the test-attempt pass — never cleared here.
  const clearSubmissionWithType = db.prepare(`
    UPDATE grades SET late = 0, draft = 0, latest_revision_at = 0, submission_type = NULL, synced_at = ?
    WHERE student_id = ? AND assignment_id = ? AND (submission_type IS NULL OR submission_type != 'assessment')
  `);
  const selectStudentByUid = db.prepare('SELECT id FROM students WHERE schoology_uid = ?');
  const selectAssignmentByExt = db.prepare('SELECT id, max_points FROM assignments WHERE schoology_assignment_id = ?');

  for (const entry of failedEntries) {
    const { sectionId: sid, assignmentExtId } = entry;
    try {
      const enrollments = await getSectionEnrollments(sid);
      const studentEnrollments = enrollments.filter(e => e.admin !== '1' && e.admin !== 1);
      const assignRow = selectAssignmentByExt.get(assignmentExtId);
      if (!assignRow) {
        stillFailing.push(entry);
        continue;
      }

      let revisions;
      try {
        metrics.submission_calls++;
        revisions = await getAssignmentSubmissions(sid, assignmentExtId);
      } catch (err) {
        if (err && err.transient) {
          if (err.rateLimited) metrics.rate_limit_hits++; else metrics.transient_failures++;
          stillFailing.push(entry);
          continue;
        }
        throw err;
      }
      const byUid = groupRevisionsByUid(revisions);
      const cellResults = [];
      for (const e of studentEnrollments) {
        const studentRow = selectStudentByUid.get(String(e.uid));
        if (!studentRow) continue;
        cellResults.push({
          studentId: studentRow.id,
          assignmentId: assignRow.id,
          enrolmentId: String(e.id),
          maxPoints: assignRow.max_points ?? null,
          summary: byUid.get(String(e.uid)) || null,
        });
      }

      if (cellResults.length > 0) {
        const writeRetry = db.transaction((rows) => {
          for (const r of rows) {
            const d = deriveNativeSubmission(r.summary);
            if (d) {
              upsertSubmissionWithType.run(
                r.studentId, r.assignmentId, r.enrolmentId, r.maxPoints,
                d.late, d.draft, d.latestRevisionAt, d.latestRevisionAt, d.submissionType, now,
              );
            } else {
              clearSubmissionWithType.run(now, r.studentId, r.assignmentId);
            }
          }
        });
        writeRetry(cellResults);
      }
      revisionsRead?.add(assignRow.id);
      metrics.retries_succeeded++;
    } catch (err) {
      // Non-transient errors (or unexpected enrollments fetch failures): mark
      // this entry as still-failing and continue with the next one. Never
      // re-raise — the retry pass is best-effort.
      stillFailing.push(entry);
    }
  }

  metrics.retries_failed = stillFailing.length;
  return stillFailing;
}

// Full sync: sections -> enrollments -> assignments -> grades
// Refresh + RECONCILE one batch of students' profiles. For each student, fetch
// the Schoology profile and: update email/grad_year/preferred-name; upsert the
// guardians Schoology currently returns; and DELETE any stored guardian it no
// longer returns. Reconciliation runs ONLY on a successful fetch — a failed
// fetch leaves the student's data and contacts untouched (never wipe on error).
// Students are never deleted. Safeguarding: a removed/changed parent contact
// must not linger. `students` is a list of { id, schoology_uid }. Returns the
// number of profiles successfully fetched. (#70)
export async function enrichStudentProfiles(db, students, now) {
  const upsertParent = db.prepare(`
    INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email, relationship)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, schoology_uid) DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      email = excluded.email
  `);
  const updateStudent = db.prepare(`
    UPDATE students SET
      email = COALESCE(?, email),
      preferred_name = COALESCE(preferred_name, ?),
      grad_year = COALESCE(?, grad_year),
      updated_at = ?
    WHERE id = ?
  `);
  const deleteAllParents = db.prepare('DELETE FROM parents WHERE student_id = ?');
  const reconcileParents = (studentId, keepUids) => {
    if (keepUids.length === 0) { deleteAllParents.run(studentId); return; }
    const placeholders = keepUids.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM parents WHERE student_id = ? AND schoology_uid NOT IN (${placeholders})`
    ).run(studentId, ...keepUids);
  };

  let profileCount = 0;
  // #105: one POST /multiget per ≤50 students instead of N GET /users/{uid}.
  // A student missing from the map = its fetch did not succeed → preserve its
  // data + contacts (reconcile nothing), matching the old per-student catch.
  const profiles = await getUserProfilesBatch(students.map(s => String(s.schoology_uid)));
  for (const s of students) {
    const profile = profiles.get(String(s.schoology_uid));
    if (!profile) continue;
    const email = profile.primary_email || null;
    const prefName = (profile.name_first_preferred && profile.use_preferred_first_name === '1')
      ? profile.name_first_preferred : null;
    const gradYear = profile.grad_year ? parseInt(profile.grad_year, 10) : null;
    updateStudent.run(email, prefName, gradYear, now, s.id);

    // Schoology may return a lone guardian as an object rather than a 1-element
    // array — normalise so a single-guardian student isn't reconciled away.
    const rawParents = profile.parents?.parent ?? [];
    const parents = Array.isArray(rawParents) ? rawParents : [rawParents];
    const keepUids = [];
    for (const p of parents) {
      upsertParent.run(s.id, String(p.id), p.name_first || '', p.name_last || '', p.primary_email || null, null);
      keepUids.push(String(p.id));
    }
    reconcileParents(s.id, keepUids);
    profileCount++;
  }
  return profileCount;
}

// Capture an archived course's IMMUTABLE snapshot: gradebook (always, public
// OAuth via syncSectionData) + mastery (only when a browser session exists —
// mastery can't change after archiving). Sets courses.finalized_at = now when a
// session was present (mastery attempted, success or caught failure), so a
// session-less call leaves it null and a later session-enabled sync retries.
// Does NOT touch student data (that is enrichStudentProfiles' job). Returns the
// gradebook counts plus { finalized }. (#70)
// An archived section's submissions, read in full like a current sync's (#72
// reversed, 19/10/2026: every read answers on an archived section, probed live:
// dropbox revisions with late flags, OneDrive/LTI document states, test attempts).
// `reader` is a createSubmissionFetcher() answer (session reads) or null (dropbox
// only). Stamps submissions_read_at only after a full read with a session.
async function readArchivedSection(db, { courseId, sectionId, now, reader }) {
  const counts = await syncSectionData(db, String(sectionId), courseId, now, {
    archivedSection: true,
    fetchDocuments: reader ? (aid) => reader.fetchDocuments(aid) : undefined,
    fetchTestAttempts: reader ? (sid, uids, itemIds) => reader.fetchTestAttempts(sid, uids, itemIds) : undefined,
  });
  if (reader) db.prepare('UPDATE courses SET submissions_read_at = ? WHERE id = ?').run(now, courseId);
  return counts;
}

async function openSubmissionReader() {
  try { return await createSubmissionFetcher(); } catch { return null; }
}

export async function finalizeArchivedCourse(db, { courseId, sectionId, now, runMastery = true }) {
  const c = db.prepare('SELECT course_name, grading_period FROM courses WHERE id = ?').get(courseId) || {};
  const period = c.grading_period ? ` — ${c.grading_period}` : '';
  const reader = await openSubmissionReader();
  console.log(`[archived] "${c.course_name || sectionId}"${period} (section ${sectionId}): reading submissions in full${reader ? '' : ' (dropbox only: no saved session)'}`);
  let counts;
  try {
    counts = await readArchivedSection(db, { courseId, sectionId, now, reader });
  } finally {
    await reader?.close().catch(() => {});
  }
  const sessionPresent = runMastery && hasMasterySession();
  if (sessionPresent) {
    try {
      await syncMasteryForCourse(courseId);
    } catch {
      // Best-effort: a mastery failure still counts as "attempted with a
      // session" so backfill doesn't retry forever; re-import is the escape hatch.
    }
    db.prepare('UPDATE courses SET finalized_at = ? WHERE id = ?').run(now, courseId);
  }
  return { ...counts, finalized: sessionPresent };
}

// Auto-archive: a previously-synced active course (archived=0, has synced_at)
// that has dropped off the active-sections set has likely been archived on
// Schoology. Confirm via a section read before archiving: active:0 → finalise
// (gradebook + mastery if a session exists) + mark archived; still active:1 →
// leave (transient/ambiguous); 404 → mark archived but keep the last snapshot.
// `activeSectionIds` is a Set of the section ids returned by getMySections. (#70)
export async function detectArchivedTransitions(db, activeSectionIds, now) {
  const dropped = db.prepare(`
    SELECT id, schoology_section_id FROM courses
    WHERE archived = 0 AND excluded = 0 AND synced_at IS NOT NULL
  `).all().filter((c) => !activeSectionIds.has(String(c.schoology_section_id)));

  for (const c of dropped) {
    const sectionId = String(c.schoology_section_id);
    let sec;
    try {
      sec = await getSection(sectionId);
    } catch (err) {
      if (err?.status === 404) {
        db.prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(c.id);
      }
      continue; // transient/other error → leave for a later sync
    }
    if (Number(sec.active) === 0) {
      const periods = await getSectionGradingPeriods(sectionId).catch(() => []);
      const gradingPeriod = periods[0]?.title || null;
      await finalizeArchivedCourse(db, { courseId: c.id, sectionId, now });
      db.prepare('UPDATE courses SET archived = 1, grading_period = COALESCE(?, grading_period) WHERE id = ?')
        .run(gradingPeriod, c.id);
    }
  }
}

// One-time backfill: finalise archived courses that were never finalised
// (imported under the old flow). Captures mastery when a session is present;
// converges over session-enabled syncs and never re-runs once finalized_at is
// set. Returns the number of courses processed. (#70)
export async function backfillUnfinalizedArchived(db, now) {
  const courses = db.prepare(
    'SELECT id, schoology_section_id FROM courses WHERE archived = 1 AND excluded = 0 AND finalized_at IS NULL'
  ).all();
  for (const c of courses) {
    await finalizeArchivedCourse(db, { courseId: c.id, sectionId: String(c.schoology_section_id), now });
  }
  return courses.length;
}

// One-time backfill (#72 reversed, 19/10/2026): read the submissions of every
// archived course finalised without them (dropbox uploads and lateness, OneDrive/
// LTI states, test takers). Waits for a saved session, so a stamp always means a
// full read; a course that fails is tried again on the next sync. → courses read.
export async function backfillArchivedSubmissions(db, now, { log = () => {} } = {}) {
  const courses = db.prepare(`
    SELECT id, schoology_section_id, course_name FROM courses
    WHERE archived = 1 AND excluded = 0 AND finalized_at IS NOT NULL AND submissions_read_at IS NULL
    ORDER BY id`).all();
  if (!courses.length) return 0;
  const reader = await openSubmissionReader();
  if (!reader) return 0;
  let read = 0;
  try {
    for (const c of courses) {
      try {
        await readArchivedSection(db, { courseId: c.id, sectionId: c.schoology_section_id, now, reader });
        read++;
        log(`Archived "${c.course_name}": submissions read (${read} of ${courses.length})`);
      } catch (err) {
        log(`Archived "${c.course_name}": submissions not read (${err.message}); trying again next sync`);
      }
    }
  } finally {
    await reader.close().catch(() => {});
  }
  return read;
}

export async function fullSync(onProgress, { includeHidden = false, recentOnly = false, recentDays = 30 } = {}) {
  const db = getDb();
  const log = (msg) => onProgress?.({ message: msg });
  const now = new Date().toISOString();

  // Insert sync log
  const syncRow = db.prepare(
    `INSERT INTO sync_log (sync_type, status, started_at) VALUES ('full', 'running', ?)`
  ).run(now);
  const syncId = syncRow.lastInsertRowid;

  // Declared outside the try so the finally-style cleanup below can always
  // release the document fetcher, even on error.
  let submissionFetcher = null;

  try {
    // 1. Get teacher's user ID and sections
    log('Fetching user profile...');
    const syncConfig = getSyncConfig();
    const startedAt = Date.now();
    const metrics = {
      submission_calls: 0,
      window_skipped: 0, // #55: assignments skipped by the recent-only due-date window
      rate_limit_hits: 0,
      transient_failures: 0,
      retries_attempted: 0,
      retries_succeeded: 0,
      retries_failed: 0,
      abandoned: 0,
      sections_skipped: 0,
      failed_assignment_ids: [], // { sectionId, courseId, assignmentExtId }
    };
    // Assignments whose revisions were read in full this sync (sections + retry pass).
    const revisionsRead = new Set();
    const userId = await getMyUserId();

    // #62: best-effort session reader for lti_submission document state
    // (the submitted/in-progress per-assignment endpoints) and Schoology test
    // attempts (grader_grade_data, make-up tests), reused across all sections.
    // Plain HTTP with the saved session's cookies, no browser (#141).
    // null when no saved session — lti badges then fall back gracefully and
    // test attempts stay unknown.
    // Native dropbox no longer needs a session (public bulk revisions, #55).
    try { submissionFetcher = await createSubmissionFetcher(); } catch { submissionFetcher = null; }

    log('Fetching course sections...');
    const sections = await getMySections(userId);
    log(`Found ${sections.length} sections`);

    let totalRecords = 0;

    // Upsert courses
    const upsertCourse = db.prepare(`
      INSERT INTO courses (schoology_section_id, course_name, section_name, course_code, section_school_code, grading_period, archived, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(schoology_section_id) DO UPDATE SET
        course_name = excluded.course_name,
        section_name = excluded.section_name,
        course_code = excluded.course_code,
        section_school_code = excluded.section_school_code,
        grading_period = excluded.grading_period,
        synced_at = excluded.synced_at
    `);

    for (const sec of sections) {
      const periods = await getSectionGradingPeriods(String(sec.id));
      const gradingPeriod = periods[0]?.title || null;
      upsertCourse.run(
        String(sec.id),
        sec.course_title,
        sec.section_title,
        sec.course_code || null,
        sec.section_school_code || null,
        gradingPeriod,
        now
      );
    }
    totalRecords += sections.length;

    // Issue #56: mark template sections (no codes) as permanently excluded.
    // Subsumes the previous auto-hide pass — the section loop below skips
    // excluded courses unconditionally, so they never reach the expensive
    // per-section API calls.
    markExcludedCourses(db);

    // 2. For each section, sync enrollments, assignments, grades, folders, categories
    const upsertFolder = db.prepare(`
      INSERT INTO folders (course_id, schoology_folder_id, title, color, parent_id, display_weight, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(course_id, schoology_folder_id) DO UPDATE SET
        title = excluded.title,
        color = excluded.color,
        parent_id = excluded.parent_id,
        display_weight = excluded.display_weight,
        synced_at = excluded.synced_at
    `);
    const upsertCategory = db.prepare(`
      INSERT INTO grading_categories (course_id, schoology_category_id, title, synced_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(course_id, schoology_category_id) DO UPDATE SET
        title = excluded.title,
        synced_at = excluded.synced_at
    `);
    const upsertScale = db.prepare(`
      INSERT INTO grading_scales (schoology_scale_id, title, levels_json, synced_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(schoology_scale_id) DO UPDATE SET
        title = excluded.title,
        levels_json = excluded.levels_json,
        synced_at = excluded.synced_at
    `);

    const selectCourseFlags = db.prepare(
      'SELECT id, hidden, archived, excluded FROM courses WHERE schoology_section_id = ?'
    );
    for (const sec of sections) {
      const sectionId = String(sec.id);
      const courseRow = selectCourseFlags.get(sectionId);
      if (!courseRow) continue;
      if (courseRow.excluded) { metrics.sections_skipped++; continue; }
      if (courseRow.hidden && !includeHidden) { metrics.sections_skipped++; continue; }
      if (courseRow.archived) { metrics.sections_skipped++; continue; }

      log(`Syncing "${sec.course_title}"...`);
      const result = await syncSectionData(db, sectionId, courseRow.id, now, {
        ...syncConfig,
        recentOnly,
        recentDays,
        fetchDocuments: submissionFetcher ? (aid) => submissionFetcher.fetchDocuments(aid) : undefined,
        fetchTestAttempts: submissionFetcher
          ? (sid, uids, itemIds) => submissionFetcher.fetchTestAttempts(sid, uids, itemIds)
          : undefined,
      });
      metrics.submission_calls += result.submissionAttempts || 0;
      metrics.window_skipped += result.windowSkipped || 0;
      metrics.rate_limit_hits += result.rateLimitHits || 0;
      metrics.transient_failures += result.transientFailures || 0;
      if (result.submissionAbandoned) metrics.abandoned = 1;
      for (const aid of (result.failedAssignmentIds || [])) {
        metrics.failed_assignment_ids.push({ sectionId, courseId: courseRow.id, assignmentExtId: aid });
      }
      for (const id of (result.revisionsReadAssignmentIds || [])) revisionsRead.add(id);
      totalRecords += result.studentsCount + result.assignmentsCount + result.gradesCount + (result.submissionCount || 0);

      // Sync folders
      try {
        const folders = await getSectionFolders(sectionId);
        for (const f of folders) {
          upsertFolder.run(courseRow.id, String(f.id), f.title, f.color || null, f.parent_id || '0', f.display_weight || 0, now);
        }
        totalRecords += folders.length;
      } catch { /* folders not available for this section */ }

      // Sync grading categories
      try {
        const categories = await getSectionGradingCategories(sectionId);
        for (const c of categories) {
          upsertCategory.run(courseRow.id, String(c.id), c.title, now);
        }
        totalRecords += categories.length;
      } catch { /* categories not available */ }

      // Sync grading scales (district-wide; same scales repeat across sections,
      // so the upsert is idempotent and cheap). Schoology returns each scale
      // with a `scale.level[]` array of { grade, cutoff, average }. We store
      // levels normalised as { name, cutoff, average } sorted ascending. Scales
      // with no levels are treated as numeric (display as score / max_points).
      try {
        const scales = await getSectionGradingScales(sectionId);
        for (const sc of scales) {
          const rawLevels = sc.scale?.level || [];
          const levels = Array.isArray(rawLevels)
            ? rawLevels
                .map(l => ({
                  name: l.grade,
                  cutoff: Number(l.cutoff),
                  average: Number(l.average),
                }))
                .filter(l => l.name && Number.isFinite(l.average))
                .sort((a, b) => a.average - b.average)
            : [];
          upsertScale.run(String(sc.id), sc.title || null, JSON.stringify(levels), now);
        }
        totalRecords += scales.length;
      } catch { /* scales not available */ }

    }

    // The session fetcher (lti state, test attempts) is only needed during the section loop
    // above (the retry pass uses the public API only). Release it now.
    if (submissionFetcher) { await submissionFetcher.close().catch(() => {}); submissionFetcher = null; }
    if (metrics.window_skipped > 0) {
      log(`Recent-only window skipped ${metrics.window_skipped} assignment${metrics.window_skipped === 1 ? '' : 's'} (undated or due > the chosen window).`);
    }

    // Retry pass: one serial attempt for assignments that hit transient errors.
    // No rate limiter, no Retry-After honoring, no further retries on failure.
    if (metrics.failed_assignment_ids.length > 0 && metrics.abandoned === 0) {
      log(`Retrying ${metrics.failed_assignment_ids.length} failed assignments...`);
      metrics.retries_attempted = metrics.failed_assignment_ids.length;
      metrics.failed_assignment_ids = await retrySubmissions(db, metrics.failed_assignment_ids, now, metrics, revisionsRead);
    }

    // One-time: finalise archived courses imported before #70 (capture mastery).
    await backfillUnfinalizedArchived(db, now);
    // One-time: read the submissions of archived courses finalised without them (#72 reversed).
    const archivedRead = await backfillArchivedSubmissions(db, now, { log });
    if (archivedRead) log(`Read the submissions of ${archivedRead} archived course${archivedRead === 1 ? '' : 's'} (one time)`);
    // Auto-archive courses that dropped off the active list this turn (#70).
    // Runs AFTER backfill so a course archived this turn isn't immediately
    // re-finalised by backfill in the same pass.
    await detectArchivedTransitions(db, new Set(sections.map((s) => String(s.id))), now);

    // 3. Refresh + reconcile every retained student's profile + guardians.
    //    Runs for ALL students every sync (including those in no active course)
    //    so student data never goes stale. See enrichStudentProfiles (#70).
    const allStudents = db.prepare('SELECT id, schoology_uid FROM students WHERE schoology_uid IS NOT NULL').all();
    log(`Fetching profiles for ${allStudents.length} students...`);
    const profileCount = await enrichStudentProfiles(db, allStudents, now);
    log(`Fetched ${profileCount} profiles, reconciled parent contacts`);
    totalRecords += profileCount;

    const duration_ms = Date.now() - startedAt;
    const metricsId = db.prepare(`
      INSERT INTO sync_metrics (
        sync_log_id, started_at, duration_ms,
        submission_calls, rate_limit_hits, transient_failures,
        retries_attempted, retries_succeeded, retries_failed,
        concurrency, rate_per_sec, abandoned, sections_skipped, failed_assignment_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      syncId, now, duration_ms,
      metrics.submission_calls, metrics.rate_limit_hits, metrics.transient_failures,
      metrics.retries_attempted, metrics.retries_succeeded, metrics.retries_failed,
      syncConfig.submissionConcurrency, syncConfig.submissionRatePerSec, metrics.abandoned,
      metrics.sections_skipped,
      JSON.stringify(metrics.failed_assignment_ids),
    ).lastInsertRowid;

    // Update sync log
    db.prepare(`UPDATE sync_log SET status = 'completed', records_synced = ?, completed_at = ? WHERE id = ?`)
      .run(totalRecords, new Date().toISOString(), syncId);
    // Best-effort: snapshot visible feedback (records resubmission arrivals, Amendment B),
    // then settle. A failure here must never flip an otherwise-completed sync to 'error'.
    // Pairs whose revisions this sync read with no new revision drop their Prism save
    // log entries from before the sync began (any revision before then was seen).
    try { captureFeedbackSnapshots(db, { revisionsRead, readSince: Math.floor(startedAt / 1000) }); } catch (err) {
      console.error('[sync] captureFeedbackSnapshots failed:', err.message);
    }
    try { settleResubmissions(db); } catch (err) {
      console.error('[sync] settleResubmissions failed:', err.message);
    }

    log(`Sync complete: ${totalRecords} records`);
    // metricsId: the orchestrator adds the run's per-phase times to this row (#143).
    return { success: true, records: totalRecords, metricsId: Number(metricsId) };

  } catch (err) {
    db.prepare(`UPDATE sync_log SET status = 'error', error_message = ?, completed_at = ? WHERE id = ?`)
      .run(err.message, new Date().toISOString(), syncId);
    throw err;
  } finally {
    if (submissionFetcher) await submissionFetcher.close().catch(() => {});
  }
}
