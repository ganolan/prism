// Publishes Prism's status line to a student's Schoology comment (triage
// resubmissions spec, Amendment B → "Status lines"). One line per student ×
// assessment, always first; replaced by the exact text stored in status_lines
// (composeComment in server/lib/statusLines.js), never by pattern.
//
// Every write follows the #46 rule from POST /api/mastery/:courseId/write-comment:
// read the grade FRESH from Schoology (getSectionGrades), echo `grade` and
// `exception` in the destructive bulk PUT. A failed read → SCHOOLOGY_READ_FAILED
// and nothing is written; a failed PUT → SCHOOLOGY_WRITE_FAILED and nothing in
// Prism changes. Publishing always sets Display on (comment_status 1); removing
// a line keeps the fresh comment_status.
import { getSectionGrades, pushGradeComments } from './schoology.js';
import { composeComment, teacherText } from '../lib/statusLines.js';
import { captureFeedbackSnapshots } from './feedbackSnapshots.js';
import { TriageError } from './triageCommon.js';

export const STATUS_LINE_KINDS = ['ask', 'extend_resubmission', 'grade_stands', 'extension', 'make_up', 'received'];

const normalise = (text) => String(text ?? '').replace(/\r\n/g, '\n');

// Student, assignment, section and Schoology enrolment for one pair.
function pairTarget(db, studentId, assignmentId) {
  const sid = Number(studentId);
  const aid = Number(assignmentId);
  const student = Number.isInteger(sid) && sid > 0 ? db.prepare('SELECT id FROM students WHERE id = ?').get(sid) : null;
  if (!student) throw new TriageError('NOT_FOUND', `No student with id ${studentId}`);
  const a = Number.isInteger(aid) && aid > 0
    ? db.prepare(`
        SELECT a.id, a.course_id, a.schoology_assignment_id, c.schoology_section_id
        FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ?
      `).get(aid)
    : null;
  if (!a) throw new TriageError('NOT_FOUND', `No assignment with id ${assignmentId}`);
  const enrollmentId = db.prepare(`
    SELECT schoology_enrolment_id FROM enrolments
    WHERE student_id = ? AND course_id = ? AND schoology_enrolment_id IS NOT NULL
    ORDER BY dropped_at IS NOT NULL LIMIT 1
  `).get(student.id, a.course_id)?.schoology_enrolment_id
    ?? db.prepare('SELECT enrolment_id FROM grades WHERE student_id = ? AND assignment_id = ?').get(student.id, a.id)?.enrolment_id;
  if (!enrollmentId || !a.schoology_assignment_id || !a.schoology_section_id) {
    throw new TriageError('NOT_ELIGIBLE', 'Prism has no Schoology enrolment for that student on this assessment — sync first');
  }
  return {
    studentId: student.id, assignmentId: a.id,
    sectionId: a.schoology_section_id, schoologyAssignmentId: String(a.schoology_assignment_id), enrollmentId: String(enrollmentId),
  };
}

const storedRow = (db, t) => db.prepare('SELECT line, kind FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(t.studentId, t.assignmentId) || null;

// The pair's grade record, read now. null = Schoology has no record for the pair yet
// (never graded / commented) — a comment-only write is then safe, as in write-comment.
async function freshGrade(t) {
  let all;
  try {
    all = await getSectionGrades(t.sectionId);
  } catch (err) {
    console.warn(`[status line] fresh grade read failed: ${err.message}`);
    throw new TriageError('SCHOOLOGY_READ_FAILED', 'Could not read the current Schoology comment — nothing was published. Try again.');
  }
  return (all || []).find((g) => String(g.assignment_id) === t.schoologyAssignmentId && String(g.enrollment_id) === t.enrollmentId) || null;
}

// apiPut never throws on an HTTP error, so check the status — and any per-entry
// response_code in the 207 body — before treating the write as done.
function anyFailedEntry(node) {
  if (!node || typeof node !== 'object') return false;
  if (Number(node.response_code) >= 400) return true;
  return Object.values(node).some(anyFailedEntry);
}

export const putSucceeded = (result) => {
  const status = Number(result?.status);
  return status >= 200 && status < 300 && !anyFailedEntry(result?.data);
};

async function putComment(t, fresh, comment, commentStatus) {
  const payload = {
    assignment_id: t.schoologyAssignmentId,
    enrollment_id: t.enrollmentId,
    comment,
    comment_status: commentStatus,
  };
  if (fresh && fresh.grade != null) payload.grade = String(fresh.grade);
  if (fresh && fresh.exception != null) payload.exception = fresh.exception;
  let result;
  try {
    result = await pushGradeComments(t.sectionId, [payload]);
  } catch (err) {
    console.error(`[status line] comment PUT failed: ${err.message}`);
    throw new TriageError('SCHOOLOGY_WRITE_FAILED', `Schoology did not accept the comment — nothing was changed (${err.message})`);
  }
  if (!putSucceeded(result)) {
    const status = Number(result?.status);
    console.error('[status line] comment PUT rejected:', status, JSON.stringify(result?.data)?.slice(0, 500));
    throw new TriageError('SCHOOLOGY_WRITE_FAILED', `Schoology did not accept the comment (HTTP ${status || '?'}) — nothing was changed`);
  }
}

// Mirror the write locally: comment + display, and score/exception from the fresh read.
function mirror(db, t, fresh, comment, commentStatus) {
  const now = new Date().toISOString();
  if (fresh) {
    db.prepare(`
      INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception, grade_comment, comment_status, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id, assignment_id) DO UPDATE SET
        score = excluded.score, exception = excluded.exception, grade_comment = excluded.grade_comment,
        comment_status = excluded.comment_status, synced_at = excluded.synced_at
    `).run(t.studentId, t.assignmentId, t.enrollmentId, fresh.grade ?? null, fresh.exception ?? 0, comment, commentStatus, now);
  } else {
    db.prepare(`
      INSERT INTO grades (student_id, assignment_id, enrolment_id, grade_comment, comment_status, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id, assignment_id) DO UPDATE SET
        grade_comment = excluded.grade_comment, comment_status = excluded.comment_status, synced_at = excluded.synced_at
    `).run(t.studentId, t.assignmentId, t.enrollmentId, comment, commentStatus, now);
  }
}

// Best-effort, like write-comment: a Prism save of this pair (fingerprint ignores the stored line).
function capture(db, t) {
  try {
    captureFeedbackSnapshots(db, { assignmentId: t.assignmentId, studentId: t.studentId, mode: 'save' });
  } catch (err) {
    console.error('[status line] snapshot failed:', err.message);
  }
}

function checkLine(line) {
  const text = normalise(line).trim();
  if (!text) throw new TriageError('BAD_VALUE', 'The status line is empty');
  return text;
}

export async function previewStatusLine(db, { studentId, assignmentId, line = '' } = {}) {
  const t = pairTarget(db, studentId, assignmentId);
  const fresh = await freshGrade(t);
  const storedLine = storedRow(db, t)?.line ?? null;
  const currentComment = normalise(fresh?.comment);
  const visible = Number(fresh?.comment_status) === 1;
  return {
    currentComment,
    visible,
    storedLine,
    resultingComment: composeComment(currentComment, storedLine, normalise(line).trim()),
    hiddenWarning: !visible && teacherText(currentComment, storedLine) !== '',
  };
}

export async function publishStatusLine(db, { studentId, assignmentId, line, kind } = {}) {
  const text = checkLine(line);
  if (!STATUS_LINE_KINDS.includes(kind)) throw new TriageError('BAD_VALUE', `kind must be one of ${STATUS_LINE_KINDS.join(', ')}`);
  const t = pairTarget(db, studentId, assignmentId);
  const fresh = await freshGrade(t);
  const comment = composeComment(fresh?.comment, storedRow(db, t)?.line ?? null, text);
  await putComment(t, fresh, comment, 1);
  db.transaction(() => {
    mirror(db, t, fresh, comment, 1);
    db.prepare(`
      INSERT INTO status_lines (student_id, assignment_id, line, kind, written_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT (student_id, assignment_id) DO UPDATE SET line = excluded.line, kind = excluded.kind, written_at = excluded.written_at
    `).run(t.studentId, t.assignmentId, text, kind);
  })();
  capture(db, t);
  return { comment, line: text };
}

// Remove the stored line (only if it is still there verbatim). `kinds` limits it to
// lines of the action being undone (an extension undo leaves an ask's line alone).
export async function removeStatusLine(db, { studentId, assignmentId, kinds = null } = {}) {
  const t = pairTarget(db, studentId, assignmentId);
  const row = storedRow(db, t);
  if (!row || (kinds && !kinds.includes(row.kind))) return { removed: false, comment: null };
  const fresh = await freshGrade(t);
  const current = normalise(fresh?.comment);
  const comment = composeComment(current, row.line, '');
  const dropRow = db.prepare('DELETE FROM status_lines WHERE student_id = ? AND assignment_id = ?');
  if (comment === current) {
    // Hand-edited (or already gone) in Schoology: it is the teacher's text now — no write.
    dropRow.run(t.studentId, t.assignmentId);
    capture(db, t);
    return { removed: false, comment: current };
  }
  const commentStatus = Number(fresh?.comment_status) === 1 ? 1 : null;
  await putComment(t, fresh, comment, commentStatus);
  db.transaction(() => {
    mirror(db, t, fresh, comment, commentStatus);
    dropRow.run(t.studentId, t.assignmentId);
  })();
  capture(db, t);
  return { removed: true, comment };
}
