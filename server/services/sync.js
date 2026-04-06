import { getDb } from '../db/index.js';
import {
  getMyUserId,
  getMySections,
  getSectionEnrollments,
  getSectionAssignments,
  getSectionGrades,
  getUserProfile,
} from './schoology.js';

// Full sync: sections -> enrollments -> assignments -> grades
export async function fullSync(onProgress) {
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
    const userId = await getMyUserId();

    log('Fetching course sections...');
    const sections = await getMySections(userId);
    log(`Found ${sections.length} sections`);

    let totalRecords = 0;

    // Upsert courses
    const upsertCourse = db.prepare(`
      INSERT INTO courses (schoology_section_id, course_name, section_name, course_code, section_school_code, grading_period, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(schoology_section_id) DO UPDATE SET
        course_name = excluded.course_name,
        section_name = excluded.section_name,
        course_code = excluded.course_code,
        section_school_code = excluded.section_school_code,
        synced_at = excluded.synced_at
    `);

    for (const sec of sections) {
      upsertCourse.run(
        String(sec.id),
        sec.course_title,
        sec.section_title,
        sec.course_code || null,
        sec.section_school_code || null,
        sec.grading_periods?.[0]?.title || null,
        now
      );
    }
    totalRecords += sections.length;

    // Hide courses without course_code or section_school_code by default (only on first sync)
    db.prepare(`
      UPDATE courses
      SET hidden = 1
      WHERE (course_code IS NULL OR course_code = '')
        AND (section_school_code IS NULL OR section_school_code = '')
        AND hidden = 0
        AND synced_at = ?
    `).run(now);

    // 2. For each section, sync enrollments, assignments, grades
    for (const sec of sections) {
      const sectionId = String(sec.id);
      const courseRow = db.prepare('SELECT id FROM courses WHERE schoology_section_id = ?').get(sectionId);
      if (!courseRow) continue;
      const courseId = courseRow.id;

      // Enrollments
      log(`Syncing enrollments for "${sec.course_title}"...`);
      const enrollments = await getSectionEnrollments(sectionId);
      const studentEnrollments = enrollments.filter(e => e.admin !== '1' && e.admin !== 1);

      const upsertStudent = db.prepare(`
        INSERT INTO students (schoology_uid, first_name, last_name, email, picture_url, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(schoology_uid) DO UPDATE SET
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          email = COALESCE(excluded.email, students.email),
          picture_url = COALESCE(excluded.picture_url, students.picture_url),
          updated_at = excluded.updated_at
      `);

      const upsertEnrolment = db.prepare(`
        INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id)
        VALUES (?, ?, ?)
        ON CONFLICT(student_id, course_id) DO UPDATE SET
          schoology_enrolment_id = excluded.schoology_enrolment_id
      `);

      for (const e of studentEnrollments) {
        upsertStudent.run(String(e.uid), e.name_first, e.name_last, e.primary_email || null, e.picture_url || null, now);
        const studentRow = db.prepare('SELECT id FROM students WHERE schoology_uid = ?').get(String(e.uid));
        if (studentRow) {
          upsertEnrolment.run(studentRow.id, courseId, String(e.id));
        }
      }
      totalRecords += studentEnrollments.length;

      // Assignments
      log(`Syncing assignments for "${sec.course_title}"...`);
      const assignments = await getSectionAssignments(sectionId);

      const upsertAssignment = db.prepare(`
        INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, max_points, assignment_type, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(schoology_assignment_id) DO UPDATE SET
          title = excluded.title,
          due_date = excluded.due_date,
          max_points = excluded.max_points,
          assignment_type = excluded.assignment_type,
          synced_at = excluded.synced_at
      `);

      for (const a of assignments) {
        upsertAssignment.run(
          courseId,
          String(a.id),
          a.title,
          a.due || null,
          a.max_points ?? null,
          a.type || 'assignment',
          now
        );
      }
      totalRecords += assignments.length;

      // Grades
      log(`Syncing grades for "${sec.course_title}"...`);
      const grades = await getSectionGrades(sectionId);

      const upsertGrade = db.prepare(`
        INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, grade_comment, comment_status, exception, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(student_id, assignment_id) DO UPDATE SET
          score = excluded.score,
          max_score = excluded.max_score,
          grade_comment = excluded.grade_comment,
          comment_status = excluded.comment_status,
          exception = excluded.exception,
          synced_at = excluded.synced_at
      `);

      // Build enrollment_id -> student_id lookup from the grades' enrollment_ids
      // Schoology grades use enrollment_id, not uid — we need to map through enrolments table
      const enrolmentMap = {};
      const allEnrolments = db.prepare('SELECT id, student_id, schoology_enrolment_id FROM enrolments WHERE course_id = ?').all(courseId);
      for (const en of allEnrolments) {
        enrolmentMap[en.schoology_enrolment_id] = en.student_id;
      }

      // Also build enrollment_id (from Schoology enrollments response) -> uid map
      // Schoology grade.enrollment_id is actually the enrollment record ID, not the uid
      const enrollIdToUid = {};
      for (const e of enrollments) {
        enrollIdToUid[String(e.id)] = String(e.uid);
      }

      for (const g of grades) {
        const enrollmentId = String(g.enrollment_id);
        // Map enrollment_id to student: first try via enrolments table, then via uid lookup
        let studentId = enrolmentMap[enrollmentId];
        if (!studentId) {
          // Try mapping enrollment_id -> uid -> student
          const uid = enrollIdToUid[enrollmentId];
          if (uid) {
            const row = db.prepare('SELECT id FROM students WHERE schoology_uid = ?').get(uid);
            studentId = row?.id;
          }
        }
        if (!studentId) continue; // skip grades for unknown students (e.g. admins)

        const assignRow = db.prepare('SELECT id, max_points FROM assignments WHERE schoology_assignment_id = ?')
          .get(String(g.assignment_id));
        if (!assignRow) continue;

        upsertGrade.run(
          studentId,
          assignRow.id,
          enrollmentId,
          g.grade ?? null,
          g.max_points ?? assignRow.max_points ?? null,
          g.comment || null,
          g.comment_status ?? null,
          g.exception ?? 0,
          now
        );
      }
      totalRecords += grades.length;
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

        // Update student email and preferred name from profile
        const email = profile.primary_email || null;
        const prefName = (profile.name_first_preferred && profile.use_preferred_first_name === '1')
          ? profile.name_first_preferred : null;

        db.prepare(`
          UPDATE students SET
            email = COALESCE(?, email),
            preferred_name = COALESCE(preferred_name, ?),
            updated_at = ?
          WHERE id = ?
        `).run(email, prefName, now, s.id);

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
