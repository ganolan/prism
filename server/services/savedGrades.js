// The grade Prism keeps while a flag is set (#40; excused_grades, server/services/gradeFlags.js),
// put into words for the Flags panel, the clear panel and the flag symbol's popover:
// "Exhibiting (75)", "87.5 / 100 and 2 topic levels". One place, so every surface says the same.
import { getAlignedTopics, scoreScaleFor } from './assessmentContext.js';
import { levelForScore } from '../lib/scoreScales.js';

const num = (v) => (v == null || v === '' ? null : Number(v));
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A new grade landed over a flag's saved copy: published from Prism over a marker (write-comment,
// send-all, /write) or, read by a sync, re-entered in Schoology after the flag was cleared
// (taskGrades.js writeGrades). The grade the flag removed is no longer the one to restore, so a
// waiting copy is retired (restored_at set) and "Restore saved grade" is no longer offered.
// `savedBefore` (ISO; the sync's start, before its read): only a copy saved before it is retired,
// so a read taken before a flag write cannot retire the copy that write just kept.
// → true when a waiting copy was retired.
export function retireCopy(db, { studentId, assignmentId, savedBefore = null } = {}) {
  return db.prepare(`UPDATE excused_grades SET restored_at = datetime('now')
    WHERE student_id = ? AND assignment_id = ? AND restored_at IS NULL AND (? IS NULL OR julianday(saved_at) < julianday(?))`)
    .run(Number(studentId), Number(assignmentId), savedBefore, savedBefore).changes > 0;
}

// "a", "a and b", "a, b and c".
export function joinParts(parts) {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// The overall: a score-scale level with its points ("Exhibiting (75)"), else the points
// ("90 / 100", or "90" with no maximum). null with no score.
export function overallText(scale, score, maxPoints = null) {
  const s = num(score);
  if (s == null) return null;
  const points = String(s);
  if (scale) {
    const code = levelForScore(scale, s);
    const label = scale.levels.find((l) => l.code === code)?.label;
    if (label) return `${label} (${points})`;
  }
  return num(maxPoints) ? `${points} / ${num(maxPoints)}` : points;
}

// A grade ({ score, max_points, topics, rows }, as gradeNow and the saved copy hold it) in words:
// the overall, then the topic levels and rubric row levels it holds. null when it holds nothing.
export function gradeSummary(scale, grade) {
  if (!grade) return null;
  const parts = [];
  const overall = overallText(scale, grade.score, grade.max_points);
  if (overall) parts.push(overall);
  const topics = Object.values(grade.topics || {}).filter(Boolean).length;
  if (topics) parts.push(count(topics, 'topic level'));
  const rows = Object.values(grade.rows || {}).filter(Boolean).length;
  if (rows) parts.push(count(rows, 'rubric row level'));
  return parts.length ? joinParts(parts) : null;
}

// The score scale Prism grades an unaligned task on, or null (an aligned task, or no known scale).
export function scaleForAssignment(db, assignmentRow) {
  if (!assignmentRow) return null;
  return scoreScaleFor(assignmentRow, getAlignedTopics(db, assignmentRow.course_id, assignmentRow.schoology_assignment_id).length);
}

// Every copy still waiting to be restored, for one course, student or assignment:
// Map "studentId:assignmentId" → { saved, flag, savedAt, summary }.
export function waitingCopies(db, { courseId = null, studentId = null, assignmentId = null } = {}) {
  const where = ['e.restored_at IS NULL'];
  const args = [];
  if (courseId != null) { where.push('a.course_id = ?'); args.push(courseId); }
  if (studentId != null) { where.push('e.student_id = ?'); args.push(studentId); }
  if (assignmentId != null) { where.push('e.assignment_id = ?'); args.push(assignmentId); }
  const rows = db.prepare(`
    SELECT e.student_id, e.assignment_id, e.flag, e.saved_json, e.saved_at
    FROM excused_grades e JOIN assignments a ON a.id = e.assignment_id
    WHERE ${where.join(' AND ')}
  `).all(...args);
  const scales = new Map();
  const out = new Map();
  for (const r of rows) {
    let saved;
    try { saved = JSON.parse(r.saved_json); } catch { continue; }
    if (!scales.has(r.assignment_id)) {
      scales.set(r.assignment_id, scaleForAssignment(db, db.prepare('SELECT * FROM assignments WHERE id = ?').get(r.assignment_id)));
    }
    out.set(`${r.student_id}:${r.assignment_id}`, {
      saved, flag: r.flag, savedAt: r.saved_at, summary: gradeSummary(scales.get(r.assignment_id), saved),
    });
  }
  return out;
}

// The flag's own status line per pair ("Marked exempt on Wed 21/10. Medical leave."), for the
// symbol's popover: Map "studentId:assignmentId" → line.
export function flagLines(db, { courseId = null, studentId = null, assignmentId = null } = {}) {
  const where = [`l.kind = 'flag'`];
  const args = [];
  if (courseId != null) { where.push('a.course_id = ?'); args.push(courseId); }
  if (studentId != null) { where.push('l.student_id = ?'); args.push(studentId); }
  if (assignmentId != null) { where.push('l.assignment_id = ?'); args.push(assignmentId); }
  const rows = db.prepare(`
    SELECT l.student_id, l.assignment_id, l.line FROM status_lines l JOIN assignments a ON a.id = l.assignment_id
    WHERE ${where.join(' AND ')}
  `).all(...args);
  return new Map(rows.map((r) => [`${r.student_id}:${r.assignment_id}`, r.line]));
}
