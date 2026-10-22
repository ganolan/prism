// Import one archived (past) section into Prism (#70): its course row (archived), then the full
// read of a finished course (finalizeArchivedCourse, mastery included), the students' profiles,
// and a best-effort block-number resolve. POST /api/courses/import calls it for the Archived tab's
// Import button, and the background import of past courses (#171, pastImport.js) through the
// queue's runner (archivedImportRun.js).
import { apiGet } from './schoology.js';
import { finalizeArchivedCourse, enrichStudentProfiles } from './sync.js';
import { syncPsAttendance } from './psAttendanceSync.js';
import { linkedSectionsOf } from './archivedCourses.js';

const parentOf = (sec) => (sec?.parent_id && String(sec.parent_id) !== '0' ? String(sec.parent_id) : null);

// → { course, studentsCount, assignmentsCount, gradesCount, finalized, masteryError }: finalized and
// masteryError are finalizeArchivedCourse's (masteryError null when mastery was read). Stamps
// sync_attempted_at (and its live tasks' task_sync_attempted_at), and course_synced_at (and
// task_synced_at on its tasks read in full) when the read was complete (#171, #172). A Schoology
// error is thrown as it came: its message carries the status (403, 404) the route maps to its answer.
// #178: linked sections are one course. A linked section imports its parent instead; the parent's
// linked sections are recorded (linked_sections) before the read, which reads every section.
export async function importArchivedCourse(db, sectionId) {
  let sec = await apiGet(`/sections/${sectionId}`);
  if (parentOf(sec)) sec = await apiGet(`/sections/${parentOf(sec)}`);
  const [periodsData, linked] = await Promise.all([
    apiGet(`/sections/${sec.id}/grading_periods`),
    linkedSectionsOf(String(sec.id)),
  ]);

  const gradingPeriod = periodsData?.grading_period?.[0]?.title || null;
  const sectionName = [sec.section_title, ...linked.map((l) => l.sectionTitle)].filter(Boolean).join(', ') || null;
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
    String(sec.id), sec.course_title, sectionName,
    sec.course_code || null, sec.section_school_code || null,
    gradingPeriod, now
  );

  const courseRow = db.prepare('SELECT * FROM courses WHERE schoology_section_id = ?').get(String(sec.id));
  const recordLinked = db.prepare(`
    INSERT INTO linked_sections (schoology_section_id, course_id, section_name) VALUES (?, ?, ?)
    ON CONFLICT(schoology_section_id) DO UPDATE SET course_id = excluded.course_id, section_name = excluded.section_name
  `);
  for (const l of linked) recordLinked.run(l.sectionId, courseRow.id, l.sectionTitle);
  // #171: the import is no orchestrator run, so it stamps the course's Synced time itself: the
  // attempt always (a read that throws too), course_synced_at below only when the read was complete.
  // #172: its tasks too, as stampCompleteSyncs (syncOrchestrator.js) does: every live task's attempt
  // here, and task_synced_at below for the tasks read in full.
  let read;
  try {
    read = await finalizeArchivedCourse(db, { courseId: courseRow.id, sectionId: String(sec.id), now, runMastery: true });
  } finally {
    db.transaction(() => {
      db.prepare('UPDATE courses SET sync_attempted_at = ? WHERE id = ?').run(now, courseRow.id);
      db.prepare('UPDATE assignments SET task_sync_attempted_at = ? WHERE course_id = ? AND removed_at IS NULL').run(now, courseRow.id);
    })();
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
  // submissions read with a session (OneDrive/LTI states and test attempts too), none failed. Unlike
  // stampCompleteSyncs (syncOrchestrator.js), comment threads are not checked: the import reads none.
  const complete = finalized && !masteryError && read.fullRead
    && !(read.failedAssignmentIds || []).length && !read.submissionAbandoned;
  if (complete) {
    db.transaction(() => {
      db.prepare('UPDATE courses SET course_synced_at = ? WHERE id = ?').run(now, courseRow.id);
      const stampTask = db.prepare('UPDATE assignments SET task_synced_at = ? WHERE id = ?');
      for (const t of read.readInFullTaskIds || []) stampTask.run(now, t);
    })();
  }

  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseRow.id);
  return { course, studentsCount, assignmentsCount, gradesCount, finalized, masteryError };
}
