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
  getUserProfile,
  getSubmissionStatus,
  getSection,
} from './schoology.js';
import { runWithLimits } from './rateLimitedRunner.js';
import { createSubmissionFetcher } from './graderSubmissions.js';
import { getSyncConfig } from '../middleware/featureGate.js';
import { syncMasteryForCourse, hasMasterySession } from './masterySync.js';

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
    submissionConcurrency = 2,
    submissionRatePerSec = 4,
    submissionAbandonAfter = 5,
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
    INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id)
    VALUES (?, ?, ?)
    ON CONFLICT(student_id, course_id) DO UPDATE SET
      schoology_enrolment_id = excluded.schoology_enrolment_id
  `);

  const selectStudent = db.prepare('SELECT id FROM students WHERE schoology_uid = ?');
  const writeEnrollments = db.transaction((rows) => {
    for (const e of rows) {
      upsertStudent.run(String(e.uid), e.name_first, e.name_last, e.primary_email || null, e.picture_url || null, e.school_uid ? String(e.school_uid) : null, now);
      const studentRow = selectStudent.get(String(e.uid));
      if (studentRow) upsertEnrolment.run(studentRow.id, courseId, String(e.id));
    }
  });
  writeEnrollments(studentEnrollments);

  const assignments = await getSectionAssignments(sectionId);
  const upsertAssignment = db.prepare(`
    INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, max_points, assignment_type, grading_category_id, grading_scale_id, folder_id, count_in_grade, published, display_weight, num_assignees, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(schoology_assignment_id) DO UPDATE SET
      title = excluded.title,
      due_date = excluded.due_date,
      max_points = excluded.max_points,
      assignment_type = excluded.assignment_type,
      grading_category_id = excluded.grading_category_id,
      grading_scale_id = excluded.grading_scale_id,
      folder_id = excluded.folder_id,
      count_in_grade = excluded.count_in_grade,
      published = excluded.published,
      display_weight = excluded.display_weight,
      num_assignees = excluded.num_assignees,
      synced_at = excluded.synced_at
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
        a.grading_category ? String(a.grading_category) : null,
        a.grading_scale ? String(a.grading_scale) : null,
        a.folder_id ? String(a.folder_id) : null,
        a.count_in_grade ?? 1,
        a.published ?? 1,
        a.display_weight ?? 0,
        Number.isFinite(Number(a.num_assignees)) ? Number(a.num_assignees) : null,
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

  // Submission status sync: authoritative late/draft from
  // /sections/{id}/submissions/{aid}/{uid}. Only runs for assignments with a
  // dropbox; saves API calls on assignments students can't submit to.
  // For OneDrive/GDrive (lti_submission), a revision with draft=1 means
  // "opened, work in progress, not submitted" — exactly the state we want
  // to surface in the UI. Empty revision array means either never-opened or
  // already-submitted (indistinguishable from this endpoint for OneDrive).
  //
  // #62/#55: the internal gradebook (grader_header_data) closes that gap. When
  // a browser-session lookup is available (injected via opts.fetchSubmissionLookup),
  // each (student, assignment) cell it covers is one of:
  //   • submitted → record submission_type ("drop"/"assessment"); still call the
  //     public API for late/draft/timing it does not carry (#62).
  //   • not submitted (bare cell) → SKIP the rate-limited public call entirely (#55)
  //     and clear status + type.
  //   • not covered (e.g. outside the grading period grader_header_data returns)
  //     → fall back to the public API and leave submission_type untouched.
  const dropboxAssignments = assignments.filter(a => a.allow_dropbox === '1' || a.allow_dropbox === 1);

  // Best-effort: null when no session / fetch fails — sync then behaves exactly
  // as before (public revisions API only).
  let submissionLookup = null;
  if (typeof opts.fetchSubmissionLookup === 'function' && dropboxAssignments.length) {
    try { submissionLookup = await opts.fetchSubmissionLookup(sectionId); } catch { submissionLookup = null; }
  }

  const upsertSubmissionStatus = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, exception, late, draft, latest_revision_at, synced_at)
    VALUES (?, ?, ?, NULL, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      late = excluded.late,
      draft = excluded.draft,
      latest_revision_at = excluded.latest_revision_at,
      synced_at = excluded.synced_at
  `);
  const clearSubmissionStatus = db.prepare(`
    UPDATE grades SET late = 0, draft = 0, latest_revision_at = 0, synced_at = ?
    WHERE student_id = ? AND assignment_id = ?
  `);
  // #62: GHD says submitted. Upsert (insert the row if missing, so a
  // submitted-but-ungraded OneDrive cell still surfaces) with submission_type.
  const upsertSubmittedWithType = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, exception, late, draft, latest_revision_at, submission_type, synced_at)
    VALUES (?, ?, ?, NULL, ?, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      late = excluded.late,
      draft = excluded.draft,
      latest_revision_at = excluded.latest_revision_at,
      submission_type = excluded.submission_type,
      synced_at = excluded.synced_at
  `);
  // #62: GHD says not submitted. UPDATE-only (never insert) so a never-touched
  // cell keeps "no engagement" (no grades row / has_grade_row = 0); clears type.
  const clearSubmissionWithType = db.prepare(`
    UPDATE grades SET late = 0, draft = 0, latest_revision_at = 0, submission_type = NULL, synced_at = ?
    WHERE student_id = ? AND assignment_id = ?
  `);

  // Submission status phase: fetch with bounded concurrency + global rate cap;
  // per-assignment atomicity — if any cell in an assignment hits a transient
  // error, discard that assignment's in-memory results and continue.
  const acceptedResults = []; // committed at end of section in one transaction
  const failedAssignmentIds = [];
  let submissionAbandoned = false;
  let rateLimitHits = 0;
  let transientFailures = 0;
  let submissionAttempts = 0;
  let submissionSkipped = 0; // #55: public calls skipped via the GHD pre-filter

  for (const a of dropboxAssignments) {
    if (failedAssignmentIds.length >= submissionAbandonAfter) {
      submissionAbandoned = true;
      break;
    }
    const assignRow = selectAssignmentByExt.get(String(a.id));
    if (!assignRow) continue;

    const cells = studentEnrollments
      .map((e) => ({ e, studentRow: selectStudentByUid.get(String(e.uid)) }))
      .filter((c) => c.studentRow);

    let assignmentResults;
    try {
      assignmentResults = await runWithLimits(
        cells,
        async ({ e, studentRow }) => {
          const ghd = submissionLookup ? submissionLookup.get(String(e.uid), String(a.id)) : undefined;
          // #55 pre-filter: GHD definitively says "not submitted" → skip the
          // rate-limited public revisions call entirely.
          if (ghd && !ghd.submitted) {
            submissionSkipped++;
            return {
              studentId: studentRow.id,
              assignmentId: assignRow.id,
              enrolmentId: String(e.id),
              maxPoints: assignRow.max_points ?? null,
              revision: null,
              ghd: { resolved: true, submitted: false, type: null },
            };
          }
          submissionAttempts++;
          const revision = await getSubmissionStatus(sectionId, String(a.id), String(e.uid));
          return {
            studentId: studentRow.id,
            assignmentId: assignRow.id,
            enrolmentId: String(e.id),
            maxPoints: assignRow.max_points ?? null,
            revision,
            ghd: ghd ? { resolved: true, submitted: true, type: ghd.submissionType } : { resolved: false },
          };
        },
        { concurrency: submissionConcurrency, ratePerSec: submissionRatePerSec },
      );
    } catch (err) {
      if (err && err.transient) {
        if (err.rateLimited) rateLimitHits++; else transientFailures++;
        failedAssignmentIds.push(String(a.id));
        continue;
      }
      throw err; // non-transient errors abort the sync
    }
    acceptedResults.push(...assignmentResults);
  }

  let submissionCount = 0;
  const writeSubmissions = db.transaction((rows) => {
    for (const r of rows) {
      const g = r.ghd || { resolved: false };
      const late = r.revision && r.revision.late ? 1 : 0;
      const draft = r.revision && r.revision.draft ? 1 : 0;
      const latestRevisionAt = (r.revision && r.revision.latestRevisionAt) || 0;
      if (g.resolved && g.submitted) {
        // #62: GHD reports a submission (incl. OneDrive/GDrive ungraded, where
        // the public revisions API is blind). Persist the type + any late/draft/
        // timing the public call also returned.
        upsertSubmittedWithType.run(
          r.studentId, r.assignmentId, r.enrolmentId, r.maxPoints,
          late, draft, latestRevisionAt, g.type, now,
        );
        submissionCount++;
      } else if (g.resolved && !g.submitted) {
        // #55: GHD says not submitted — clear status + type (UPDATE-only).
        clearSubmissionWithType.run(now, r.studentId, r.assignmentId);
      } else if (r.revision) {
        // GHD not covering this cell; public API has a revision → prior behavior
        // (do not touch submission_type).
        upsertSubmissionStatus.run(
          r.studentId, r.assignmentId, r.enrolmentId, r.maxPoints,
          late, draft, latestRevisionAt, now,
        );
        submissionCount++;
      } else {
        clearSubmissionStatus.run(now, r.studentId, r.assignmentId);
      }
    }
  });
  writeSubmissions(acceptedResults);

  return {
    studentsCount: studentEnrollments.length,
    assignmentsCount: assignments.length,
    gradesCount,
    submissionCount,
    failedAssignmentIds,
    submissionAbandoned,
    submissionAttempts,
    submissionSkipped,
    rateLimitHits,
    transientFailures,
  };
}

// End-of-sync serial retry pass for assignments that hit transient submission
// errors during the main sync. One pass, no rate limiter, no Retry-After
// honoring, no further retries on failure. Per-assignment atomicity preserved:
// any new transient error in any cell discards that assignment's partial
// results. Mutates `metrics.retries_succeeded`, `metrics.retries_failed`,
// `metrics.submission_calls`, `metrics.rate_limit_hits`, and
// `metrics.transient_failures`. Returns the list of entries that still failed.
export async function retrySubmissions(db, failedEntries, now, metrics) {
  const stillFailing = [];

  const upsertSubmissionStatus = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, exception, late, draft, latest_revision_at, synced_at)
    VALUES (?, ?, ?, NULL, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      late = excluded.late,
      draft = excluded.draft,
      latest_revision_at = excluded.latest_revision_at,
      synced_at = excluded.synced_at
  `);
  const clearSubmissionStatus = db.prepare(`
    UPDATE grades SET late = 0, draft = 0, latest_revision_at = 0, synced_at = ?
    WHERE student_id = ? AND assignment_id = ?
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

      const cellResults = [];
      let assignmentFailed = false;
      for (const e of studentEnrollments) {
        const studentRow = selectStudentByUid.get(String(e.uid));
        if (!studentRow) continue;
        metrics.submission_calls++;
        try {
          const revision = await getSubmissionStatus(sid, assignmentExtId, String(e.uid));
          cellResults.push({
            studentId: studentRow.id,
            assignmentId: assignRow.id,
            enrolmentId: String(e.id),
            maxPoints: assignRow.max_points ?? null,
            revision,
          });
        } catch (err) {
          if (err && err.transient) {
            if (err.rateLimited) metrics.rate_limit_hits++; else metrics.transient_failures++;
            assignmentFailed = true;
            break;
          }
          throw err;
        }
      }

      if (assignmentFailed) {
        stillFailing.push(entry);
        continue;
      }

      if (cellResults.length > 0) {
        const writeRetry = db.transaction((rows) => {
          for (const r of rows) {
            if (r.revision) {
              upsertSubmissionStatus.run(
                r.studentId, r.assignmentId, r.enrolmentId,
                r.maxPoints,
                r.revision.late ? 1 : 0,
                r.revision.draft ? 1 : 0,
                r.revision.latestRevisionAt || 0,
                now,
              );
            } else {
              clearSubmissionStatus.run(now, r.studentId, r.assignmentId);
            }
          }
        });
        writeRetry(cellResults);
      }
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
  for (const s of students) {
    try {
      const profile = await getUserProfile(s.schoology_uid);
      const email = profile.primary_email || null;
      const prefName = (profile.name_first_preferred && profile.use_preferred_first_name === '1')
        ? profile.name_first_preferred : null;
      const gradYear = profile.grad_year ? parseInt(profile.grad_year, 10) : null;
      updateStudent.run(email, prefName, gradYear, now, s.id);

      // Schoology may return a lone guardian as an object rather than a
      // 1-element array — normalise so a single-guardian student isn't skipped
      // or wrongly reconciled away. (Same shape-quirk as parseAssignees.)
      const rawParents = profile.parents?.parent ?? [];
      const parents = Array.isArray(rawParents) ? rawParents : [rawParents];
      const keepUids = [];
      for (const p of parents) {
        upsertParent.run(s.id, String(p.id), p.name_first || '', p.name_last || '', p.primary_email || null, null /* relationship: not provided by Schoology */);
        keepUids.push(String(p.id));
      }
      reconcileParents(s.id, keepUids);
      profileCount++;
    } catch {
      // Non-fatal: profile inaccessible (e.g. a graduated student). Preserve
      // last-known data + contacts; delete nothing.
    }
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
export async function finalizeArchivedCourse(db, { courseId, sectionId, now, runMastery = true }) {
  const counts = await syncSectionData(db, String(sectionId), courseId, now);
  const sessionPresent = runMastery && hasMasterySession();
  if (sessionPresent) {
    try {
      await syncMasteryForCourse(courseId, { allowInteractiveLogin: false });
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

export async function fullSync(onProgress, { includeHidden = false } = {}) {
  const db = getDb();
  const log = (msg) => onProgress?.({ message: msg });
  const now = new Date().toISOString();

  // Insert sync log
  const syncRow = db.prepare(
    `INSERT INTO sync_log (sync_type, status, started_at) VALUES ('full', 'running', ?)`
  ).run(now);
  const syncId = syncRow.lastInsertRowid;

  // Declared outside the try so the finally-style cleanup below can always
  // close the browser the GHD fetcher holds, even on error.
  let submissionFetcher = null;

  try {
    // 1. Get teacher's user ID and sections
    log('Fetching user profile...');
    const syncConfig = getSyncConfig();
    const startedAt = Date.now();
    const metrics = {
      submission_calls: 0,
      submissions_skipped: 0, // #55: public calls skipped via the GHD pre-filter
      rate_limit_hits: 0,
      transient_failures: 0,
      retries_attempted: 0,
      retries_succeeded: 0,
      retries_failed: 0,
      abandoned: 0,
      sections_skipped: 0,
      failed_assignment_ids: [], // { sectionId, courseId, assignmentExtId }
    };
    const userId = await getMyUserId();

    // #62/#55: best-effort browser-session reader for internal-gradebook
    // submission state, reused across all sections. null when no saved session —
    // the per-section sync then falls back to the public revisions API alone.
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
        fetchSubmissionLookup: submissionFetcher ? (sid) => submissionFetcher.fetch(sid) : undefined,
      });
      metrics.submission_calls += result.submissionAttempts || 0;
      metrics.submissions_skipped += result.submissionSkipped || 0;
      metrics.rate_limit_hits += result.rateLimitHits || 0;
      metrics.transient_failures += result.transientFailures || 0;
      if (result.submissionAbandoned) metrics.abandoned = 1;
      for (const aid of (result.failedAssignmentIds || [])) {
        metrics.failed_assignment_ids.push({ sectionId, courseId: courseRow.id, assignmentExtId: aid });
      }
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

    // GHD reader is only needed during the section loop above (the retry pass
    // uses the public API only). Close its browser now.
    if (submissionFetcher) { await submissionFetcher.close().catch(() => {}); submissionFetcher = null; }
    if (metrics.submissions_skipped > 0) log(`Skipped ${metrics.submissions_skipped} submission checks via gradebook pre-filter`);

    // Retry pass: one serial attempt for assignments that hit transient errors.
    // No rate limiter, no Retry-After honoring, no further retries on failure.
    if (metrics.failed_assignment_ids.length > 0 && metrics.abandoned === 0) {
      log(`Retrying ${metrics.failed_assignment_ids.length} failed assignments...`);
      metrics.retries_attempted = metrics.failed_assignment_ids.length;
      metrics.failed_assignment_ids = await retrySubmissions(db, metrics.failed_assignment_ids, now, metrics);
    }

    // Auto-archive courses that have dropped off the active list this turn (#70).
    await detectArchivedTransitions(db, new Set(sections.map((s) => String(s.id))), now);

    // One-time: finalise archived courses imported before #70 (capture mastery).
    await backfillUnfinalizedArchived(db, now);

    // 3. Refresh + reconcile every retained student's profile + guardians.
    //    Runs for ALL students every sync (including those in no active course)
    //    so student data never goes stale. See enrichStudentProfiles (#70).
    const allStudents = db.prepare('SELECT id, schoology_uid FROM students WHERE schoology_uid IS NOT NULL').all();
    log(`Fetching profiles for ${allStudents.length} students...`);
    const profileCount = await enrichStudentProfiles(db, allStudents, now);
    log(`Fetched ${profileCount} profiles, reconciled parent contacts`);
    totalRecords += profileCount;

    const duration_ms = Date.now() - startedAt;
    db.prepare(`
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
    );

    // Update sync log
    db.prepare(`UPDATE sync_log SET status = 'completed', records_synced = ?, completed_at = ? WHERE id = ?`)
      .run(totalRecords, new Date().toISOString(), syncId);

    log(`Sync complete: ${totalRecords} records`);
    return { success: true, records: totalRecords };

  } catch (err) {
    db.prepare(`UPDATE sync_log SET status = 'error', error_message = ?, completed_at = ? WHERE id = ?`)
      .run(err.message, new Date().toISOString(), syncId);
    throw err;
  } finally {
    if (submissionFetcher) await submissionFetcher.close().catch(() => {});
  }
}
