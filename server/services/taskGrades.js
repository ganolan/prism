// The grades write shared by the full sync (a section's grades) and the
// on-demand refresh (one task's grades, #108), so the two cannot disagree.
// Note: late/draft are owned by the submission reads (taskSubmissions.js) and are
// intentionally NOT updated on conflict here. The grades write seeds them to 0
// on initial insert.

import { retireCopy } from './savedGrades.js';

// `grades`: rows of GET /sections/{id}/grades (or its ?assignment_id= form).
// A student is found by the course's stored enrolment, then through
// `enrollIdToUid` (enrolment id → uid) for one not stored yet. A pair with no flag and a score
// retires a saved copy still waiting from a cleared flag (#40: the teacher re-entered the grade in
// Schoology); `now` is when the read began, so a copy kept after it is left alone. → rows written.
export function writeGrades(db, { courseId, grades, now, enrollIdToUid = {} }) {
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

  const selectStudentByUid = db.prepare('SELECT id FROM students WHERE schoology_uid = ?');
  const selectAssignmentByExt = db.prepare('SELECT id, max_points FROM assignments WHERE schoology_assignment_id = ?');
  let gradesCount = 0;
  const write = db.transaction((rows) => {
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
      if (!(Number(g.exception) || 0) && g.grade != null && g.grade !== '') {
        retireCopy(db, { studentId, assignmentId: assignRow.id, savedBefore: now });
      }
      gradesCount++;
    }
  });
  write(grades);
  return gradesCount;
}
