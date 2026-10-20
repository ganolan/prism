// Import one archived (past) section into Prism (#70): its course row (archived), then the full
// read of a finished course (finalizeArchivedCourse, mastery included), the students' profiles,
// and a best-effort block-number resolve. POST /api/courses/import calls it for the Archived tab's
// Import button, and the background import of past courses (#171, pastImport.js) through the
// queue's runner (archivedImportRun.js).
import { apiGet } from './schoology.js';
import { finalizeArchivedCourse, enrichStudentProfiles } from './sync.js';
import { syncPsAttendance } from './psAttendanceSync.js';

// → { course, studentsCount, assignmentsCount, gradesCount, finalized, masteryError }: finalized and
// masteryError are finalizeArchivedCourse's (masteryError null when mastery was read). Stamps
// sync_attempted_at, and course_synced_at when the read was complete (#171). A Schoology error is
// thrown as it came: its message carries the status (403, 404) the route maps to its answer.
export async function importArchivedCourse(db, sectionId) {
  const [sec, periodsData] = await Promise.all([
    apiGet(`/sections/${sectionId}`),
    apiGet(`/sections/${sectionId}/grading_periods`),
  ]);

  const gradingPeriod = periodsData?.grading_period?.[0]?.title || null;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO courses (schoology_section_id, course_name, section_name, course_code, section_school_code, grading_period, archived, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(schoology_section_id) DO UPDATE SET
      course_name = excluded.course_name,
      section_name = excluded.section_name,
      course_code = excluded.course_code,
      section_school_code = excluded.section_school_code,
      grading_period = excluded.grading_period,
      archived = 1,
      synced_at = excluded.synced_at
  `).run(
    String(sec.id), sec.course_title, sec.section_title,
    sec.course_code || null, sec.section_school_code || null,
    gradingPeriod, now
  );

  const courseRow = db.prepare('SELECT * FROM courses WHERE schoology_section_id = ?').get(String(sec.id));
  // #171: the import is no orchestrator run, so it stamps the course's Synced time itself: the
  // attempt always (a read that throws too), course_synced_at below only when the read was complete.
  let read;
  try {
    read = await finalizeArchivedCourse(db, { courseId: courseRow.id, sectionId: String(sec.id), now, runMastery: true });
  } finally {
    db.prepare('UPDATE courses SET sync_attempted_at = ? WHERE id = ?').run(now, courseRow.id);
  }
  const { studentsCount, assignmentsCount, gradesCount, finalized, masteryError } = read;
  // Bring the imported section's students to full parity (email + guardians).
  const sectionStudents = db.prepare(`
    SELECT s.id, s.schoology_uid FROM students s
    JOIN enrolments e ON e.student_id = s.id
    WHERE e.course_id = ? AND s.schoology_uid IS NOT NULL AND e.dropped_at IS NULL
  `).all(courseRow.id);
  await enrichStudentProfiles(db, sectionStudents, now);

  // #106: best-effort resolve this archived course's PowerSchool block number
  // at import time (the regular sync only covers active courses). Only
  // current-year sections resolve; prior-year ones skip. Never fails the import.
  try {
    await syncPsAttendance({ courseIds: [courseRow.id] });
  } catch (err) {
    console.warn(`[import] block-number resolve failed for ${courseRow.course_name}: ${err.message}`);
  }

  // Complete as a listed archived re-read counts it in fullSync (archivedComplete): mastery read,
  // submissions read with a session (OneDrive/LTI states and test attempts too), none failed.
  const complete = finalized && !masteryError && read.fullRead
    && !(read.failedAssignmentIds || []).length && !read.submissionAbandoned;
  if (complete) db.prepare('UPDATE courses SET course_synced_at = ? WHERE id = ?').run(now, courseRow.id);

  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseRow.id);
  return { course, studentsCount, assignmentsCount, gradesCount, finalized, masteryError };
}
