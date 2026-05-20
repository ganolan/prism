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
} from './schoology.js';
import { runWithLimits } from './rateLimitedRunner.js';
import { getSyncConfig } from '../middleware/featureGate.js';

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
  const dropboxAssignments = assignments.filter(a => a.allow_dropbox === '1' || a.allow_dropbox === 1);
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

  // Submission status phase: fetch with bounded concurrency + global rate cap;
  // per-assignment atomicity — if any cell in an assignment hits a transient
  // error, discard that assignment's in-memory results and continue.
  const acceptedResults = []; // committed at end of section in one transaction
  const failedAssignmentIds = [];
  let submissionAbandoned = false;
  let rateLimitHits = 0;
  let transientFailures = 0;
  let submissionAttempts = 0;

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
          submissionAttempts++;
          const revision = await getSubmissionStatus(sectionId, String(a.id), String(e.uid));
          return {
            studentId: studentRow.id,
            assignmentId: assignRow.id,
            enrolmentId: String(e.id),
            maxPoints: assignRow.max_points ?? null,
            revision,
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
      if (r.revision) {
        upsertSubmissionStatus.run(
          r.studentId, r.assignmentId, r.enrolmentId,
          r.maxPoints,
          r.revision.late ? 1 : 0,
          r.revision.draft ? 1 : 0,
          r.revision.latestRevisionAt || 0,
          now,
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
export async function fullSync(onProgress, { includeHidden = false, includeArchived = false } = {}) {
  const db = getDb();
  const log = (msg) => onProgress?.({ message: msg });
  const now = new Date().toISOString();

  // Insert sync log
  const syncRow = db.prepare(
    `INSERT INTO sync_log (sync_type, status, started_at) VALUES ('full', 'running', ?)`
  ).run(now);
  const syncId = syncRow.lastInsertRowid;

  try {
    // 1. Get teacher's user ID and sections
    log('Fetching user profile...');
    const syncConfig = getSyncConfig();
    const startedAt = Date.now();
    const metrics = {
      submission_calls: 0,
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
      if (courseRow.archived && !includeArchived) { metrics.sections_skipped++; continue; }

      log(`Syncing "${sec.course_title}"...`);
      const result = await syncSectionData(db, sectionId, courseRow.id, now, syncConfig);
      metrics.submission_calls += result.submissionAttempts || 0;
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

    // Retry pass: one serial attempt for assignments that hit transient errors.
    // No rate limiter, no Retry-After honoring, no further retries on failure.
    if (metrics.failed_assignment_ids.length > 0 && metrics.abandoned === 0) {
      log(`Retrying ${metrics.failed_assignment_ids.length} failed assignments...`);
      metrics.retries_attempted = metrics.failed_assignment_ids.length;
      metrics.failed_assignment_ids = await retrySubmissions(db, metrics.failed_assignment_ids, now, metrics);
    }

    // 3. Fetch full profiles + parent data for all students
    const allStudents = db.prepare('SELECT id, schoology_uid FROM students WHERE schoology_uid IS NOT NULL').all();
    log(`Fetching profiles for ${allStudents.length} students...`);

    const upsertParent = db.prepare(`
      INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email, relationship)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id, schoology_uid) DO UPDATE SET
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        email = excluded.email
    `);

    let profileCount = 0;
    for (const s of allStudents) {
      try {
        const profile = await getUserProfile(s.schoology_uid);

        // Update student email, preferred name, and grad_year from profile
        const email = profile.primary_email || null;
        const prefName = (profile.name_first_preferred && profile.use_preferred_first_name === '1')
          ? profile.name_first_preferred : null;
        const gradYear = profile.grad_year ? parseInt(profile.grad_year) : null;

        db.prepare(`
          UPDATE students SET
            email = COALESCE(?, email),
            preferred_name = COALESCE(preferred_name, ?),
            grad_year = COALESCE(?, grad_year),
            updated_at = ?
          WHERE id = ?
        `).run(email, prefName, gradYear, now, s.id);

        const parents = profile.parents?.parent || [];

        // Upsert parents
        for (const p of parents) {
          upsertParent.run(
            s.id,
            String(p.id),
            p.name_first || '',
            p.name_last || '',
            p.primary_email || null,
            null // Schoology doesn't provide relationship type
          );
        }
        profileCount++;
      } catch (err) {
        // Non-fatal: some student profiles may be inaccessible
        // Just skip and continue
      }
    }
    log(`Fetched ${profileCount} profiles, synced parent contacts`);
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
  }
}
