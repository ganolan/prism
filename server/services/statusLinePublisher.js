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
import { composeComment, teacherText, plainLine, isPlainLine } from '../lib/statusLines.js';
import { captureFeedbackSnapshots } from './feedbackSnapshots.js';
import { TriageError } from './triageCommon.js';

export const STATUS_LINE_KINDS = ['ask', 'extend_resubmission', 'grade_stands', 'extension', 'make_up', 'received'];

const normalise = (text) => String(text ?? '').replace(/\r\n/g, '\n');

// Per-pair lock (in-process: Prism is one server). A comment write is read → PUT →
// record; two overlapping writes for one student × assessment could each compose
// from the same fresh read and the second would drop the first's line. The second
// gets BUSY (409) before it reads anything. Callers hold the lock across the whole
// validate → publish → record sequence (server/routes/triage.js act(), write-comment).
const busyPairs = new Set();
export function lockPair(studentId, assignmentId) {
  const key = `${Number(studentId)}:${Number(assignmentId)}`;
  if (busyPairs.has(key)) throw new TriageError('BUSY', 'Another update for this student is in progress — try again');
  busyPairs.add(key);
  let held = true;
  return () => { if (held) { held = false; busyPairs.delete(key); } };
}

// Point the pair's stored line at the Prism record whose action published it, so an
// undo removes only its own line. Called after the record step (an ask's id only
// exists then).
export function setStatusLineSource(db, { studentId, assignmentId, type, id }) {
  db.prepare('UPDATE status_lines SET source_type = ?, source_id = ? WHERE student_id = ? AND assignment_id = ?')
    .run(type, Number(id), Number(studentId), Number(assignmentId));
}

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

const storedRow = (db, t) => db.prepare('SELECT line, kind, source_type, source_id FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(t.studentId, t.assignmentId) || null;

// The pair's grade record, read now. null = Schoology has no record for the pair yet
// (never graded / commented) — a comment-only write is then safe, as in write-comment.
// But if Prism holds a score or exception for the pair, a missing record means the
// read didn't find it (ids drifted, partial response): writing without the echo
// would wipe that grade, so treat it as a failed read.
async function freshGrade(db, t) {
  let all;
  try {
    all = await getSectionGrades(t.sectionId);
  } catch (err) {
    console.warn(`[status line] fresh grade read failed: ${err.message}`);
    throw new TriageError('SCHOOLOGY_READ_FAILED', 'Could not read the current Schoology comment — nothing was published. Try again.');
  }
  const found = (all || []).find((g) => String(g.assignment_id) === t.schoologyAssignmentId && String(g.enrollment_id) === t.enrollmentId) || null;
  if (!found) {
    const local = db.prepare('SELECT score, exception FROM grades WHERE student_id = ? AND assignment_id = ?').get(t.studentId, t.assignmentId);
    if (local && (local.score != null || (Number(local.exception) || 0) !== 0)) {
      console.warn(`[status line] no Schoology grade record for ${t.studentId}:${t.assignmentId}, but Prism has a grade — not writing blind`);
      throw new TriageError('SCHOOLOGY_READ_FAILED', 'Schoology did not return this student\'s grade record — nothing was published. Sync, then try again.');
    }
  }
  return found;
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

// Best-effort, like write-comment. Unstamped (R1): the mirror may carry a Schoology regrade
// the last sync never saw, and a status line is not teacher feedback, so this capture
// records the fresh state without counting as a Prism save — a publish after a
// resubmission must never make it read as answered. The publisher never moves
// grades.submitted_at either (mirror() leaves it alone). The fingerprint ignores the
// stored line.
function capture(db, t) {
  try {
    captureFeedbackSnapshots(db, { assignmentId: t.assignmentId, studentId: t.studentId, mode: 'save', stamp: false });
  } catch (err) {
    console.error('[status line] snapshot failed:', err.message);
  }
}

// One line: surrounding whitespace is trimmed; a line break inside is refused (the
// stored line must stay the comment's whole first line). Plain ASCII only: typographic
// characters are normalised (plainLine) and anything else non-ASCII is refused, so the
// stored and published line can't be altered by an encoding round-trip.
export function checkLine(line) {
  const text = plainLine(line).trim();
  if (!text) throw new TriageError('BAD_LINE', 'The status line is empty');
  if (/[\r\n]/.test(text)) throw new TriageError('BAD_LINE', 'The status line must be a single line');
  if (!isPlainLine(text)) throw new TriageError('BAD_LINE', 'Use plain characters in the status line');
  return text;
}

// write-comment / send-all: the client composed `comment` with the raw status line as
// its first line. checkLine may have normalised the line, so swap that first line for
// the normalised one (the comment's teacher text below it is left as typed).
export function withCheckedLine(comment, rawLine, line) {
  const text = String(comment ?? '').replace(/\r\n/g, '\n');
  const raw = String(rawLine ?? '').trim();
  if (raw !== line && (text === raw || text.startsWith(`${raw}\n`))) return line + text.slice(raw.length);
  return comment;
}

export async function previewStatusLine(db, { studentId, assignmentId, line = '' } = {}) {
  const t = pairTarget(db, studentId, assignmentId);
  const fresh = await freshGrade(db, t);
  const row = storedRow(db, t);
  const storedLine = row?.line ?? null;
  const currentComment = normalise(fresh?.comment);
  const visible = Number(fresh?.comment_status) === 1;
  // Be honest about the candidate line: what publish would store (normalisedLine) and
  // whether publish would refuse it (lineProblem 'BAD_LINE' + its message) — including a
  // line that normalises to '' (blank). No line at all ('' — reading the comment before
  // a line exists) is not a problem.
  const normalisedLine = plainLine(normalise(line)).trim();
  let lineProblem = null;
  let lineProblemMessage;
  if (String(line ?? '') !== '') {
    try { checkLine(line); } catch (err) { lineProblem = err.code; lineProblemMessage = err.message; }
  }
  return {
    currentComment,
    visible,
    storedLine,
    // Which record's action published the stored line (an Undo removes it only if it is its own).
    storedSource: row?.source_type ? { sourceType: row.source_type, sourceId: Number(row.source_id) } : null,
    resultingComment: composeComment(currentComment, storedLine, normalisedLine),
    hiddenWarning: !visible && teacherText(currentComment, storedLine) !== '',
    normalisedLine,
    lineProblem,
    ...(lineProblem ? { lineProblemMessage } : {}),
  };
}

export async function publishStatusLine(db, { studentId, assignmentId, line, kind } = {}) {
  const text = checkLine(line);
  if (!STATUS_LINE_KINDS.includes(kind)) throw new TriageError('BAD_VALUE', `kind must be one of ${STATUS_LINE_KINDS.join(', ')}`);
  const t = pairTarget(db, studentId, assignmentId);
  const fresh = await freshGrade(db, t);
  const comment = composeComment(fresh?.comment, storedRow(db, t)?.line ?? null, text);
  await putComment(t, fresh, comment, 1);
  db.transaction(() => {
    mirror(db, t, fresh, comment, 1);
    db.prepare(`
      INSERT INTO status_lines (student_id, assignment_id, line, kind, written_at, source_type, source_id)
      VALUES (?, ?, ?, ?, datetime('now'), NULL, NULL)
      ON CONFLICT (student_id, assignment_id) DO UPDATE SET line = excluded.line, kind = excluded.kind,
        written_at = excluded.written_at, source_type = NULL, source_id = NULL
    `).run(t.studentId, t.assignmentId, text, kind);
  })();
  capture(db, t);
  return { comment, line: text };
}

// Remove the stored line (only if it is still there verbatim). `source` ({ type, id })
// limits it to the line published by that record's action: undoing request #1 never
// strips the live line of request #2 or of an extension.
export async function removeStatusLine(db, { studentId, assignmentId, source = null } = {}) {
  const t = pairTarget(db, studentId, assignmentId);
  const row = storedRow(db, t);
  const own = !source || (row && row.source_type === source.type && Number(row.source_id) === Number(source.id));
  if (!row || !own) return { removed: false, comment: null };
  const fresh = await freshGrade(db, t);
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
